'use strict';

// Read-only history loading and independent calendar navigation for each plot.
window.CligmetHistory = (() => {
  const HOUR = 3600000;
  const DAY = 24 * HOUR;
  const PERIODS = new Set(['day', 'recent', 'week', 'month', 'year', 'forecast', 'all']);
  const numeric = value => value !== null && value !== undefined && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value)) ? Number(value) : null;
  const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const label = value => new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
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

  function create({ onChange, getSnapshot }) {
    const cache = new Map(), pending = new Map(), selections = new Map();
    let revision = 0, snapshotKey = '', availability = null, coefficientData = null, coefficientsRequested = false;
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem('cligmet.periods.v1')) || {}; } catch { /* Optional preferences. */ }

    function periodFor(id) {
      if (!selections.has(id)) selections.set(id, {
        period: PERIODS.has(stored[id]) && (id === 'coefficient' ? ['all', 'week', 'month', 'year'].includes(stored[id]) : stored[id] !== 'all') ? stored[id] : id === 'coefficient' ? 'all' : 'recent',
        offset: 0, anchor: null,
      });
      return selections.get(id);
    }

    function baseTime() {
      const snapshot = getSnapshot();
      const candidate = stamp(snapshot?.generated_at) ?? stamp(snapshot?.current?.observation?.timestamp) ?? Date.now();
      // Hourly observations are aligned to UTC hour boundaries.
      return Math.floor(candidate / HOUR) * HOUR;
    }

    function domain(id) {
      const selection = periodFor(id), base = selection.anchor ?? baseTime();
      const forecast = sequence(getSnapshot()?.forecast?.points).map(point => stamp(point?.timestamp)).filter(value => value !== null);
      const forecastEnd = getSnapshot()?.forecast?.available && forecast.length ? Math.max(...forecast) : base + DAY;
      const endHistory = shift(base, selection.period, selection.offset);
      let start = shift(base, selection.period, selection.offset - 1);
      if (selection.period === 'forecast') start = base;
      if (selection.period === 'all') {
        const times = coefficients().map(item => stamp(item?.timestamp)).filter(value => value !== null);
        start = times.length ? Math.min(...times) : base - 30 * DAY;
      }
      return { start, end: id !== 'coefficient' && selection.offset === 0 ? Math.max(base + HOUR, forecastEnd) : Math.max(start + HOUR, endHistory), historyEnd: endHistory, boundary: base, period: selection.period, offset: selection.offset, interval: selection.period === 'year' ? 24 : selection.period === 'month' ? 3 : 1 };
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

    function requestKey(window) {
      return [getSnapshot()?.settings?.station_id || '', window.start, window.historyEnd, window.interval].join('|');
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
      if (!getSnapshot() || window.period === 'forecast') return;
      const key = requestKey(window);
      if (cache.has(key) || pending.has(key)) return;
      const url = getURL('weather');
      if (!url) { cache.set(key, { failed: true }); return; }
      url.searchParams.set('start', new Date(window.start).toISOString());
      url.searchParams.set('end', new Date(window.historyEnd).toISOString());
      url.searchParams.set('interval_hours', String(window.interval));
      const station = String(getSnapshot()?.settings?.station_id || '');
      if (station) url.searchParams.set('station_id', station);
      const issuedRevision = revision;
      const job = request(url).then(data => {
        if (revision !== issuedRevision) return;
        if (!data || !Array.isArray(data.points) || data.interval_hours !== window.interval || (station && data.station_id !== station)) throw new Error('invalid-history');
        cache.set(key, { data });
        availability = data;
      }).catch(() => { if (revision === issuedRevision) cache.set(key, { failed: true }); }).finally(() => {
        if (pending.get(key) === job) pending.delete(key);
        if (revision === issuedRevision) onChange();
      });
      pending.set(key, job);
    }

    function coefficients() {
      const saved = sequence(coefficientData?.history), current = sequence(getSnapshot()?.calibration?.history);
      const merged = new Map();
      [...saved, ...current].forEach(item => { if (stamp(item?.timestamp) !== null) merged.set(item.timestamp, item); });
      return [...merged.values()].sort((a, b) => stamp(a.timestamp) - stamp(b.timestamp));
    }

    function ensureCoefficients() {
      if (coefficientsRequested || !getSnapshot()) return;
      coefficientsRequested = true;
      const url = getURL('coefficients');
      if (!url) { coefficientData = { failed: true }; return; }
      const station = String(getSnapshot()?.settings?.station_id || '');
      if (station) url.searchParams.set('station_id', station);
      const issuedRevision = revision;
      request(url).then(data => {
        if (revision !== issuedRevision) return;
        if (!data || !Array.isArray(data.history) || (station && data.station_id !== station)) throw new Error('invalid-history');
        coefficientData = data;
      }).catch(() => { if (revision === issuedRevision) coefficientData = { failed: true }; }).finally(() => { if (revision === issuedRevision) onChange(); });
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
      document.getElementById(`${id}Window`).textContent = `${label(window.start)} – ${label(window.end)}${id !== 'coefficient' && selection.offset === 0 && selection.period !== 'forecast' ? ' · includes next 24 h forecast' : ''}`;
    }

    function view(id) {
      const window = domain(id);
      ensure(window);
      const result = cache.get(requestKey(window));
      const fallback = aggregate(getSnapshot()?.history?.points, window.interval, window.start, window.historyEnd);
      const observationPoints = result?.data?.points ?? fallback;
      const fallbackTimes = sequence(getSnapshot()?.history?.points).map(point => stamp(point?.timestamp)).filter(value => value !== null);
      const earliest = stamp(availability?.available_from) ?? (fallbackTimes.length ? Math.min(...fallbackTimes) : null);
      controls(id, window, result?.data ? earliest : null);
      const note = document.getElementById(`${id}Coverage`);
      const averaging = window.interval === 24 ? 'Daily means of available hours (UTC days)' : window.interval === 3 ? '3-hour means of available hours (UTC)' : 'Hourly means';
      note.dataset.state = '';
      if (window.period === 'forecast') note.textContent = 'Next 24 hours · station-adjusted forecast';
      else if (pending.has(requestKey(window))) note.textContent = `${averaging} · loading archived observations…`;
      else if (result?.failed) {
        note.textContent = `${averaging} · long-term archive unavailable; showing only the current snapshot’s history.`;
        note.dataset.state = 'limited';
      } else if (!observationPoints.length) {
        note.textContent = `${averaging} · no observations saved for this period.${earliest !== null ? ` Archive starts ${label(earliest)}.` : ''}`;
        note.dataset.state = 'limited';
      } else if (earliest !== null && earliest > window.start) {
        note.textContent = `${averaging} · partial coverage; archive starts ${label(earliest)}.`;
        note.dataset.state = 'limited';
      } else note.textContent = `${averaging} · gaps indicate missing observations`;
      return { ...window, observationPoints };
    }

    function coefficientView() {
      ensureCoefficients();
      const window = domain('coefficient'), all = coefficients();
      const first = all.length ? stamp(all[0].timestamp) : null;
      controls('coefficient', window, first);
      const note = document.getElementById('coefficientCoverage');
      const baseline = [...all].reverse().find(item => stamp(item.timestamp) < window.start);
      const visible = all.filter(item => stamp(item.timestamp) >= window.start && stamp(item.timestamp) <= window.end);
      const selected = baseline ? [{ ...baseline, timestamp: new Date(window.start).toISOString(), carried_forward: true }, ...visible] : visible;
      if (selected.length && stamp(selected.at(-1).timestamp) < window.end) selected.push({ ...selected.at(-1), timestamp: new Date(window.end).toISOString(), carried_forward: true });
      note.dataset.state = coefficientData?.failed || coefficientData?.truncated ? 'limited' : '';
      note.textContent = coefficientData?.failed ? 'Saved coefficient changes from the current snapshot; longer archive unavailable.' : coefficientData?.truncated ? 'Showing the most recent 5,000 coefficient changes.' : !coefficientData ? 'Loading saved coefficient changes…' : 'Step lines show the coefficient in force between saved changes.';
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
      const snapshot = getSnapshot();
      const key = `${snapshot?.settings?.station_id}|${snapshot?.generated_at}`;
      if (key !== snapshotKey) {
        snapshotKey = key;
        revision += 1;
        cache.clear();
        pending.clear();
        availability = null;
        coefficientData = null;
        coefficientsRequested = false;
      } else {
        for (const [key, value] of cache) if (value.failed) cache.delete(key);
        if (coefficientData?.failed) { coefficientData = null; coefficientsRequested = false; }
      }
    }

    return { bind, view, coefficientView, refreshed };
  }
  return { create };
})();
