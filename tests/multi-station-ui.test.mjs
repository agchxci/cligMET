import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('page loads station helpers before the main app', () => {
  const station = html.indexOf('station-selection.js');
  const data = html.indexOf('multi-station-data.js');
  const history = html.indexOf('history-navigation.js');
  const main = html.indexOf('app.js');
  assert.ok(station >= 0 && data > station && history > data && main > history);
});

test('page exposes both/single station selector and dual condition/calibration regions', () => {
  assert.match(html, /data-station-selection="both"/);
  assert.match(html, /data-station-selection="ILONDO1066"/);
  assert.match(html, /data-station-selection="ILONDO327"/);
  assert.match(html, /id="dualWeatherOverview"/);
  assert.match(html, /id="dualCalibrationSummary"/);
});

test('main app stores station selection and snapshot map', () => {
  assert.match(app, /snapshots:\s*new Map\(\)/);
  assert.match(app, /stationSelection:/);
  assert.match(app, /getSnapshots:\s*\(\)\s*=>\s*state\.snapshots/);
  assert.match(app, /getSelectedStationIds:/);
});

test('multi-station UI has dedicated responsive styling hooks', () => {
  const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  for (const selector of ['.station-selector', '.dual-current-grid', '.dual-current-card', '.dual-calibration-grid', '.readout-station']) {
    assert.ok(css.includes(selector), `${selector} missing`);
  }
});
