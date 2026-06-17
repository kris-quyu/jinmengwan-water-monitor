import json
import math
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel


BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "jinmengwan.db"

DEFAULT_SETTINGS = {
    "doWarn": 5.0,
    "doDanger": 4.0,
    "phMin": 7.6,
    "phMax": 8.6,
    "salinityMin": 8,
    "salinityMax": 18,
    "tempMin": 26,
    "tempMax": 32,
    "levelMin": 60,
    "levelMax": 95,
    "pondCount": 4,
    "enabledSensors": ["do", "ph", "salinity", "temperature", "waterLevel", "orp", "roomTemperature"],
}

SENSOR_DEFINITIONS = {
    "do": {"key": "do", "name": "DO", "unit": "mg/L", "value": 6.8, "status": "normal", "min": 5.0, "max": 9.0},
    "ph": {"key": "ph", "name": "pH", "unit": "", "value": 8.1, "status": "normal", "min": 7.6, "max": 8.6},
    "salinity": {"key": "salinity", "name": "盐度", "unit": "ppt", "value": 12, "status": "normal", "min": 8, "max": 18},
    "temperature": {"key": "temperature", "name": "温度", "unit": "℃", "value": 28.3, "status": "normal", "min": 26, "max": 32},
    "waterLevel": {"key": "waterLevel", "name": "水位", "unit": "cm", "value": 79, "status": "normal", "min": 60, "max": 95},
    "orp": {"key": "orp", "name": "ORP", "unit": "mV", "value": 220, "status": "normal", "min": 180, "max": 280},
    "roomTemperature": {"key": "roomTemperature", "name": "室温", "unit": "℃", "value": 27.2, "status": "normal", "min": 18, "max": 36},
}

SENSORS = list(SENSOR_DEFINITIONS.values())

LEVEL_TEXT = {
    "warning": "提醒",
    "abnormal": "异常",
    "danger": "危险",
    "normal": "正常",
    "提醒": "提醒",
    "异常": "异常",
    "危险": "危险",
    "正常": "正常",
}

STATUS_TEXT = {
    "handled": "已处理",
    "pending": "未处理",
    "已处理": "已处理",
    "未处理": "未处理",
}

SENSOR_NAME_TO_KEY = {
    "DO": "do",
    "pH": "ph",
    "盐度": "salinity",
    "温度": "temperature",
    "水温": "temperature",
    "水位": "waterLevel",
    "ORP": "orp",
    "室温": "roomTemperature",
}

ALARM_SEED_ROWS = [
    ("2026-06-16 08:10:22", "1号池", "DO", "4.8 mg/L", "提醒", "溶解氧接近提醒阈值", "未处理"),
    ("2026-06-16 07:42:16", "2号池", "pH", "8.7", "异常", "pH 高于上限", "未处理"),
    ("2026-06-15 19:35:08", "4号池", "水位", "58 cm", "异常", "水位低于下限", "已处理"),
    ("2026-06-15 16:06:51", "1号池", "温度", "32.8 ℃", "提醒", "水温偏高", "已处理"),
    ("2026-06-15 11:28:23", "3号池", "ORP", "165 mV", "提醒", "ORP 低于建议范围", "已处理"),
    ("2026-06-15 08:20:12", "1号池", "室温", "35.4 ℃", "提醒", "室温偏高", "已处理"),
]

RANGE_STEPS = {
    "30m": 1,
    "1h": 2,
    "6h": 12,
    "12h": 24,
    "24h": 48,
}


class SettingsPayload(BaseModel):
    doWarn: float | None = None
    doDanger: float | None = None
    phMin: float | None = None
    phMax: float | None = None
    salinityMin: float | None = None
    salinityMax: float | None = None
    tempMin: float | None = None
    tempMax: float | None = None
    levelMin: float | None = None
    levelMax: float | None = None
    pondCount: int | None = None
    enabledSensors: list[str] | None = None


class FeedingPlanPayload(BaseModel):
    pond: str
    time: str
    feedName: str
    amountKg: float
    enabled: bool = True


