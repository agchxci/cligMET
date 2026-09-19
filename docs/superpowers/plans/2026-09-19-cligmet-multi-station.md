# cligMET Multi-Station Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ILONDO327 as a fully independent cligMET station while preserving ILONDO1066, then expose BOTH / ILONDO1066 / ILONDO327 selection on the public site.

**Architecture:** Preserve the existing schema-v1 station snapshot format. The home publisher becomes explicitly station-aware and publishes one complete snapshot per station; the Render receiver stores one latest snapshot per station while keeping a shared station-keyed history archive; the website fetches one or both independent snapshots and overlays them without averaging.

**Tech Stack:** Python 3 / FastAPI / SQLite / httpx on the home publisher and receiver; vanilla JavaScript / SVG / HTML / CSS on the public site; pytest for Python tests; Node's built-in test runner for frontend regression tests; systemd on the home server.

**Spec:** `docs/superpowers/specs/2026-09-19-cligmet-multi-station-design.md`

## Global Constraints

- Primary/default station remains exactly `ILONDO1066`.
- Second station is exactly `ILONDO327`.
- Public selector is exactly `BOTH · ILONDO1066 · ILONDO327`.
- BOTH is the default for a new browser.
- Each station has independent current observations, forecast runs, forecast verification, controls, calibration state, coefficient history and status.
- Existing ILONDO1066 observations, forecast runs and current calibration controls/history must survive the migration.
- Keep public snapshot `schema_version: 1`; do not create a combined schema-v2 snapshot.
- Plain `GET /snapshot.json` remains backward-compatible and returns ILONDO1066.
- A failure in one station must not stop collection, forecasting, publishing or rendering for the other.
- Render history/self-heal remains station-partitioned and independently repairable.
- No station values are averaged/fused in the public site.
- WU API key and publish token remain private.
- Do not deploy the public site before the receiver and home publisher both support two stations.
- Back up the live home SQLite database with SQLite's backup API before applying the migration.

## Review Focus

1. **Legacy receiver snapshot during rollout:** an existing single `cligmet_snapshot.json` must still serve ILONDO1066 before the first post-upgrade publish; Task 1 adds a migration/fallback regression test.
2. **Partial station failure:** ILONDO327 WU/model/publish failure must not mark ILONDO1066 failed or abort the cycle; Tasks 3 and 4 pin this.
3. **Idempotent live DB migration:** restarting the upgraded home service repeatedly must not duplicate coefficient-history rows or reset ILONDO1066 controls; Task 2 pins this.
4. **Unequal historical coverage:** BOTH mode must render ILONDO1066 even if ILONDO327 has little/no history for the selected window; Tasks 5 and 7 pin this.
5. **Stale/invalid browser station preference:** values outside `both|ILONDO1066|ILONDO327` must fall back to BOTH without malformed API requests; Task 6 pins this.

---

### Task 1: Make the Render receiver store and serve station-keyed live snapshots

**Repository:** `agchxci/cligMET_render_receiver`

**Files:**
- Modify: `main.py`
- Modify: `test_receiver.py`
- Modify: `test_history.py`
- Modify: `README.md`
- Modify: `.github/workflows/render-smoke.yml`

**Interfaces:**
- Consumes: existing schema-v1 snapshot with `settings.station_id`.
- Produces:
  - `normalise_station_id(value: str | None) -> str`
  - `snapshot_path(station_id: str) -> Path`
  - `read_snapshot(station_id: str = DEFAULT_STATION_ID) -> dict | None`
  - `GET /stations.json`
  - `GET /snapshot.json?station_id=<id>`
  - default history/calibration station = `ILONDO1066`.

- [ ] **Step 1: Write failing tests for two latest snapshots and default compatibility**

Add to `test_receiver.py`:

```python
def station_snapshot(station, generated):
    value = sample_snapshot()
    value["generated_at"] = generated
    value["settings"] = {"station_id": station}
    value["current"] = {
        "available": True,
        "observation": {"timestamp": generated, "temperature": 20.0},
    }
    return value


def auth():
    return {"Authorization": "Bearer test-token"}


def test_two_station_snapshots_do_not_replace_each_other(tmp_path, monkeypatch):
    monkeypatch.chdir(Path(__file__).parent)
    receiver = load_receiver(tmp_path)
    client = TestClient(receiver.app)

    a = station_snapshot("ILONDO1066", "2026-09-19T12:00:00Z")
    b = station_snapshot("ILONDO327", "2026-09-19T12:01:00Z")

    assert client.post("/publish", json=a, headers=auth()).status_code == 200
    assert client.post("/publish", json=b, headers=auth()).status_code == 200

    assert client.get("/snapshot.json").json()["settings"]["station_id"] == "ILONDO1066"
    assert client.get("/snapshot.json?station_id=ILONDO1066").json()["generated_at"] == a["generated_at"]
    assert client.get("/snapshot.json?station_id=ILONDO327").json()["generated_at"] == b["generated_at"]


def test_older_payload_only_competes_with_same_station(tmp_path, monkeypatch):
    monkeypatch.chdir(Path(__file__).parent)
    receiver = load_receiver(tmp_path)
    client = TestClient(receiver.app)

    newer = station_snapshot("ILONDO1066", "2026-09-19T12:00:00Z")
    older = station_snapshot("ILONDO1066", "2026-09-19T11:00:00Z")
    other = station_snapshot("ILONDO327", "2026-09-19T10:00:00Z")

    for payload in (newer, older, other):
        assert client.post("/publish", json=payload, headers=auth()).status_code == 200

    assert client.get("/snapshot.json?station_id=ILONDO1066").json()["generated_at"] == newer["generated_at"]
    assert client.get("/snapshot.json?station_id=ILONDO327").json()["generated_at"] == other["generated_at"]
```

- [ ] **Step 2: Write the legacy-file rollout test**

Add:

```python
def test_legacy_single_snapshot_is_default_station_fallback(tmp_path, monkeypatch):
    monkeypatch.chdir(Path(__file__).parent)
    receiver = load_receiver(tmp_path)
    legacy = station_snapshot("ILONDO1066", "2026-09-19T09:00:00Z")
    Path(receiver.SNAPSHOT_FILE).write_text(json.dumps(legacy), encoding="utf-8")

    client = TestClient(receiver.app)
    result = client.get("/snapshot.json")

    assert result.status_code == 200
    assert result.json()["settings"]["station_id"] == "ILONDO1066"
```

Run:

```bash
python -m pytest -q test_receiver.py -k "two_station or older_payload or legacy_single"
```

Expected: FAIL because the receiver still has one live snapshot path.

- [ ] **Step 3: Add explicit station configuration and safe snapshot paths**

In `main.py`, add:

```python
import re

DEFAULT_STATION_ID = os.getenv("DEFAULT_STATION_ID", "ILONDO1066").strip().upper() or "ILONDO1066"
CONFIGURED_STATIONS = tuple(dict.fromkeys(
    value.strip().upper()
    for value in os.getenv("STATION_IDS", "ILONDO1066,ILONDO327").split(",")
    if value.strip()
))
STATION_RE = re.compile(r"^[A-Z0-9_-]{1,100}$")


def normalise_station_id(value: str | None) -> str:
    station = (value or DEFAULT_STATION_ID).strip().upper()
    if station not in CONFIGURED_STATIONS or not STATION_RE.fullmatch(station):
        raise HTTPException(404, "Unknown station")
    return station


def snapshot_path(station_id: str) -> Path:
    station = normalise_station_id(station_id)
    return SNAPSHOT_FILE.with_name(f"{SNAPSHOT_FILE.stem}.{station}{SNAPSHOT_FILE.suffix}")
```

