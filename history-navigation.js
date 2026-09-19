'use strict';

// Read-only history loading and independent calendar navigation for each plot.
window.CligmetHistory = (() => {
  const HOUR = 3600000;
  const DAY = 24 * HOUR;
  const PERIODS = new Set(['day', 'recent', 'week', 'month', 'year', 'forecast', 'all']);
  const numeric = value => value !== null && value !== undefined && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value)) ? Number(value) : null;
  const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const label = value => new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
  const sequence = value => Array.isArray(value) ? value : [];

  function shift(base, period, offset) {
    if (period === 'month' || period === 'year') {
      const date = new Date(base), day = date.getUTCDate();
      date.setUTCDate(1);
      if (period === 'month') date.setUTCMonth(date.getUTCMonth() + offset);
      else date.setUTCFullYear(date.getUTCFullYear() + offset);
      const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      date.setUTCDate(Math.min(day, lastDay));
      return date.getTime();
    }
    return base + offset * (period === 'day' ? DAY : period === 'week' ? 7 * DAY : 3 * DAY);
  }

  function aggregate(points, interval, start, end) {
    const buckets = new Map();
    const fields = ['temperature', 'pressure', 'humidity', 'solar_radiation'];
    const unique = new Map(sequence(points).filter(point => point && stamp(point.timestamp) !== null).map(point => [point.timestamp, point]));
    [...unique.values()].forEach(point => {
      const time = stamp(point.timestamp);
      if (time < start || time > end) return;
      const bucket = Math.floor(time / (interval * HOUR)) * interval * HOUR;
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(point);
    });
    return [...buckets].sort((a, b) => a[0] - b[0]).map(([bucket, samples]) => {
      const result = { timestamp: new Date(Math.max(bucket, start)).toISOString(), sample_count: samples.length, sample_counts: {} };
      fields.forEach(field => {
        const values = samples.map(point => numeric(point[field])).filter(value => value !== null);
        result[field] = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
        result.sample_counts[field] = values.length;
      });
      return result;
    });
  }

  function historyRequestKey(stationId, window) {
    return [stationId || '', window.start, window.historyEnd, window.interval].join('|');
  }

  function create({ onChange, getSnapshot, getSnapshots, getSelectedStationIds }) {
    const cache = new Map(), pending = new Map(), selections = new Map();
    const availability = new Map();
    let revision = 0, snapshotKey = '', coefficientData = null, coefficientsRequested = false;
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem('cligmet.periods.v1')) || {}; } catch { /* Optional preferences. */ }

    function snapshots() {
      if (typeof getSnapshots === 'function') {
        const value = getSnapshots();
        if (value instanceof Map) return value;
      }
      const snapshot = typeof getSnapshot === 'function' ? getSnapshot() : null;
      const station = snapshot?.settings?.station_id;
      return station ? new Map([[String(station), snapshot]]) : new Map();
    }

    function selectedIds() {
      if (typeof getSelectedStationIds === 'function') {
        const ids = sequence(getSelectedStationIds()).map(value => String(value)).filter(Boolean);
        if (ids.length) return ids;
      }
      return [...snapshots().keys()];
    }

    function firstSnapshot() {
      for (const id of selectedIds()) {
        const snapshot = snapshots().get(id);
        if (snapshot) return snapshot;
      }
      return typeof getSnapshot === 'function' ? getSnapshot() : null;
    }

    function periodFor(id) {
      if (!selections.has(id)) selections.set(id, {
        period: PERIODS.has(stored[id]) && (id === 'coefficient' ? ['all', 'week', 'month', 'year'].includes(stored[id]) : stored[id] !== 'all') ? stored[id] : id === 'coefficient' ? 'all' : 'recent',
        offset: 0, anchor: null,
      });
      return selections.get(id);
    }

    function baseTime() {
      const candidates = [];
      for (const id of selectedIds()) {
        const snapshot = snapshots().get(id);
        const value = stamp(snapshot?.generated_at) ?? stamp(snapshot?.current?.observation?.timestamp);
        if (value !== null) candidates.push(value);
      }
      const candidate = candidates.length ? Math.max(...candidates) : Date.now();
      return Math.floor(candidate / HOUR) * HOUR;
    }

    function domain(id) {
      const selection = periodFor(id), base = selection.anchor ?? baseTime();
      const forecastTimes = [];
      for (const station of selectedIds()) {
        const snapshot = snapshots().get(station);
        if (!snapshot?.forecast?.available) continue;
        sequence(snapshot.forecast.points).forEach(point => {
          const value = stamp(point?.timestamp);
          if (value !== null) forecastTimes.push(value);
        });
      }
      const forecastEnd = forecastTimes.length ? Math.max(...forecastTimes) : base + DAY;
      const endHistory = shift(base, selection.period, selection.offset);
      let start = shift(base, selection.period, selection.offset - 1);
      if (selection.period === 'forecast') start = base;
      if (selection.period === 'all') {
        const times = coefficients().map(item => stamp(item?.timestamp)).filter(value => value !== null);
        start = times.length ? Math.min(...times) : base - 30 * DAY;
      }
      return {
        start,
        end: id !== 'coefficient' && selection.offset === 0 ? Math.max(base + HOUR, forecastEnd) : Math.max(start + HOUR, endHistory),
        historyEnd: endHistory,
        boundary: base,
        period: selection.period,
        offset: selection.offset,
        interval: selection.period === 'year' ? 24 : selection.period === 'month' ? 3 : 1,
      };
    }

    function getURL(type) {
      const configured = type === 'weather' ? window.CLIGMET_HISTORY_URL : window.CLIGMET_CALIBRATION_HISTORY_URL;
      if (configured === false) return null;
      try {
        const snapshotURL = new URL(String(window.CLIGMET_SNAPSHOT_URL || ''), window.location.href);
        const url = new URL(configured || (type === 'weather' ? 'history.json' : 'calibration-history.json'), snapshotURL);
        return ['https:', 'http:'].includes(url.protocol) ? url : null;
      } catch { return null; }
    }

    async function request(url) {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(url, { method: 'GET', credentials: 'omit', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('history-unavailable');
        return await response.json();
      } finally { clearTimeout(timeout); }
    }

    function ensure(window) {
      if (!selectedIds().length || window.period === 'forecast') return;
      for (const station of selectedIds()) {
        const key = historyRequestKey(station, window);
        if (cache.has(key) || pending.has(key)) continue;
        const url = getURL('weather');
        if (!url) { cache.set(key, { failed: true }); continue; }
        url.searchParams.set('start', new Date(window.start).toISOString());
        url.searchParams.set('end', new Date(window.historyEnd).toISOString());
        url.searchParams.set('interval_hours', String(window.interval));
        url.searchParams.set('station_id', station);
        const issuedRevision = revision;
        const job = request(url).then(data => {
          if (revision !== issuedRevision) return;
          if (!data || !Array.isArray(data.points) || data.interval_hours !== window.interval || data.station_id !== station) throw new Error('invalid-history');
          cache.set(key, { data });
          availability.set(station, data);
        }).catch(() => {
          if (revision === issuedRevision) cache.set(key, { failed: true });
        }).finally(() => {
          if (pending.get(key) === job) pending.delete(key);
          if (revision === issuedRevision) onChange();
        });
        pending.set(key, job);
      }
    }

    function coefficientStation() {
      const ids = selectedIds();
      return ids.length === 1 ? ids[0] : null;
    }

    function coefficients() {
      const station = coefficientStation();
      const snapshot = station ? snapshots().get(station) : null;
      const saved = sequence(coefficientData?.history), current = sequence(snapshot?.calibration?.history);
      const merged = new Map();
      [...saved, ...current].forEach(item => { if (stamp(item?.timestamp) !== null) merged.set(item.timestamp, item); });
      return [...merged.values()].sort((a, b) => stamp(a.timestamp) - stamp(b.timestamp));
    }

    function ensureCoefficients() {
      const station = coefficientStation();
      if (!station || coefficientsRequested || !snapshots().get(station)) return;
      coefficientsRequested = true;
      const url = getURL('coefficients');
      if (!url) { coefficientData = { failed: true }; return; }
      url.searchParams.set('station_id', station);
      const issuedRevision = revision;
      request(url).then(data => {
        if (revision !== issuedRevision) return;
        if (!data || !Array.isArray(data.history) || data.station_id !== station) throw new Error('invalid-history');
        coefficientData = data;
      }).catch(() => { if (revision === issuedRevision) coefficientData = { failed: true }; })
        .finally(() => { if (revision === issuedRevision) onChange(); });
    }

    function controls(id, window, earliest) {
      const selection = periodFor(id);
      document.getElementById(`${id}Period`).value = selection.period;
      document.querySelectorAll(`[data-period-target="${id}"]`).forEach(button => {
        const active = button.dataset.period === selection.period;
        button.setAttribute('aria-pressed', String(active));
      });
      const fixed = ['all', 'forecast'].includes(selection.period);
      document.getElementById(`${id}Previous`).disabled = fixed || (earliest !== null && window.start <= earliest);
      document.getElementById(`${id}Next`).disabled = fixed || selection.offset === 0;
      document.getElementById(`${id}Latest`).disabled = selection.offset === 0;
      document.getElementById(`${id}Window`).textContent = `${label(window.start)}–${label(window.end)}`;
    }

    function view(id) {
      const window = domain(id);
      ensure(window);
      const observationPointsByStation = new Map();
      const earliestByStation = new Map();
      const notes = [];
      for (const station of selectedIds()) {
        const snapshot = snapshots().get(station);
        const key = historyRequestKey(station, window);
        const result = cache.get(key);
        const fallback = aggregate(snapshot?.history?.points, window.interval, window.start, window.historyEnd);
        const points = result?.data?.points ?? fallback;
        observationPointsByStation.set(station, points);
        const fallbackTimes = sequence(snapshot?.history?.points).map(point => stamp(point?.timestamp)).filter(value => value !== null);
        const earliest = stamp(availability.get(station)?.available_from) ?? (fallbackTimes.length ? Math.min(...fallbackTimes) : null);
        earliestByStation.set(station, earliest);
        if (window.period === 'forecast' || pending.has(key)) continue;
        if (result?.failed) notes.push(`${station} ARCHIVE UNAVAILABLE`);
        else if (!points.length) notes.push(`${station} ${earliest !== null ? `NO DATA · FROM ${label(earliest)}` : 'NO DATA'}`);
        else if (earliest !== null && earliest > window.start) notes.push(`${station} PARTIAL · FROM ${label(earliest)}`);
      }
      const earliestValues = [...earliestByStation.values()].filter(value => value !== null);
      const earliest = earliestValues.length ? Math.min(...earliestValues) : null;
      controls(id, window, earliest);
      const note = document.getElementById(`${id}Coverage`);
      note.textContent = notes.join(' · ');
      note.dataset.state = notes.length ? 'limited' : '';
      const first = observationPointsByStation.get(selectedIds()[0]) || [];
      return { ...window, observationPoints: first, observationPointsByStation, earliestByStation };
    }

    function coefficientView() {
      const station = coefficientStation();
      const window = domain('coefficient');
      const note = document.getElementById('coefficientCoverage');
      if (!station) {
        controls('coefficient', window, null);
        note.dataset.state = 'limited';
        note.textContent = 'SELECT ONE STATION';
        return { ...window, history: [], savedCount: 0 };
      }
      ensureCoefficients();
      const all = coefficients();
      const first = all.length ? stamp(all[0].timestamp) : null;
      controls('coefficient', window, first);
      const baseline = [...all].reverse().find(item => stamp(item.timestamp) < window.start);
      const visible = all.filter(item => stamp(item.timestamp) >= window.start && stamp(item.timestamp) <= window.end);
      const selected = baseline ? [{ ...baseline, timestamp: new Date(window.start).toISOString(), carried_forward: true }, ...visible] : visible;
      if (selected.length && stamp(selected.at(-1).timestamp) < window.end) selected.push({ ...selected.at(-1), timestamp: new Date(window.end).toISOString(), carried_forward: true });
      note.dataset.state = coefficientData?.failed || coefficientData?.truncated ? 'limited' : '';
      note.textContent = coefficientData?.failed ? 'ARCHIVE UNAVAILABLE' : coefficientData?.truncated ? 'LATEST 5000' : '';
      return { ...window, history: selected, savedCount: visible.length };
    }

    function savePeriods() {
      try { localStorage.setItem('cligmet.periods.v1', JSON.stringify(Object.fromEntries([...selections].map(([id, value]) => [id, value.period])))); } catch { /* Optional preferences. */ }
    }

    function bind(id) {
      const select = document.getElementById(`${id}Period`);
      select.value = periodFor(id).period;
      select.addEventListener('change', () => {
        const current = periodFor(id);
        if (!PERIODS.has(select.value)) return;
        current.period = select.value;
        current.offset = 0;
        current.anchor = null;
        savePeriods();
        onChange();
      });
      document.querySelectorAll(`[data-period-target="${id}"]`).forEach(button => {
        button.addEventListener('click', () => {
          if (!PERIODS.has(button.dataset.period)) return;
          select.value = button.dataset.period;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
      for (const [suffix, change] of [['Previous', -1], ['Next', 1], ['Latest', 0]]) {
        document.getElementById(`${id}${suffix}`).addEventListener('click', () => {
          const current = periodFor(id);
          if (['all', 'forecast'].includes(current.period)) return;
          if (current.anchor === null && change !== 0) current.anchor = baseTime();
          current.offset = change === 0 ? 0 : Math.min(0, current.offset + change);
          if (current.offset === 0) current.anchor = null;
          onChange();
        });
      }
    }

    function refreshed() {
      const key = selectedIds().map(station => `${station}|${snapshots().get(station)?.generated_at || ''}`).join(';');
      if (key !== snapshotKey) {
        snapshotKey = key;
        revision += 1;
        cache.clear();
        pending.clear();
        availability.clear();
        coefficientData = null;
        coefficientsRequested = false;
      } else {
        for (const [key, value] of cache) if (value.failed) cache.delete(key);
        if (coefficientData?.failed) { coefficientData = null; coefficientsRequested = false; }
      }
    }

    return { bind, view, coefficientView, refreshed };
  }
  return { create, historyRequestKey };
})();