app = FastAPI(title="金梦湾渔业水质在线监测平台 API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def execute_schema() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sensor_data (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sensor_key TEXT NOT NULL,
                sensor_name TEXT NOT NULL,
                unit TEXT,
                value REAL NOT NULL,
                pond_no INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS alarm_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                time TEXT NOT NULL,
                pool TEXT NOT NULL,
                metric TEXT NOT NULL,
                value TEXT NOT NULL,
                level TEXT NOT NULL,
                content TEXT NOT NULL,
                status TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sensor_config (
                sensor_key TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                unit TEXT,
                base_value REAL NOT NULL,
                status TEXT NOT NULL,
                min_value REAL,
                max_value REAL,
                enabled INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS feeding_plan (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pond TEXT NOT NULL,
                time TEXT NOT NULL,
                feed_name TEXT NOT NULL,
                amount_kg REAL NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS camera_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                location TEXT NOT NULL,
                stream_url TEXT NOT NULL,
                status TEXT NOT NULL
            );
            """
        )


def table_count(conn: sqlite3.Connection, table: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def seed_database_if_empty() -> None:
    with get_conn() as conn:
        if table_count(conn, "settings") == 0:
            for key, value in DEFAULT_SETTINGS.items():
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?)",
                    (key, json.dumps(value, ensure_ascii=False)),
                )

        if table_count(conn, "sensor_config") == 0:
            enabled = set(DEFAULT_SETTINGS["enabledSensors"])
            conn.executemany(
                """
                INSERT INTO sensor_config
                (sensor_key, name, unit, base_value, status, min_value, max_value, enabled)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        sensor["key"],
                        sensor["name"],
                        sensor["unit"],
                        sensor["value"],
                        sensor["status"],
                        sensor["min"],
                        sensor["max"],
                        1 if sensor["key"] in enabled else 0,
                    )
                    for sensor in SENSORS
                ],
            )

        if table_count(conn, "sensor_data") == 0:
            now = datetime.now()
            rows = []
            for index in range(30):
                created_at = now - timedelta(minutes=(29 - index))
                for sensor in SENSORS:
                    span = 0.08 if sensor["key"] == "ph" else max(1, sensor["value"] * 0.035)
                    value = sensor["value"] + math.sin(index / 3) * span + math.cos(index / 5) * span * 0.45
                    if sensor["key"] in {"waterLevel", "orp"}:
                        value = round(value)
                    elif sensor["key"] == "ph":
                        value = round(value, 2)
                    else:
                        value = round(value, 1)
                    rows.append((sensor["key"], sensor["name"], sensor["unit"], value, (index % 4) + 1, created_at.isoformat(timespec="seconds")))
            conn.executemany(
                """
                INSERT INTO sensor_data (sensor_key, sensor_name, unit, value, pond_no, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                rows,
            )

        if table_count(conn, "alarm_log") == 0:
            conn.executemany(
                """
                INSERT INTO alarm_log (time, pool, metric, value, level, content, status)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                ALARM_SEED_ROWS,
            )

        if table_count(conn, "feeding_plan") == 0:
            conn.executemany(
                "INSERT INTO feeding_plan (pond, time, feed_name, amount_kg, enabled) VALUES (?, ?, ?, ?, ?)",
                [
                    ("1号池", "08:30", "南美白对虾配合饲料", 12.5, 1),
                    ("2号池", "12:30", "南美白对虾配合饲料", 10.0, 1),
                    ("3号池", "18:00", "强化营养饲料", 9.5, 1),
                ],
            )

        if table_count(conn, "camera_config") == 0:
            conn.executemany(
                "INSERT INTO camera_config (name, location, stream_url, status) VALUES (?, ?, ?, ?)",
                [
                    ("1号池枪机", "1号池", "rtsp://example.local/pond1", "在线"),
                    ("2号池枪机", "2号池", "rtsp://example.local/pond2", "在线"),
                    ("车间全景", "养殖车间", "rtsp://example.local/workshop", "在线"),
                ],
            )