Refactor `read_snapshot` and `write_snapshot`:

```python
def read_snapshot(station_id: str = DEFAULT_STATION_ID) -> dict[str, Any] | None:
    station = normalise_station_id(station_id)
    path = snapshot_path(station)
    candidates = [path]
    if station == DEFAULT_STATION_ID:
        candidates.append(SNAPSHOT_FILE)  # legacy rollout fallback
    with _LOCK:
        for candidate in candidates:
            try:
                payload = json.loads(candidate.read_text(encoding="utf-8"))
            except (FileNotFoundError, OSError, json.JSONDecodeError):
                continue
            settings = payload.get("settings")
            if isinstance(settings, dict) and str(settings.get("station_id", "")).strip().upper() == station:
                return payload
    return None


def write_snapshot(station_id: str, encoded: bytes) -> None:
    path = snapshot_path(station_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with _LOCK:
        temporary.write_bytes(encoded)
        os.replace(temporary, path)
```

- [ ] **Step 4: Make publish compare timestamps per station**

Inside `publish`:

```python
settings = payload.get("settings")
station = normalise_station_id(settings.get("station_id") if isinstance(settings, dict) else None)

with _LOCK:
    try:
        get_archive().ingest(payload)
        _ARCHIVE_ERROR = None
    except (OSError, sqlite3.Error, ValueError, TypeError):
        logger.exception("Could not archive published weather history")
        _ARCHIVE_ERROR = "History could not be saved; check receiver logs and storage."
        archive_ok = False
    current = read_snapshot(station)
    current_date = parse_iso(current.get("generated_at")) if current else None
    incoming_date = parse_iso(payload["generated_at"])
    if not current_date or incoming_date >= current_date:
        write_snapshot(station, encoded)
```

Return `"station_id": station` in the publish response.

- [ ] **Step 5: Add station discovery tests**

Add:

```python
def test_stations_endpoint_reports_both_station_states(tmp_path, monkeypatch):
    monkeypatch.chdir(Path(__file__).parent)
    receiver = load_receiver(tmp_path)
    client = TestClient(receiver.app)

    client.post("/publish", json=station_snapshot("ILONDO1066", "2026-09-19T12:00:00Z"), headers=auth())
    client.post("/publish", json=station_snapshot("ILONDO327", "2026-09-19T12:01:00Z"), headers=auth())

    data = client.get("/stations.json").json()
    assert data["default_station_id"] == "ILONDO1066"
    assert [row["station_id"] for row in data["stations"]] == ["ILONDO1066", "ILONDO327"]
    assert all(row["snapshot_available"] for row in data["stations"])
```

Run it and verify RED.

- [ ] **Step 6: Implement `/stations.json` and station-specific snapshot query**

Add helpers:

```python
def station_snapshot_status(station_id: str) -> dict[str, Any]:
    snapshot = read_snapshot(station_id)
    generated = parse_iso(snapshot.get("generated_at")) if snapshot else None
    current = snapshot.get("current", {}) if snapshot else {}
    observation = current.get("observation", {}) if isinstance(current, dict) else {}
    observed = parse_iso(observation.get("timestamp")) if isinstance(observation, dict) else None
    age = max(0, int((datetime.now(timezone.utc) - generated).total_seconds())) if generated else None
    return {
        "station_id": station_id,
        "snapshot_available": bool(snapshot),
        "generated_at": snapshot.get("generated_at") if snapshot else None,
        "observation_at": observation.get("timestamp") if isinstance(observation, dict) else None,
        "age_seconds": age,
        "status": "missing" if not snapshot else ("fresh" if age is not None and age <= 900 else "stale"),
    }
```

Routes:

```python
@app.get("/stations.json")
def stations() -> JSONResponse:
    return archive_response({
        "default_station_id": DEFAULT_STATION_ID,
        "stations": [station_snapshot_status(station) for station in CONFIGURED_STATIONS],
    })


@app.get("/snapshot.json")
def snapshot(station_id: str | None = Query(default=None, max_length=100)) -> JSONResponse:
    station = normalise_station_id(station_id)
    payload = read_snapshot(station)
    if not payload:
        raise HTTPException(404, "No snapshot has been published for this station")
    return JSONResponse(
        payload,
        headers={
            "Cache-Control": "no-store, max-age=0",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    )
```

- [ ] **Step 7: Make archive bootstrap and default history station deterministic**

Replace `current_station` with:

```python
def current_station(requested: str | None = None) -> str:
    return normalise_station_id(requested)
```

In `get_archive()`, seed all available station snapshots:

```python
archive = Archive(HISTORY_DB)
for station in CONFIGURED_STATIONS:
    existing = read_snapshot(station)
    if existing:
        archive.ingest(existing)
```

Add a test in `test_history.py` that publishing B last does not change the default history/calibration station.

- [ ] **Step 8: Extend health and smoke tests**

`/health` must include:

```python
"default_station_id": DEFAULT_STATION_ID,
"stations": {station: station_snapshot_status(station) for station in CONFIGURED_STATIONS},
```

Retain the existing top-level archive fields.

Update `.github/workflows/render-smoke.yml` to verify:

```bash
curl -fsS "$BASE_URL/health"
curl -fsS "$BASE_URL/stations.json"
curl -fsS "$BASE_URL/snapshot.json?station_id=ILONDO1066"
test "$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/history/import")" = "401"
```

- [ ] **Step 9: Run receiver verification**

Run:

```bash
python -m pytest -q
```

Expected: all tests PASS.

- [ ] **Step 10: Commit receiver changes**

```bash
git add main.py test_receiver.py test_history.py README.md .github/workflows/render-smoke.yml
git commit -m "feat: support independent station snapshots"
```

---

### Task 2: Add an idempotent per-station database migration to the home publisher

**Source package:** current `cligMET_home_publisher_v1.1.2` home package.

**Files:**
- Modify: `home/cligmet.py`
- Modify: `home/test_cligmet.py`
- Create: `home/test_multistation.py`
- Modify: `home/README.md`

**Interfaces:**
- Produces:
  - `PRIMARY_STATION_ID = "ILONDO1066"`
  - `STATION_IDS = ("ILONDO1066", "ILONDO327")`
  - `normalise_station_id(value: str) -> str`
  - `Database.settings(station_id=PRIMARY_STATION_ID, reveal_key=False)`
  - `Database.controls(station_id)`
  - `Database.station_status(station_id)`
  - `Database.set_station_status(station_id, key, value)`.

- [ ] **Step 1: Create a migration snapshot test before changing schema**

Create `home/test_multistation.py` with the module loader first:

```python
import importlib
import os
from pathlib import Path

import pytest


def load_cligmet(tmp_path, monkeypatch):
    monkeypatch.setenv("CLIGMET_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("CLIGMET_STATION_IDS", "ILONDO1066,ILONDO327")
    import cligmet
    return importlib.reload(cligmet)
```

Then create a legacy DB using the current schema, set non-default ILONDO1066 controls, and add one coefficient-history row:

