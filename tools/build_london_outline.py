#!/usr/bin/env python3
"""Build london-outline.svg from the London boroughs TopoJSON.

Source: londonBoroughs.json from https://github.com/vega/vega-datasets
(simplified from the London Datastore "London_Borough_Excluding_MHW"
boundaries, OGL-UK-3.0). Those boundaries exclude the river below mean high
water, so the Thames is a channel between the boroughs. This script fills
that channel in and traces its centreline, so the map can draw the river as
one line instead of two banks.

Requires numpy, scipy, scikit-image, networkx and Pillow.

Usage: python tools/build_london_outline.py path/to/londonBoroughs.json

The projection constants printed at the end must match PROJECTION in
station-map.js; tests/station-map.test.mjs checks that they do.
"""

from __future__ import annotations

import json
import math
import sys
from collections import Counter
from pathlib import Path

import networkx as nx
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from skimage.measure import approximate_polygon, find_contours
from skimage.morphology import skeletonize

WIDTH = 1000
PAD = 20
RASTER = 4          # raster pixels per map unit when tracing the river
CLOSE_RADIUS = 10   # map units; wider than half the Thames anywhere in London
MIN_EDGE_LENGTH = 20  # map units; London's real boundary pieces are far longer

# Above Teddington Lock the Thames isn't tidal, so the boundaries don't cut it
# out. These points (latitude, longitude) continue it upstream: Kingston
# Bridge, then London's own south-west edge, which follows the river from
# Seething Wells past Hampton Court to where it leaves London near Sunbury.
UPSTREAM_THAMES = [
    (51.4116, -0.3102), (51.3937, -0.3178), (51.3918, -0.3277), (51.4034, -0.3412),
    (51.4040, -0.3438), (51.4120, -0.3598), (51.4111, -0.3665), (51.4086, -0.3731),
    (51.4078, -0.3795), (51.4101, -0.3838), (51.4107, -0.3897),
]
OUTPUT = Path(__file__).resolve().parent.parent / "london-outline.svg"


def decode_arcs(topology: dict) -> list[list[tuple[float, float]]]:
    scale_x, scale_y = topology["transform"]["scale"]
    shift_x, shift_y = topology["transform"]["translate"]
    arcs = []
    for arc in topology["arcs"]:
        x = y = 0
        points = []
        for dx, dy in arc:
            x += dx
            y += dy
            points.append((x * scale_x + shift_x, y * scale_y + shift_y))
        arcs.append(points)
    return arcs


def polygon_rings(geometry: dict) -> list[list[int]]:
    if geometry["type"] == "Polygon":
        return geometry["arcs"]
    if geometry["type"] == "MultiPolygon":
        return [ring for polygon in geometry["arcs"] for ring in polygon]
    return []


def path_data(lines: list[list[tuple[float, float]]], close: bool = False) -> str:
    return "".join(
        "M" + "L".join(f"{x:.1f} {y:.1f}" for x, y in line) + ("Z" if close else "")
        for line in lines
    )


def chaikin(points: np.ndarray, iterations: int = 2) -> np.ndarray:
    for _ in range(iterations):
        q = 0.75 * points[:-1] + 0.25 * points[1:]
        r = 0.25 * points[:-1] + 0.75 * points[1:]
        middle = np.empty((len(q) * 2, 2))
        middle[0::2], middle[1::2] = q, r
        points = np.vstack([points[:1], middle, points[-1:]])
    return points


def longest_skeleton_path(skeleton: np.ndarray) -> np.ndarray:
    graph = nx.Graph()
    rows, cols = np.nonzero(skeleton)
    pixels = set(zip(rows.tolist(), cols.tolist()))
    for r, c in pixels:
        for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
            if (r + dr, c + dc) in pixels:
                graph.add_edge((r, c), (r + dr, c + dc), weight=math.hypot(dr, dc))
    component = max(nx.connected_components(graph), key=len)
    graph = graph.subgraph(component)
    start = next(iter(component))
    first = max(nx.single_source_dijkstra_path_length(graph, start).items(), key=lambda item: item[1])[0]
    lengths, paths = nx.single_source_dijkstra(graph, first)
    last = max(lengths.items(), key=lambda item: item[1])[0]
    return np.array(paths[last], dtype=float)


