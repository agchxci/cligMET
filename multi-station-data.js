'use strict';

window.CligmetMultiStation = (() => {
  const STATIONS = Object.freeze(['ILONDO1066', 'ILONDO327']);

  function selectedIds(selection) {
    return selection === 'both' ? [...STATIONS] : STATIONS.includes(selection) ? [selection] : [...STATIONS];
  }

  function currentRows(snapshots, selection) {
    return selectedIds(selection)
      .map(stationId => {
        const snapshot = snapshots.get(stationId);
        const observation = snapshot?.current?.available ? snapshot.current.observation || null : null;
        return snapshot ? { stationId, snapshot, observation } : null;
      })
      .filter(Boolean);
  }

  function seriesSources(snapshots, histories, selection, preferences) {
    const output = [];
    for (const stationId of selectedIds(selection)) {
      const snapshot = snapshots.get(stationId);
      if (!snapshot) continue;
      if (preferences.measured) output.push({ stationId, kind: 'observed', points: histories.get(stationId) || [] });
      if (preferences.archived) output.push({ stationId, kind: 'archived', points: snapshot.past_forecast?.available ? snapshot.past_forecast.points || [] : [] });
      if (preferences.forecast) output.push({ stationId, kind: 'forecast', points: snapshot.forecast?.available ? snapshot.forecast.points || [] : [] });
    }
    return output;
  }

  return { STATIONS, selectedIds, currentRows, seriesSources };
})();