```python
def test_migration_preserves_primary_controls_and_history(tmp_path, monkeypatch):
    module = load_cligmet(tmp_path, monkeypatch)
    db = module.Database(tmp_path / "cligmet.db")
    db.init()

    with db.connect() as con:
        con.execute(
            """UPDATE settings SET temperature_offset=?, station_bias_influence=?,
               pressure_trend_influence=?, temperature_responsiveness=?,
               local_rain_influence=?, calibration_mode=?, calibration_paused=?,
               calibration_days=?, minimum_verified_hours=? WHERE id=1""",
            (1.25, 0.8, 0.42, 1.7, 0.15, "auto", 1, 45, 240),
        )
        con.execute("DELETE FROM coefficient_history")
        con.execute(
            """INSERT INTO coefficient_history
               (timestamp,source,mode,reason,controls_json,verified_hours)
               VALUES (?,?,?,?,?,?)""",
            ("2026-09-01T00:00:00Z", "auto", "auto", "legacy", '{"temperature_offset":1.25}', 200),
        )

    # Calling init again represents upgrading/restarting the service.
    db.init()

    settings = db.settings("ILONDO1066", reveal_key=True)
    assert settings["controls"]["temperature_offset"] == 1.25
    assert settings["controls"]["station_bias_influence"] == 0.8
    assert settings["calibration"]["paused"] is True

    history = db.coefficient_history("ILONDO1066")
    assert len(history) == 1
    assert history[0]["reason"] == "legacy"
```

Also add:

```python
def test_migration_is_idempotent(tmp_path, monkeypatch):
    module = load_cligmet(tmp_path, monkeypatch)
    db = module.Database(tmp_path / "cligmet.db")
    db.init()
    before = db.coefficient_history("ILONDO1066")
    db.init()
    db.init()
    after = db.coefficient_history("ILONDO1066")
    assert len(after) == len(before)
```

Run and verify RED.

- [ ] **Step 2: Add configured-station validation**

At module constants:

```python
PRIMARY_STATION_ID = "ILONDO1066"
STATION_IDS = tuple(dict.fromkeys(
    value.strip().upper()
    for value in os.getenv("CLIGMET_STATION_IDS", "ILONDO1066,ILONDO327").split(",")
    if value.strip()
))


def normalise_station_id(value: str) -> str:
    station = str(value or "").strip().upper()
    if station not in STATION_IDS:
        raise ValueError(f"Unknown station: {station or '(blank)'}")
    return station
```

Keep `DEFAULT_STATION_ID = PRIMARY_STATION_ID` for older code paths during migration.

- [ ] **Step 3: Add `station_settings` and `station_status`**

Inside `Database.init()`, create:

```sql
CREATE TABLE IF NOT EXISTS station_settings (
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

CREATE TABLE IF NOT EXISTS station_status (
    station_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (station_id, key)
);
```

Copy the singleton controls to primary only when no primary row exists:

```python
legacy = con.execute("SELECT * FROM settings WHERE id=1").fetchone()
con.execute(
    """INSERT OR IGNORE INTO station_settings
       (station_id,temperature_offset,station_bias_influence,pressure_trend_influence,
        temperature_responsiveness,local_rain_influence,calibration_mode,calibration_paused,
        calibration_days,minimum_verified_hours,last_calibration_run,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
    (
        PRIMARY_STATION_ID,
        legacy["temperature_offset"], legacy["station_bias_influence"],
        legacy["pressure_trend_influence"], legacy["temperature_responsiveness"],
        legacy["local_rain_influence"], legacy["calibration_mode"],
        legacy["calibration_paused"], legacy["calibration_days"],
        legacy["minimum_verified_hours"], legacy["last_calibration_run"],
        now, now,
    ),
)
```

Insert ILONDO327 with `Controls()` defaults and normal auto-calibration defaults via `INSERT OR IGNORE`.

- [ ] **Step 4: Transactionally migrate coefficient history**

Check the schema with:

```python
columns = {row["name"] for row in con.execute("PRAGMA table_info(coefficient_history)")}
```

If `station_id` is absent, in the same transaction:

```sql
ALTER TABLE coefficient_history RENAME TO coefficient_history_legacy;

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

INSERT INTO coefficient_history
(id,station_id,timestamp,source,mode,reason,controls_json,verified_hours,cligmet_mae,model_mae)
SELECT id,'ILONDO1066',timestamp,source,mode,reason,controls_json,verified_hours,cligmet_mae,model_mae
FROM coefficient_history_legacy;

DROP TABLE coefficient_history_legacy;

CREATE INDEX idx_coefficient_history_station_time
ON coefficient_history(station_id,timestamp);
```

Only create an initial coefficient event for a station when that station has zero coefficient rows.

- [ ] **Step 5: Refactor settings/control/status reads**

Implement:

```python
def settings(self, station_id: str = PRIMARY_STATION_ID, reveal_key: bool = False) -> dict[str, Any]:
    station = normalise_station_id(station_id)
    with self.connect() as con:
        global_row = con.execute("SELECT * FROM settings WHERE id=1").fetchone()
        row = con.execute("SELECT * FROM station_settings WHERE station_id=?", (station,)).fetchone()
    controls = self.controls_from_row(row)
    key = global_row["api_key"] if reveal_key else ("configured" if global_row["api_key"] else "")
    return {
        "station_id": station,
        "api_key": key,
        "api_key_configured": bool(global_row["api_key"]),
        "configured": bool(global_row["api_key"]),
        "units": global_row["units"],
        "forecast": asdict(controls),
        "controls": asdict(controls),
        "display": self.display_options(),
        "calibration": {
            "mode": row["calibration_mode"],
            "paused": bool(row["calibration_paused"]),
            "calibration_days": row["calibration_days"],
            "minimum_verified_hours": row["minimum_verified_hours"],
            "last_run": row["last_calibration_run"],
        },
    }


def controls(self, station_id: str) -> Controls:
    station = normalise_station_id(station_id)
    with self.connect() as con:
        row = con.execute("SELECT * FROM station_settings WHERE station_id=?", (station,)).fetchone()
    return self.controls_from_row(row)


def set_station_status(self, station_id: str, key: str, value: str) -> None:
    station = normalise_station_id(station_id)
    with self.lock, self.connect() as con:
        con.execute(
            """INSERT INTO station_status(station_id,key,value) VALUES(?,?,?)
               ON CONFLICT(station_id,key) DO UPDATE SET value=excluded.value""",
            (station, key, value),
        )


def station_status(self, station_id: str) -> dict[str, Any]:
    station = normalise_station_id(station_id)
    with self.connect() as con:
        values = {r["key"]: r["value"] for r in con.execute(
            "SELECT key,value FROM station_status WHERE station_id=?", (station,)
        )}
        counts = {
            "observations": con.execute("SELECT COUNT(*) FROM observations WHERE station_id=?", (station,)).fetchone()[0],
            "forecast_runs": con.execute("SELECT COUNT(*) FROM forecast_runs WHERE station_id=?", (station,)).fetchone()[0],
        }
    return {
        **values,
        **counts,
        "syncing": str(values.get("syncing", "false")).lower() == "true",
        "last_success": values.get("last_success") or None,
        "last_history_success": values.get("last_history_success") or None,
        "last_error": values.get("last_error") or None,
    }
```

Keep `app_status` only for display/global values.

- [ ] **Step 6: Refactor coefficient/calibration methods to require station**

Update signatures and SQL filters:

```text
calibration_records(station_id)
calibration_metrics(station_id)
append_coefficient_snapshot(station_id, source, reason)
coefficient_history(station_id, limit=240)
save_controls(station_id, controls, source, reason, update_last_run=False)
set_calibration(station_id, **values)
```

All coefficient queries include `WHERE station_id=?`.

All settings updates target `station_settings WHERE station_id=?`.

- [ ] **Step 7: Run migration tests**

Run:

```bash
python -m pytest -q home/test_cligmet.py home/test_multistation.py
```

Expected: PASS.

- [ ] **Step 8: Create a pre-deploy DB backup helper**

Add a small command or documented Python invocation using SQLite backup API:

```bash
python - <<'PY'
import sqlite3
from pathlib import Path
src = Path("cligmet.db")
dst = Path("cligmet.pre-multistation.backup.db")
with sqlite3.connect(src) as source, sqlite3.connect(dst) as target:
    source.backup(target)
print(dst)
PY
```

Document that the live migration is not run until this file exists.

- [ ] **Step 9: Commit the home DB migration**

Commit/package the source changes as:

```text
feat: add per-station publisher state migration
```

---

### Task 3: Make home collection, forecast verification and calibration independently station-aware

**Files:**
- Modify: `home/cligmet.py`
- Modify: `home/test_multistation.py`

**Interfaces:**
- Consumes Task 2 station-aware DB methods.
- Produces:
  - `fetch_wu(endpoint, source, station_id)`
  - `generate_and_store_forecast(station_id)`
  - `auto_calibrate(station_id, force=False)`
  - `sync_station(station_id, include_history=False)`
  - `sync_once(include_history=False)` returning per-station results.

- [ ] **Step 1: Write a failing WU request station test**

Monkeypatch `httpx.AsyncClient.get` and assert the request params:

```python
@pytest.mark.asyncio
async def test_fetch_wu_uses_requested_station(tmp_path, monkeypatch):
    module = load_cligmet(tmp_path, monkeypatch)
    module.db.init()
    with module.db.connect() as con:
        con.execute("UPDATE settings SET api_key='secret' WHERE id=1")

    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "observations": [{
                    "stationID": "ILONDO327",
                    "epoch": 1789833600,
                    "lat": 51.5,
                    "lon": -0.12,
                    "humidity": 55,
                    "metric": {"temp": 19.0, "pressure": 1012.0},
                }]
            }

    async def fake_get(self, url, params=None, **kwargs):
        captured.update(params or {})
        return FakeResponse()

    monkeypatch.setattr(module.httpx.AsyncClient, "get", fake_get)
    await module.fetch_wu(module.WU_CURRENT_URL, "current", "ILONDO327")

    assert captured["stationId"] == "ILONDO327"
```

Run and verify RED.

- [ ] **Step 2: Refactor WU fetch/normalisation**

Change:

```python
async def fetch_wu(endpoint: str, source: str, station_id: str) -> int:
    station = normalise_station_id(station_id)
    settings = db.settings(station, reveal_key=True)
    if not settings["api_key"]:
        raise RuntimeError("Weather Underground API key is not configured")
    params = {
        "stationId": station,
        "format": "json",
        "units": "m",
        "numericPrecision": "decimal",
        "apiKey": settings["api_key"],
    }
    async with httpx.AsyncClient(
        timeout=25,
        headers={"User-Agent": f"{APP_NAME}/{APP_VERSION}"},
    ) as client:
        response = await client.get(endpoint, params=params)
        response.raise_for_status()
        payload = response.json()
    if payload.get("errors"):
        raise RuntimeError(payload["errors"][0].get("message", "Weather service error"))
    observations = payload.get("observations") or []
    if not observations:
        raise RuntimeError("The station returned no observations")
    rows = [normalise_observation(item, source, station) for item in observations]
    return db.store_observations(rows)
```

Ensure every normalised observation row gets `"station_id": station` from the explicit argument rather than implicit settings.

- [ ] **Step 3: Add station arguments throughout observation/forecast methods**

Refactor:

```python
def observation_rows(self, station_id: str, hours: int = 72) -> list[dict[str, Any]]:
    station = normalise_station_id(station_id)
    cutoff = int(time.time()) - hours * 3600
    with self.connect() as con:
        rows = con.execute(
            "SELECT * FROM observations WHERE station_id=? AND epoch>=? ORDER BY epoch",
            (station, cutoff),
        ).fetchall()
    return [dict(row) for row in rows]


def latest_observation(self, station_id: str) -> dict[str, Any] | None:
    station = normalise_station_id(station_id)
    with self.connect() as con:
        row = con.execute(
            "SELECT * FROM observations WHERE station_id=? ORDER BY epoch DESC LIMIT 1",
            (station,),
        ).fetchone()
    return dict(row) if row else None


def coordinates(self, station_id: str) -> tuple[float, float]:
    latest = self.latest_observation(station_id)
    latitude = finite(latest.get("latitude")) if latest else None
    longitude = finite(latest.get("longitude")) if latest else None
    return (
        latitude if latitude is not None else DEFAULT_LATITUDE,
        longitude if longitude is not None else DEFAULT_LONGITUDE,
    )
```

Apply the same explicit `station = normalise_station_id(station_id)` pattern to `latest_forecast`, `past_forecast` and `verify_forecasts`; their existing SQL bodies remain, but every forecast-run lookup/join must filter `forecast_runs.station_id=?`.

Every SQL query includes the explicit station.

For `forecast_points`, join through `forecast_runs` and filter `forecast_runs.station_id=?`.

- [ ] **Step 4: Write forecast isolation test**

Seed station A at 10 °C and station B at 30 °C, call the forecast preparation path for each, and assert each run records its own issue temperature/station ID.

The test must fail if `generate_and_store_forecast("ILONDO327")` accidentally reads the latest ILONDO1066 observation.

- [ ] **Step 5: Refactor forecast generation**

Change all helpers that currently reach into `db.settings()`, `db.controls()`, `db.latest_observation()`, `db.coordinates()` or `db.observation_rows()` to accept/pass the same `station_id`.

At forecast storage:

```python
db.store_forecast(
    station_id=station,
    issued_epoch=issued_epoch,
    method="cligmet-v3.2",
    controls=controls,
    issue_temperature=current["temperature"],
    raw_station_bias=raw_station_bias,
    recent_temperature_slope=recent_temperature_slope,
    model_latitude=latitude,
    model_longitude=longitude,
    points=forecast_points,
)
```

- [ ] **Step 6: Write calibration-isolation tests**

Seed verified forecast records for both stations with deliberately opposite biases.

Run:

```python
changed_a, _ = module.auto_calibrate("ILONDO1066", force=True)
controls_b_before = module.db.controls("ILONDO327")
controls_b_after = module.db.controls("ILONDO327")
assert controls_b_after == controls_b_before
```

Then run B and assert A remains unchanged.

- [ ] **Step 7: Refactor calibration**

Implement:

```python
def auto_calibrate(station_id: str, force: bool = False) -> tuple[bool, str]:
    station = normalise_station_id(station_id)
    settings = db.settings(station, reveal_key=True)
    calibration = settings["calibration"]
    metrics = db.calibration_metrics(station)

    if calibration["mode"] != "auto":
        return False, "Manual calibration selected."
    if calibration["paused"]:
        return False, "Automatic calibration paused."
    if not force and metrics["verified_hours"] < calibration["minimum_verified_hours"]:
        return False, "Collecting verified forecast hours."

    current = db.controls(station)
    candidate, reason = calibrated_candidate(current, metrics)
    if candidate == current:
        return False, "No coefficient change required."

    db.save_controls(station, candidate, "auto", reason, update_last_run=True)
    return True, reason
```