def extend_to_edge(line: np.ndarray, inside: np.ndarray, step: float = 0.25) -> np.ndarray:
    """Continue the downstream end of the river line until it leaves Greater London."""

    def walk(end: np.ndarray, before: np.ndarray) -> np.ndarray:
        direction = end - before
        direction /= np.linalg.norm(direction)
        point = end.copy()
        for _ in range(int(4 * CLOSE_RADIUS / step)):
            point = point + direction * step
            r, c = int(point[1] * RASTER), int(point[0] * RASTER)
            if not (0 <= r < inside.shape[0] and 0 <= c < inside.shape[1]) or not inside[r, c]:
                return point
        return end

    return np.vstack([line, walk(line[-1], line[max(-7, -len(line))])])


def main(source: Path) -> None:
    topology = json.loads(source.read_text(encoding="utf-8"))
    arcs = decode_arcs(topology)
    geometries = next(iter(topology["objects"].values()))["geometries"]

    lon_min, lat_min, lon_max, lat_max = topology["bbox"]
    cos_lat = math.cos(math.radians((lat_min + lat_max) / 2))
    scale = (WIDTH - 2 * PAD) / ((lon_max - lon_min) * cos_lat)
    height = round((lat_max - lat_min) * scale + 2 * PAD)

    def project(lon: float, lat: float) -> tuple[float, float]:
        return (PAD + (lon - lon_min) * cos_lat * scale, PAD + (lat_max - lat) * scale)

    projected_arcs = [[project(*point) for point in arc] for arc in arcs]

    def oriented(index: int) -> list[tuple[float, float]]:
        return projected_arcs[index] if index >= 0 else projected_arcs[~index][::-1]

    usage = Counter()
    land_rings = []
    for geometry in geometries:
        for ring in polygon_rings(geometry):
            points = []
            for position, index in enumerate(ring):
                usage[index if index >= 0 else ~index] += 1
                segment = oriented(index)
                points.extend(segment if position == 0 else segment[1:])
            land_rings.append(points)

    # Rasterise the boroughs, close the gaps between them, and keep the
    # largest gap: the Thames (with its tidal creeks).
    image = Image.new("1", (WIDTH * RASTER, height * RASTER), 0)
    draw = ImageDraw.Draw(image)
    for ring in land_rings:
        draw.polygon([(x * RASTER, y * RASTER) for x, y in ring], fill=1, outline=1)
    land = np.array(image, dtype=bool)
    radius = CLOSE_RADIUS * RASTER
    closed = ndimage.distance_transform_edt(ndimage.distance_transform_edt(~land) <= radius) > radius
    eight = np.ones((3, 3))
    outside_labels, _ = ndimage.label(~land, structure=eight)
    border = np.unique(np.concatenate([outside_labels[0], outside_labels[-1], outside_labels[:, 0], outside_labels[:, -1]]))
    outside = np.isin(outside_labels, border[border > 0]) & ~closed

    # Water enclosed by London (the Thames and its tidal creeks) touches the
    # outside only at the river mouths; gaps along London's own edge that the
    # closing filled touch the outside along much of their perimeter.
    labels, count = ndimage.label(closed & ~land, structure=eight)
    touching = ndimage.binary_dilation(outside, iterations=2)
    river = np.zeros_like(land)
    for index in range(1, count + 1):
        piece = labels == index
        perimeter = piece & ~ndimage.binary_erosion(piece)
        if perimeter.sum() and (perimeter & touching).sum() / perimeter.sum() < 0.1:
            river |= piece

    # Centreline: the longest path through the river's skeleton. Bridging
    # first joins stretches the simplified boundaries pinch apart.
    bridged = ndimage.binary_dilation(river, iterations=int(RASTER * 1.5)) & (closed | land)
    centre = longest_skeleton_path(skeletonize(bridged))[:, ::-1] / RASTER + 0.5 / RASTER
    if centre[0][0] > centre[-1][0]:
        centre = centre[::-1]  # draw west to east
    centre = approximate_polygon(centre, tolerance=0.35)
    upstream = np.array([project(lon, lat) for lat, lon in reversed(UPSTREAM_THAMES)])
    centre = chaikin(np.vstack([upstream, extend_to_edge(centre, closed | land)]), iterations=2)

    # Fill the river channel so no gap shows either side of the line.
    river_fill = ndimage.binary_dilation(bridged, iterations=RASTER * 2) & ~ndimage.binary_dilation(outside, iterations=RASTER)
    fill_rings = [
        approximate_polygon(contour[:, ::-1] / RASTER, tolerance=0.3).tolist()
        for contour in find_contours(river_fill.astype(float), 0.5)
        if len(contour) > 20
    ]

    # Arcs used by one borough are the Greater London boundary or a river
    # bank; banks are dropped because the centreline replaces them.
    near_river = ndimage.binary_dilation(bridged, iterations=RASTER * 2)

    def sample(mask: np.ndarray, x: float, y: float) -> bool:
        return bool(mask[min(max(int(y * RASTER), 0), mask.shape[0] - 1), min(max(int(x * RASTER), 0), mask.shape[1] - 1)])

    def bank(a: tuple[float, float], b: tuple[float, float]) -> bool:
        points = [a, ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2), b]
        return all(sample(near_river, *p) for p in points)

    edge_arcs = []
    for index, count in sorted(usage.items()):
        if count != 1:
            continue
        run = []
        points = projected_arcs[index]
        for a, b in zip(points, points[1:]):
            if bank(a, b):
                if len(run) > 1:
                    edge_arcs.append(run)
                run = []
            else:
                run = run or [a]
                run.append(b)
        if len(run) > 1:
            edge_arcs.append(run)
    # Drop the short stubs left where narrow tidal creeks met the river.
    edge_arcs = [run for run in edge_arcs if sum(math.dist(a, b) for a, b in zip(run, run[1:])) >= MIN_EDGE_LENGTH]
    # London's outline is a closed loop except where the river banks were
    # removed; join those loose ends to the river line.
    ends = [run[0] for run in edge_arcs] + [run[-1] for run in edge_arcs]
    river_points = centre.tolist()
    for run in edge_arcs:
        for position in (0, -1):
            end = run[position]
            if sum(math.dist(end, other) < 0.5 for other in ends) > 1:
                continue
            nearest = min(river_points, key=lambda point: math.dist(end, point))
            if math.dist(end, nearest) < 3 * CLOSE_RADIUS:
                run.insert(0, tuple(nearest)) if position == 0 else run.append(tuple(nearest))
    internal_arcs = [projected_arcs[i] for i, count in sorted(usage.items()) if count > 1]

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {height}" data-projection="lonMin={lon_min:.6f} latMax={lat_max:.6f} cosLat={cos_lat:.6f} scale={scale:.4f} pad={PAD}">
<!-- Greater London boroughs and the River Thames. Generated by tools/build_london_outline.py. -->
<!-- Contains National Statistics data (c) Crown copyright and database right 2015. Contains Ordnance Survey data (c) Crown copyright and database right 2015. Open Government Licence v3.0. -->
<path d="{path_data(land_rings, close=True)}{path_data(fill_rings, close=True)}" fill="#f3f3f0" stroke="none"/>
<path d="{path_data(internal_arcs)}" fill="none" stroke="#c9c9c4" stroke-width="0.75" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
<path d="{path_data(edge_arcs)}" fill="none" stroke="#111111" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
<path class="thames" d="{path_data([centre.tolist()])}" fill="none" stroke="#111111" stroke-width="4.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
</svg>
"""
    OUTPUT.write_text(svg, encoding="utf-8")
    print(f"Wrote {OUTPUT} ({len(svg.encode()):,} bytes, viewBox 0 0 {WIDTH} {height})")
    print(f"Thames centreline: {len(centre)} points; boundary arcs kept: {len(edge_arcs)}")
    print(f"PROJECTION = {{ lonMin: {lon_min:.6f}, latMax: {lat_max:.6f}, cosLat: {cos_lat:.6f}, scale: {scale:.4f}, pad: {PAD}, width: {WIDTH}, height: {height} }}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]))
