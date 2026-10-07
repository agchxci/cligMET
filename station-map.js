'use strict';

window.CligmetStationMap = (() => {
  // Must match london-outline.svg (data-projection), produced by
  // tools/build_london_outline.py. tests/station-map.test.mjs checks this.
  const PROJECTION = Object.freeze({ lonMin: -0.510375, latMax: 51.691874, cosLat: 0.622661, scale: 1825.8979, pad: 20, width: 1000, height: 780 });
  const KM_PER_DEGREE = 111.32;
  const SCALE_BAR_KM = 5;

  // Positions as published on each station's Weather Underground page.
  const STATIONS = Object.freeze({
    ILONDO1066: Object.freeze({ name: 'cligMET_N1', latitude: 51.534, longitude: -0.093 }),
    ILONDO327: Object.freeze({ name: 'cligCAST', latitude: 51.57, longitude: -0.05 }),
  });

  function project(latitude, longitude) {
    const x = PROJECTION.pad + (longitude - PROJECTION.lonMin) * PROJECTION.cosLat * PROJECTION.scale;
    const y = PROJECTION.pad + (PROJECTION.latMax - latitude) * PROJECTION.scale;
    return { x: x / PROJECTION.width * 100, y: y / PROJECTION.height * 100 };
  }

  function scaleBarPercent(km = SCALE_BAR_KM) {
    return km / KM_PER_DEGREE * PROJECTION.scale / PROJECTION.width * 100;
  }

  function distanceKm(a, b) {
    const radians = degrees => degrees * Math.PI / 180;
    const dLat = radians(b.latitude - a.latitude);
    const dLon = radians(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
  }

  function coordinateLabel(latitude, longitude) {
    return `${Math.abs(latitude).toFixed(2)}°${latitude >= 0 ? 'N' : 'S'} ${Math.abs(longitude).toFixed(2)}°${longitude >= 0 ? 'E' : 'W'}`;
  }

  // reading: { temperature, state } for a loaded station, or undefined when
  // the station is not part of the current selection. A temperature that is
  // not live carries a flag so an old reading is never shown as current.
  function readingParts(reading) {
    if (!reading) return { value: '', flag: '' };
    const known = typeof reading.temperature === 'number' && Number.isFinite(reading.temperature);
    const value = known ? `${reading.temperature.toFixed(1)}°` : '—';
    const flag = known && reading.state !== 'fresh' ? String(reading.state || 'stale').toUpperCase() : '';
    return { value, flag };
  }

  function readingLabel(reading) {
    const { value, flag } = readingParts(reading);
    return [value, flag].filter(Boolean).join(' ');
  }

  function selectStation(stationId) {
    const button = document.querySelector(`.station-selector [data-station-selection="${stationId}"]`);
    if (button && !button.disabled) button.click();
  }

  function init() {
    const map = document.getElementById('stationMap');
    if (!map) return;
    map.querySelectorAll('[data-map-station]').forEach(marker => {
      const station = STATIONS[marker.dataset.mapStation];
      if (!station) return;
      const { x, y } = project(station.latitude, station.longitude);
      marker.style.left = `${x}%`;
      marker.style.top = `${y}%`;
      marker.addEventListener('click', () => selectStation(marker.dataset.mapStation));
    });
    const scale = document.getElementById('stationMapScale');
    if (scale) scale.style.width = `${scaleBarPercent()}%`;
    document.querySelectorAll('[data-station-coordinates]').forEach(element => {
      const station = STATIONS[element.dataset.stationCoordinates];
      if (station) element.textContent = coordinateLabel(station.latitude, station.longitude);
    });
    const separation = document.getElementById('stationSeparation');
    if (separation) separation.textContent = `${distanceKm(STATIONS.ILONDO1066, STATIONS.ILONDO327).toFixed(1)} km`;
  }

  function update(selection, readings = new Map()) {
    const map = document.getElementById('stationMap');
    if (!map) return;
    map.dataset.selection = selection;
    map.querySelectorAll('[data-map-station]').forEach(marker => {
      const stationId = marker.dataset.mapStation;
      const active = selection === 'both' || selection === stationId;
      marker.dataset.active = String(active);
      marker.setAttribute('aria-pressed', String(selection === stationId));
      const { value, flag } = readingParts(readings.get(stationId));
      const reading = marker.querySelector('.map-reading');
      const state = marker.querySelector('.map-state');
      if (reading) reading.textContent = value;
      if (state) state.textContent = flag;
    });
  }

  if (typeof document !== 'undefined') init();

  return { PROJECTION, STATIONS, project, scaleBarPercent, distanceKm, coordinateLabel, readingLabel, update };
})();