If the existing calibration function computes the candidate inline rather than through `calibrated_candidate`, extract that existing calculation unchanged into `calibrated_candidate(current, metrics) -> tuple[Controls, str]`; do not alter its mathematics in this feature.

All `verify_forecasts`, coefficient-history and calibration methods receive the same station.

- [ ] **Step 8: Write partial-failure sync test**

Monkeypatch `sync_station` so ILONDO327 raises while ILONDO1066 succeeds:

```python
@pytest.mark.asyncio
async def test_sync_once_keeps_other_station_when_one_fails(tmp_path, monkeypatch):
    result = await module.sync_once(False)
    assert result["stations"]["ILONDO1066"]["ok"] is True
    assert result["stations"]["ILONDO327"]["ok"] is False
    assert module.db.station_status("ILONDO1066")["last_error"] is None
    assert module.db.station_status("ILONDO327")["last_error"]
```

- [ ] **Step 9: Implement station-isolated sync loop**

```python
async def sync_station(station_id: str, include_history: bool = False) -> dict[str, Any]:
    station = normalise_station_id(station_id)
    db.set_station_status(station, "syncing", "true")
    try:
        current_count = await fetch_wu(WU_CURRENT_URL, "current", station)
        history_count = 0
        if include_history:
            history_count = await fetch_wu(WU_HISTORY_URL, "history_7day", station)
            db.set_station_status(station, "last_history_success", iso_now())
        verified = db.verify_forecasts(station)
        await generate_and_store_forecast(station)
        auto_calibrate(station, False)
        db.set_station_status(station, "last_success", iso_now())
        db.set_station_status(station, "last_error", "")
        return {"ok": True, "current_count": current_count, "history_count": history_count, "verified": verified}
    except Exception as exc:
        db.set_station_status(station, "last_error", str(exc))
        return {"ok": False, "error": str(exc)}
    finally:
        db.set_station_status(station, "syncing", "false")


async def sync_once(include_history: bool = False) -> dict[str, Any]:
    async with sync_lock:
        results = {}
        for station in STATION_IDS:
            results[station] = await sync_station(station, include_history)
        if not any(item.get("ok") for item in results.values()):
            raise RuntimeError("All configured stations failed to refresh")
        return {"stations": results}
```

- [ ] **Step 10: Run all home tests and commit**

```bash
python -m pytest -q home/test_cligmet.py home/test_multistation.py
```

Expected: PASS.

Commit:

```text
feat: collect forecast and calibrate stations independently
```

---

### Task 4: Publish two independent snapshots and update home APIs

**Files:**
- Modify: `home/cligmet.py`
- Modify: `home/test_multistation.py`
- Modify: `home/static/index.html` only where local-dashboard API calls require a station query
- Modify: `home/README.md`

**Interfaces:**
- Produces:
  - `public_snapshot(station_id)`
  - `publish_snapshot(station_id)`
  - `publish_all_snapshots()`
  - `GET /api/stations`
  - station-aware home API query parameters.

- [ ] **Step 1: Write snapshot isolation test**

Seed distinct current/history/forecast/calibration values for both stations.

Assert:

```python
a = module.public_snapshot("ILONDO1066")
b = module.public_snapshot("ILONDO327")

assert a["settings"]["station_id"] == "ILONDO1066"
assert b["settings"]["station_id"] == "ILONDO327"
assert a["current"]["observation"]["station_id"] == "ILONDO1066"
assert b["current"]["observation"]["station_id"] == "ILONDO327"
assert a["calibration"]["controls"] != b["calibration"]["controls"]
```

No section of snapshot A may contain a `station_id` of B, or vice versa.

- [ ] **Step 2: Refactor payload helpers to station arguments**

Change:

```text
pressure_trends_payload(station_id)
calibration_payload(station_id)
public_snapshot(station_id)
```

Inside `public_snapshot(station)` call only station-aware DB methods.

Keep `schema_version = 1`.

- [ ] **Step 3: Write dual-publish failure-isolation test**

Monkeypatch the receiver HTTP POST to fail for ILONDO327 only. Assert `publish_all_snapshots()` still posts ILONDO1066 and returns independent statuses.

- [ ] **Step 4: Implement publishing**

```python
async def publish_snapshot(station_id: str) -> dict[str, Any]:
    station = normalise_station_id(station_id)
    config = load_publish_config()
    if not config["configured"]:
        return {"ok": False, "station_id": station, "error": "Publishing is not configured"}
    snapshot = public_snapshot(station)
    headers = {
        "Authorization": f"Bearer {config['publish_token']}",
        "Content-Type": "application/json",
    }
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(config["publish_url"], json=snapshot, headers=headers)
        response.raise_for_status()
        db.set_station_status(station, "last_publish_success", iso_now())
        db.set_station_status(station, "last_publish_error", "")
        return {"ok": True, "station_id": station, **response.json()}
    except Exception as exc:
        db.set_station_status(station, "last_publish_error", str(exc))
        return {"ok": False, "station_id": station, "error": str(exc)}


async def publish_all_snapshots() -> dict[str, Any]:
    results = {}
    for station in STATION_IDS:
        results[station] = await publish_snapshot(station)
    return {"stations": results}
```

The publisher worker calls `publish_all_snapshots()`.

- [ ] **Step 5: Add home station discovery route**

```python
@app.get("/api/stations")
async def api_stations() -> dict[str, Any]:
    return {
        "default_station_id": PRIMARY_STATION_ID,
        "stations": [
            {
                "station_id": station,
                "status": db.station_status(station),
                "configured": db.settings(station)["configured"],
            }
            for station in STATION_IDS
        ],
    }
```

- [ ] **Step 6: Add validated `station_id` query parameters to home APIs**

For station-dependent routes, use:

```python
def station_query(station_id: str = Query(PRIMARY_STATION_ID, max_length=100)) -> str:
    try:
        return normalise_station_id(station_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
```

Apply the station to:

```text
/api/status
/api/settings
/api/current
/api/history
/api/forecast
/api/past-forecast
/api/forecast-controls
/api/calibration
/api/publish (optional station; omit = all)
/api/refresh (optional station; omit = all)
```

Global API-key updates remain on the singleton `settings` row.

- [ ] **Step 7: Run home API/snapshot tests**

```bash
python -m pytest -q home/test_cligmet.py home/test_multistation.py
```

Expected: PASS.

- [ ] **Step 8: Package an upgraded home publisher**

Create a versioned package containing:

```text
home/cligmet.py
home/backfill_history.py
home/test_cligmet.py
home/test_multistation.py
home/static/index.html
home/README.md
home/requirements.txt
systemd/cligmet.service
```

Do not include the live DB or publisher token.

Commit/package label:

```text
cligMET Home Publisher multi-station v1.2
```

---

### Task 5: Make the history self-heal explicitly verify every station

**Files:**
- Modify: `home/backfill_history.py`
- Modify/create tests for history sync alongside home publisher tests
- Modify the installed history-sync invocation/service only after code verification.

**Interfaces:**
- Consumes receiver `/history.json?station_id=...` and `/history/import`.
- Produces per-station coverage comparison/repair.

