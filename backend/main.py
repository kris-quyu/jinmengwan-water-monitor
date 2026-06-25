import hashlib
import hmac
import json
import math
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import jwt
from fastapi import Depends, FastAPI, Header, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "jinmengwan.db"
JWT_SECRET = os.getenv("JWT_SECRET", "change-this-secret-before-production")
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_MINUTES = 8 * 60
GATEWAY_TOKEN = os.getenv("GATEWAY_TOKEN", "jmw-demo-gateway-token")

SENSOR_DEFINITIONS = {
    "do": {"name": "DO", "unit": "mg/L", "base": 6.8},
    "water_temp": {"name": "水温", "unit": "℃", "base": 28.5},
    "ph": {"name": "pH", "unit": "", "base": 8.1},
    "orp": {"name": "ORP", "unit": "mV", "base": 220},
    "water_level": {"name": "水位", "unit": "cm", "base": 80},
    "salinity": {"name": "盐度", "unit": "ppt", "base": 12.0},
    "room_temp": {"name": "室温", "unit": "℃", "base": 27.2},
}

DEFAULT_THRESHOLDS = {
    "do_min": 5.0,
    "do_danger": 4.0,
    "water_temp_min": 26.0,
    "water_temp_max": 32.0,
    "ph_min": 7.6,
    "ph_max": 8.6,
    "orp_min": 180.0,
    "orp_max": 280.0,
    "water_level_min": 60.0,
    "water_level_max": 95.0,
}

app = FastAPI(title="金梦湾渔业水质在线监测平台 API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
security = HTTPBearer(auto_error=False)


class LoginPayload(BaseModel):
    username: str
    password: str


class ThresholdPayload(BaseModel):
    farm_id: int
    values: dict[str, float]


class FeedPlanPayload(BaseModel):
    farm_id: int
    pond_id: int
    feed_time: str
    feed_name: str
    amount_kg: float = Field(gt=0)
    enabled: bool = True


class GatewayReadingPayload(BaseModel):
    farm_id: int
    pond_id: int
    device_id: int
    do_value: float | None = None
    water_temp: float | None = None
    ph_value: float | None = None
    orp_value: float | None = None
    water_level: float | None = None
    salinity: float | None = None
    room_temp: float | None = None
    system_status: str = "normal"
    alarm_status: str = "normal"
    communication_status: str = "online"
    timestamp: str | None = None


class FarmPayload(BaseModel):
    name: str
    location: str = ""
    pond_count: int = Field(default=4, ge=1, le=100)


class UserPayload(BaseModel):
    username: str
    display_name: str
    password: str = Field(min_length=6)
    role: str = "operator"
    farm_ids: list[int] = []


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def password_hash(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000)
    return f"{salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt, expected = stored.split("$", 1)
    except ValueError:
        return False
    actual = password_hash(password, salt).split("$", 1)[1]
    return hmac.compare_digest(actual, expected)


def create_token(user: sqlite3.Row) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user["id"]),
        "username": user["username"],
        "role": user["role"],
        "iat": now,
        "exp": now + timedelta(minutes=ACCESS_TOKEN_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> dict[str, Any]:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="请先登录")
    try:
        payload = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="登录已失效")
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, username, display_name, role, active FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    if not row or not row["active"]:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不可用")
    return dict(row)


