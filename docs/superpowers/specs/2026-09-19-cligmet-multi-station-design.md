# cligMET Multi-Station Design

Date: 2026-09-19  
Status: Approved design, pending implementation plan

## Goal

Extend cligMET from one Weather Underground station to two independent stations:

- `ILONDO1066`
- `ILONDO327`

Each station must have its own current observations, retained history, cligMET forecast, forecast verification, calibration state, calibration history, and live/error status.

The public website must allow the user to select:

`BOTH · ILONDO1066 · ILONDO327`

`BOTH` is the default. In BOTH mode the site overlays the two stations without averaging them.

The change must preserve all existing ILONDO1066 history and calibration state and must not weaken the existing Render-cache self-heal/backfill behavior.

## Selected Architecture

Use one home publisher, one home SQLite database, one Render receiver, and one public website.

Keep the current schema-v1 public snapshot shape. The publisher generates and posts one complete schema-v1 snapshot per station rather than introducing a multi-station schema-v2 payload.

Conceptually:

```text
Home publisher
  ├── ILONDO1066
  │     ├── WU observations
  │     ├── cligMET forecast
  │     ├── verification
  │     └── independent calibration
  │
  └── ILONDO327
        ├── WU observations
        ├── cligMET forecast
        ├── verification
        └── independent calibration

        ↓ two authenticated POST /publish requests

Render receiver
  ├── latest snapshot: ILONDO1066
  ├── latest snapshot: ILONDO327
  └── shared station-partitioned history archive

        ↓

Public site
  └── BOTH / ILONDO1066 / ILONDO327
```

This preserves compatibility with the existing snapshot format and existing history archive while making station identity explicit throughout the system.

## Compatibility Rules

1. Existing ILONDO1066 observations, forecast runs, forecast verification records and calibration controls must be retained.
2. Existing public `GET /snapshot.json` without a station query must continue to return ILONDO1066.
3. Existing schema-v1 snapshots remain valid.
4. Existing `/history.json?station_id=...` and `/calibration-history.json?station_id=...` remain valid.
5. A failure affecting ILONDO327 must not stop ILONDO1066 from collecting, forecasting or publishing, and vice versa.
6. One station publishing must never overwrite the other station's latest live snapshot.
7. The home database remains the durable source of historical observations; Render remains a public cache/archive that can be rebuilt after loss.
8. No WU API key or publish token is exposed in public snapshots or public receiver endpoints.

---

# 1. Home Publisher

## 1.1 Existing state to preserve

The current home publisher already has station-partitioned:

- `observations.station_id`
- `forecast_runs.station_id`
- forecast points linked to station-specific forecast runs
- historical backfill grouped by `station_id`

The current single-station assumptions are concentrated in:

- the singleton `settings` row;
- global `app_status` keys;
- `coefficient_history` without a station column;
- database methods that internally call `settings()` to discover one active station;
- collection/forecast/calibration functions that operate on that implicit active station;
- `public_snapshot()` and `publish_snapshot()`, which produce one active-station snapshot.

The migration should extend these boundaries rather than replace the existing observation/forecast model.

## 1.2 Station profiles

Define the configured station set explicitly. Version 1 of multi-station cligMET has exactly:

```text
PRIMARY_STATION = ILONDO1066
STATIONS = [ILONDO1066, ILONDO327]
```

The implementation should centralise these identifiers in one configuration layer rather than scattering literals across collection, publishing and UI code.

The shared WU API key remains a global secret. Each station profile has independent forecast/calibration settings.

## 1.3 Database migration

### Global settings

Keep the existing singleton `settings` row for global/shared configuration and backward compatibility, especially:

- WU API key
- units
- primary/default station identifier

The existing `station_id` field in that row remains the primary/default station and is expected to remain `ILONDO1066`.

Per-station forecast/calibration values move to a new table.

### New `station_settings`

Create:

```sql
CREATE TABLE station_settings (
    station_id TEXT PRIMARY KEY,
    temperature_offset REAL NOT NULL DEFAULT 0,
    station_bias_influence REAL NOT NULL DEFAULT 1,
    pressure_trend_influence REAL NOT NULL DEFAULT 0.30,
    temperature_responsiveness REAL NOT NULL DEFAULT 1.50,
    local_rain_influence REAL NOT NULL DEFAULT 0.20,
    calibration_mode TEXT NOT NULL DEFAULT 'auto',
    calibration_paused INTEGER NOT NULL DEFAULT 0,
    calibration_days INTEGER NOT NULL DEFAULT 30,
    minimum_verified_hours INTEGER NOT NULL DEFAULT 168,
    last_calibration_run TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

Migration behavior:

1. Read the current singleton `settings` row.
2. Insert an `ILONDO1066` station-settings row using the current control and calibration values exactly.
3. Insert an `ILONDO327` row using the normal cligMET default controls/calibration values.
4. Do not alter existing observations or forecast runs.
5. Migration must be transactional and idempotent.

### New `station_status`

Create:

```sql
CREATE TABLE station_status (
    station_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (station_id, key)
);
```

Per-station keys include:

- `syncing`
- `last_success`
- `last_history_success`
- `last_error`
- `last_model_error`
- `last_forecast`
- `last_publish_success`
- `last_publish_error`

The existing `app_status` table remains for genuinely global/UI settings such as display preferences and any non-station-specific service status.

### `coefficient_history`

Migrate coefficient history to include `station_id`.

All existing rows are assigned to the primary station `ILONDO1066`.

Fresh schema:

```sql
CREATE TABLE coefficient_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    source TEXT NOT NULL,
    mode TEXT NOT NULL,
    reason TEXT NOT NULL,
    controls_json TEXT NOT NULL,
    verified_hours INTEGER NOT NULL DEFAULT 0,
    cligmet_mae REAL,
    model_mae REAL
);
CREATE INDEX idx_coefficient_history_station_time
    ON coefficient_history(station_id, timestamp);
```

For an existing SQLite database, perform a transactional table rebuild/copy rather than leaving historical rows with a nullable station ID.

## 1.4 Database API changes

Station-dependent methods must take a station ID explicitly rather than discovering an implicit active station.

Examples:

```text
settings(station_id, reveal_key=False)
controls(station_id)
station_status(station_id)
set_station_status(station_id, key, value)

observation_rows(station_id, hours)
latest_observation(station_id)
station_coordinates(station_id)

store_forecast(station_id, ...)
latest_forecast(station_id, hours)
past_forecast(station_id, hours)
verify_forecasts(station_id)

calibration_records(station_id)
calibration_metrics(station_id)
append_coefficient_snapshot(station_id, ...)
coefficient_history(station_id, ...)
save_controls(station_id, ...)
set_calibration(station_id, ...)
```

Where a station ID enters from HTTP or configuration, normalise it to uppercase and require it to be one of the configured stations.

## 1.5 Weather Underground collection

Refactor the WU fetch path to accept a station ID:

```text
fetch_wu(endpoint, source, station_id)
```

Each request uses the same shared API key but the requested station's ID.

Normal collection cycle:

```text
for station in STATIONS:
    sync_station(station, include_history)