- [ ] **Step 1: Pin station enumeration**

Add:

```python
def station_ids(db_path: Path) -> list[str]:
    with sqlite3.connect(db_path) as db:
        return [
            str(row[0]).upper()
            for row in db.execute("SELECT DISTINCT station_id FROM observations ORDER BY station_id")
            if row[0]
        ]
```

Test:

```python
assert station_ids(db_path) == ["ILONDO1066", "ILONDO327"]
```

- [ ] **Step 2: Add completeness test where one station is complete and one is incomplete**

Mock receiver metadata:

```python
local = {
    "ILONDO1066": {"stored_hours": 1300, "available_from": "2026-07-27T17:00:00Z", "available_to": "2026-09-19T11:00:00Z"},
    "ILONDO327": {"stored_hours": 200, "available_from": "2026-09-11T04:00:00Z", "available_to": "2026-09-19T11:00:00Z"},
}
remote = {
    "ILONDO1066": {"stored_hours": 1300, "available_from": "2026-07-27T17:00:00Z", "available_to": "2026-09-19T11:00:00Z"},
    "ILONDO327": {"stored_hours": 10, "available_from": "2026-09-19T02:00:00Z", "available_to": "2026-09-19T11:00:00Z"},
}
assert stations_requiring_repair(local, remote) == ["ILONDO327"]
```

Define `stations_requiring_repair(local, remote)` in the repair code as the station-by-station comparison used by the live sync command.

Assert the repair plan contains only `ILONDO327`.

- [ ] **Step 3: Keep backfill payloads single-station**

The existing `hourly_rows()` grouping is already correct. Preserve payload shape:

```python
{
    "schema_version": 1,
    "generated_at": now_iso(),
    "settings": {"station_id": station},
    "history": {"interval_hours": 1, "aggregation": "mean", "points": [point(row) for row in batch]},
    "calibration": {"history": []},
}
```

Never combine station rows in one import request.

- [ ] **Step 4: Run a dry-run against a two-station test DB**

Expected output contains separate lines for ILONDO1066 and ILONDO327 and does not upload.

- [ ] **Step 5: After receiver + home publisher deployment, run live repair dry-run**

On the home server:

```bash
cd /home/agchxci/cligmet/cligMET_Home_Publisher_v1.1
python backfill_history.py --dry-run
```

Expected: both station IDs appear once ILONDO327 observations exist.

Then run the configured automatic history sync once and verify both station coverages independently.

- [ ] **Step 6: Commit/package**

```text
feat: verify and repair public history per station
```

---

### Task 6: Add public station discovery, selection and current-condition rendering

**Repository:** `agchxci/cligMET`

**Files:**
- Modify: `config.js`
- Modify: `index.html`
- Modify: `styles.css`
- Modify: `app.js`
- Create: `station-selection.js`
- Create: `tests/station-selection.test.mjs`

**Interfaces:**
- Produces `window.CligmetStations` helper with:
  - `VALID = ["ILONDO1066","ILONDO327"]`
  - `normaliseSelection(value) -> "both"|"ILONDO1066"|"ILONDO327"`
  - `snapshotUrl(baseUrl, stationId) -> URL`
  - `stationsUrl(baseUrl) -> URL`.

- [ ] **Step 1: Write RED tests for selection validation and URL construction**

`tests/station-selection.test.mjs`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../station-selection.js', import.meta.url), 'utf8');
const context = { window: {}, URL };
vm.createContext(context);
vm.runInContext(code, context);
const stations = context.window.CligmetStations;

test('defaults invalid selection to both', () => {
  assert.equal(stations.normaliseSelection(null), 'both');
  assert.equal(stations.normaliseSelection('INVALID'), 'both');
});

test('preserves both configured station choices', () => {
  assert.equal(stations.normaliseSelection('both'), 'both');
  assert.equal(stations.normaliseSelection('ILONDO1066'), 'ILONDO1066');
  assert.equal(stations.normaliseSelection('ILONDO327'), 'ILONDO327');
});

test('builds station-specific snapshot and discovery URLs', () => {
  const base = 'https://cligmet-render-receiver.onrender.com/snapshot.json';
  assert.equal(
    stations.snapshotUrl(base, 'ILONDO327').toString(),
    'https://cligmet-render-receiver.onrender.com/snapshot.json?station_id=ILONDO327'
  );
  assert.equal(
    stations.stationsUrl(base).toString(),
    'https://cligmet-render-receiver.onrender.com/stations.json'
  );
});
```

Run:

```bash
node --test tests/station-selection.test.mjs
```

Expected: FAIL because helper does not exist.

- [ ] **Step 2: Implement `station-selection.js`**

```javascript
'use strict';

window.CligmetStations = (() => {
  const VALID = Object.freeze(['ILONDO1066', 'ILONDO327']);

  function normaliseSelection(value) {
    const text = String(value ?? '');
    if (text === 'both') return 'both';
    const station = text.toUpperCase();
    return VALID.includes(station) ? station : 'both';
  }

  function snapshotUrl(baseUrl, stationId) {
    const url = new URL(baseUrl, window.location?.href || 'https://cligmet.xyz/');
    url.searchParams.set('station_id', stationId);
    return url;
  }

  function stationsUrl(baseUrl) {
    return new URL('stations.json', new URL(baseUrl, window.location?.href || 'https://cligmet.xyz/'));
  }

  return { VALID, normaliseSelection, snapshotUrl, stationsUrl };
})();
```

Load it before `history-navigation.js` and `app.js`.

- [ ] **Step 3: Add selector markup**

In the masthead, add an accessible group:

```html
<div class="station-selector" id="stationSelector" role="group" aria-label="Weather station">
  <button type="button" data-station-selection="both" aria-pressed="true">BOTH</button>
  <button type="button" data-station-selection="ILONDO1066" aria-pressed="false">ILONDO1066</button>
  <button type="button" data-station-selection="ILONDO327" aria-pressed="false">ILONDO327</button>
</div>
```

Add a dual-current container that can render two station cards in BOTH mode while retaining current element IDs for single-station compatibility.

- [ ] **Step 4: Refactor app state from one snapshot to map**

Use:

```javascript
const storedStation = (() => {
  try { return localStorage.getItem('cligmet.station.v1'); } catch { return null; }
})();

const state = {
  stations: null,
  snapshots: new Map(),
  stationSelection: window.CligmetStations.normaliseSelection(storedStation),
  compatibilityMode: false,
  loading: false,
  error: null,
  lastAttempt: 0,
  preferences: savedPreferences || { ...defaultPreferences },
  preferencesInitialised: Boolean(savedPreferences),
  charts: new Map(),
  selectedTimes: new Map(),
};
```

Add:

```javascript
function selectedStationIds() {
  return state.stationSelection === 'both'
    ? window.CligmetStations.VALID.slice()
    : [state.stationSelection];
}

function selectedSnapshots() {
  return selectedStationIds()
    .map(id => [id, state.snapshots.get(id)])
    .filter(([, snapshot]) => snapshot);
}
```

- [ ] **Step 5: Implement discovery + fallback loading**

Normal path:

```javascript
const discovery = await fetch(CligmetStations.stationsUrl(configuredURL), {
  method: 'GET',
  cache: 'no-store',
  credentials: 'omit',
  signal: controller.signal,
}).then(r => {
  if (!r.ok) throw new Error('station-discovery');
  return r.json();
});

