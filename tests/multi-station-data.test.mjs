import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../multi-station-data.js', import.meta.url), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(code, context);
const data = context.window.CligmetMultiStation;

test('both selection returns both configured stations', () => {
  assert.deepEqual(Array.from(data.selectedIds('both')), ['ILONDO1066','ILONDO327']);
  assert.deepEqual(Array.from(data.selectedIds('ILONDO327')), ['ILONDO327']);
});

test('current rows preserve independent station values', () => {
  const snapshots = new Map([
    ['ILONDO1066', {current:{available:true,observation:{temperature:10}}}],
    ['ILONDO327', {current:{available:true,observation:{temperature:30}}}],
  ]);
  const rows = Array.from(data.currentRows(snapshots, 'both'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].observation.temperature, 10);
  assert.equal(rows[1].observation.temperature, 30);
});

test('series sources retain station and data type identity', () => {
  const snapshots = new Map([
    ['ILONDO1066', {forecast:{available:true,points:[{timestamp:'2026-09-19T12:00:00Z',temperature:11}]},past_forecast:{available:true,points:[]}}],
    ['ILONDO327', {forecast:{available:true,points:[{timestamp:'2026-09-19T12:00:00Z',temperature:31}]},past_forecast:{available:true,points:[]}}],
  ]);
  const histories = new Map([
    ['ILONDO1066', [{timestamp:'2026-09-19T11:00:00Z',temperature:10}]],
    ['ILONDO327', [{timestamp:'2026-09-19T11:00:00Z',temperature:30}]],
  ]);
  const series = Array.from(data.seriesSources(snapshots, histories, 'both', {measured:true,forecast:true,archived:true}));
  assert.deepEqual(series.map(x => `${x.stationId}:${x.kind}`), [
    'ILONDO1066:observed','ILONDO1066:archived','ILONDO1066:forecast',
    'ILONDO327:observed','ILONDO327:archived','ILONDO327:forecast',
  ]);
  assert.equal(series[0].points[0].temperature, 10);
  assert.equal(series[3].points[0].temperature, 30);
});


test('both mode keeps a missing station visible instead of silently dropping it', () => {
  const snapshots = new Map([
    ['ILONDO1066', {current:{available:true,observation:{temperature:10}}}],
  ]);
  const rows = Array.from(data.currentRows(snapshots, 'both'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].stationId, 'ILONDO1066');
  assert.equal(rows[1].stationId, 'ILONDO327');
  assert.equal(rows[1].snapshot, null);
  assert.equal(rows[1].observation, null);
});