def repair_legacy_sensor_data() -> None:
    enabled = DEFAULT_SETTINGS["enabledSensors"]
    with get_conn() as conn:
        conn.execute("DELETE FROM sensor_config WHERE sensor_key IN ('ammonia', 'nh3')")
        conn.execute("DELETE FROM sensor_data WHERE sensor_key IN ('ammonia', 'nh3')")
        bad_metric_names = ("氨氮", "ammonia", "nh3", chr(63) * 2, chr(63))
        conn.execute(
            f"DELETE FROM alarm_log WHERE metric IN ({','.join('?' for _ in bad_metric_names)})",
            bad_metric_names,
        )
        conn.execute(
            """
            DELETE FROM alarm_log
            WHERE pool LIKE '%?%'
               OR level LIKE '%?%'
               OR status LIKE '%?%'
               OR content LIKE '%?%'
               OR level NOT IN ('提醒', '异常', '危险', '正常', 'warning', 'abnormal', 'danger', 'normal')
               OR status NOT IN ('已处理', '未处理', 'handled', 'pending')
            """
        )
        if conn.execute("SELECT COUNT(*) FROM alarm_log").fetchone()[0] == 0:
            conn.executemany(
                """
                INSERT INTO alarm_log (time, pool, metric, value, level, content, status)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                ALARM_SEED_ROWS,
            )
        conn.execute("DELETE FROM settings WHERE key IN ('nh3Warn', 'nh3Danger')")

        for sensor in SENSORS:
            conn.execute(
                """
                INSERT INTO sensor_config
                (sensor_key, name, unit, base_value, status, min_value, max_value, enabled)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(sensor_key) DO UPDATE SET
                    name = excluded.name,
                    unit = excluded.unit,
                    base_value = excluded.base_value,
                    status = excluded.status,
                    min_value = excluded.min_value,
                    max_value = excluded.max_value,
                    enabled = excluded.enabled
                """,
                (
                    sensor["key"],
                    sensor["name"],
                    sensor["unit"],
                    sensor["value"],
                    sensor["status"],
                    sensor["min"],
                    sensor["max"],
                    1 if sensor["key"] in enabled else 0,
                ),
            )

        current_settings = {}
        for row in conn.execute("SELECT key, value FROM settings").fetchall():
            try:
                current_settings[row["key"]] = json.loads(row["value"])
            except json.JSONDecodeError:
                current_settings[row["key"]] = row["value"]
        current_settings.update({
            "enabledSensors": [key for key in current_settings.get("enabledSensors", enabled) if key in SENSOR_DEFINITIONS],
        })
        if not current_settings["enabledSensors"]:
            current_settings["enabledSensors"] = enabled
        if "roomTemperature" not in current_settings["enabledSensors"]:
            current_settings["enabledSensors"].append("roomTemperature")
        for key, value in DEFAULT_SETTINGS.items():
            current_settings.setdefault(key, value)
        for key in ("nh3Warn", "nh3Danger"):
            current_settings.pop(key, None)
        for key, value in current_settings.items():
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (key, json.dumps(value, ensure_ascii=False)),
            )

        if conn.execute("SELECT COUNT(*) FROM sensor_data WHERE sensor_key = 'roomTemperature'").fetchone()[0] == 0:
            now = datetime.now()
            room = SENSOR_DEFINITIONS["roomTemperature"]
            rows = []
            for index in range(30):
                created_at = now - timedelta(minutes=(29 - index))
                span = max(1, room["value"] * 0.035)
                value = round(room["value"] + math.sin(index / 3) * span + math.cos(index / 5) * span * 0.45, 1)
                rows.append((room["key"], room["name"], room["unit"], value, (index % 4) + 1, created_at.isoformat(timespec="seconds")))
            conn.executemany(
                """
                INSERT INTO sensor_data (sensor_key, sensor_name, unit, value, pond_no, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                rows,
            )


@app.on_event("startup")
def startup() -> None:
    execute_schema()
    seed_database_if_empty()
    repair_legacy_sensor_data()


def read_settings() -> dict[str, Any]:
    with get_conn() as conn:
        rows = conn.execute("SELECT key, value FROM settings").fetchall()
    settings = DEFAULT_SETTINGS.copy()
    for row in rows:
        try:
            settings[row["key"]] = json.loads(row["value"])
        except json.JSONDecodeError:
            settings[row["key"]] = row["value"]
    settings["pondCount"] = max(1, min(50, int(settings.get("pondCount") or 4)))
    settings["enabledSensors"] = [key for key in settings.get("enabledSensors", []) if key in SENSOR_DEFINITIONS]
    if not settings["enabledSensors"]:
        settings["enabledSensors"] = DEFAULT_SETTINGS["enabledSensors"]
    settings.pop("nh3Warn", None)
    settings.pop("nh3Danger", None)
    return settings


def write_settings(settings: dict[str, Any]) -> dict[str, Any]:
    current = read_settings()
    current.update({key: value for key, value in settings.items() if value is not None})
    current["pondCount"] = max(1, min(50, int(current.get("pondCount") or 4)))
    enabled = [key for key in current.get("enabledSensors", []) if key in SENSOR_DEFINITIONS]
    current["enabledSensors"] = enabled or DEFAULT_SETTINGS["enabledSensors"]
    current.pop("nh3Warn", None)
    current.pop("nh3Danger", None)

    with get_conn() as conn:
        for key, value in current.items():
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (key, json.dumps(value, ensure_ascii=False)),
            )
        conn.execute("UPDATE sensor_config SET enabled = 0")
        conn.executemany(
            "UPDATE sensor_config SET enabled = 1 WHERE sensor_key = ?",
            [(key,) for key in current["enabledSensors"]],
        )
    return current