const ids = selectedStationIds();
const snapshots = await Promise.allSettled(ids.map(async stationId => {
  const response = await fetch(CligmetStations.snapshotUrl(configuredURL, stationId), {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    signal: controller.signal,
  });
  if (!response.ok) throw new Error('service');
  return [stationId, await response.json()];
}));
```

Store fulfilled snapshots independently; do not throw away a good station because the other rejects.

Fallback if discovery itself is unavailable/invalid:

```javascript
const response = await fetch(configuredURL, {
  method: 'GET',
  cache: 'no-store',
  credentials: 'omit',
  signal: controller.signal,
});
const snapshot = await response.json();
const station = String(snapshot.settings?.station_id || 'ILONDO1066').toUpperCase();
state.compatibilityMode = true;
state.stationSelection = station;
state.snapshots = new Map([[station, snapshot]]);
```

- [ ] **Step 6: Add a regression test for partial load**

Extract a pure helper:

```javascript
function fulfilledSnapshots(results) {
  return new Map(results
    .filter(result => result.status === 'fulfilled')
    .map(result => result.value));
}
```

Test that one rejected ILONDO327 request retains ILONDO1066.

- [ ] **Step 7: Render station selection and persist it**

On button click:

```javascript
state.stationSelection = CligmetStations.normaliseSelection(button.dataset.stationSelection);
try { localStorage.setItem('cligmet.station.v1', state.stationSelection); } catch {}
state.snapshots.clear();
loadSnapshot();
```

Update every selector button's `aria-pressed`.

- [ ] **Step 8: Render current conditions without averaging**

Create `renderStationObservation(stationId, snapshot, target)` that formats exactly the existing metrics.

Single mode uses the existing current panel.

BOTH mode creates two station blocks and calls it once per available snapshot. It must never calculate a numeric mean between stations.

Each station block includes independent status/freshness.

- [ ] **Step 9: Run frontend selection tests and syntax checks**

```bash
node --test tests/station-selection.test.mjs
node --check station-selection.js
node --check app.js
node --check history-navigation.js
```

Expected: PASS.

- [ ] **Step 10: Commit**

```text
feat: add station selector and dual current conditions
```

---

### Task 7: Refactor public history, charts, fullscreen crosshair and calibration for BOTH mode

**Repository:** `agchxci/cligMET`

**Files:**
- Modify: `history-navigation.js`
- Modify: `app.js`
- Modify: `styles.css`
- Modify: `tests/fullscreen-overlay.test.mjs`
- Create: `tests/multi-station-charts.test.mjs`

**Interfaces:**
- Consumes Task 6 `state.snapshots` and selected station IDs.
- Produces station-aware chart series and per-station history cache.

- [ ] **Step 1: Write a RED history cache-key test**

Expose/test a pure helper:

```javascript
function historyRequestKey(stationId, window) {
  return [stationId, window.start, window.historyEnd, window.interval].join('|');
}
```

Assert ILONDO1066 and ILONDO327 never produce the same key for the same window.

- [ ] **Step 2: Change history-navigation interface**

Change creation from:

```javascript
create({ onChange, getSnapshot })
```

to:

```javascript
create({ onChange, getSnapshots, getSelectedStationIds })
```

`baseTime()` uses the latest valid generated/current timestamp across selected snapshots.

`domain(id)` derives forecast end from all selected snapshots.

`ensure(window)` loops over selected station IDs and issues separate requests:

```javascript
for (const stationId of getSelectedStationIds()) {
  const key = historyRequestKey(stationId, window);
  if (cache.has(key) || pending.has(key)) continue;
  const url = getURL('weather');
  if (!url) {
    cache.set(key, { failed: true });
    continue;
  }
  url.searchParams.set('start', new Date(window.start).toISOString());
  url.searchParams.set('end', new Date(window.historyEnd).toISOString());
  url.searchParams.set('interval_hours', String(window.interval));
  url.searchParams.set('station_id', stationId);

  const issuedRevision = revision;
  const job = request(url)
    .then(data => {
      if (revision !== issuedRevision) return;
      if (!data || !Array.isArray(data.points) || data.station_id !== stationId) {
        throw new Error('invalid-history');
      }
      cache.set(key, { data });
      availability.set(stationId, data);
    })
    .catch(() => {
      if (revision === issuedRevision) cache.set(key, { failed: true });
    })
    .finally(() => pending.delete(key));
  pending.set(key, job);
}
```

Store `availability` per station in a `Map`.

- [ ] **Step 3: Preserve successful history when one station fails**

Test:

```javascript
assert.equal(resultFor1066.failed, false);
assert.equal(resultFor327.failed, true);
assert.ok(domain.observationPointsByStation.get('ILONDO1066').length > 0);
```

No catch block may replace the entire selected history state.

- [ ] **Step 4: Make chart inputs station-aware**

In `app.js`, build series for each station:

```javascript
for (const [stationId, snapshot] of selectedSnapshots()) {
  const observed = clipPoints(normalisePoints(
    domain.observationPointsByStation.get(stationId) || [],
    definition.key
  ));
  const forecast = clipPoints(normalisePoints(
    snapshot.forecast?.available ? snapshot.forecast.points : [],
    definition.key
  ));
  const archived = clipPoints(normalisePoints(
    snapshot.past_forecast?.available ? snapshot.past_forecast.points : [],
    definition.key
  ));

  if (state.preferences.measured) {
    series.push({
      stationId,
      kind: 'observed',
      label: 'Measured',
      points: observed,
      colour: COLOURS.stations[stationId],
      dash: DASH.observed,
      interval: domain.interval,
    });
  }
  if (state.preferences.archived) {
    series.push({
      stationId,
      kind: 'archived',
      label: 'Archived',
      points: archived,
      colour: COLOURS.stations[stationId],
      dash: DASH.archived,
    });
  }
  if (state.preferences.forecast) {
    series.push({
      stationId,
      kind: 'forecast',
      label: 'Forecast',
      points: forecast,
      colour: COLOURS.stations[stationId],
      dash: DASH.forecast,
    });
  }
}
```

- [ ] **Step 5: Add explicit two-station visual tokens**

Extend `COLOURS`:

```javascript
stations: {
  ILONDO1066: '#111111',
  ILONDO327: '#6c5a43',
}
```

Use station colour for identity and dash patterns for type:

```javascript
const DASH = {
  observed: '',
  forecast: '7 4',
  archived: '2 5',
};
```

Do not use colour alone: legends/readouts include station ID text.

- [ ] **Step 6: Make bounds/timeline include both stations**

`values` and crosshair `timeline` derive from every visible series.

Temperature uncertainty bands are drawn once per station in the station colour with low opacity.

If forecast boundaries differ by <= 5 minutes, render one common `FCST` line; otherwise render one subtle labelled line per station.

- [ ] **Step 7: Write crosshair BOTH-mode regression test**

The pure readout-builder should receive series objects with `stationId` and return grouped rows:

```javascript
[
  {
    stationId: 'ILONDO1066',
    values: [{ kind: 'observed', label: 'OBS', value: 18.4 }],
  },
  {
    stationId: 'ILONDO327',
    values: [{ kind: 'observed', label: 'OBS', value: 17.9 }],
  },
]
```

Assert both IDs appear and values remain distinct.

- [ ] **Step 8: Update fullscreen overlay**

Keep the existing floating large readout and opposite-side positioning logic.

In BOTH mode render:

```text
ILONDO1066
OBS …
FCST …