```

`sync_station()` performs:

1. current WU fetch;
2. optional seven-day WU history fetch;
3. verification of that station's previous forecasts;
4. generation/storage of that station's forecast;
5. independent auto-calibration;
6. update of that station's status.

Errors are isolated per station. The outer cycle records failure and continues with the next station.

The existing process-level sync lock can remain to prevent overlapping collection cycles.

## 1.6 Forecast generation

Forecast generation must accept a station ID throughout.

The station's most recent coordinates continue to come from its own stored WU observations. Open-Meteo requests/cache entries therefore resolve independently by location.

Each forecast run must use:

- only that station's observations;
- that station's current controls;
- that station's stored forecast history;
- that station's verification data.

No measured values, local bias, pressure trend or rain adjustment may cross between stations.

## 1.7 Independent calibration

Calibration operates independently per station.

`auto_calibrate(station_id)` must:

- read only that station's verified forecast points;
- respect that station's calibration mode, pause state, window and minimum verified hours;
- update only that station's controls;
- append only that station's coefficient-history event;
- update only that station's `last_calibration_run`.

ILONDO1066 begins with its migrated current controls and coefficient history.

ILONDO327 begins with a new initial coefficient-history event containing default controls and then accumulates its own verification window.

## 1.8 Public snapshots

Change:

```text
public_snapshot()
```

to:

```text
public_snapshot(station_id)
```

The returned JSON shape remains schema version 1.

Every section is station-specific:

- `settings.station_id`
- public station settings and controls
- station status
- current observation and pressure trends
- 72-hour measured history
- latest forecast
- past forecast
- calibration payload/history

No snapshot may contain data belonging to the other station.

## 1.9 Publishing

Change the publish cycle from one snapshot to two station-isolated uploads.

```text
for station in STATIONS:
    publish_snapshot(station)
