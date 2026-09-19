import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../station-selection.js', import.meta.url), 'utf8');
const context = { window: { location: { href: 'https://cligmet.xyz/' } }, URL };
vm.createContext(context);
vm.runInContext(code, context);
const stations = context.window.CligmetStations;

test('defaults invalid selection to both', () => {
  assert.equal(stations.normaliseSelection(null), 'both');
  assert.equal(stations.normaliseSelection('INVALID'), 'both');
});

test('preserves configured station choices', () => {
  assert.equal(stations.normaliseSelection('both'), 'both');
  assert.equal(stations.normaliseSelection('ILONDO1066'), 'ILONDO1066');
  assert.equal(stations.normaliseSelection('ILONDO327'), 'ILONDO327');
});

test('builds station-specific snapshot and discovery URLs', () => {
  const base = 'https://cligmet-render-receiver.onrender.com/snapshot.json';
  assert.equal(
    stations.snapshotUrl(base, 'ILONDO327').toString(),
    'https://cligmet-render-receiver.onrender.com/snapshot.json?station_id=ILONDO327'
  );
  assert.equal(
    stations.stationsUrl(base).toString(),
    'https://cligmet-render-receiver.onrender.com/stations.json'
  );
});

test('keeps successful snapshots when the other station fails', () => {
  const results = [
    { status: 'fulfilled', value: ['ILONDO1066', { settings: { station_id: 'ILONDO1066' } }] },
    { status: 'rejected', reason: new Error('offline') },
  ];
  const map = stations.fulfilledSnapshots(results);
  assert.equal(map.size, 1);
  assert.equal(map.get('ILONDO1066').settings.station_id, 'ILONDO1066');
});