ILONDO327
OBS …
FCST …
```

The shared vertical crosshair remains one timestamp.

- [ ] **Step 9: Refactor calibration rendering**

Single station:

```javascript
renderCalibrationFor(stationId, snapshot)
renderCoefficientHistory(stationId)
```

BOTH:

- render two compact calibration summary blocks;
- hide/replace the detailed coefficient-history chart with explanatory copy such as `Select one station to view coefficient history`;
- never draw coefficient curves from both stations on one coefficient chart.

History-navigation requests calibration history only for a selected single station.

- [ ] **Step 10: Add coverage labels per station**

When historical coverage differs, show station-specific coverage text from each history response.

Never claim BOTH has a full year merely because one station does.

- [ ] **Step 11: Run frontend tests**

```bash
node --test tests/*.test.mjs
node --check app.js
node --check history-navigation.js
node --check station-selection.js
```

Expected: PASS.

- [ ] **Step 12: Commit**

```text
feat: overlay independent stations in cligMET charts
```

---

### Task 8: Deploy in compatibility order and verify end-to-end behavior

**Files/Systems:**
- Receiver: `agchxci/cligMET_render_receiver` / Render
- Home publisher: live home server
- Website: `agchxci/cligMET`
- Home SQLite: `cligmet.db`
- Existing systemd publisher and history-sync services/timers.

**Interfaces:** All tasks 1–7.

- [ ] **Step 1: Deploy receiver first**

Merge receiver changes and wait for Render deployment.

Before touching the home publisher verify:

```bash
curl -fsS https://cligmet-render-receiver.onrender.com/health
curl -fsS https://cligmet-render-receiver.onrender.com/stations.json
curl -fsS 'https://cligmet-render-receiver.onrender.com/snapshot.json?station_id=ILONDO1066'
```

Expected:

- default snapshot remains ILONDO1066;
- ILONDO1066 remains live via legacy fallback or station file;
- ILONDO327 may be `missing` until home dual publish begins;
- history/archive endpoints remain healthy.

- [ ] **Step 2: Create and validate the live DB backup**

On home server, use SQLite backup API and verify integrity:

```bash
cd /home/agchxci/cligmet/cligMET_Home_Publisher_v1.1
python - <<'PY'
import sqlite3, time
src="cligmet.db"
dst=f"cligmet.pre-multistation.{int(time.time())}.db"
with sqlite3.connect(src) as source, sqlite3.connect(dst) as target:
    source.backup(target)
with sqlite3.connect(dst) as db:
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
print(dst)
PY
```

Do not continue if integrity check is not `ok`.

- [ ] **Step 3: Stop home publisher and install tested package**

```bash
sudo systemctl stop cligmet.service
```

Copy the tested upgraded publisher files into the live application directory while leaving:

- `cligmet.db`
- `publisher.json`
- any secret environment configuration

untouched.

Run the package tests against a temporary/test DB before starting the live service.

- [ ] **Step 4: Start service and validate migration**

```bash
sudo systemctl start cligmet.service
sudo systemctl status cligmet.service --no-pager
```

Query the local API:

```bash
curl -fsS http://127.0.0.1:8000/api/stations
curl -fsS 'http://127.0.0.1:8000/api/settings?station_id=ILONDO1066'
curl -fsS 'http://127.0.0.1:8000/api/settings?station_id=ILONDO327'
```

Verify ILONDO1066 controls against the pre-migration values captured from backup/current API.

- [ ] **Step 5: Trigger one dual refresh**

```bash
curl -fsS -X POST http://127.0.0.1:8000/api/refresh
```

Expected response has independent station results and at least one observation for each valid WU station.

Check:

```bash
curl -fsS 'http://127.0.0.1:8000/api/current?station_id=ILONDO1066'
curl -fsS 'http://127.0.0.1:8000/api/current?station_id=ILONDO327'
```

- [ ] **Step 6: Trigger/observe dual publish**

Verify:

```bash
curl -fsS 'https://cligmet-render-receiver.onrender.com/snapshot.json?station_id=ILONDO1066'
curl -fsS 'https://cligmet-render-receiver.onrender.com/snapshot.json?station_id=ILONDO327'
curl -fsS https://cligmet-render-receiver.onrender.com/stations.json
```

Both snapshots must exist simultaneously and contain their own station ID.

- [ ] **Step 7: Verify independent forecasts/calibration**

Home API:

```bash
curl -fsS 'http://127.0.0.1:8000/api/forecast?station_id=ILONDO1066'
curl -fsS 'http://127.0.0.1:8000/api/forecast?station_id=ILONDO327'
curl -fsS 'http://127.0.0.1:8000/api/calibration?station_id=ILONDO1066'
curl -fsS 'http://127.0.0.1:8000/api/calibration?station_id=ILONDO327'
```

Verify distinct station IDs/state and no shared coefficient history.

- [ ] **Step 8: Run history repair dry-run, then repair if needed**

Confirm both station IDs are enumerated and ILONDO1066 coverage remains intact.

If ILONDO327 is incomplete, allow the repair worker to import it independently.

Then verify receiver history for each station with identical time windows.

- [ ] **Step 9: Deploy website last**

Only after both public snapshots are available and receiver tests/smoke are green, merge/deploy the site changes.

- [ ] **Step 10: Browser acceptance check**

Verify:

1. new browser defaults to BOTH;
2. current values show two labelled stations with no averaging;
3. selector switches to ILONDO1066;
4. selector switches to ILONDO327;
5. 24H, 72H, 7D, 30D and 1Y work in BOTH and single modes;
6. unequal coverage does not blank the chart;
7. forecast lines for both stations remain independent;
8. fullscreen graph opens and crosshair overlay lists both stations;
9. selecting one station restores detailed calibration coefficient history;
10. refresh preserves the station selection.

- [ ] **Step 11: Failure-isolation smoke test**

Temporarily simulate/observe a station-level unavailable condition only if it can be done without altering production credentials; otherwise rely on automated tests.

The user-facing site must continue to render the healthy station.

- [ ] **Step 12: Final verification report**

Record:

- receiver commit SHA and green workflow;
- website commit SHA and green tests;
- home publisher package version/hash;
- live DB backup filename;
- ILONDO1066 history coverage before/after;
- ILONDO327 first/last stored hour;
- latest generated timestamp for both live snapshots;
- calibration mode and verified-hour count for each station.

## Final Acceptance Checklist

- [ ] Existing ILONDO1066 controls and history survived migration.
- [ ] ILONDO1066 and ILONDO327 both collect WU data.
- [ ] Forecast runs are station-isolated.
- [ ] Calibration and coefficient history are station-isolated.
- [ ] One station failure does not abort the other.
- [ ] Two live receiver snapshots coexist.
- [ ] Plain `/snapshot.json` still returns ILONDO1066.
- [ ] `/stations.json` reports both stations.
- [ ] History self-heal evaluates both stations independently.
- [ ] Public site defaults to BOTH.
- [ ] BOTH mode never averages station values.
- [ ] Charts overlay both stations with clear station identity and data-type line styles.
- [ ] Fullscreen crosshair reports both stations.
- [ ] Single-station mode retains detailed coefficient history.
- [ ] Android WebView automatically inherits the updated site without an APK rebuild.
