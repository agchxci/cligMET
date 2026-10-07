import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = { window: {}, URL };
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL('../station-map.js', import.meta.url), 'utf8'), context);
vm.runInContext(fs.readFileSync(new URL('../station-radar.js', import.meta.url), 'utf8'), context);
const radar = context.window.CligmetRadar;
const map = context.window.CligmetStationMap;
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('radar colours convert to rain rates and ink strength', () => {
  assert.ok(Math.abs(radar.rateFromDbz(20) - 0.65) < 0.02);
  assert.ok(Math.abs(radar.rateFromDbz(40) - 11.5) < 0.2);
  assert.equal(radar.rateFromColour(0, 0, 0, 0), 0);
  assert.equal(radar.rateFromColour(0x00, 0xa3, 0xe0, 0xff), radar.rateFromDbz(20));
  assert.equal(radar.rateFromColour(0xff, 0xaa, 0x00, 0xff), radar.rateFromDbz(40));
  assert.equal(radar.alphaForRate(0.05), 0);
  assert.ok(Math.abs(radar.alphaForRate(0.1) - 0.14) < 1e-9);
  assert.ok(Math.abs(radar.alphaForRate(200) - 0.8) < 1e-9);
  const rates = [0.2, 1, 4, 16, 45];
  rates.slice(1).forEach((rate, i) => assert.ok(radar.alphaForRate(rate) > radar.alphaForRate(rates[i])));
});

test('rain map covers exactly the London outline image', () => {
  const extent = radar.mapExtent(map.PROJECTION);
  const nw = map.project(extent.north, extent.west), se = map.project(extent.south, extent.east);
  assert.ok(Math.abs(nw.x) < 1e-6 && Math.abs(nw.y) < 1e-6);
  assert.ok(Math.abs(se.x - 100) < 1e-6 && Math.abs(se.y - 100) < 1e-6);
  const { tiles } = radar.radarTiles(extent);
  assert.equal(JSON.stringify(tiles.map(tile => [tile.x, tile.y])), '[[63,42],[64,42]]');
  const frame = radar.latestRadarFrame({ host: 'https://tilecache.rainviewer.com', radar: { past: [{ time: 1, path: '/v2/radar/1' }, { time: 2, path: '/v2/radar/2' }] } });
  assert.equal(frame.time, 2000);
  assert.equal(radar.tileUrl(frame, tiles[0]), 'https://tilecache.rainviewer.com/v2/radar/2/512/7/63/42/2/1_0.png');
  assert.equal(radar.latestRadarFrame({ radar: { past: [] } }), null);
});

test('forecast grid requests every point and yields four hours of 15-minute frames', () => {
  const extent = radar.mapExtent(map.PROJECTION);
  const points = radar.gridPoints(extent);
  assert.equal(points.length, radar.GRID.cols * radar.GRID.rows);
  assert.deepEqual([points[0].latitude, points[0].longitude], [+extent.north.toFixed(4), +extent.west.toFixed(4)]);
  const url = radar.forecastUrl(points);
  assert.equal(url.searchParams.get('latitude').split(',').length, points.length);
  assert.equal(url.searchParams.get('minutely_15'), 'precipitation');

  const now = Date.UTC(2026, 9, 7, 21, 7);
  const start = Date.UTC(2026, 9, 7, 21, 0) / 1000;
  const times = Array.from({ length: 20 }, (_, i) => start + i * 900);
  const payload = points.map((_, p) => ({ minutely_15: { time: times, precipitation: times.map((_, i) => (p === 0 && i === 2 ? 0.5 : 0)) } }));
  const frames = radar.forecastFrames(payload, now);
  assert.equal(frames.length, radar.FORECAST_STEPS);
  assert.ok(frames.every(frame => frame.time > now && frame.time <= now + 4 * 3600000 + 60000));
  assert.equal(frames[0].time, (start + 900) * 1000);
  assert.equal(frames[1].rates[0], 2); // 0.5 mm in 15 minutes = 2 mm/h
  assert.equal(radar.forecastFrames(payload.slice(1), now).length, 0);
});

test('timeline labels say whether a frame is radar or forecast', () => {
  const now = Date.UTC(2026, 9, 7, 21, 0);
  assert.match(radar.frameLabel({ kind: 'radar', time: now - 600000 }, now), /^RADAR \d\d:\d\d$/);
  assert.match(radar.frameLabel({ kind: 'forecast', time: now + 45 * 60000 }, now), /^FORECAST \d\d:\d\d · \+45M$/);
  assert.match(radar.frameLabel({ kind: 'forecast', time: now + 60 * 60000 }, now), / · \+1H$/);
  assert.match(radar.frameLabel({ kind: 'forecast', time: now + 90 * 60000 }, now), / · \+1H30$/);
  assert.equal(radar.frameLabel(undefined, now), 'RAIN MAP UNAVAILABLE');
});

test('page includes the rain layer and timeline in the map', () => {
  const map = html.indexOf('station-map.js'), rain = html.indexOf('station-radar.js'), main = html.indexOf('src="app.js"');
  assert.ok(map >= 0 && rain > map && main > rain);
  for (const id of ['stationRadar', 'radarTime', 'radarPlay', 'radarReadout']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /RainViewer/);
  assert.match(html, /Open-Meteo/);
});