```

Each station gets its own success/error status.

A failed upload for one station does not prevent the other upload.

The normal public-publish interval remains unchanged unless later operational evidence shows the WU/API load needs adjustment.

## 1.10 Local publisher API

Preserve the home publisher's management UI/API by making station choice explicit where needed.

Add:

```text
GET /api/stations
```

and allow station-specific reads/updates such as:

```text
GET /api/settings?station_id=ILONDO1066
GET /api/current?station_id=ILONDO327
GET /api/history?...&station_id=...
GET /api/forecast?station_id=...
GET /api/calibration?station_id=...
```

Station-setting writes target one station's controls/calibration while WU API-key changes remain global.

The local home dashboard does not need a major visual redesign as part of this public multi-station project; compatibility and safe station selection are sufficient.

---

# 2. History Backfill and Self-Heal

## 2.1 Home backfill

The existing history backfill already groups hourly observation means by `station_id`. Preserve that behavior.

Once ILONDO327 data exists in `observations`, a normal unfiltered backfill transfers both stations independently.

No combined history payload is introduced.

## 2.2 Automatic public-cache repair

The installed history-sync/self-heal process must enumerate all stations present in the home archive rather than assuming only ILONDO1066.

For each station independently:

1. determine local hourly coverage;
2. query receiver availability for that station;
3. compare hour count and coverage boundaries;
4. import that station's missing/incomplete history if necessary;
5. verify that station's receiver coverage after repair.

A complete ILONDO1066 cache must not suppress repair of an incomplete ILONDO327 cache.

A repair for one station must not replace either live snapshot.

---

# 3. Render Receiver

## 3.1 Multi-station live snapshot storage

The current receiver has one `SNAPSHOT_FILE`, so whichever station publishes last would otherwise become the only live snapshot.

Replace that behavior with station-keyed snapshot files.

Treat `SNAPSHOT_FILE` as a base path/configuration root, while generating safe station-specific paths internally, for example:

```text
/tmp/cligmet_snapshot.ILONDO1066.json
/tmp/cligmet_snapshot.ILONDO327.json
```

Station IDs used in filenames must first be validated/normalised against a conservative identifier format; raw path input must never be accepted.

Writes remain atomic via temporary file + `os.replace`.

## 3.2 Default station

Define:

```text
DEFAULT_STATION_ID=ILONDO1066
```

Public compatibility rule:

```text
GET /snapshot.json
```

is equivalent to:

```text
GET /snapshot.json?station_id=ILONDO1066
```

The default must not depend on whichever station published most recently.

## 3.3 Publishing

`POST /publish` continues accepting a normal schema-v1 snapshot.

The receiver:

1. validates/authenticates as today;
2. validates `settings.station_id`;
3. archives the snapshot into the existing station-partitioned archive;
4. compares `generated_at` only against that same station's current live snapshot;
5. updates only that station's snapshot file.

An older ILONDO1066 payload cannot replace a newer ILONDO1066 snapshot, but it has no bearing on ILONDO327's snapshot timestamp.

## 3.4 Station discovery endpoint

Add:

```text
GET /stations.json
```

Response shape:

```json
{
  "default_station_id": "ILONDO1066",
  "stations": [
    {
      "station_id": "ILONDO1066",
      "snapshot_available": true,
      "generated_at": "2026-09-19T18:00:00Z",
      "observation_at": "2026-09-19T17:59:00Z",
      "age_seconds": 60,
      "status": "fresh"
    },
    {
      "station_id": "ILONDO327",
      "snapshot_available": true,
      "generated_at": "2026-09-19T18:00:02Z",
      "observation_at": "2026-09-19T17:58:00Z",
      "age_seconds": 120,
      "status": "fresh"
    }
  ]
}
```

`status` is descriptive receiver freshness metadata such as `fresh`, `stale` or `missing`; the website still evaluates detailed snapshot/source errors itself.

Only configured/published stations need be returned. The endpoint contains no secrets.

## 3.5 Snapshot endpoint

Support:

```text
GET /snapshot.json?station_id=ILONDO1066
GET /snapshot.json?station_id=ILONDO327
```

Unknown or unavailable stations return 404.

The query parameter is read-only and bounded in length.

## 3.6 History and calibration endpoints

The existing history archive already partitions observations and coefficients by station.

Keep:

```text
/history.json?...&station_id=...
/calibration-history.json?station_id=...
```

Remove any fallback that infers station identity from a single latest snapshot.

If `station_id` is omitted, use `DEFAULT_STATION_ID`.

## 3.7 Archive bootstrap

At receiver startup, seed the public history archive from every station snapshot file found for the configured station set, not from one single snapshot.

Failure to read one station snapshot must not prevent the archive from opening or the other station from serving.

## 3.8 Health

Extend `/health` to report per-station snapshot state as well as shared archive state.

Example:

```json
{
  "ok": true,
  "version": "...",
  "default_station_id": "ILONDO1066",
  "stations": {
    "ILONDO1066": {
      "snapshot_available": true,
      "snapshot_generated_at": "...",
      "snapshot_age_seconds": 80
    },
    "ILONDO327": {
      "snapshot_available": true,
      "snapshot_generated_at": "...",
      "snapshot_age_seconds": 100
    }
  },
  "history_archive_ready": true,
  "history_archive_error": null
}
```

Shared archive failure remains separately visible.

---

# 4. Public Website

## 4.1 Station state

Replace the single `state.snapshot` assumption with:

```text
state.stations
state.snapshots = Map<stationId, snapshot>
state.stationSelection = "both" | "ILONDO1066" | "ILONDO327"
```

Persist the selection locally, e.g. `cligmet.station.v1`.

If there is no stored valid choice, default to `both`.

## 4.2 Startup and fallback

Normal startup:

1. fetch `/stations.json`;
2. identify available configured stations;
3. fetch both station snapshots when selection is BOTH;
4. fetch one snapshot when selection is a single station;
5. render available data.

Fallback:

If station discovery fails or is invalid, fetch the existing configured `/snapshot.json` URL exactly as the current site does and operate in single-station compatibility mode.

This allows receiver and website deployments to be staged independently.

## 4.3 Selector

Add a compact selector in the masthead close to the existing station identity:

```text
BOTH   ILONDO1066   ILONDO327
```

Requirements:

- keyboard accessible;
- clear selected state;
- works in normal and fullscreen-chart layouts;
- does not resemble a separate app navigation bar;
- fits the existing technical/editorial visual language;
- remembers the last choice.

If one station is temporarily unavailable, keep its selector visible but mark it unavailable/stale rather than silently changing the user's selection.

## 4.4 Current observations

### Single station

Preserve the current layout and behavior.

### BOTH

Do not average values.

Show the same metrics for both stations in a compact two-station comparison presentation:

- temperature
- humidity
- pressure
- wind
- rain
- solar irradiance
- pressure trend
- observation time
- freshness/status

Station labels must always remain visible.

A stale/offline station must not make the other station appear stale.

## 4.5 Chart series model

Charts need two independent visual dimensions:

1. station identity;
2. data type.

Station identity uses two consistent, accessible station colours.

Data type uses line style:

- measured: solid;
- forecast: dashed;
- archived/past forecast: dotted/lighter;
- uncertainty range: translucent fill in the corresponding station colour.

Single-station mode may keep the current visual treatment where practical.

Every generated chart series object must include `stationId`.

No combined/averaged line is produced.

## 4.6 Axes and domains

In BOTH mode, derive a common X domain and Y bounds from all visible series from both stations.

The forecast boundary may differ slightly by station. If the boundaries are effectively identical, one shared forecast marker is acceptable; otherwise render separate subtle station-labelled boundaries.

Missing periods remain gaps.

## 4.7 Crosshair/fullscreen readout

The existing fullscreen crosshair remains one shared timestamp selector.

At the selected timestamp, the readout shows available values for both stations, grouped by station.

For example:

```text
18:00