def require_admin(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


def accessible_farm_ids(user: dict[str, Any]) -> list[int]:
    with get_conn() as conn:
        if user["role"] == "admin":
            rows = conn.execute("SELECT id FROM farms WHERE active = 1 ORDER BY id").fetchall()
        else:
            rows = conn.execute(
                """
                SELECT f.id FROM farms f
                JOIN user_farms uf ON uf.farm_id = f.id
                WHERE uf.user_id = ? AND f.active = 1
                ORDER BY f.id
                """,
                (user["id"],),
            ).fetchall()
    return [row["id"] for row in rows]


def ensure_farm_access(user: dict[str, Any], farm_id: int | None) -> int:
    farm_ids = accessible_farm_ids(user)
    if not farm_ids:
        raise HTTPException(status_code=403, detail="当前用户未绑定养殖场")
    selected = farm_id or farm_ids[0]
    if selected not in farm_ids:
        raise HTTPException(status_code=403, detail="无权访问该养殖场")
    return selected


def create_schema() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'operator',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS farms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                location TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS user_farms (
                user_id INTEGER NOT NULL,
                farm_id INTEGER NOT NULL,
                PRIMARY KEY (user_id, farm_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (farm_id) REFERENCES farms(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS ponds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                farm_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                code TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'running',
                FOREIGN KEY (farm_id) REFERENCES farms(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS devices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                farm_id INTEGER NOT NULL,
                pond_id INTEGER,
                device_code TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                device_type TEXT NOT NULL,
                communication_status TEXT NOT NULL DEFAULT 'online',
                last_seen TEXT,
                FOREIGN KEY (farm_id) REFERENCES farms(id) ON DELETE CASCADE,
                FOREIGN KEY (pond_id) REFERENCES ponds(id) ON DELETE SET NULL
            );
            CREATE TABLE IF NOT EXISTS sensor_readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                farm_id INTEGER NOT NULL,
                pond_id INTEGER NOT NULL,
                device_id INTEGER NOT NULL,
                do_value REAL,
                water_temp REAL,
                ph_value REAL,
                orp_value REAL,
                water_level REAL,
                salinity REAL,
                room_temp REAL,
                system_status TEXT NOT NULL,
                alarm_status TEXT NOT NULL,
                communication_status TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (farm_id) REFERENCES farms(id),
                FOREIGN KEY (pond_id) REFERENCES ponds(id),
                FOREIGN KEY (device_id) REFERENCES devices(id)
            );
            CREATE INDEX IF NOT EXISTS idx_readings_farm_time
                ON sensor_readings(farm_id, timestamp DESC);
            CREATE TABLE IF NOT EXISTS alarm_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                farm_id INTEGER NOT NULL,
                pond_id INTEGER NOT NULL,
                device_id INTEGER,
                metric TEXT NOT NULL,
                value REAL NOT NULL,
                level TEXT NOT NULL,
                message TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                handled_at TEXT,
                handled_by INTEGER,
                FOREIGN KEY (farm_id) REFERENCES farms(id),
                FOREIGN KEY (pond_id) REFERENCES ponds(id)
            );
            CREATE TABLE IF NOT EXISTS thresholds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                farm_id INTEGER NOT NULL,
                metric TEXT NOT NULL,
                min_value REAL,
                max_value REAL,
                UNIQUE(farm_id, metric),
                FOREIGN KEY (farm_id) REFERENCES farms(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS feed_plans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                farm_id INTEGER NOT NULL,
                pond_id INTEGER NOT NULL,
                feed_time TEXT NOT NULL,
                feed_name TEXT NOT NULL,
                amount_kg REAL NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY (farm_id) REFERENCES farms(id),
                FOREIGN KEY (pond_id) REFERENCES ponds(id)
            );
            """
        )


def seed_database() -> None:
    now = datetime.now()
    with get_conn() as conn:
        if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
            conn.executemany(
                """
                INSERT INTO users (username, display_name, password_hash, role, active, created_at)
                VALUES (?, ?, ?, ?, 1, ?)
                """,
                [
                    ("admin", "系统管理员", password_hash("Admin123!"), "admin", now.isoformat()),
                    ("operator1", "一号场操作员", password_hash("Demo123!"), "operator", now.isoformat()),
                    ("operator2", "二号场操作员", password_hash("Demo123!"), "operator", now.isoformat()),
                ],
            )
        if conn.execute("SELECT COUNT(*) FROM farms").fetchone()[0] == 0:
            conn.executemany(
                "INSERT INTO farms (name, location, active, created_at) VALUES (?, ?, 1, ?)",
                [
                    ("金梦湾一号养殖场", "广东省湛江市", now.isoformat()),
                    ("金梦湾二号养殖场", "广东省阳江市", now.isoformat()),
                ],
            )
        if conn.execute("SELECT COUNT(*) FROM ponds").fetchone()[0] == 0:
            farms = conn.execute("SELECT id FROM farms ORDER BY id").fetchall()
            for farm in farms:
                pond_count = 4 if farm["id"] == farms[0]["id"] else 3
                conn.executemany(
                    "INSERT INTO ponds (farm_id, name, code, status) VALUES (?, ?, ?, 'running')",
                    [(farm["id"], f"{i}号池", f"P{i:02d}") for i in range(1, pond_count + 1)],
                )
        if conn.execute("SELECT COUNT(*) FROM user_farms").fetchone()[0] == 0:
            users = {row["username"]: row["id"] for row in conn.execute("SELECT id, username FROM users")}
            farms = [row["id"] for row in conn.execute("SELECT id FROM farms ORDER BY id")]
            links = []
            if farms:
                links.append((users["operator1"], farms[0]))
            if len(farms) > 1:
                links.append((users["operator2"], farms[1]))
            conn.executemany("INSERT OR IGNORE INTO user_farms (user_id, farm_id) VALUES (?, ?)", links)
        if conn.execute("SELECT COUNT(*) FROM devices").fetchone()[0] == 0:
            ponds = conn.execute("SELECT id, farm_id, name FROM ponds ORDER BY farm_id, id").fetchall()
            conn.executemany(
                """
                INSERT INTO devices
                (farm_id, pond_id, device_code, name, device_type, communication_status, last_seen)
                VALUES (?, ?, ?, ?, 'water_gateway', 'online', ?)
                """,
                [
                    (
                        pond["farm_id"],
                        pond["id"],
                        f"JMW-F{pond['farm_id']:02d}-P{pond['id']:03d}",
                        f"{pond['name']}水质采集网关",
                        now.isoformat(timespec="seconds"),
                    )
                    for pond in ponds
                ],
            )
        if conn.execute("SELECT COUNT(*) FROM thresholds").fetchone()[0] == 0:
            farm_ids = [row["id"] for row in conn.execute("SELECT id FROM farms")]
            metric_rows = [
                ("do", DEFAULT_THRESHOLDS["do_danger"], None),
                ("water_temp", DEFAULT_THRESHOLDS["water_temp_min"], DEFAULT_THRESHOLDS["water_temp_max"]),
                ("ph", DEFAULT_THRESHOLDS["ph_min"], DEFAULT_THRESHOLDS["ph_max"]),
                ("orp", DEFAULT_THRESHOLDS["orp_min"], DEFAULT_THRESHOLDS["orp_max"]),
                ("water_level", DEFAULT_THRESHOLDS["water_level_min"], DEFAULT_THRESHOLDS["water_level_max"]),
            ]
            conn.executemany(
                "INSERT OR IGNORE INTO thresholds (farm_id, metric, min_value, max_value) VALUES (?, ?, ?, ?)",
                [(farm_id, metric, low, high) for farm_id in farm_ids for metric, low, high in metric_rows],
            )
        if conn.execute("SELECT COUNT(*) FROM sensor_readings").fetchone()[0] == 0:
            devices = conn.execute("SELECT id, farm_id, pond_id FROM devices ORDER BY id").fetchall()
            rows = []
            for point in range(48):
                ts = now - timedelta(minutes=(47 - point) * 30)
                for device in devices:
                    phase = point / 4 + device["pond_id"] * 0.3
                    rows.append(
                        (
                            device["farm_id"], device["pond_id"], device["id"],
                            round(6.8 + math.sin(phase) * 0.35, 2),
                            round(28.5 + math.sin(phase / 2) * 1.1, 2),
                            round(8.1 + math.cos(phase) * 0.12, 2),
                            round(220 + math.sin(phase) * 18, 1),
                            round(80 + math.cos(phase / 2) * 4, 1),
                            round(12 + math.sin(phase / 3) * 0.8, 2),
                            round(27.2 + math.cos(phase / 2) * 1.4, 2),
                            "normal", "normal", "online", ts.isoformat(timespec="seconds"),
                        )
                    )
            conn.executemany(
                """
                INSERT INTO sensor_readings
                (farm_id, pond_id, device_id, do_value, water_temp, ph_value, orp_value,
                 water_level, salinity, room_temp, system_status, alarm_status,
                 communication_status, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
        if conn.execute("SELECT COUNT(*) FROM alarm_logs").fetchone()[0] == 0:
            devices = conn.execute("SELECT id, farm_id, pond_id FROM devices ORDER BY id LIMIT 6").fetchall()
            metrics = [("do", 4.8, "warning", "溶解氧接近提醒阈值"), ("ph", 8.7, "abnormal", "pH 高于上限"), ("orp", 168, "warning", "ORP 低于建议范围")]
            conn.executemany(
                """
                INSERT INTO alarm_logs
                (farm_id, pond_id, device_id, metric, value, level, message, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
                """,
                [
                    (
                        device["farm_id"], device["pond_id"], device["id"],
                        metrics[i % len(metrics)][0], metrics[i % len(metrics)][1],
                        metrics[i % len(metrics)][2], metrics[i % len(metrics)][3],
                        (now - timedelta(hours=i + 1)).isoformat(timespec="seconds"),
                    )
                    for i, device in enumerate(devices)
                ],
            )
        if conn.execute("SELECT COUNT(*) FROM feed_plans").fetchone()[0] == 0:
            ponds = conn.execute("SELECT id, farm_id FROM ponds ORDER BY farm_id, id LIMIT 5").fetchall()
            conn.executemany(
                """
                INSERT INTO feed_plans (farm_id, pond_id, feed_time, feed_name, amount_kg, enabled)
                VALUES (?, ?, ?, '对虾配合饲料', ?, 1)
                """,
                [(pond["farm_id"], pond["id"], "08:30", 10 + index) for index, pond in enumerate(ponds)],
            )


@app.on_event("startup")
def startup() -> None:
    create_schema()
    seed_database()


def latest_rows(farm_id: int) -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            """
            SELECT sr.*, p.name AS pond_name, d.name AS device_name
            FROM sensor_readings sr
            JOIN ponds p ON p.id = sr.pond_id
            JOIN devices d ON d.id = sr.device_id
            JOIN (
                SELECT pond_id, MAX(timestamp) AS max_time
                FROM sensor_readings WHERE farm_id = ? GROUP BY pond_id
            ) latest ON latest.pond_id = sr.pond_id AND latest.max_time = sr.timestamp
            WHERE sr.farm_id = ?
            ORDER BY sr.pond_id
            """,
            (farm_id, farm_id),
        ).fetchall()


def reading_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "farm_id": row["farm_id"],
        "pond_id": row["pond_id"],
        "pond_name": row["pond_name"],
        "device_id": row["device_id"],
        "device_name": row["device_name"],
        "do_value": row["do_value"],
        "water_temp": row["water_temp"],
        "ph_value": row["ph_value"],
        "orp_value": row["orp_value"],
        "water_level": row["water_level"],
        "salinity": row["salinity"],
        "room_temp": row["room_temp"],
        "system_status": row["system_status"],
        "alarm_status": row["alarm_status"],
        "communication_status": row["communication_status"],
        "timestamp": row["timestamp"],
    }


@app.post("/api/auth/login")
def login(payload: LoginPayload) -> dict[str, Any]:
    with get_conn() as conn:
        user = conn.execute("SELECT * FROM users WHERE username = ?", (payload.username,)).fetchone()
    if not user or not user["active"] or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    return {"access_token": create_token(user), "token_type": "bearer"}


@app.get("/api/auth/me")
def me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return {**user, "farm_ids": accessible_farm_ids(user)}


@app.get("/api/farms")
def farms(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    ids = accessible_farm_ids(user)
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT f.*, COUNT(p.id) AS pond_count
            FROM farms f LEFT JOIN ponds p ON p.farm_id = f.id
            WHERE f.id IN ({placeholders})
            GROUP BY f.id ORDER BY f.id
            """,
            ids,
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/ponds")
def ponds(farm_id: int | None = None, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    selected = ensure_farm_access(user, farm_id)
    with get_conn() as conn:
        rows = conn.execute("SELECT * FROM ponds WHERE farm_id = ? ORDER BY id", (selected,)).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/dashboard")
def dashboard(farm_id: int | None = None, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    selected = ensure_farm_access(user, farm_id)
    latest = [reading_dict(row) for row in latest_rows(selected)]
    with get_conn() as conn:
        farm = dict(conn.execute("SELECT * FROM farms WHERE id = ?", (selected,)).fetchone())
        pond_count = conn.execute("SELECT COUNT(*) FROM ponds WHERE farm_id = ?", (selected,)).fetchone()[0]
        device_count = conn.execute("SELECT COUNT(*) FROM devices WHERE farm_id = ?", (selected,)).fetchone()[0]
        online_count = conn.execute(
            "SELECT COUNT(*) FROM devices WHERE farm_id = ? AND communication_status = 'online'", (selected,)
        ).fetchone()[0]
        alarm_count = conn.execute(
            "SELECT COUNT(*) FROM alarm_logs WHERE farm_id = ? AND status = 'pending'", (selected,)
        ).fetchone()[0]
    return {
        "farm": farm,
        "summary": {
            "pond_count": pond_count,
            "device_count": device_count,
            "online_count": online_count,
            "pending_alarm_count": alarm_count,
        },
        "latest": latest,
    }


@app.get("/api/latest")
def latest(farm_id: int | None = None, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    return [reading_dict(row) for row in latest_rows(ensure_farm_access(user, farm_id))]


@app.get("/api/history")
def history(
    metric: str = "do",
    range_key: str = Query("24h", alias="range"),
    farm_id: int | None = None,
    pond_id: int | None = None,
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    selected = ensure_farm_access(user, farm_id)
    column_map = {
        "do": "do_value", "water_temp": "water_temp", "ph": "ph_value",
        "orp": "orp_value", "water_level": "water_level",
        "salinity": "salinity", "room_temp": "room_temp",
    }
    if metric not in column_map:
        raise HTTPException(status_code=400, detail="不支持的指标")
    hours = {"30m": 0.5, "1h": 1, "6h": 6, "12h": 12, "24h": 24, "7d": 168}.get(range_key, 24)
    since = (datetime.now() - timedelta(hours=hours)).isoformat(timespec="seconds")
    params: list[Any] = [selected, since]
    pond_clause = ""
    if pond_id:
        with get_conn() as conn:
            pond = conn.execute("SELECT farm_id FROM ponds WHERE id = ?", (pond_id,)).fetchone()
        if not pond or pond["farm_id"] != selected:
            raise HTTPException(status_code=403, detail="无权访问该池塘")
        pond_clause = "AND sr.pond_id = ?"
        params.append(pond_id)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT sr.timestamp, sr.{column_map[metric]} AS value, sr.pond_id, p.name AS pond_name
            FROM sensor_readings sr JOIN ponds p ON p.id = sr.pond_id
            WHERE sr.farm_id = ? AND sr.timestamp >= ? {pond_clause}
            ORDER BY sr.timestamp
            """,
            params,
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/alarms")
def alarms(farm_id: int | None = None, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    selected = ensure_farm_access(user, farm_id)
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT a.*, p.name AS pond_name,
                   COALESCE(u.display_name, '') AS handled_by_name
            FROM alarm_logs a
            JOIN ponds p ON p.id = a.pond_id
            LEFT JOIN users u ON u.id = a.handled_by
            WHERE a.farm_id = ?
            ORDER BY a.created_at DESC
            """,
            (selected,),
        ).fetchall()
    return [
        {
            **dict(row),
            "sensor_name": SENSOR_DEFINITIONS.get(row["metric"], {}).get("name", row["metric"]),
            "unit": SENSOR_DEFINITIONS.get(row["metric"], {}).get("unit", ""),
        }
        for row in rows
    ]


@app.post("/api/alarms/{alarm_id}/handle")
def handle_alarm(alarm_id: int, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    with get_conn() as conn:
        row = conn.execute("SELECT farm_id FROM alarm_logs WHERE id = ?", (alarm_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="报警不存在")
        ensure_farm_access(user, row["farm_id"])
        conn.execute(
            """
            UPDATE alarm_logs SET status = 'handled', handled_at = ?, handled_by = ?
            WHERE id = ?
            """,
            (datetime.now().isoformat(timespec="seconds"), user["id"], alarm_id),
        )
    return {"success": True}


@app.get("/api/settings")
def get_settings(farm_id: int | None = None, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    selected = ensure_farm_access(user, farm_id)
    with get_conn() as conn:
        rows = conn.execute("SELECT metric, min_value, max_value FROM thresholds WHERE farm_id = ?", (selected,)).fetchall()
    return {"farm_id": selected, "thresholds": [dict(row) for row in rows]}


@app.post("/api/settings")
def save_settings(payload: ThresholdPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    selected = ensure_farm_access(user, payload.farm_id)
    grouped: dict[str, dict[str, float]] = {}
    for key, value in payload.values.items():
        suffix = "_min" if key.endswith("_min") else "_max" if key.endswith("_max") else ""
        metric = key[: -len(suffix)] if suffix else key
        if metric in SENSOR_DEFINITIONS and suffix:
            grouped.setdefault(metric, {})[suffix[1:]] = value
    with get_conn() as conn:
        for metric, values in grouped.items():
            current = conn.execute(
                "SELECT min_value, max_value FROM thresholds WHERE farm_id = ? AND metric = ?",
                (selected, metric),
            ).fetchone()
            low = values.get("min", current["min_value"] if current else None)
            high = values.get("max", current["max_value"] if current else None)
            conn.execute(
                """
                INSERT INTO thresholds (farm_id, metric, min_value, max_value) VALUES (?, ?, ?, ?)
                ON CONFLICT(farm_id, metric) DO UPDATE SET min_value = excluded.min_value, max_value = excluded.max_value
                """,
                (selected, metric, low, high),
            )
    return {"success": True}


@app.get("/api/sensors")
def sensors(farm_id: int | None = None, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    selected = ensure_farm_access(user, farm_id)
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT d.*, p.name AS pond_name FROM devices d
            LEFT JOIN ponds p ON p.id = d.pond_id
            WHERE d.farm_id = ? ORDER BY d.id
            """,
            (selected,),
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/feeding/plans")
def feeding_plans(farm_id: int | None = None, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    selected = ensure_farm_access(user, farm_id)
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT fp.*, p.name AS pond_name FROM feed_plans fp
            JOIN ponds p ON p.id = fp.pond_id
            WHERE fp.farm_id = ? ORDER BY fp.feed_time, fp.id
            """,
            (selected,),
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/feeding/plans")
def save_feeding_plan(payload: FeedPlanPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    selected = ensure_farm_access(user, payload.farm_id)
    with get_conn() as conn:
        pond = conn.execute("SELECT farm_id FROM ponds WHERE id = ?", (payload.pond_id,)).fetchone()
        if not pond or pond["farm_id"] != selected:
            raise HTTPException(status_code=400, detail="池塘不属于当前养殖场")
        cursor = conn.execute(
            """
            INSERT INTO feed_plans (farm_id, pond_id, feed_time, feed_name, amount_kg, enabled)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (selected, payload.pond_id, payload.feed_time, payload.feed_name, payload.amount_kg, int(payload.enabled)),
        )
    return {"success": True, "id": cursor.lastrowid}


@app.get("/api/cameras")
def cameras(farm_id: int | None = None, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    selected = ensure_farm_access(user, farm_id)
    with get_conn() as conn:
        ponds_data = conn.execute("SELECT id, name FROM ponds WHERE farm_id = ? ORDER BY id", (selected,)).fetchall()
    return [
        {"id": pond["id"], "name": f"{pond['name']}摄像头", "location": pond["name"], "status": "reserved", "stream_url": ""}
        for pond in ponds_data
    ]


@app.post("/api/gateway/ingest")
def gateway_ingest(
    payload: GatewayReadingPayload,
    x_gateway_token: str | None = Header(default=None),
) -> dict[str, Any]:
    if x_gateway_token != GATEWAY_TOKEN:
        raise HTTPException(status_code=401, detail="网关令牌无效")
    with get_conn() as conn:
        device = conn.execute(
            "SELECT farm_id, pond_id FROM devices WHERE id = ?", (payload.device_id,)
        ).fetchone()
        if not device or device["farm_id"] != payload.farm_id or device["pond_id"] != payload.pond_id:
            raise HTTPException(status_code=400, detail="设备、池塘和养殖场不匹配")
        timestamp = payload.timestamp or datetime.now().isoformat(timespec="seconds")
        cursor = conn.execute(
            """
            INSERT INTO sensor_readings
            (farm_id, pond_id, device_id, do_value, water_temp, ph_value, orp_value,
             water_level, salinity, room_temp, system_status, alarm_status,
             communication_status, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.farm_id, payload.pond_id, payload.device_id, payload.do_value,
                payload.water_temp, payload.ph_value, payload.orp_value, payload.water_level,
                payload.salinity, payload.room_temp, payload.system_status, payload.alarm_status,
                payload.communication_status, timestamp,
            ),
        )
        conn.execute(
            "UPDATE devices SET communication_status = ?, last_seen = ? WHERE id = ?",
            (payload.communication_status, timestamp, payload.device_id),
        )
    return {"success": True, "reading_id": cursor.lastrowid}


@app.get("/api/admin/users")
def admin_users(_: dict[str, Any] = Depends(require_admin)) -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT u.id, u.username, u.display_name, u.role, u.active,
                   GROUP_CONCAT(f.name, '、') AS farms
            FROM users u
            LEFT JOIN user_farms uf ON uf.user_id = u.id
            LEFT JOIN farms f ON f.id = uf.farm_id
            GROUP BY u.id ORDER BY u.id
            """
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/admin/users")
def create_user(payload: UserPayload, _: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    if payload.role not in {"admin", "operator", "viewer"}:
        raise HTTPException(status_code=400, detail="角色无效")
    with get_conn() as conn:
        try:
            cursor = conn.execute(
                """
                INSERT INTO users (username, display_name, password_hash, role, active, created_at)
                VALUES (?, ?, ?, ?, 1, ?)
                """,
                (payload.username, payload.display_name, password_hash(payload.password), payload.role, datetime.now().isoformat()),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=409, detail="用户名已存在")
        conn.executemany(
            "INSERT OR IGNORE INTO user_farms (user_id, farm_id) VALUES (?, ?)",
            [(cursor.lastrowid, farm_id) for farm_id in payload.farm_ids],
        )
    return {"success": True, "id": cursor.lastrowid}


@app.post("/api/admin/farms")
def create_farm(payload: FarmPayload, _: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    with get_conn() as conn:
        cursor = conn.execute(
            "INSERT INTO farms (name, location, active, created_at) VALUES (?, ?, 1, ?)",
            (payload.name, payload.location, datetime.now().isoformat()),
        )
        farm_id = cursor.lastrowid
        pond_rows = [(farm_id, f"{i}号池", f"P{i:02d}") for i in range(1, payload.pond_count + 1)]
        conn.executemany("INSERT INTO ponds (farm_id, name, code) VALUES (?, ?, ?)", pond_rows)
        ponds_created = conn.execute("SELECT id, name FROM ponds WHERE farm_id = ? ORDER BY id", (farm_id,)).fetchall()
        conn.executemany(
            """
            INSERT INTO devices
            (farm_id, pond_id, device_code, name, device_type, communication_status, last_seen)
            VALUES (?, ?, ?, ?, 'water_gateway', 'offline', NULL)
            """,
            [(farm_id, pond["id"], f"JMW-F{farm_id:02d}-P{pond['id']:03d}", f"{pond['name']}水质采集网关") for pond in ponds_created],
        )
    return {"success": True, "id": farm_id}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "mode": "mock-plc"}


app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")


@app.get("/")
def root() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "login.html")


@app.get("/{page_name}.html")
def page(page_name: str) -> FileResponse:
    safe_pages = {
        "login", "index", "monitoring", "analysis", "alarm", "settings",
        "device", "feeding", "camera", "management",
    }
    if page_name not in safe_pages:
        raise HTTPException(status_code=404, detail="Page not found")
    return FileResponse(FRONTEND_DIR / f"{page_name}.html")