def enabled_sensor_rows() -> list[sqlite3.Row]:
    settings = read_settings()
    enabled = settings["enabledSensors"]
    placeholders = ",".join("?" for _ in enabled)
    with get_conn() as conn:
        return conn.execute(
            f"""
            SELECT sensor_key, name, unit, base_value, status, min_value, max_value, enabled
            FROM sensor_config
            WHERE sensor_key IN ({placeholders})
            ORDER BY CASE sensor_key
                WHEN 'do' THEN 1 WHEN 'ph' THEN 2 WHEN 'salinity' THEN 3
                WHEN 'temperature' THEN 4 WHEN 'waterLevel' THEN 5
                WHEN 'orp' THEN 6 WHEN 'roomTemperature' THEN 7 ELSE 99 END
            """,
            enabled,
        ).fetchall()


def sensor_to_metric(row: sqlite3.Row) -> dict[str, Any]:
    latest = latest_sensor_value(row["sensor_key"])
    definition = SENSOR_DEFINITIONS.get(row["sensor_key"], {})
    return {
        "key": row["sensor_key"],
        "name": definition.get("name") or row["name"],
        "unit": definition.get("unit", row["unit"] or ""),
        "value": latest if latest is not None else row["base_value"],
        "status": row["status"],
        "min": row["min_value"],
        "max": row["max_value"],
    }


def latest_sensor_value(sensor_key: str) -> float | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT value FROM sensor_data WHERE sensor_key = ? ORDER BY created_at DESC, id DESC LIMIT 1",
            (sensor_key,),
        ).fetchone()
    return None if row is None else row["value"]


def build_ponds(pond_count: int) -> list[dict[str, Any]]:
    return [{"id": index + 1, "name": f"{index + 1}号池", "status": "运行中"} for index in range(pond_count)]


def metric_to_sensor_key(metric: str | None) -> str | None:
    if not metric:
        return None
    if metric in SENSOR_DEFINITIONS:
        return metric
    if metric in {"ammonia", "nh3", "氨氮"}:
        return None
    return SENSOR_NAME_TO_KEY.get(metric)


def normalize_pond_name(pool: str | None, pond_id: Any = None) -> str:
    if pool and "号池" in pool and "?" not in pool:
        return pool
    if pond_id:
        return f"{pond_id}号池"
    digits = "".join(ch for ch in str(pool or "") if ch.isdigit())
    return f"{digits or 1}号池"


def alarm_rows() -> list[dict[str, Any]]:
    enabled_names = {row["name"] for row in enabled_sensor_rows()}
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM alarm_log ORDER BY time DESC, id DESC").fetchall()
    alarms = []
    for row in rows:
        key = metric_to_sensor_key(row["metric"])
        if not key or key not in SENSOR_DEFINITIONS:
            continue
        definition = SENSOR_DEFINITIONS[key]
        if definition["name"] not in enabled_names:
            continue
        level = LEVEL_TEXT.get(row["level"], "提醒")
        status = STATUS_TEXT.get(row["status"], "未处理")
        pool = normalize_pond_name(row["pool"])
        alarms.append({
            "id": row["id"],
            "time": row["time"],
            "pondId": int("".join(ch for ch in pool if ch.isdigit()) or 1),
            "pondName": pool,
            "pool": pool,
            "key": key,
            "sensorName": definition["name"],
            "metric": definition["name"],
            "value": row["value"],
            "level": level,
            "levelText": level,
            "content": row["content"],
            "status": status,
            "statusText": status,
        })
    return alarms


@app.get("/api/latest")
def get_latest() -> dict[str, Any]:
    settings = read_settings()
    sensors = enabled_sensor_rows()
    metrics = [sensor_to_metric(row) for row in sensors]
    devices = [
        {
            "key": row["sensor_key"],
            "name": f"{row['name']} 传感器",
            "sensorName": row["name"],
            "unit": row["unit"] or "",
            "status": "在线" if row["enabled"] else "离线",
            "location": f"{(index % settings['pondCount']) + 1}号池",
        }
        for index, row in enumerate(sensors)
    ]
    sensor_count = len(metrics)
    return {
        "config": {"pondCount": settings["pondCount"], "enabledSensors": settings["enabledSensors"]},
        "system": {
            "pondCount": settings["pondCount"],
            "sensorCount": sensor_count,
            "onlineSensorCount": sensor_count,
            "onlineDevices": f"{sensor_count}/{sensor_count}",
            "todayAlarms": 0,
            "status": "运行正常",
        },
        "ponds": build_ponds(settings["pondCount"]),
        "metrics": metrics,
        "alarms": alarm_rows(),
        "devices": devices,
    }