ILONDO1066
OBS  18.4 °C
FCST 18.1 °C

ILONDO327
OBS  17.9 °C
FCST 18.0 °C
```

Only series actually visible under the measured/forecast/archived/range controls are included.

The existing large floating overlay behavior remains.

## 4.8 History navigation

The existing `history-navigation.js` currently keys requests using one snapshot station ID.

Refactor it to operate on the selected station set.

In BOTH mode, for every requested time window:

```text
/history.json?...&station_id=ILONDO1066
/history.json?...&station_id=ILONDO327
```

may run in parallel.

Cache keys must include station ID.

One failed station request does not discard a successful response from the other station.

Availability/coverage is tracked per station so the website can say, for example, that ILONDO1066 has one year of data while ILONDO327 only has two weeks.

No browser-side merging of station values is permitted; the browser only combines independent series for rendering.

## 4.9 Forecast data

Each snapshot carries its own:

- latest forecast;
- uncertainty range;
- past forecast.

In BOTH mode charts display both independent forecast streams.

Current forecast/calibration controls remain station-specific and are never mathematically blended.

## 4.10 Calibration UI

Single-station mode continues to show the selected station's detailed calibration summary and coefficient history.

BOTH mode shows two compact independent summaries, including:

- calibration state;
- verified hours;
- cligMET MAE;
- model MAE;
- current controls.

Do not overlay all coefficient-history series from both stations on the existing detailed coefficient charts.

Detailed coefficient-history charts are shown only in single-station mode.

## 4.11 Status/freshness

Status is calculated per station from that station's:

- latest observation time;
- snapshot generation time;
- source error;
- syncing state.

BOTH mode shows a separate freshness state for each station.

The site-level state is usable as long as at least one requested station has valid data.

---

# 5. Data and Error Isolation

The following invariants are mandatory:

- ILONDO1066 data never contributes to ILONDO327 calibration.
- ILONDO327 data never contributes to ILONDO1066 calibration.
- One station's WU failure does not stop collection for the other.
- One station's model/forecast failure does not stop the other.
- One station's publishing failure does not stop the other.
- One station's receiver snapshot cannot overwrite the other.
- One station's history fetch failure does not erase the other station's chart data.
- A stale station is labelled stale individually.
- Unknown station IDs are rejected rather than implicitly becoming a new station.
- Public endpoints never return the WU API key or publish token.

---

# 6. Deployment Sequence

Deploy in this order.

## Phase 1 — Receiver

Deploy station-keyed snapshot storage, `/stations.json`, station-specific `/snapshot.json`, default-station compatibility and health changes.

Before any dual publishing begins, verify:

```text
/snapshot.json
/history.json?...&station_id=ILONDO1066
/calibration-history.json?station_id=ILONDO1066
/health
```

continue to work for ILONDO1066.

## Phase 2 — Home publisher

Back up `cligmet.db` using SQLite-safe backup procedures.

Run the idempotent schema migration.

Verify:

- ILONDO1066 controls match pre-migration values;
- ILONDO1066 observations/forecast runs remain;
- existing coefficient history is assigned to ILONDO1066;
- ILONDO327 has default independent station settings.

Start dual collection/forecast/publishing.

Verify both station snapshots at the receiver.

## Phase 3 — History/self-heal

Update the scheduled cache-repair worker to verify both stations.

Perform a dry run, then confirm both station coverages independently.

## Phase 4 — Public website

Deploy station discovery, selector, dual current panels and dual chart series.

Default to BOTH only once both receiver station snapshots are confirmed.

The compatibility fallback remains available.

---

# 7. Testing Requirements

## Home publisher tests

Add/extend tests proving:

1. migration copies existing singleton controls/calibration to ILONDO1066 exactly;
2. migration is idempotent;
3. coefficient history is assigned to ILONDO1066;
4. ILONDO327 gets its own defaults;
5. settings/control reads are station-specific;
6. status reads/writes are station-specific;
7. collection uses the requested WU station ID;
8. forecast generation reads only requested-station observations;
9. forecast verification is station-isolated;
10. auto-calibration is station-isolated;
11. one station sync failure does not block the other;
12. `public_snapshot(station)` contains only that station;
13. dual publish attempts both stations even when one fails.

## Backfill/self-heal tests

Prove:

1. all stations in the home DB are enumerated;
2. completeness is evaluated per station;
3. one complete station cannot mask another incomplete station;
4. repair imports only the intended station batch;
5. live snapshots are not replaced by history import.

## Receiver tests

Add tests proving:

1. a publish stores the snapshot under its station;
2. publishing station B cannot replace station A;
3. older same-station snapshot cannot replace newer same-station snapshot;
4. plain `/snapshot.json` returns ILONDO1066;
5. station-specific snapshot query returns the requested station;
6. `/stations.json` returns both and correct freshness metadata;
7. history and calibration defaults resolve to ILONDO1066 rather than last publisher;
8. history remains isolated;
9. archive bootstrap ingests both existing station snapshots;
10. a missing/corrupt station snapshot does not break the other station;
11. health reports both station states;
12. secret-field rejection and authentication remain unchanged.

## Website tests

Add JavaScript regression tests covering:

1. selection defaults to BOTH;
2. stored valid selection is restored;
3. invalid stored station falls back safely;
4. station discovery failure activates legacy single-snapshot fallback;
5. BOTH mode requests two snapshots;
6. single mode requests one snapshot;
7. current values are never averaged;
8. chart series carry station IDs;
9. history cache keys include station ID;
10. one history failure preserves the other station;
11. common chart bounds include both stations;
12. fullscreen crosshair readout shows both stations;
13. single-station coefficient history remains available;
14. BOTH mode does not draw combined coefficient-history lines.

## End-to-end acceptance

The feature is complete when:

- both stations collect successfully at home;
- both produce forecasts independently;
- both accumulate independent verification/calibration state;
- both publish independently;
- receiver exposes both snapshots simultaneously;
- Render history contains station-separated observations for both;
- self-heal verifies/repairs both;
- public website defaults to BOTH;
- selector switches instantly between BOTH and each individual station;
- BOTH charts overlay both independent station streams;
- existing ILONDO1066 history/calibration survives unchanged.

---

# 8. Out of Scope

This change does not include:

- mathematical fusion/averaging of the two stations;
- selecting one station as a calibration reference for the other;
- arbitrary user-created station management;
- more than the two configured stations in the public selector;
- separate Render services;
- schema-v2 combined public snapshots;
- notification/alert changes;
- Android-app-specific UI changes beyond inheriting the updated live website through WebView.

The architecture should make a future third configured station possible without another database rewrite, but the UI and acceptance scope for this release remain ILONDO1066 and ILONDO327 only.
