'use strict';

window.CligmetStations = (() => {
  const VALID = Object.freeze(['ILONDO1066', 'ILONDO327']);

  function normaliseSelection(value) {
    const text = String(value ?? '').trim();
    if (text.toLowerCase() === 'both') return 'both';
    const station = text.toUpperCase();
    return VALID.includes(station) ? station : 'both';
  }

  function snapshotUrl(baseUrl, stationId) {
    const url = new URL(baseUrl, window.location?.href || 'https://cligmet.xyz/');
    url.searchParams.set('station_id', stationId);
    return url;
  }

  function stationsUrl(baseUrl) {
    const base = new URL(baseUrl, window.location?.href || 'https://cligmet.xyz/');
    return new URL('stations.json', base);
  }

  function fulfilledSnapshots(results) {
    return new Map(results
      .filter(result => result?.status === 'fulfilled' && Array.isArray(result.value) && result.value.length === 2)
      .map(result => result.value));
  }

  return { VALID, normaliseSelection, snapshotUrl, stationsUrl, fulfilledSnapshots };
})();