@app.get("/api/history")
def get_history(metric: str = Query("do"), range_key: str = Query("30m", alias="range")) -> list[dict[str, Any]]:
    step = RANGE_STEPS.get(range_key, 1)
    row = next((sensor for sensor in SENSORS if sensor["key"] == metric), SENSORS[0])
    now = datetime.now()
    history = []
    for index in range(30):
        time_point = now - timedelta(minutes=(29 - index) * step)
        span = 0.08 if row["key"] == "ph" else max(1, row["value"] * 0.035)
        value = row["value"] + math.sin(index / 3) * span + math.cos(index / 5) * span * 0.45
        if row["key"] in {"waterLevel", "orp"}:
            value = round(value)
        elif row["key"] == "ph":
            value = round(value, 2)
        else:
            value = round(value, 1)
        history.append({"time": time_point.strftime("%H:%M"), "value": value})
    return history


@app.get("/api/alarms")
def get_alarms() -> list[dict[str, Any]]:
    return alarm_rows()


@app.post("/api/alarms/{alarm_id}/handled")
def handle_alarm(alarm_id: int) -> dict[str, Any]:
    with get_conn() as conn:
        cursor = conn.execute("UPDATE alarm_log SET status = ? WHERE id = ?", ("已处理", alarm_id))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Alarm not found")
    return {"success": True, "id": alarm_id}


@app.get("/api/settings")
def get_settings() -> dict[str, Any]:
    return read_settings()


@app.post("/api/settings")
def post_settings(payload: SettingsPayload) -> dict[str, Any]:
    return write_settings(payload.model_dump(exclude_unset=True))


@app.get("/api/sensors")
def get_sensors() -> dict[str, Any]:
    settings = read_settings()
    sensors = enabled_sensor_rows()
    all_sensors = []
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM sensor_config").fetchall()
    for row in rows:
        definition = SENSOR_DEFINITIONS.get(row["sensor_key"], {})
        if not definition:
            continue
        all_sensors.append(
            {
                "key": row["sensor_key"],
                "name": definition["name"],
                "unit": definition["unit"],
                "value": row["base_value"],
                "status": row["status"],
                "min": row["min_value"],
                "max": row["max_value"],
                "enabled": bool(row["enabled"]),
            }
        )
    return {
        "sensors": [
            {
                "key": row["sensor_key"],
                "name": f"{row['name']} 传感器",
                "sensorName": row["name"],
                "unit": row["unit"] or "",
                "status": "在线",
                "location": f"{(index % settings['pondCount']) + 1}号池",
            }
            for index, row in enumerate(sensors)
        ],
        "metrics": [sensor_to_metric(row) for row in sensors],
        "allSensors": all_sensors,
        "operations": ["08:00 系统自动巡检完成", "08:20 水质数据刷新成功", "08:40 后端 API 数据同步完成"],
        "exceptions": ["今日 07:42 2号池 pH 异常", "昨日 19:35 4号池水位异常"],
    }


@app.get("/api/feeding/plans")
def get_feeding_plans() -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM feeding_plan ORDER BY time, id").fetchall()
    return [
        {
            "id": row["id"],
            "pond": row["pond"],
            "time": row["time"],
            "feedName": row["feed_name"],
            "amountKg": row["amount_kg"],
            "enabled": bool(row["enabled"]),
        }
        for row in rows
    ]


@app.post("/api/feeding/plans")
def post_feeding_plan(payload: FeedingPlanPayload) -> dict[str, Any]:
    with get_conn() as conn:
        cursor = conn.execute(
            "INSERT INTO feeding_plan (pond, time, feed_name, amount_kg, enabled) VALUES (?, ?, ?, ?, ?)",
            (payload.pond, payload.time, payload.feedName, payload.amountKg, 1 if payload.enabled else 0),
        )
        plan_id = cursor.lastrowid
    return {"success": True, "id": plan_id}


@app.get("/api/cameras")
def get_cameras() -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM camera_config ORDER BY id").fetchall()
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "location": row["location"],
            "streamUrl": row["stream_url"],
            "status": row["status"],
        }
        for row in rows
    ]


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


@app.get("/{page_name}.html")
def html_page(page_name: str) -> FileResponse:
    page = FRONTEND_DIR / f"{page_name}.html"
    if not page.exists():
        raise HTTPException(status_code=404, detail="Page not found")
    return FileResponse(page)


app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")
