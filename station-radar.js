'use strict';

// Monotone rain map for the station map: the latest RainViewer radar frame,
// then Open-Meteo's 15-minute precipitation forecast for the next four hours,
// both drawn as ink over london-outline.svg.
window.CligmetRadar = (() => {
  const RAINVIEWER_URL = 'https://api.rainviewer.com/public/weather-maps.json';
  const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
  const RADAR_ZOOM = 7;           // RainViewer's free maximum
  const RADAR_TILE = 512;
  const GRID = Object.freeze({ cols: 10, rows: 8 });
  const FORECAST_STEPS = 16;      // 16 x 15 minutes = 4 hours
  const STEP_MINUTES = 15;
  const RADAR_REFRESH = 5 * 60000;
  const FORECAST_REFRESH = 30 * 60000;
  const MIN_RATE = 0.1;           // mm/h; anything lighter is left clear
  const MAX_RATE = 50;
  const INK = [17, 17, 17];

  // RainViewer "Universal Blue" rain colours (the only scheme its free API
  // still serves), from 5 dBZ up. Each pixel is matched to the nearest one.
  const UNIVERSAL_BLUE = [
    [5, '92887164'], [6, '9e93756e'], [7, 'aa9e7978'], [8, 'b6a97e82'], [9, 'c2b4828c'], [10, 'cec08796'],
    [11, 'd2c48ba0'], [12, 'd6c88faa'], [13, 'dacc93b4'], [14, 'ded097be'], [15, '88ddeeff'], [16, '6cd1ebff'],
    [17, '51c5e8ff'], [18, '36bae5ff'], [19, '1baee2ff'], [20, '00a3e0ff'], [21, '009ad5ff'], [22, '0091caff'],
    [23, '0088bfff'], [24, '007fb4ff'], [25, '0077aaff'], [26, '0070a3ff'], [27, '00699cff'], [28, '006295ff'],
    [29, '005b8eff'], [30, '005588ff'], [31, '005180ff'], [32, '004e78ff'], [33, '004a70ff'], [34, '004768ff'],
    [35, 'ffee00ff'], [36, 'ffe000ff'], [37, 'ffd200ff'], [38, 'ffc500ff'], [39, 'ffb700ff'], [40, 'ffaa00ff'],
    [41, 'ff9f00ff'], [42, 'ff9500ff'], [43, 'ff8b00ff'], [44, 'ff8100ff'], [45, 'ff4400ff'], [46, 'f23600ff'],
    [47, 'e62800ff'], [48, 'd91b00ff'], [49, 'cd0d00ff'], [50, 'c10000ff'], [51, 'a80000ff'], [52, '8f0000ff'],
    [53, '760000ff'], [54, '5d0000ff'], [55, 'ffaaffff'], [56, 'ff9fffff'], [57, 'ff95ffff'], [58, 'ff8bffff'],
    [59, 'ff81ffff'], [60, 'ff77ffff'], [61, 'ff6cffff'], [62, 'ff62ffff'], [63, 'ff58ffff'], [64, 'ff4effff'],
  ].map(([dbz, hex]) => ({ dbz, rgba: [0, 2, 4, 6].map(i => parseInt(hex.slice(i, i + 2), 16)) }));

  // Marshall-Palmer: Z = 200 R^1.6.
  function rateFromDbz(dbz) {
    return (10 ** (dbz / 10) / 200) ** (1 / 1.6);
  }

  function rateFromColour(r, g, b, a) {
    if (a < 16) return 0;
    let best = null, distance = Infinity;
    for (const entry of UNIVERSAL_BLUE) {
      const [er, eg, eb, ea] = entry.rgba;
      const d = (r - er) ** 2 + (g - eg) ** 2 + (b - eb) ** 2 + (a - ea) ** 2;
      if (d < distance) { distance = d; best = entry; }
    }
    return best ? rateFromDbz(best.dbz) : 0;
  }

  // Light rain is a faint wash, heavy rain approaches solid ink.
  function alphaForRate(rate) {
    if (!(rate >= MIN_RATE)) return 0;
    const t = Math.min(1, Math.log10(rate / MIN_RATE) / Math.log10(MAX_RATE / MIN_RATE));
    return 0.14 + 0.66 * t;
  }

  // Geographic extent of the map image (london-outline.svg, padding included).
  function mapExtent(projection) {
    const { lonMin, latMax, cosLat, scale, pad, width, height } = projection;
    return {
      west: lonMin - pad / (cosLat * scale),
      east: lonMin + (width - pad) / (cosLat * scale),
      north: latMax + pad / scale,
      south: latMax - (height - pad) / scale,
    };
  }

  function gridPoints(extent, cols = GRID.cols, rows = GRID.rows) {
    const points = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        points.push({
          latitude: +(extent.north - (extent.north - extent.south) * row / (rows - 1)).toFixed(4),
          longitude: +(extent.west + (extent.east - extent.west) * col / (cols - 1)).toFixed(4),
        });
      }
    }
    return points;
  }

  function forecastUrl(points) {
    const url = new URL(OPEN_METEO_URL);
    url.searchParams.set('latitude', points.map(point => point.latitude).join(','));
    url.searchParams.set('longitude', points.map(point => point.longitude).join(','));
    url.searchParams.set('minutely_15', 'precipitation');
    url.searchParams.set('forecast_minutely_15', String(FORECAST_STEPS + 2));
    url.searchParams.set('timeformat', 'unixtime');
    url.searchParams.set('timezone', 'GMT');
    return url;
  }

  // Open-Meteo returns one object per location (or a single object for one).
  // Each value is rain over the preceding 15 minutes; frames are mm/h grids.
  function forecastFrames(payload, now, cols = GRID.cols, rows = GRID.rows) {
    const locations = Array.isArray(payload) ? payload : [payload];
    if (locations.length !== cols * rows) return [];
    const times = locations[0]?.minutely_15?.time;
    if (!Array.isArray(times)) return [];
    const frames = [];
    times.forEach((seconds, index) => {
      const time = seconds * 1000;
      if (time <= now || time > now + FORECAST_STEPS * STEP_MINUTES * 60000 + 60000) return;
      const rates = locations.map(location => {
        const value = location?.minutely_15?.precipitation?.[index];
        return typeof value === 'number' && Number.isFinite(value) ? value * 60 / STEP_MINUTES : null;
      });
      frames.push({ kind: 'forecast', time, rates });
    });
    return frames.slice(0, FORECAST_STEPS);
  }

  function mercator(lon, lat, zoom = RADAR_ZOOM, tile = RADAR_TILE) {
    const world = tile * 2 ** zoom;
    const phi = lat * Math.PI / 180;
    return {
      x: (lon + 180) / 360 * world,
      y: (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2 * world,
    };
  }

  function radarTiles(extent) {
    const topLeft = mercator(extent.west, extent.north);
    const bottomRight = mercator(extent.east, extent.south);
    const tiles = [];
    for (let y = Math.floor(topLeft.y / RADAR_TILE); y <= Math.floor(bottomRight.y / RADAR_TILE); y++) {
      for (let x = Math.floor(topLeft.x / RADAR_TILE); x <= Math.floor(bottomRight.x / RADAR_TILE); x++) tiles.push({ x, y });
    }
    return { tiles, origin: topLeft, size: { width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y } };
  }

  function latestRadarFrame(payload) {
    const past = payload?.radar?.past;
    if (!payload?.host || !Array.isArray(past) || !past.length) return null;
    const frame = past[past.length - 1];
    return { kind: 'radar', time: frame.time * 1000, host: payload.host, path: frame.path };
  }

  function tileUrl(frame, tile) {
    return `${frame.host}${frame.path}/${RADAR_TILE}/${RADAR_ZOOM}/${tile.x}/${tile.y}/2/1_0.png`;
  }

  function clock(time) {
    return new Date(time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function frameLabel(frame, now) {
    if (!frame) return 'RAIN MAP UNAVAILABLE';
    if (frame.kind === 'radar') return `RADAR ${clock(frame.time)}`;
    const minutes = Math.round((frame.time - now) / 60000 / STEP_MINUTES) * STEP_MINUTES;
    const ahead = minutes >= 60 ? `+${Math.floor(minutes / 60)}H${minutes % 60 ? String(minutes % 60).padStart(2, '0') : ''}` : `+${minutes}M`;
    return `FORECAST ${clock(frame.time)} · ${ahead}`;
  }

  // ---- Browser rendering -------------------------------------------------

  const state = { frames: [], index: 0, radar: null, forecast: [], radarImage: null, radarFetched: 0, forecastFetched: 0, playing: null, now: Date.now(), pending: 2, touched: false };

  // Ask for CORS so the tile can be recoloured; if the server refuses, load
  // it plainly and draw it greyscale instead.
  function loadImage(src, cors = true) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      if (cors) image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => (cors ? loadImage(src, false).then(resolve, reject) : reject(new Error('tile')));
      image.src = src;
    });
  }

  async function buildRadarImage(frame) {
    const extent = mapExtent(window.CligmetStationMap.PROJECTION);
    const { tiles, origin, size } = radarTiles(extent);
    const left = Math.floor(origin.x), top = Math.floor(origin.y);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(origin.x + size.width) - left;
    canvas.height = Math.ceil(origin.y + size.height) - top;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const images = await Promise.all(tiles.map(tile => loadImage(tileUrl(frame, tile)).then(image => ({ tile, image }))));
    images.forEach(({ tile, image }) => context.drawImage(image, tile.x * RADAR_TILE - left, tile.y * RADAR_TILE - top));
    let raw = false;
    try {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const cache = new Map();
      const data = pixels.data;
      for (let i = 0; i < data.length; i += 4) {
        const key = (data[i] << 24 | data[i + 1] << 16 | data[i + 2] << 8 | data[i + 3]) >>> 0;
        let alpha = cache.get(key);
        if (alpha === undefined) { alpha = alphaForRate(rateFromColour(data[i], data[i + 1], data[i + 2], data[i + 3])); cache.set(key, alpha); }
        data[i] = INK[0]; data[i + 1] = INK[1]; data[i + 2] = INK[2]; data[i + 3] = Math.round(alpha * 255);
      }
      context.putImageData(pixels, 0, 0);
    } catch {
      raw = true; // Tiles without CORS can be drawn but not recoloured.
    }
    return { canvas, raw, source: { x: origin.x - left, y: origin.y - top, width: size.width, height: size.height } };
  }

  function forecastImage(frame) {
    const canvas = document.createElement('canvas');
    canvas.width = GRID.cols;
    canvas.height = GRID.rows;
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(GRID.cols, GRID.rows);
    frame.rates.forEach((rate, i) => {
      pixels.data.set([...INK, Math.round(alphaForRate(rate ?? 0) * 255)], i * 4);
    });
    context.putImageData(pixels, 0, 0);
    return canvas;
  }

  function draw() {
    const canvas = document.getElementById('stationRadar');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    const frame = state.frames[state.index];
    if (frame?.kind === 'radar' && state.radarImage) {
      const { canvas: image, raw, source } = state.radarImage;
      // Unrecoloured tiles become a flat grey rain/no-rain silhouette, since
      // greyscaling their colours would make heavy (yellow/red) rain look lighter.
      context.filter = raw ? 'brightness(0) opacity(0.4)' : 'none';
      context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, width, height);
      context.filter = 'none';
    } else if (frame?.kind === 'forecast') {
      // Grid points sit on the extent's edges, so the cells overhang by half a step.
      const cellWidth = width / (GRID.cols - 1), cellHeight = height / (GRID.rows - 1);
      context.filter = `blur(${Math.round(Math.min(cellWidth, cellHeight) * 0.18)}px)`;
      context.drawImage(forecastImage(frame), -cellWidth / 2, -cellHeight / 2, width + cellWidth, height + cellHeight);
      context.filter = 'none';
    }
    renderControls();
  }

  function renderControls() {
    const slider = document.getElementById('radarTime');
    const readout = document.getElementById('radarReadout');
    const play = document.getElementById('radarPlay');
    const frame = state.frames[state.index];
    const dry = frame && (frame.kind === 'forecast' ? frame.rates.every(rate => !(rate >= MIN_RATE)) : state.radarImage?.dry);
    const label = !frame && state.pending ? 'RAIN MAP LOADING' : frameLabel(frame, state.now) + (dry ? ' · DRY' : '');
    if (readout) readout.textContent = label;
    if (slider) {
      slider.max = String(Math.max(0, state.frames.length - 1));
      slider.value = String(state.index);
      slider.disabled = state.frames.length < 2;
      slider.setAttribute('aria-valuetext', label);
    }
    if (play) {
      play.disabled = state.frames.length < 2;
      play.textContent = state.playing ? '❚❚' : '▶';
      play.setAttribute('aria-label', state.playing ? 'Pause rain timeline' : 'Play rain timeline');
    }
    const container = document.getElementById('stationMap');
    if (container) container.dataset.rainFrame = frame?.kind || 'none';
  }

  function rebuildFrames() {
    const current = state.frames[state.index];
    state.frames = [state.radar, ...state.forecast.filter(frame => frame.time > (state.radar?.time ?? 0))].filter(Boolean);
    // Open on the live frame; once someone has moved the timeline, stay on
    // the frame they chose when new data arrives.
    const keep = state.touched && current ? state.frames.findIndex(frame => frame.kind === current.kind && frame.time === current.time) : 0;
    state.index = Math.max(0, keep);
    draw();
  }

  async function refreshRadar() {
    state.radarFetched = Date.now();
    try {
      const response = await fetch(RAINVIEWER_URL, { cache: 'no-store', credentials: 'omit' });
      const frame = latestRadarFrame(await response.json());
      if (!frame) throw new Error('no-radar');
      if (frame.time !== state.radar?.time) {
        const image = await buildRadarImage(frame);
        image.dry = !image.raw && !hasInk(image.canvas);
        state.radar = frame;
        state.radarImage = image;
      }
    } catch {
      state.radar = null;
      state.radarImage = null;
    }
    state.pending = Math.max(0, state.pending - 1);
    rebuildFrames();
  }

  function hasInk(canvas) {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  }

  async function refreshForecast() {
    state.forecastFetched = Date.now();
    state.now = Date.now();
    try {
      const points = gridPoints(mapExtent(window.CligmetStationMap.PROJECTION));
      const response = await fetch(forecastUrl(points), { credentials: 'omit' });
      if (!response.ok) throw new Error('forecast');
      state.forecast = forecastFrames(await response.json(), state.now);
    } catch {
      state.forecast = [];
    }
    state.pending = Math.max(0, state.pending - 1);
    rebuildFrames();
  }

  function step() {
    if (state.index >= state.frames.length - 1) { stop(); return; }
    state.index += 1;
    draw();
  }

  function stop() {
    clearInterval(state.playing);
    state.playing = null;
    renderControls();
  }

  function init() {
    const canvas = document.getElementById('stationRadar');
    if (!canvas || !window.CligmetStationMap) return;
    document.getElementById('radarTime')?.addEventListener('input', event => {
      const index = Number(event.target.value) || 0;
      stop();
      state.touched = true;
      state.index = index;
      draw();
    });
    document.getElementById('radarPlay')?.addEventListener('click', () => {
      if (state.playing) { stop(); return; }
      state.touched = true;
      if (state.index >= state.frames.length - 1) state.index = 0;
      state.playing = setInterval(step, 700);
      draw();
    });
    if ('ResizeObserver' in window) new ResizeObserver(() => draw()).observe(canvas);
    refreshRadar();
    refreshForecast();
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - state.radarFetched >= RADAR_REFRESH) refreshRadar();
      if (Date.now() - state.forecastFetched >= FORECAST_REFRESH) refreshForecast();
    }, 60000);
  }

  if (typeof document !== 'undefined' && typeof window.CligmetStationMap !== 'undefined') init();

  function status() {
    return { loading: state.pending > 0, index: state.index, frames: state.frames.map(frame => frame.kind), radarRecoloured: state.radarImage ? !state.radarImage.raw : null };
  }

  return { status, GRID, FORECAST_STEPS, rateFromDbz, rateFromColour, alphaForRate, mapExtent, gridPoints, forecastUrl, forecastFrames, mercator, radarTiles, latestRadarFrame, tileUrl, frameLabel };
})();
