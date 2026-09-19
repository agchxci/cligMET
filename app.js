'use strict';

(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const HOUR = 3600000;
  const COLOURS = { ink: '#111111', muted: '#666666', gridMajor: '#d0d0cd', gridMinor: '#eeeeeb', forecast: '#111111', archived: '#777777', band: '#e2e2df', boundary: '#888888', stations: { ILONDO1066: '#111111', ILONDO327: '#9b5b40' } };
  const DASH = { observed: '', forecast: '7 4', archived: '2 5' };
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
  const shortDate = value => time(value) === null ? '—' : new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
  const clockLabel = value => time(value) === null ? '—' : new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const dateLabel = value => time(value) === null ? '—' : `${shortDate(value)} ${clockLabel(value)}`;
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

  let savedStationSelection = null;
  try { savedStationSelection = localStorage.getItem('cligmet.station.v1'); } catch { /* Optional device preference. */ }

  const state = {
    snapshot: null,
    snapshots: new Map(),
    stations: null,
    stationSelection: window.CligmetStations.normaliseSelection(savedStationSelection),
    compatibilityMode: false,
    loading: false,
    error: null,
    lastAttempt: 0,
    preferences: savedPreferences || { ...defaultPreferences },
    preferencesInitialised: Boolean(savedPreferences),
    charts: new Map(),
    selectedTimes: new Map(),
  };

  function selectedStationIds() {
    return window.CligmetMultiStation.selectedIds(state.stationSelection);
  }

  function selectedSnapshots() {
    return selectedStationIds()
      .map(stationId => [stationId, state.snapshots.get(stationId)])
      .filter(([, snapshot]) => Boolean(snapshot));
  }

  function firstSelectedSnapshot() {
    return selectedSnapshots()[0]?.[1] || state.snapshot || null;
  }

  const chartDefinitions = [
    { id: 'temperatureChart', key: 'temperature', readout: 'temperatureReadout', name: 'Temperature', unit: '°C', digits: 1, band: true },
    { id: 'pressureChart', key: 'pressure', readout: 'pressureReadout', name: 'Pressure', unit: 'hPa', digits: 1 },
    { id: 'humidityChart', key: 'humidity', readout: 'humidityReadout', name: 'Humidity', unit: '%', digits: 0, minimum: 0, maximum: 100 },
    { id: 'solarChart', key: 'solar_radiation', readout: 'solarReadout', name: 'Solar irradiance', unit: 'W/m²', digits: 0, minimum: 0 },
  ];
  const historyNavigation = window.CligmetHistory.create({
    getSnapshot: () => firstSelectedSnapshot(),
    getSnapshots: () => state.snapshots,
    getSelectedStationIds: selectedStationIds,
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

  function stationFreshness(snapshot) {
    const observation = snapshot?.current?.available ? snapshot.current.observation : null;
    const observedAt = time(observation?.timestamp);
    const publishedAt = time(snapshot?.generated_at);
    const sourceError = Boolean(snapshot?.status?.last_error);
    const referenceTimes = [observedAt, publishedAt].filter(value => value !== null);
    const age = referenceTimes.length ? Math.max(0, Date.now() - Math.min(...referenceTimes)) : null;
    const fresh = age !== null && age <= 15 * 60000 && observedAt !== null && publishedAt !== null && !sourceError;
    return {
      state: !snapshot ? 'missing' : fresh ? 'fresh' : 'stale',
      label: !snapshot ? 'NO DATA' : fresh ? 'LIVE' : 'STALE',
      observedAt,
      sourceError,
    };
  }

  function renderStationSelector() {
    document.querySelectorAll('[data-station-selection]').forEach(button => {
      const active = button.dataset.stationSelection === state.stationSelection;
      button.setAttribute('aria-pressed', String(active));
      button.disabled = state.compatibilityMode && !active;
    });
  }

  function renderDualObservationCard(stationId, snapshot) {
    const observation = snapshot?.current?.available ? snapshot.current.observation || {} : {};
    const trend = snapshot?.current?.available ? number(snapshot.current?.trends?.change_3h) : null;
    const freshness = stationFreshness(snapshot);
    const card = document.createElement('article');
    card.className = 'dual-current-card';
    card.dataset.station = stationId;

    const heading = document.createElement('header');
    heading.className = 'dual-current-heading';
    const title = document.createElement('strong');
    title.textContent = stationId;
    const badge = document.createElement('span');
    badge.className = 'status-badge';
    badge.dataset.state = freshness.state;
    badge.textContent = freshness.label;
    heading.append(title, badge);

    const temperature = document.createElement('div');
    temperature.className = 'dual-temperature';
    temperature.innerHTML = `<span>${format(observation.temperature)}</span><span class="large-unit">°C</span>`;

    const stamp = document.createElement('p');
    stamp.className = 'reading-time';
    stamp.textContent = dateLabel(observation.timestamp);

    const rows = document.createElement('dl');
    rows.className = 'dual-measurements';
    const measurements = [
      ['RH', `${format(observation.humidity, 0)} %`],
      ['PRES', `${format(observation.pressure)} hPa`],
      ['ΔP3H', `${signed(trend)} hPa`],
      ['WIND', `${format(observation.wind_speed)} km/h`],
      ['RAIN', `${format(observation.precip_rate)} mm/h`],
      ['SOL', `${format(observation.solar_radiation, 0)} W/m²`],
    ];
    measurements.forEach(([label, value]) => {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      row.append(dt, dd);
      rows.append(row);
    });
    card.append(heading, temperature, stamp, rows);
    return card;
  }

  function updateStatus() {
    const snapshot = state.snapshot;
    let message, label, status;
    if (!snapshot) {
      status = state.error ? 'error' : 'loading';
      label = state.error ? 'OFFLINE' : 'CONNECTING';
      message = state.error ? 'OFFLINE' : '';
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
        message = observedAt !== null ? `OFFLINE · ${dateLabel(observedAt)}` : 'OFFLINE';
      } else if (!observation) {
        label = 'NO DATA';
        message = 'NO DATA';
      } else if (sourceError) {
        message = `SYNC ERROR · ${dateLabel(observedAt)}`;
      } else if (!fresh) {
        message = `STALE · ${dateLabel(observedAt)}`;
      } else if (snapshot.status?.syncing) {
        message = `SYNC · ${clockLabel(observedAt)}`;
      } else {
        message = '';
      }
    }
    text('dataBadge', label);
    $('dataBadge').dataset.state = status;
    text('statusLine', message);
    $('statusLine').dataset.state = status;
  }

  function renderObservation() {
    renderStationSelector();
    const both = state.stationSelection === 'both' && !state.compatibilityMode;
    const dual = $('dualWeatherOverview');
    const single = $('weatherOverview');

    if (both) {
      single.hidden = true;
      dual.hidden = false;
      dual.replaceChildren();
      const rows = window.CligmetMultiStation.currentRows(state.snapshots, state.stationSelection);
      for (const { stationId, snapshot } of rows) dual.append(renderDualObservationCard(stationId, snapshot));
      text('stationName', 'BOTH STATIONS');
      text('footerStation', rows.map(row => row.stationId).join(' · ') || 'Stations —');
      text('stationMeta', `${rows.length}/2 STATIONS · TZ ${localZone.replaceAll('_', ' ').toUpperCase()} · UPDATE 60S`);
      const display = rows[0]?.snapshot?.settings?.display;
      if (!state.preferencesInitialised && display) {
        state.preferences.measured = display.show_measured !== false;
        state.preferences.forecast = display.show_adjusted !== false;
        state.preferences.range = display.show_uncertainty !== false;
        state.preferencesInitialised = true;
        renderPreferences();
      }
      return;
    }

    dual.hidden = true;
    single.hidden = false;
    const snapshot = firstSelectedSnapshot();
    if (!snapshot) { updateStatus(); return; }
    state.snapshot = snapshot;
    const station = String(snapshot.settings?.station_id || '—');
    text('stationName', station);
    text('footerStation', station);
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
    text('pressureTrendNote', `ΔP / 3H · ${trend === null ? '—' : trend > .05 ? 'RISING' : trend < -.05 ? 'FALLING' : 'STEADY'}`);
    text('observationTime', dateLabel(observation.timestamp));
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
    const both = state.stationSelection === 'both' && !state.compatibilityMode;
    const summary = $('dualCalibrationSummary');
    const performance = $('calibrationPerformance');
    const details = $('modelDetails');

    if (both) {
      summary.hidden = false;
      performance.hidden = true;
      details.hidden = true;
      summary.replaceChildren();
      text('calibrationMode', 'BOTH STATIONS');
      text('calibrationStatus', 'Independent calibration state for each station. Select one station for coefficient history.');
      for (const [stationId, snapshot] of selectedSnapshots()) {
        const calibration = snapshot.calibration || {};
        const metrics = calibration.metrics || {};
        const controls = calibration.controls || {};
        const card = document.createElement('article');
        card.className = 'dual-calibration-card';
        const title = document.createElement('h3');
        title.textContent = stationId;
        const mode = document.createElement('p');
        mode.textContent = calibration.mode === 'auto' ? calibration.paused ? 'AUTO · PAUSED' : 'AUTO' : 'MANUAL';
        const values = document.createElement('dl');
        values.innerHTML = `
          <div><dt>Verified</dt><dd>${format(metrics.verified_hours, 0)} h</dd></div>
          <div><dt>cligMET MAE</dt><dd>${format(metrics.cligmet_mae, 3)} °C</dd></div>
          <div><dt>Open-Meteo MAE</dt><dd>${format(metrics.model_mae, 3)} °C</dd></div>
          <div><dt>Temp adj.</dt><dd>${signed(controls.temperature_offset)} °C</dd></div>`;
        card.append(title, mode, values);
        summary.append(card);
      }
      return;
    }

    summary.hidden = true;
    performance.hidden = false;
    details.hidden = false;
    const snapshot = firstSelectedSnapshot();
    const calibration = snapshot?.calibration;
    const metrics = calibration?.metrics || {};
    const controls = calibration?.controls || {};
    text('calibrationMode', !calibration ? 'Unavailable' : calibration.mode === 'auto' ? calibration.paused ? 'Auto calibration paused' : 'Auto calibration' : 'Manual coefficients');
    const minimum = number(metrics.minimum_verified_hours) ?? number(calibration?.minimum_verified_hours) ?? 168;
    const verified = number(metrics.verified_hours);
    const days = number(metrics.calibration_days) ?? number(calibration?.calibration_days);
    const explanation = !calibration ? 'UNAVAILABLE'
      : calibration.paused ? 'PAUSED'
      : calibration.status === 'collecting' || (verified !== null && verified < minimum) ? `${format(verified, 0)}/${minimum} H VERIFIED`
      : days !== null ? `${format(days, 0)}D WINDOW` : '';
    text('calibrationStatus', explanation);
    text('verifiedHours', format(verified, 0));
    text('verifiedNote', '');
    text('cligmetMae', format(metrics.cligmet_mae, 3));
    text('modelMae', format(metrics.model_mae, 3));
    text('improvement', signed(metrics.improvement, 3));
    text('coefficientTemperature', `${signed(controls.temperature_offset)} °C`);
    const percentage = value => number(value) === null ? '—' : `${Math.round(Number(value) * 100)}%`;
    text('coefficientStation', percentage(controls.station_bias_influence));
    text('coefficientPressure', percentage(controls.pressure_trend_influence));
    text('coefficientResponsiveness', `${format(controls.temperature_responsiveness)} °C/h`);
    text('coefficientRain', percentage(controls.local_rain_influence));
    text('calibrationNote', '');
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
    const node = svgElement('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', 'font-size': 11, fill: COLOURS.muted, 'class': 'chart-empty-label' }, label);
    svg.append(node);
  }

  function drawTimeTicks(svg, domain, plot, x) {
    const targetCount = Math.max(2, Math.floor(plot.width / 88));
    const step = Math.max(1, Math.ceil((domain.end - domain.start) / HOUR / targetCount)) * HOUR;
    // Epoch-based major ticks keep a consistent real-time scale through clock changes.
    const ticks = [];
    for (let stamp = Math.ceil(domain.start / step) * step; stamp <= domain.end; stamp += step) ticks.push(stamp);
    if (!ticks.length) ticks.push(domain.start);
    ticks.forEach(stamp => {
      const xx = x(stamp);
      svg.append(svgElement('line', { x1: xx, x2: xx, y1: plot.top, y2: plot.bottom, stroke: COLOURS.gridMajor, 'stroke-width': .8 }));
      const anchor = xx < plot.left + 24 ? 'start' : xx > plot.right - 24 ? 'end' : 'middle';
      const label = svgElement('text', { x: xx, y: plot.bottom + 22, 'text-anchor': anchor, fill: COLOURS.muted, 'font-size': 10, 'class': 'chart-axis-label chart-axis-time' });
      const longWindow = domain.end - domain.start > 8 * 24 * HOUR;
      label.append(svgElement('tspan', { x: xx }, longWindow ? shortDate(stamp) : clockLabel(stamp)));
      if (!longWindow) label.append(svgElement('tspan', { x: xx, dy: 16 }, shortDate(stamp)));
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

  function addBand(parent, points, x, y, domain, colour = COLOURS.band) {
    let group = [];
    const flush = () => {
      if (group.length > 1) {
        const upper = group.map((point, index) => `${index ? 'L' : 'M'}${x(point.t)},${y(point.upper)}`).join(' ');
        const lower = [...group].reverse().map(point => `L${x(point.t)},${y(point.lower)}`).join(' ');
        parent.append(svgElement('path', { d: `${upper} ${lower} Z`, fill: colour, 'fill-opacity': .14, stroke: 'none' }));
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
    const clipPoints = points => points.filter(point => point.t >= domain.start && point.t <= domain.end);
    const histories = domain.observationPointsByStation instanceof Map ? domain.observationPointsByStation : new Map();
    const rawSeries = window.CligmetMultiStation.seriesSources(state.snapshots, histories, state.stationSelection, state.preferences);
    const labelFor = kind => kind === 'observed' ? 'Measured' : kind === 'forecast' ? 'Forecast' : 'Archived';
    const series = rawSeries.map(item => ({
      ...item,
      label: labelFor(item.kind),
      points: clipPoints(normalisePoints(item.points, definition.key)),
      colour: COLOURS.stations[item.stationId] || COLOURS.ink,
      dash: DASH[item.kind] || '',
      interval: item.kind === 'observed' ? domain.interval : 1,
    }));
    const forecastSeries = series.filter(item => item.kind === 'forecast');
    const useBand = definition.band && state.preferences.range;
    const values = series.flatMap(item => item.points.map(point => point.value)).filter(value => value !== null);
    if (useBand) forecastSeries.forEach(item => item.points.forEach(point => {
      const lower = number(point.source.temperature_lower), upper = number(point.source.temperature_upper);
      if (lower !== null && upper !== null && lower <= upper) values.push(lower, upper);
    }));
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
    for (let i = 0; i <= 4; i++) {
      const value = bounds.low + (bounds.high - bounds.low) * i / 4;
      const yy = y(value);
      svg.append(svgElement('line', { x1: plot.left, x2: plot.right, y1: yy, y2: yy, stroke: COLOURS.gridMajor, 'stroke-width': .75 }));
      const digits = definition.key === 'pressure' || bounds.high - bounds.low < 5 ? 1 : 0;
      svg.append(svgElement('text', { x: plot.left - 8, y: yy + 4, 'text-anchor': 'end', fill: COLOURS.muted, 'font-size': 10, 'class': 'chart-axis-label chart-axis-value' }, format(value, digits)));
    }
    drawTimeTicks(svg, domain, plot, x);
    const defs = svgElement('defs');
    const clip = svgElement('clipPath', { id: `${definition.id}-clip` });
    clip.append(svgElement('rect', { x: plot.left - 1, y: plot.top - 2, width: plot.width + 2, height: plot.bottom - plot.top + 4 }));
    defs.append(clip);
    svg.append(defs);
    const lines = svgElement('g', { 'clip-path': `url(#${definition.id}-clip)` });
    if (useBand) forecastSeries.forEach(item => addBand(lines, item.points, x, y, domain, item.colour));
    series.forEach(item => {
      const maximumGap = (item.interval || 1) * 1.75 * HOUR;
      lines.append(svgElement('path', { d: linePath(item.points, x, y, maximumGap), fill: 'none', stroke: item.colour, 'stroke-width': item.kind === 'archived' ? 1.7 : 2.2, 'stroke-dasharray': item.dash, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
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
    if (definition.key === 'temperature' && plot.right - forecastX > 34) {
      const labelX = Math.min(forecastX + 10, plot.right - 12), labelY = plot.top + 7;
      svg.append(svgElement('text', { x: labelX, y: labelY, fill: COLOURS.muted, 'font-size': 9, 'letter-spacing': 1.2, transform: `rotate(90 ${labelX} ${labelY})` }, 'FCST'));
    }
    const guide = svgElement('g', { visibility: 'hidden', 'aria-hidden': 'true', 'class': 'chart-crosshair' });
    const guideLine = svgElement('line', { y1: plot.top, y2: plot.bottom, stroke: '#7a7a7a', 'stroke-width': 1, 'stroke-dasharray': '3 3', 'class': 'chart-crosshair-line' });
    guide.append(guideLine);
    svg.append(guide);
    const bandTimes = useBand ? forecastSeries.flatMap(item => item.points.filter(point => number(point.source.temperature_lower) !== null && number(point.source.temperature_upper) !== null).map(point => point.t)) : [];
    const timeline = [...new Set(series.flatMap(item => item.points.filter(point => point.value !== null).map(point => point.t)).concat(bandTimes))].sort((a, b) => a - b);
    const data = { definition, domain, plot, width, x, y, series, forecastSeries, useBand, timeline, guide, guideLine };
    state.charts.set(definition.id, data);
    readout.textContent = '';
    const selectedTime = state.selectedTimes.get(definition.id);
    if (selectedTime !== undefined && timeline.includes(selectedTime)) inspectChart(data, selectedTime, false);
    else state.selectedTimes.delete(definition.id);
  }

  function positionFullscreenReadout(data, selectedTime) {
    const { definition, x, width } = data;
    const svg = $(definition.id);
    const card = svg.closest('.chart-card');
    const readout = $(definition.readout);
    if (!card?.classList.contains('is-fullscreen')) {
      readout.classList.remove('overlay-left', 'overlay-right');
      readout.style.removeProperty('--overlay-top');
      readout.style.removeProperty('--overlay-left-edge');
      readout.style.removeProperty('--overlay-right-edge');
      return;
    }

    const svgRect = svg.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const crosshairRatio = Math.max(0, Math.min(1, x(selectedTime) / width));
    const placeLeft = crosshairRatio > .52;
    readout.classList.toggle('overlay-left', placeLeft);
    readout.classList.toggle('overlay-right', !placeLeft);
    readout.style.setProperty('--overlay-top', `${Math.max(12, svgRect.top - cardRect.top + 18)}px`);
    readout.style.setProperty('--overlay-left-edge', `${Math.max(14, svgRect.left - cardRect.left + 18)}px`);
    readout.style.setProperty('--overlay-right-edge', `${Math.max(14, cardRect.right - svgRect.right + 18)}px`);
  }

  function inspectChart(data, selectedTime, announce) {
    const { definition, series, forecastSeries, useBand, guide, guideLine, x, y } = data;
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
    for (const stationId of selectedStationIds()) {
      const stationSeries = series.filter(item => item.stationId === stationId);
      const stationValues = stationSeries.flatMap(item => {
        const point = item.points.find(candidate => candidate.t === selectedTime && candidate.value !== null);
        return point ? [[item, point]] : [];
      });
      if (!stationValues.length && !useBand) continue;
      const stationHeading = document.createElement('span');
      stationHeading.className = 'readout-station';
      stationHeading.textContent = stationId;
      values.append(stationHeading);
      stationValues.forEach(([item, point]) => {
        const count = number(point.source?.sample_counts?.[definition.key]);
        const shortLabel = item.kind === 'observed' ? 'OBS' : item.kind === 'forecast' ? 'FCST' : 'ARCH';
        const coverage = item.kind === 'observed' && item.interval > 1 && count !== null ? ` ${count}/${item.interval}H` : '';
        const phrase = `${shortLabel} ${format(point.value, definition.digits)}${definition.unit}${coverage}`;
        parts.push(`${stationId} ${phrase}`);
        const element = document.createElement('span');
        element.textContent = phrase;
        values.append(element);
        const fullscreen = $(definition.id).closest('.chart-card')?.classList.contains('is-fullscreen');
        guide.append(svgElement('circle', { cx: x(point.t), cy: y(point.value), r: fullscreen ? 5.2 : 3.7, fill: '#fff', stroke: item.colour, 'stroke-width': fullscreen ? 2.4 : 2, 'class': 'chart-crosshair-point' }));
      });
      if (useBand) {
        const forecast = forecastSeries.find(item => item.stationId === stationId);
        const point = forecast?.points.find(candidate => candidate.t === selectedTime);
        if (point && number(point.source.temperature_lower) !== null && number(point.source.temperature_upper) !== null && Number(point.source.temperature_lower) <= Number(point.source.temperature_upper)) {
          const phrase = `RNG ${format(point.source.temperature_lower)}–${format(point.source.temperature_upper)}°C`;
          parts.push(`${stationId} ${phrase}`);
          const element = document.createElement('span');
          element.textContent = phrase;
          values.append(element);
        }
      }
    }
    readout.append(heading, values);
    positionFullscreenReadout(data, selectedTime);
    if (announce) text('chartAnnouncement', `${definition.name}, ${heading.textContent}. ${parts.join('. ')}`);
  }

  function renderCharts() {
    if (!state.snapshots.size) return;
    chartDefinitions.forEach(definition => renderChart(definition, historyNavigation.view(definition.id.replace('Chart', ''))));
    text('forecastNote', state.stationSelection === 'both' && !state.compatibilityMode ? 'ILONDO1066 dark · ILONDO327 brown · solid measured · dashed forecast · dotted archive' : '');
    text('timezoneNote', '');
  }

  function renderCoefficientHistory() {
    if (state.stationSelection === 'both' && !state.compatibilityMode) return;
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
      drawEmpty(svg, width, height, 'No data');
      text('coefficientDescription', '');
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
    svg.append(svgElement('text', { x: left, y: height - 13, 'font-size': 12, fill: COLOURS.muted }, shortDate(view.start)));
    svg.append(svgElement('text', { x: right, y: height - 13, 'text-anchor': 'end', 'font-size': 12, fill: COLOURS.muted }, shortDate(view.end)));
    text('coefficientDescription', '');
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

  function fullscreenChartCard() {
    return document.querySelector('.chart-card.is-fullscreen');
  }

  function closeFullscreenChart({ restoreFocus = true } = {}) {
    const card = fullscreenChartCard();
    if (!card) return false;
    const svg = card.querySelector('.chart');
    const closeButton = card.querySelector('.chart-fullscreen-close');
    card.classList.remove('is-fullscreen');
    card.querySelector('.chart-readout')?.classList.remove('overlay-left', 'overlay-right');
    if (svg) svg.setAttribute('aria-expanded', 'false');
    card.removeAttribute('role');
    card.removeAttribute('aria-modal');
    card.removeAttribute('aria-labelledby');
    document.body.classList.remove('chart-fullscreen-open');
    if (closeButton) closeButton.hidden = true;
    requestAnimationFrame(renderCharts);
    if (restoreFocus && svg) requestAnimationFrame(() => svg.focus({ preventScroll: true }));
    return true;
  }

  function openFullscreenChart(definition) {
    const svg = $(definition.id);
    const card = svg.closest('.chart-card');
    if (!card || card.classList.contains('is-fullscreen')) return;
    closeFullscreenChart({ restoreFocus: false });
    card.classList.add('is-fullscreen');
    svg.setAttribute('aria-expanded', 'true');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', `${definition.id}Title`);
    document.body.classList.add('chart-fullscreen-open');
    const closeButton = card.querySelector('.chart-fullscreen-close');
    if (closeButton) {
      closeButton.hidden = false;
      requestAnimationFrame(() => closeButton.focus({ preventScroll: true }));
    }
    requestAnimationFrame(renderCharts);
    text('chartAnnouncement', `${definition.name} chart expanded to full screen.`);
  }

  function bindChartInteraction(definition) {
    const svg = $(definition.id);
    const card = svg.closest('.chart-card');
    svg.setAttribute('aria-haspopup', 'dialog');
    svg.setAttribute('aria-expanded', 'false');
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'chart-fullscreen-close';
    closeButton.setAttribute('aria-label', `Close ${definition.name} full screen chart`);
    closeButton.textContent = '×';
    closeButton.hidden = true;
    card.append(closeButton);
    closeButton.addEventListener('click', () => {
      closeFullscreenChart();
      text('chartAnnouncement', `${definition.name} chart returned to page view.`);
    });

    let activePointerId = null;

    const inspectPointer = event => {
      const fullscreen = card.classList.contains('is-fullscreen');
      if (event.type === 'pointerdown' && !fullscreen) {
        event.preventDefault();
        openFullscreenChart(definition);
        return;
      }
      if (!fullscreen) return;
      if (event.type === 'pointermove' && event.pointerType !== 'mouse' && activePointerId !== event.pointerId) return;

      const data = state.charts.get(definition.id);
      if (!data?.timeline.length) return;
      const rect = svg.getBoundingClientRect();
      const pointerX = Math.max(0, Math.min(rect.width, event.clientX - rect.left)) / rect.width * data.width;
      const target = data.domain.start + (pointerX - data.plot.left) / data.plot.width * (data.domain.end - data.domain.start);
      const nearest = data.timeline.reduce((best, candidate) => Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best);
      inspectChart(data, nearest, event.type === 'pointerdown');
    };

    svg.addEventListener('pointerdown', event => {
      if (!card.classList.contains('is-fullscreen')) {
        inspectPointer(event);
        return;
      }
      event.preventDefault();
      activePointerId = event.pointerId;
      if (svg.setPointerCapture) {
        try { svg.setPointerCapture(event.pointerId); } catch { /* Pointer capture is optional. */ }
      }
      inspectPointer(event);
    });
    svg.addEventListener('pointermove', inspectPointer);
    const releasePointer = event => {
      if (activePointerId !== event.pointerId) return;
      activePointerId = null;
      if (svg.hasPointerCapture?.(event.pointerId)) svg.releasePointerCapture(event.pointerId);
    };
    svg.addEventListener('pointerup', releasePointer);
    svg.addEventListener('pointercancel', releasePointer);
    svg.addEventListener('keydown', event => {
      if (!card.classList.contains('is-fullscreen') && ['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openFullscreenChart(definition);
        return;
      }
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
  text('todayLabel', shortDate(Date.now()));
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
  }
  window.addEventListener('resize', resize);
  document.addEventListener('keydown', event => {
    const card = fullscreenChartCard();
    if (!card) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeFullscreenChart();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...card.querySelectorAll('button:not([hidden]):not([disabled]), .chart[tabindex="0"]')]
      .filter(element => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.lastAttempt > 60000) loadSnapshot();
  });
  window.addEventListener('online', loadSnapshot);
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      text('todayLabel', shortDate(Date.now()));
      loadSnapshot();
    }
  }, 60000);
  loadSnapshot();
})();
