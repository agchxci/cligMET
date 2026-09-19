import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../history-navigation.js', import.meta.url), 'utf8');
const context = { window: {}, console };
vm.createContext(context);
vm.runInContext(code, context);

test('history cache key includes station identity', () => {
  const window = { start: 1, historyEnd: 2, interval: 3 };
  const a = context.window.CligmetHistory.historyRequestKey('ILONDO1066', window);
  const b = context.window.CligmetHistory.historyRequestKey('ILONDO327', window);
  assert.notEqual(a, b);
  assert.equal(a, 'ILONDO1066|1|2|3');
});
