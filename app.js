'use strict';

(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const HOUR = 3600000;
  const COLOURS = { ink: '#111111', muted: '#666666', gridMajor: '#d0d0cd', gridMinor: '#eeeeeb', forecast: '#111111', archived: '#777777', band: '#e2e2df', boundary: '#888888' };
  const $ = id => document.getElementById(id);
  const number = value => {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  };
  const format = (value, digits = 1) => number(value) === null ? '—' : Number(value).toFixed(digits);
  const signed = (value, digits = 1) => number(value) === null ? '—' : `${Number(value) >= 0 ? '+' : '−'}${Math.abs(Number(value)).toFixed(digits)}`;
  const time = value => {
    if (!value || (typeof value !== 'string' && typeof value !== 'number')) return null;
    const result = new Date(value).getTime();
    return Number.isFinite(result) ? result : null;
  };
  const dateLabel = value => time(value) === null ? 'not available' : new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const clockLabel = value => time(value) === null ? '—' : new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const text = (id, value) => { $(id).textContent = value; };
  const list = value => Array.isArray(value) ? value : [];
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'device local time';
  const defaultPreferences = { measured: true, forecast: true, archived: true, range: true };
  let savedPreferences = null;
  try {
    const saved = JSON.parse(localStorage.getItem('cligmet.display.v2'));
    if (saved && typeof saved === 'object') {
      savedPreferences = { ...defaultPreferences };
      for (const key of ['measured', 'forecast', 'archived', 'range']) {
        if (typeof saved[key] === 'boolean') savedPreferences[key] = saved[key];
      }
    }
  } catch { /* The page also works with browser storage disabled. */ }

  const state = {
    snapshot: null,
    loading: false,
    error: null,
    lastAttempt: 0,
    preferences: savedPreferences || { ...defaultPreferences },
    preferencesInitialised: Boolean(savedPreferences),
    charts: new Map(),
    selectedTimes: new Map(),
  };

  const chartDefinitions = [
    { id: 'temperatureChart', key: 'temperature', readout: 'temperatureReadout', name: 'Temperature', unit: '°C', digits: 1, band: true },
    { id: 'pressureChart', key: 'pressure', readout: 'pressureReadout', name: 'Pressure', unit: 'hPa', digits: 1 },
    { id: 'humidityChart', key: 'humidity', readout: 'humidityReadout', name: 'Humidity', unit: '%', digits: 0, minimum: 0, maximum: 100 },
    { id: 'solarChart', key: 'solar_radiation', readout: 'solarReadout', name: 'Solar irradiance', unit: 'W/m²', digits: 0, minimum: 0 },
  ];
  const historyNavigation = window.CligmetHistory.create({
    getSnapshot: () => state.snapshot,
    onChange: () => { renderCharts(); renderCoefficientHistory(); },
  });
  const coefficientDefinitions = {
    station_bias_influence: { label: 'Station influence', scale: 100, unit: '%', digits: 0 },
    temperature_offset: { label: 'Temperature adjustment', scale: 1, unit: '°C', digits: 1 },
    pressure_trend_influence: { label: 'Pressure influence', scale: 100, unit: '%', digits: 0 },
    temperature_responsiveness: { label: 'Temperature responsiveness', scale: 1, unit: '°C/h', digits: 1 },
    local_rain_influence: { label: 'Rain influence', scale: 100, unit: '%', digits: 0 },
  };

  function svgElement(tag, attributes = {}, content) {
    const element = document.createElementNS(NS, tag);
    Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, String(value)));
    if (content !== undefined) element.textContent = content;
    return element;
  }

  function normalisePoints(points, key) {
    const values = new Map();
    list(points).forEach(point => {
      if (!point || typeof point !== 'object') return;
      const timestamp = time(point.timestamp);
      if (timestamp === null) return;
      values.set(timestamp, { t: timestamp, value: number(point[key]), source: point });
    });
    return [...values.values()].sort((a, b) => a.t - b.t);
  }

  function updateStatus() {
    const snapshot = state.snapshot;
    let message, label, status;
    if (!snapshot) {
      status = state.error ? 'error' : 'loading';
      label = state.error ? 'OFFLINE' : 'CONNECTING';
      message = state.error || 'Loading the latest station reading…';
    } else {
      const observation = snapshot.current?.available ? snapshot.current.observation : null;
      const observedAt = time(observation?.timestamp);
      const publishedAt = time(snapshot.generated_at);
      const sourceError = Boolean(snapshot.status?.last_error);
      const referenceTimes = [observedAt, publishedAt].filter(value => value !== null);
      const age = referenceTimes.length ? Math.max(0, Date.now() - Math.min(...referenceTimes)) : null;
      const fresh = age !== null && age <= 15 * 60000 && observedAt !== null && publishedAt !== null;
      status = state.error || sourceError || !fresh ? 'stale' : 'fresh';
      label = status === 'fresh' ? 'LIVE' : 'STALE';
      if (state.error) {
        message = `Couldn’t fetch the latest data. ${observedAt !== null ? `Showing the reading from ${dateLabel(observedAt)}.` : 'Showing the last available snapshot.'} Try Refresh.`;
      } else if (!observation) {
        label = 'NO DATA';
        message = snapshot.settings?.configured === false ? 'The station publisher is not configured yet.' : 'The station has not supplied a current observation. Available history is shown below.';
      } else if (sourceError) {
        message = `Station refresh failed. Showing the stored observation from ${dateLabel(observedAt)}.`;
      } else if (!fresh) {
        message = `Latest observation: ${dateLabel(observedAt)}. ${publishedAt === null ? 'The snapshot timestamp is unavailable.' : `Snapshot published ${dateLabel(publishedAt)}.`} Readings may be out of date.`;
      } else if (snapshot.status?.syncing) {
        message = `Updating station data. Latest observation: ${clockLabel(observedAt)}.`;
      } else {
        message = `Observed ${clockLabel(observedAt)} · published ${clockLabel(publishedAt)} · updates every minute`;
      }
    }
    text('dataBadge', label);
    $('dataBadge').dataset.state = status;
    text('statusLine', message);
    $('statusLine').dataset.state = status;
  }

  function renderObservation() {
    const snapshot = state.snapshot;
    const station = String(snapshot.settings?.station_id || '—');
    text('stationName', `Station ${station}`);
    text('footerStation', `Station ${station} · Weather Underground observations`);
    const latitude = number(snapshot.settings?.latitude ?? snapshot.settings?.lat);
    const longitude = number(snapshot.settings?.longitude ?? snapshot.settings?.lon);
    const position = latitude !== null && longitude !== null ? ` · ${Math.abs(latitude).toFixed(2)}°${latitude >= 0 ? 'N' : 'S'} / ${Math.abs(longitude).toFixed(2)}°${longitude >= 0 ? 'E' : 'W'}` : '';
    text('stationMeta', `STN ${station}${position} · TZ ${localZone.replaceAll('_', ' ').toUpperCase()} · UPDATE 60S`);
    const observation = snapshot.current?.available ? snapshot.current.observation || {} : {};
    text('temperatureValue', format(observation.temperature));
    text('humidityValue', format(observation.humidity, 0));
    text('solarValue', format(observation.solar_radiation, 0));
    text('pressureValue', format(observation.pressure));
    text('windValue', format(observation.wind_speed));
    text('rainValue', format(observation.precip_rate));
    const trend = snapshot.current?.available ? number(snapshot.current?.trends?.change_3h) : null;
    text('pressureTrendValue', signed(trend));
    text('pressureTrendNote', `Pressure change · ${trend === null ? 'unavailable' : trend > .05 ? 'rising' : trend < -.05 ? 'falling' : 'steady'} · 3 h`);
    text('observationTime', time(observation.timestamp) === null ? 'Observation time unavailable' : dateLabel(observation.timestamp));
    const display = snapshot.settings?.display;
    if (!state.preferencesInitialised && display) {
      state.preferences.measured = display.show_measured !== false;
      state.preferences.forecast = display.show_adjusted !== false;
      state.preferences.range = display.show_uncertainty !== false;
      state.preferencesInitialised = true;
      renderPreferences();
    }
    updateStatus();
  }

  function renderCalibration() {
    const calibration = state.snapshot.calibration;
    const metrics = calibration?.metrics || {};
    const controls = calibration?.controls || {};
    text('calibrationMode', !calibration ? 'Unavailable' : calibration.mode === 'auto' ? calibration.paused ? 'Auto calibration paused' : 'Auto calibration' : 'Manual coefficients');
    const minimum = number(metrics.minimum_verified_hours) ?? number(calibration?.minimum_verified_hours) ?? 168;
    const verified = number(metrics.verified_hours);
    const days = number(metrics.calibration_days) ?? number(calibration?.calibration_days);
    let explanation;
    if (!calibration) explanation = 'Calibration results are not included in the current snapshot.';
    else if (calibration.paused) explanation = 'Automatic calibration is paused. The existing coefficients remain in use.';
    else if (calibration.mode !== 'auto') explanation = 'The forecast uses manually selected coefficients. Errors below compare verified temperature forecasts with observations.';
    else if (calibration.status === 'collecting' || (verified !== null && verified < minimum)) explanation = `Collecting verified results: ${format(verified, 0)} of ${minimum} unique hours needed before automatic adjustments begin.`;
    else explanation = `Temperature forecasts are checked against observations${days !== null ? ` over a rolling ${format(days, 0)}-day window` : ''}. Automatic coefficient changes are limited to small daily steps.`;
    text('calibrationStatus', explanation);
    text('verifiedHours', format(verified, 0));
    text('verifiedNote', `${minimum} hours required for calibration`);
    text('cligmetMae', format(metrics.cligmet_mae, 3));
    text('modelMae', format(metrics.model_mae, 3));
    text('improvement', signed(metrics.improvement, 3));
    text('coefficientTemperature', `${signed(controls.temperature_offset)} °C`);
    const percentage = value => number(value) === null ? '—' : `${Math.round(Number(value) * 100)}%`;
    text('coefficientStation', percentage(controls.station_bias_influence));
    text('coefficientPressure', percentage(controls.pressure_trend_influence));
    text('coefficientResponsiveness', `${format(controls.temperature_responsiveness)} °C/h`);
    text('coefficientRain', percentage(controls.local_rain_influence));
    text('calibrationNote', `Last automatic check: ${dateLabel(calibration?.last_run)}. Model settings are managed on the home cligMET dashboard.`);
    renderCoefficientHistory();
  }

  function yBounds(values, definition) {
    let low = definition.minimum ?? Math.min(...values);
    let high = definition.maximum ?? Math.max(...values);
    if (definition.maximum === undefined && high <= low) high = low + Math.max(1, Math.abs(low) * .01);
    const padding = (high - low || 1) * .13;
    if (definition.minimum === undefined) low -= padding;
    if (definition.maximum === undefined) high += padding;
    return { low, high };
  }

  function drawEmpty(svg, width, height, label) {
    const node = svgElement('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', 'font-size': 14, fill: COLOURS.muted }, label);
    svg.append(node);
  }

  function drawTimeTicks(svg, domain, plot, x) {
    const targetCount = Math.max(2, Math.floor(plot.width / 88));
    const step = Math.max(1, Math.ceil((domain.end - domain.start) / HOUR / targetCount)) * HOUR;
    const minorStep = step / 2;
    // One quiet minor division between labelled time ticks keeps the technical grid without visual overload.
    for (let stamp = Math.ceil(domain.start / minorStep) * minorStep; stamp <= domain.end; stamp += minorStep) {
      const isMajor = Math.abs(stamp / step - Math.round(stamp / step)) < 1e-7;
      if (isMajor) continue;
      const xx = x(stamp);
      svg.append(svgElement('line', { x1: xx, x2: xx, y1: plot.top, y2: plot.bottom, stroke: COLOURS.gridMinor, 'stroke-width': .5 }));
    }
    // Epoch-based major ticks keep a consistent real-time scale through clock changes.
    const ticks = [];
    for (let stamp = Math.ceil(domain.start / step) * step; stamp <= domain.end; stamp += step) ticks.push(stamp);
    if (!ticks.length) ticks.push(domain.start);
    ticks.forEach(stamp => {
      const xx = x(stamp);
      svg.append(svgElement('line', { x1: xx, x2: xx, y1: plot.top, y2: plot.bottom, stroke: COLOURS.gridMajor, 'stroke-width': .8 }));
      const anchor = xx < plot.left + 24 ? 'start' : xx > plot.right - 24 ? 'end' : 'middle';
      const label = svgElement('text', { x: xx, y: plot.bottom + 22, 'text-anchor': anchor, fill: COLOURS.muted, 'font-size': 11 });
      const longWindow = domain.end - domain.start > 8 * 24 * HOUR;
      label.append(svgElement('tspan', { x: xx }, longWindow
        ? new Date(stamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
        : new Date(stamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })));
      label.append(svgElement('tspan', { x: xx, dy: 16 }, longWindow
        ? String(new Date(stamp).getFullYear())
        : new Date(stamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })));
      svg.append(label);
    });
  }

  function linePath(points, x, y, maximumGap = 1.75 * HOUR) {
    let drawing = false, previousTime = null;
    return points.map(point => {
      if (point.value === null) { drawing = false; previousTime = null; return ''; }
      const connect = drawing && previousTime !== null && point.t - previousTime <= maximumGap;
      drawing = true;
      previousTime = point.t;
      return `${connect ? 'L' : 'M'}${x(point.t).toFixed(2)},${y(point.value).toFixed(2)}`;
    }).join(' ');
  }

  function addBand(parent, points, x, y, domain) {
    let group = [];
    const flush = () => {
      if (group.length > 1) {
        const upper = group.map((point, index) => `${index ? 'L' : 'M'}${x(point.t)},${y(point.upper)}`).join(' ');
        const lower = [...group].reverse().map(point => `L${x(point.t)},${y(point.lower)}`).join(' ');
        parent.append(svgElement('path', { d: `${upper} ${lower} Z`, fill: COLOURS.band, 'fill-opacity': .45, stroke: 'none' }));
      }
      group = [];
    };
    points.forEach(point => {
      const lower = number(point.source.temperature_lower), upper = number(point.source.temperature_upper);
      if (lower === null || upper === null || lower > upper || point.t < domain.start || point.t > domain.end) { flush(); return; }
      if (group.length && point.t - group.at(-1).t > 1.75 * HOUR) flush();
      group.push({ t: point.t, lower, upper });
    });
    flush();
  }

  function renderChart(definition, domain) {
    const svg = $(definition.id);
    const readout = $(definition.readout);
    svg.replaceChildren();
    const width = Math.max(180, svg.getBoundingClientRect().width);
    const height = svg.getBoundingClientRect().height || 270;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const left = definition.key === 'pressure' ? 62 : 42;
    const plot = { left, right: width - 12, top: 27, bottom: height - 55 };
    plot.width = plot.right - plot.left;
    const snapshot = state.snapshot;
    const clipPoints = points => points.filter(point => point.t >= domain.start && point.t <= domain.end);
    const observed = clipPoints(normalisePoints(domain.observationPoints, definition.key));
    const forecast = clipPoints(normalisePoints(snapshot.forecast?.available ? snapshot.forecast.points : [], definition.key));
    const archived = clipPoints(normalisePoints(snapshot.past_forecast?.available ? snapshot.past_forecast.points : [], definition.key));
    const series = [];
    if (state.preferences.measured) series.push({ label: 'Measured', points: observed, colour: COLOURS.ink, dash: '', interval: domain.interval });
    if (state.preferences.archived) series.push({ label: 'Archived', points: archived, colour: COLOURS.archived, dash: '2 5' });
    if (state.preferences.forecast) series.push({ label: 'Forecast', points: forecast, colour: COLOURS.forecast, dash: '6 4' });
    const useBand = definition.band && state.preferences.range;
    const values = series.flatMap(item => item.points.map(point => point.value)).filter(value => value !== null);
    if (useBand) forecast.forEach(point => {
      const lower = number(point.source.temperature_lower), upper = number(point.source.temperature_upper);
      if (lower !== null && upper !== null && lower <= upper) values.push(lower, upper);
    });
    if (!values.length) {
      const visible = state.preferences.measured || state.preferences.forecast || state.preferences.archived || useBand;
      drawEmpty(svg, width, height, visible ? 'No data in this time window' : 'Select a series above');
      readout.textContent = visible ? 'Missing readings are left blank.' : 'Choose a visible series using the checkboxes above.';
      state.charts.delete(definition.id);
      return;
    }

    const bounds = yBounds(values, definition);
    const x = stamp => plot.left + (stamp - domain.start) / (domain.end - domain.start || 1) * plot.width;
    const y = value => plot.top + (bounds.high - value) / (bounds.high - bounds.low || 1) * (plot.bottom - plot.top);
    const forecastX = Math.max(plot.left, Math.min(plot.right, x(domain.boundary)));
    const horizontalDivisions = 8;
    for (let i = 0; i <= horizontalDivisions; i++) {
      const value = bounds.low + (bounds.high - bounds.low) * i / horizontalDivisions;
      const yy = y(value);
      const major = i % 2 === 0;
      svg.append(svgElement('line', { x1: plot.left, x2: plot.right, y1: yy, y2: yy, stroke: major ? COLOURS.gridMajor : COLOURS.gridMinor, 'stroke-width': major ? .8 : .5 }));
      if (major) {
        const digits = definition.key === 'pressure' || bounds.high - bounds.low < 5 ? 1 : 0;
        svg.append(svgElement('text', { x: plot.left - 8, y: yy + 4, 'text-anchor': 'end', fill: COLOURS.muted, 'font-size': 11 }, format(value, digits)));
      }
    }
    drawTimeTicks(svg, domain, plot, x);
    const defs = svgElement('defs');
    const clip = svgElement('clipPath', { id: `${definition.id}-clip` });
    clip.append(svgElement('rect', { x: plot.left - 1, y: plot.top - 2, width: plot.width + 2, height: plot.bottom - plot.top + 4 }));
    defs.append(clip);
    svg.append(defs);
    const lines = svgElement('g', { 'clip-path': `url(#${definition.id}-clip)` });
    if (useBand) addBand(lines, forecast, x, y, domain);
    series.forEach(item => {
      const maximumGap = (item.interval || 1) * 1.75 * HOUR;
      lines.append(svgElement('path', { d: linePath(item.points, x, y, maximumGap), fill: 'none', stroke: item.colour, 'stroke-width': item.label === 'Archived' ? 1.7 : 2.2, 'stroke-dasharray': item.dash, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      const valid = item.points.filter(point => point.value !== null);
      valid.forEach((point, index) => {
        const prev = valid[index - 1], next = valid[index + 1];
        if ((!prev || point.t - prev.t > maximumGap) && (!next || next.t - point.t > maximumGap)) {
          lines.append(svgElement('circle', { cx: x(point.t), cy: y(point.value), r: 2.8, fill: item.colour }));
        }
      });
    });
    svg.append(lines);
    if (forecastX > plot.left + 2) svg.append(svgElement('line', { x1: forecastX, x2: forecastX, y1: plot.top, y2: plot.bottom, stroke: COLOURS.boundary, 'stroke-width': 1.2, 'stroke-dasharray': '2 3' }));
    if (plot.right - forecastX > 48) svg.append(svgElement('text', { x: Math.min(forecastX + 6, plot.right - 48), y: 15, fill: COLOURS.muted, 'font-size': 10, 'letter-spacing': 1.1 }, 'FCST'));
    const guide = svgElement('g', { visibility: 'hidden', 'aria-hidden': 'true' });
    const guideLine = svgElement('line', { y1: plot.top, y2: plot.bottom, stroke: '#7a7a7a', 'stroke-width': 1, 'stroke-dasharray': '3 3' });
    guide.append(guideLine);
    svg.append(guide);
    const timeline = [...new Set(series.flatMap(item => item.points.filter(point => point.value !== null).map(point => point.t)).concat(useBand ? forecast.filter(point => number(point.source.temperature_lower) !== null && number(point.source.temperature_upper) !== null).map(point => point.t) : []))].sort((a, b) => a - b);
    const data = { definition, domain, plot, width, x, y, series, forecast, useBand, timeline, guide, guideLine };
    state.charts.set(definition.id, data);
    readout.textContent = `${domain.interval === 24 ? 'Daily means' : domain.interval === 3 ? '3-hour means' : 'Hourly readings'} · hover, tap or use arrow keys for values`;
    const selectedTime = state.selectedTimes.get(definition.id);
    if (selectedTime !== undefined && timeline.includes(selectedTime)) inspectChart(data, selectedTime, false);
    else state.selectedTimes.delete(definition.id);
  }

  function inspectChart(data, selectedTime, announce) {
    const { definition, series, forecast, useBand, guide, guideLine, x, y } = data;
    state.selectedTimes.set(definition.id, selectedTime);
    guide.setAttribute('visibility', 'visible');
    guideLine.setAttribute('x1', x(selectedTime));
    guideLine.setAttribute('x2', x(selectedTime));
    while (guide.children.length > 1) guide.lastChild.remove();
    const readout = $(definition.readout);
    readout.replaceChildren();
    const heading = document.createElement('strong');
    heading.className = 'readout-time';
    heading.textContent = dateLabel(selectedTime);
    const values = document.createElement('span');
    values.className = 'readout-values';
    const parts = [];
    series.forEach(item => {
      const point = item.points.find(candidate => candidate.t === selectedTime && candidate.value !== null);
      if (!point) return;
      const count = number(point.source?.sample_counts?.[definition.key]);
      const coverage = item.label === 'Measured' && item.interval > 1 && count !== null ? ` (${count}/${item.interval} hours)` : '';
      const phrase = `${item.label}: ${format(point.value, definition.digits)} ${definition.unit}${coverage}`;
      parts.push(phrase);
      const element = document.createElement('span');
      element.textContent = phrase;
      values.append(element);
      guide.append(svgElement('circle', { cx: x(point.t), cy: y(point.value), r: 3.7, fill: '#fff', stroke: item.colour, 'stroke-width': 2 }));
    });
    if (useBand) {
      const point = forecast.find(candidate => candidate.t === selectedTime);
      if (point && number(point.source.temperature_lower) !== null && number(point.source.temperature_upper) !== null && Number(point.source.temperature_lower) <= Number(point.source.temperature_upper)) {
        const phrase = `Range: ${format(point.source.temperature_lower)}–${format(point.source.temperature_upper)} °C`;
        parts.push(phrase);
        const element = document.createElement('span');
        element.textContent = phrase;
        values.append(element);
      }
    }
    readout.append(heading, values);
    if (announce) text('chartAnnouncement', `${definition.name}, ${heading.textContent}. ${parts.join('. ')}`);
  }

  function renderCharts() {
    if (!state.snapshot) return;
    chartDefinitions.forEach(definition => renderChart(definition, historyNavigation.view(definition.id.replace('Chart', ''))));
    const snapshot = state.snapshot;
    const parts = ['Each plot has its own history window; aggregation is shown above it.'];
    if (snapshot.forecast?.available) parts.push(`Forecast issued ${dateLabel(snapshot.forecast.issued_at)}.`);
    else parts.push('The current forecast is unavailable.');
    if (snapshot.past_forecast?.available && state.preferences.archived) parts.push(`Archived forecast issued ${dateLabel(snapshot.past_forecast.issued_at)}.`);
    text('forecastNote', parts.join(' '));
    text('timezoneNote', `All times: ${localZone.replaceAll('_', ' ')}.`);
  }

  function renderCoefficientHistory() {
    if (!$('modelDetails').open) return;
    const svg = $('coefficientChart');
    const key = $('coefficientSelect').value;
    const definition = coefficientDefinitions[key];
    const view = historyNavigation.coefficientView();
    const history = list(view.history).flatMap(item => {
      const timestamp = time(item?.timestamp), value = number(item?.controls?.[key]);
      return timestamp === null || value === null ? [] : [{ t: timestamp, value: value * definition.scale }];
    }).sort((a, b) => a.t - b.t);
    svg.replaceChildren();
    const width = Math.max(180, svg.getBoundingClientRect().width), height = 250;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    if (!history.length) {
      drawEmpty(svg, width, height, 'No coefficient history yet');
      text('coefficientDescription', 'No saved snapshots are available for this coefficient.');
      return;
    }
    const first = history[0], last = history.at(-1);
    const bounds = yBounds(history.map(point => point.value), {});
    const left = 58, right = width - 15, top = 25, bottom = height - 44;
    const x = stamp => left + (stamp - view.start) / (view.end - view.start || 1) * (right - left);
    const y = value => top + (bounds.high - value) / (bounds.high - bounds.low || 1) * (bottom - top);
    for (let i = 0; i <= 6; i++) {
      const xx = left + (right - left) * i / 6;
      const major = i % 2 === 0;
      svg.append(svgElement('line', { x1: xx, x2: xx, y1: top, y2: bottom, stroke: major ? COLOURS.gridMajor : COLOURS.gridMinor, 'stroke-width': major ? .8 : .5 }));
    }
    const coefficientHorizontalDivisions = 8;
    for (let i = 0; i <= coefficientHorizontalDivisions; i++) {
      const value = bounds.low + (bounds.high - bounds.low) * i / coefficientHorizontalDivisions;
      const yy = y(value);
      const major = i % 2 === 0;
      svg.append(svgElement('line', { x1: left, x2: right, y1: yy, y2: yy, stroke: major ? COLOURS.gridMajor : COLOURS.gridMinor, 'stroke-width': major ? .8 : .5 }));
      if (major) svg.append(svgElement('text', { x: left - 8, y: yy + 4, 'text-anchor': 'end', 'font-size': 11, fill: COLOURS.muted }, `${format(value, definition.digits)}${definition.unit === '%' ? '%' : ''}`));
    }
    // Coefficients stay constant between saved changes, so use a step line.
    const path = history.map((point, index) => index ? `H${x(point.t)} V${y(point.value)}` : `M${x(point.t)},${y(point.value)}`).join(' ');
    svg.append(svgElement('path', { d: path, fill: 'none', stroke: COLOURS.forecast, 'stroke-width': 2 }));
    history.forEach(point => {
      const dot = svgElement('circle', { cx: x(point.t), cy: y(point.value), r: 3, fill: '#fff', stroke: COLOURS.forecast, 'stroke-width': 1.7 });
      dot.append(svgElement('title', {}, `${dateLabel(point.t)}: ${format(point.value, definition.digits)} ${definition.unit}`));
      svg.append(dot);
    });
    svg.append(svgElement('text', { x: left, y: height - 13, 'font-size': 12, fill: COLOURS.muted }, new Date(view.start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })));
    svg.append(svgElement('text', { x: right, y: height - 13, 'text-anchor': 'end', 'font-size': 12, fill: COLOURS.muted }, new Date(view.end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })));
    text('coefficientDescription', `${definition.label}: ${format(first.value, definition.digits)} ${definition.unit} at the first known point in this window; ${format(last.value, definition.digits)} ${definition.unit} at the end. ${view.savedCount} saved changes in this window. Values carry forward between changes.`);
  }

  function renderPreferences() {
    $('showMeasured').checked = state.preferences.measured;
    $('showForecast').checked = state.preferences.forecast;
    $('showArchived').checked = state.preferences.archived;
    $('showRange').checked = state.preferences.range;
  }

  function savePreferences() {
    state.preferences = { measured: $('showMeasured').checked, forecast: $('showForecast').checked, archived: $('showArchived').checked, range: $('showRange').checked };
    state.preferencesInitialised = true;
    try { localStorage.setItem('cligmet.display.v2', JSON.stringify(state.preferences)); } catch { /* Optional, device-local display preferences only. */ }
    renderCharts();
  }

  async function loadSnapshot() {
    if (state.loading) return;
    state.loading = true;
    state.lastAttempt = Date.now();
    $('refreshButton').disabled = true;
    $('refreshButton').setAttribute('aria-busy', 'true');
    $('weatherOverview').setAttribute('aria-busy', 'true');
    text('refreshLabel', 'Refreshing');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const configuredURL = String(window.CLIGMET_SNAPSHOT_URL || '').trim();
      if (!configuredURL || configuredURL.includes('YOUR-CLIGMET')) throw new Error('configuration');
      const url = new URL(configuredURL, window.location.href);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('configuration');
      const response = await fetch(url, { method: 'GET', cache: 'no-store', credentials: 'omit', signal: controller.signal });
      if (!response.ok) throw new Error('service');
      const snapshot = await response.json();
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !snapshot.settings || !snapshot.current || !snapshot.history || !snapshot.forecast) throw new Error('invalid-data');
      state.snapshot = snapshot;
      state.error = null;
      historyNavigation.refreshed();
      renderObservation();
      renderCharts();
      renderCalibration();
    } catch (error) {
      state.error = error.message === 'configuration' ? 'The public weather feed has not been configured.' : 'The weather feed is unavailable. Use Refresh to try again.';
      updateStatus();
      if (!state.snapshot) {
        chartDefinitions.forEach(definition => {
          const svg = $(definition.id);
          svg.replaceChildren();
          const width = Math.max(180, svg.getBoundingClientRect().width), height = svg.getBoundingClientRect().height || 270;
          svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
          drawEmpty(svg, width, height, 'Waiting for weather data');
          text(definition.readout, 'Use Refresh to try the weather feed again.');
        });
        text('calibrationStatus', 'Calibration results will appear when the weather feed is available.');
      }
    } finally {
      clearTimeout(timeout);
      state.loading = false;
      $('refreshButton').disabled = false;
      $('refreshButton').setAttribute('aria-busy', 'false');
      $('weatherOverview').setAttribute('aria-busy', 'false');
      text('refreshLabel', 'Refresh');
    }
  }

  function bindChartInteraction(definition) {
    const svg = $(definition.id);
    const inspectPointer = event => {
      if (event.type === 'pointermove' && event.pointerType === 'touch') return;
      const data = state.charts.get(definition.id);
      if (!data?.timeline.length) return;
      const rect = svg.getBoundingClientRect();
      const pointerX = (event.clientX - rect.left) / rect.width * data.width;
      const target = data.domain.start + (pointerX - data.plot.left) / data.plot.width * (data.domain.end - data.domain.start);
      const nearest = data.timeline.reduce((best, candidate) => Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best);
      inspectChart(data, nearest, event.type === 'pointerdown');
    };
    svg.addEventListener('pointermove', inspectPointer);
    svg.addEventListener('pointerdown', inspectPointer);
    svg.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
      const data = state.charts.get(definition.id);
      if (!data?.timeline.length) return;
      event.preventDefault();
      if (event.key === 'Escape') {
        state.selectedTimes.delete(definition.id);
        renderChart(definition, data.domain);
        text('chartAnnouncement', `${definition.name}: selection cleared.`);
        return;
      }
      let index = data.timeline.indexOf(state.selectedTimes.get(definition.id));
      if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = data.timeline.length - 1;
      else if (event.key === 'ArrowRight') index = Math.min(data.timeline.length - 1, index + 1);
      else index = index < 0 ? data.timeline.length - 1 : Math.max(0, index - 1);
      inspectChart(data, data.timeline[index], true);
    });
  }

  renderPreferences();
  text('todayLabel', new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }));
  ['showMeasured', 'showForecast', 'showArchived', 'showRange'].forEach(id => $(id).addEventListener('change', savePreferences));
  ['temperature', 'pressure', 'humidity', 'solar', 'coefficient'].forEach(id => historyNavigation.bind(id));
  $('refreshButton').addEventListener('click', loadSnapshot);
  $('coefficientSelect').addEventListener('change', renderCoefficientHistory);
  $('modelDetails').addEventListener('toggle', renderCoefficientHistory);
  chartDefinitions.forEach(bindChartInteraction);
  let resizeFrame;
  const resize = () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => { renderCharts(); renderCoefficientHistory(); });
  };
  if ('ResizeObserver' in window) {
    let previousWidth = 0;
    new ResizeObserver(entries => {
      const width = entries[0].contentRect.width;
      if (Math.abs(width - previousWidth) < 1) return;
      previousWidth = width;
      resize();
    }).observe(document.querySelector('.charts-grid'));
  } else window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.lastAttempt > 60000) loadSnapshot();
  });
  window.addEventListener('online', loadSnapshot);
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      text('todayLabel', new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }));
      loadSnapshot();
    }
  }, 60000);
  loadSnapshot();
})();
