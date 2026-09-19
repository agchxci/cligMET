import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('fullscreen chart readout overlays the plot and flips away from the crosshair', () => {
  assert.match(app, /function positionFullscreenReadout\(/);
  assert.match(app, /classList\.toggle\('overlay-left'/);
  assert.match(app, /classList\.toggle\('overlay-right'/);
  assert.match(app, /positionFullscreenReadout\(data, selectedTime\)/);
  assert.match(css, /\.chart-card\.is-fullscreen \.chart-readout\s*\{[^}]*position:\s*absolute/s);
  assert.match(css, /\.chart-card\.is-fullscreen \.readout-values span\s*\{[^}]*font-size:\s*clamp\(/s);
  assert.match(css, /background:\s*rgba\(255,\s*255,\s*255,/);
});
