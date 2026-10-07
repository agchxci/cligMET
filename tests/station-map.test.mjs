import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../station-map.js', import.meta.url), 'utf8');
const svg = fs.readFileSync(new URL('../london-outline.svg', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(code, context);
const map = context.window.CligmetStationMap;

function landRings() {
  const d = svg.match(/<path d="([^"]+)" fill="#f3f3f0"/)[1];
  return d.split('Z').filter(Boolean).map(ring => ring.replace(/^M/, '').split('L').map(pair => pair.trim().split(/\s+/).map(Number)));
}

function insideLand(x, y) {
  let inside = false;
  for (const ring of landRings()) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

test('projection matches the generated London outline', () => {
  const attributes = Object.fromEntries(svg.match(/data-projection="([^"]+)"/)[1].split(' ').map(pair => pair.split('=')));
  const { PROJECTION } = map;
  assert.equal(Number(attributes.lonMin), PROJECTION.lonMin);
  assert.equal(Number(attributes.latMax), PROJECTION.latMax);
  assert.equal(Number(attributes.cosLat), PROJECTION.cosLat);
  assert.equal(Number(attributes.scale), PROJECTION.scale);
  assert.equal(Number(attributes.pad), PROJECTION.pad);
  assert.match(svg, new RegExp(`viewBox="0 0 ${PROJECTION.width} ${PROJECTION.height}"`));
});

test('both stations fall inside Greater London, ILONDO327 north-east of ILONDO1066', () => {
  const positions = {};
  for (const [stationId, station] of Object.entries(map.STATIONS)) {
    const { x, y } = map.project(station.latitude, station.longitude);
    positions[stationId] = { x, y };
    const px = x / 100 * map.PROJECTION.width, py = y / 100 * map.PROJECTION.height;
    assert.ok(insideLand(px, py), `${stationId} is outside the London outline`);
  }
  assert.ok(positions.ILONDO327.x > positions.ILONDO1066.x);
  assert.ok(positions.ILONDO327.y < positions.ILONDO1066.y);
});

test('scale bar and separation use real distances', () => {
  assert.ok(Math.abs(map.scaleBarPercent(5) - 8.2) < 0.05);
  const km = map.distanceKm(map.STATIONS.ILONDO1066, map.STATIONS.ILONDO327);
  assert.ok(km > 4.8 && km < 5.2, `separation ${km}`);
  assert.equal(map.coordinateLabel(51.534, -0.093), '51.53°N 0.09°W');
});

test('marker readings show fresh, stale and unselected stations honestly', () => {
  assert.equal(map.readingLabel({ temperature: 15.34, state: 'fresh' }), '15.3°');
  assert.equal(map.readingLabel({ temperature: 17.1, state: 'stale' }), '17.1° STALE');
  assert.equal(map.readingLabel({ temperature: null, state: 'stale' }), '—');
  assert.equal(map.readingLabel(undefined), '');
});

test('page includes the map section, both markers and the app hook', () => {
  const history = html.indexOf('history-navigation.js');
  const stationMap = html.indexOf('station-map.js');
  const main = html.indexOf('src="app.js"');
  assert.ok(history >= 0 && stationMap > history && main > stationMap);
  assert.match(html, /id="stationMap"/);
  assert.match(html, /data-map-station="ILONDO1066"/);
  assert.match(html, /data-map-station="ILONDO327"/);
  assert.match(html, /src="london-outline\.svg"/);
  assert.ok(html.indexOf('id="stations"') < html.indexOf('id="observations"'), 'map is the first section');
  assert.match(svg, /Crown copyright/);
  assert.match(app, /window\.CligmetStationMap\.update\(state\.stationSelection, readings\)/);
});

test('the Thames is drawn as one continuous line from Sunbury to Erith', () => {
  const lines = [...svg.matchAll(/<path class="thames" d="([^"]+)"/g)];
  assert.equal(lines.length, 1);
  const subpaths = lines[0][1].split('M').filter(Boolean);
  assert.equal(subpaths.length, 1);
  const points = subpaths[0].split('L').map(pair => pair.trim().split(/\s+/).map(Number));
  const [west, east] = [points[0], points.at(-1)];
  const toLon = x => map.PROJECTION.lonMin + (x - map.PROJECTION.pad) / (map.PROJECTION.cosLat * map.PROJECTION.scale);
  assert.ok(toLon(west[0]) < -0.38, `west end ${toLon(west[0])}`);
  assert.ok(toLon(east[0]) > 0.17, `east end ${toLon(east[0])}`);
});
