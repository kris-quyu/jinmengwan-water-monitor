import hashlib
import hmac
import math
import os
import random
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

SENSOR_TYPES = {
    "do": {"name": "DO", "unit": "mg/L", "base": 6.8, "min": 5.0, "max": 9.0, "default": True},
    "water_temp": {"name": "水温", "unit": "℃", "base": 28.5, "min": 26.0, "max": 32.0, "default": True},
    "ph": {"name": "pH", "unit": "", "base": 8.1, "min": 7.6, "max": 8.6, "default": True},
    "orp": {"name": "ORP", "unit": "mV", "base": 220.0, "min": 180.0, "max": 280.0, "default": True},
    "water_level": {"name": "水位", "unit": "cm", "base": 80.0, "min": 60.0, "max": 95.0, "default": True},
    "salinity": {"name": "盐度", "unit": "‰", "base": 12.0, "min": 8.0, "max": 18.0, "default": False},
    "ammonia": {"name": "氨氮", "unit": "mg/L", "base": 0.18, "min": 0.0, "max": 0.5, "default": False},
    "nitrite": {"name": "亚硝酸盐", "unit": "mg/L", "base": 0.08, "min": 0.0, "max": 0.2, "default": False},
}

app = FastAPI(title="金梦湾渔业水质在线监测平台 API", version="0.3.0")
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


class FarmPayload(BaseModel):
    name: str
    location: str = ""
    status: str = "active"
    pond_count: int = Field(default=0, ge=0, le=100)


class PondPayload(BaseModel):
    name: str
    sort_order: int = 0
    status: str = "active"
    remark: str = ""


class SensorPayload(BaseModel):
    farm_id: int
    pond_id: int | None = None
    name: str
    type: str
    unit: str = ""
    address: str = "1"
    register: str = "0"
    data_type: str = "float32"
    enabled: bool = True
    min_limit: float | None = None
    max_limit: float | None = None
    low_alarm: float | None = None
    high_alarm: float | None = None
    sort_order: int = 0
    remark: str = ""


class FeedPlanPayload(BaseModel):
    farm_id: int
    pond_id: int
    feed_time: str
    feed_name: str
    amount_kg: float = Field(gt=0)
    enabled: bool = True


class UserPayload(BaseModel):
    username: str
    display_name: str
    password: str = Field(min_length=6)
    role: str = "operator"
    farm_ids: list[int] = []


class GatewayReadingItem(BaseModel):
    sensor_id: int
    value: float
    status: str = "normal"
    timestamp: str | None = None


class GatewayPayload(BaseModel):
    farm_id: int
    pond_id: int
    readings: list[GatewayReadingItem]


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?", (name,)
    ).fetchone() is not None


def table_columns(conn: sqlite3.Connection, name: str) -> set[str]:
    if not table_exists(conn, name):
        return set()
    return {row["name"] for row in conn.execute(f"PRAGMA table_info({name})")}


def add_column(conn: sqlite3.Connection, table: str, definition: str) -> None:
    name = definition.split()[0]
    if name not in table_columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {definition}")


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
    return jwt.encode(
        {
            "sub": str(user["id"]),
            "username": user["username"],
            "role": user["role"],
            "iat": now,
            "exp": now + timedelta(minutes=ACCESS_TOKEN_MINUTES),
        },
        JWT_SECRET,
        algorithm=JWT_ALGORITHM,
    )


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
        raise HTTPException(status_code=401, detail="用户不可用")
    return dict(row)


def require_admin(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


def require_editor(user: dict[str, Any]) -> None:
    if user["role"] == "viewer":
        raise HTTPException(status_code=403, detail="只读账号不能修改配置")


def accessible_farm_ids(user: dict[str, Any]) -> list[int]:
    with get_conn() as conn:
        if user["role"] == "admin":
            rows = conn.execute(
                "SELECT id FROM farms WHERE status != 'deleted' ORDER BY id"
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT f.id FROM farms f
                JOIN user_farms uf ON uf.farm_id = f.id
                WHERE uf.user_id = ? AND f.status != 'deleted'
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


def get_pond_or_404(conn: sqlite3.Connection, pond_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM ponds WHERE id = ?", (pond_id,)).fetchone()
    if not row or row["status"] == "deleted":
        raise HTTPException(status_code=404, detail="水池不存在")
    return row


def get_sensor_or_404(conn: sqlite3.Connection, sensor_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM sensors WHERE id = ?", (sensor_id,)).fetchone()
    if not row or row["status"] == "deleted":
        raise HTTPException(status_code=404, detail="传感器不存在")
    return row


def migrate_schema() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        if table_exists(conn, "sensor_readings") and "sensor_id" not in table_columns(conn, "sensor_readings"):
            if table_exists(conn, "sensor_readings_legacy"):
                conn.execute("DROP TABLE sensor_readings_legacy")
            conn.execute("ALTER TABLE sensor_readings RENAME TO sensor_readings_legacy")
        if table_exists(conn, "alarm_logs") and "sensor_id" not in table_columns(conn, "alarm_logs"):
            if table_exists(conn, "alarm_logs_legacy"):
                conn.execute("DROP TABLE alarm_logs_legacy")
            conn.execute("ALTER TABLE alarm_logs RENAME TO alarm_logs_legacy")

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
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS user_farms (
                user_id INTEGER NOT NULL,
                farm_id INTEGER NOT NULL,
                PRIMARY KEY (user_id, farm_id),
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (farm_id) REFERENCES farms(id)
            );
            CREATE TABLE IF NOT EXISTS ponds (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                farm_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                code TEXT NOT NULL DEFAULT '',
                sort_order INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'active',
                remark TEXT NOT NULL DEFAULT '',
                created_at TEXT,
                updated_at TEXT,
                FOREIGN KEY (farm_id) REFERENCES farms(id)
            );
            CREATE TABLE IF NOT EXISTS sensors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                farm_id INTEGER NOT NULL,
                pond_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                type TEXT NOT NULL,
                unit TEXT NOT NULL DEFAULT '',
                address TEXT NOT NULL DEFAULT '1',
                register TEXT NOT NULL DEFAULT '0',
                data_type TEXT NOT NULL DEFAULT 'float32',
                enabled INTEGER NOT NULL DEFAULT 1,
                min_limit REAL,
                max_limit REAL,
                low_alarm REAL,
                high_alarm REAL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                remark TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'active',
                communication_status TEXT NOT NULL DEFAULT 'online',
                communication_failures INTEGER NOT NULL DEFAULT 0,
                created_at TEXT,
                updated_at TEXT,
                FOREIGN KEY (farm_id) REFERENCES farms(id),
                FOREIGN KEY (pond_id) REFERENCES ponds(id)
            );
            CREATE TABLE IF NOT EXISTS sensor_readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                farm_id INTEGER NOT NULL,
                pond_id INTEGER NOT NULL,
                sensor_id INTEGER NOT NULL,
                sensor_type TEXT NOT NULL,
                value REAL NOT NULL,
                unit TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'normal',
                timestamp TEXT NOT NULL,
                FOREIGN KEY (farm_id) REFERENCES farms(id),
                FOREIGN KEY (pond_id) REFERENCES ponds(id),
                FOREIGN KEY (sensor_id) REFERENCES sensors(id)
            );
            CREATE INDEX IF NOT EXISTS idx_readings_sensor_time
                ON sensor_readings(sensor_id, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_readings_farm_time
                ON sensor_readings(farm_id, timestamp DESC);
            CREATE TABLE IF NOT EXISTS alarm_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                farm_id INTEGER NOT NULL,
                pond_id INTEGER NOT NULL,
                sensor_id INTEGER NOT NULL,
                sensor_type TEXT NOT NULL,
                alarm_type TEXT NOT NULL,
                alarm_level TEXT NOT NULL,
                value REAL NOT NULL,
                threshold REAL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                confirmed_at TEXT,
                confirmed_by INTEGER,
                FOREIGN KEY (farm_id) REFERENCES farms(id),
                FOREIGN KEY (pond_id) REFERENCES ponds(id),
                FOREIGN KEY (sensor_id) REFERENCES sensors(id)
            );
            CREATE TABLE IF NOT EXISTS feed_plans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                farm_id INTEGER NOT NULL,
                pond_id INTEGER NOT NULL,
                feed_time TEXT NOT NULL,
                feed_name TEXT NOT NULL,
                amount_kg REAL NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1
            );
            """
        )
        add_column(conn, "farms", "status TEXT NOT NULL DEFAULT 'active'")
        add_column(conn, "ponds", "sort_order INTEGER NOT NULL DEFAULT 0")
        add_column(conn, "ponds", "remark TEXT NOT NULL DEFAULT ''")
        add_column(conn, "ponds", "created_at TEXT")
        add_column(conn, "ponds", "updated_at TEXT")
        conn.execute("UPDATE farms SET status = CASE WHEN active = 1 THEN 'active' ELSE 'disabled' END WHERE status IS NULL OR status = ''")
        conn.execute("UPDATE ponds SET status = 'active' WHERE status = 'running'")
        farm_ids = [row["id"] for row in conn.execute("SELECT id FROM farms ORDER BY id")]
        for farm_id in farm_ids:
            ponds = conn.execute(
                "SELECT id, name, sort_order FROM ponds WHERE farm_id = ? ORDER BY id",
                (farm_id,),
            ).fetchall()
            for index, pond in enumerate(ponds, 1):
                name = pond["name"] if "池" in (pond["name"] or "") else f"{index}号池"
                sort_order = pond["sort_order"] or index
                conn.execute(
                    "UPDATE ponds SET name = ?, sort_order = ? WHERE id = ?",
                    (name, sort_order, pond["id"]),
                )


def seed_database() -> None:
    now = datetime.now().isoformat(timespec="seconds")
    with get_conn() as conn:
        if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
            conn.executemany(
                """
                INSERT INTO users (username, display_name, password_hash, role, active, created_at)
                VALUES (?, ?, ?, ?, 1, ?)
                """,
                [
                    ("admin", "系统管理员", password_hash("Admin123!"), "admin", now),
                    ("operator1", "一号场操作员", password_hash("Demo123!"), "operator", now),
                ],
            )
        if conn.execute("SELECT COUNT(*) FROM farms").fetchone()[0] == 0:
            conn.execute(
                "INSERT INTO farms (name, location, active, status, created_at) VALUES (?, ?, 1, 'active', ?)",
                ("金梦湾一号养殖场", "广东省湛江市", now),
            )
        if conn.execute("SELECT COUNT(*) FROM ponds WHERE status != 'deleted'").fetchone()[0] == 0:
            farm_id = conn.execute("SELECT id FROM farms ORDER BY id LIMIT 1").fetchone()["id"]
            conn.executemany(
                """
                INSERT INTO ponds (farm_id, name, code, sort_order, status, remark, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'active', '', ?, ?)
                """,
                [(farm_id, f"{i}号池", f"P{i:02d}", i, now, now) for i in range(1, 5)],
            )
        if conn.execute("SELECT COUNT(*) FROM user_farms").fetchone()[0] == 0:
            user = conn.execute("SELECT id FROM users WHERE username = 'operator1'").fetchone()
            farm = conn.execute("SELECT id FROM farms ORDER BY id LIMIT 1").fetchone()
            if user and farm:
                conn.execute("INSERT OR IGNORE INTO user_farms (user_id, farm_id) VALUES (?, ?)", (user["id"], farm["id"]))
        if conn.execute("SELECT COUNT(*) FROM sensors WHERE status != 'deleted'").fetchone()[0] == 0:
            ponds = conn.execute("SELECT id, farm_id FROM ponds WHERE status != 'deleted' ORDER BY id").fetchall()
            default_types = [key for key, item in SENSOR_TYPES.items() if item["default"]]
            rows = []
            for pond in ponds:
                for order, sensor_type in enumerate(default_types, 1):
                    definition = SENSOR_TYPES[sensor_type]
                    rows.append(
                        (
                            pond["farm_id"], pond["id"], definition["name"], sensor_type,
                            definition["unit"], str(order), str(100 + order), "float32", 1,
                            definition["min"], definition["max"], definition["min"], definition["max"],
                            order, "", "active", "online", 0, now, now,
                        )
                    )
            conn.executemany(
                """
                INSERT INTO sensors
                (farm_id, pond_id, name, type, unit, address, register, data_type, enabled,
                 min_limit, max_limit, low_alarm, high_alarm, sort_order, remark, status,
                 communication_status, communication_failures, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
        if conn.execute("SELECT COUNT(*) FROM sensor_readings").fetchone()[0] == 0:
            sensors = conn.execute("SELECT * FROM sensors WHERE status = 'active'").fetchall()
            rows = []
            base_now = datetime.now()
            for point in range(48):
                timestamp = (base_now - timedelta(minutes=(47 - point) * 30)).isoformat(timespec="seconds")
                for sensor in sensors:
                    value = mock_value(sensor, point)
                    rows.append(
                        (sensor["farm_id"], sensor["pond_id"], sensor["id"], sensor["type"], value, sensor["unit"], "normal", timestamp)
                    )
            conn.executemany(
                """
                INSERT INTO sensor_readings
                (farm_id, pond_id, sensor_id, sensor_type, value, unit, status, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
        if conn.execute("SELECT COUNT(*) FROM alarm_logs").fetchone()[0] == 0:
            sensors = conn.execute(
                "SELECT * FROM sensors WHERE status = 'active' AND type IN ('do', 'ph', 'orp') ORDER BY id LIMIT 6"
            ).fetchall()
            rows = []
            for index, sensor in enumerate(sensors):
                definition = SENSOR_TYPES[sensor["type"]]
                value = sensor["low_alarm"] - 0.2 if sensor["low_alarm"] is not None else definition["base"]
                rows.append(
                    (
                        sensor["farm_id"], sensor["pond_id"], sensor["id"], sensor["type"],
                        "low", "warning" if index % 2 == 0 else "abnormal", value,
                        sensor["low_alarm"], "pending",
                        (datetime.now() - timedelta(hours=index + 1)).isoformat(timespec="seconds"),
                    )
                )
            conn.executemany(
                """
                INSERT INTO alarm_logs
                (farm_id, pond_id, sensor_id, sensor_type, alarm_type, alarm_level,
                 value, threshold, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )


def mock_value(sensor: sqlite3.Row, tick: int | None = None) -> float:
    definition = SENSOR_TYPES.get(sensor["type"], {"base": 1.0})
    base = float(definition["base"])
    tick = tick if tick is not None else int(datetime.now().timestamp() // 5)
    phase = tick / 4 + sensor["id"] * 0.37
    span = max(abs(base) * 0.035, 0.03)
    value = base + math.sin(phase) * span + random.uniform(-span * 0.08, span * 0.08)
    if sensor["type"] in {"orp", "water_level"}:
        return round(value, 1)
    if sensor["type"] in {"ammonia", "nitrite"}:
        return round(max(0, value), 3)
    return round(value, 2)


def refresh_mock_readings(farm_id: int, pond_id: int | None = None) -> None:
    now = datetime.now()
    with get_conn() as conn:
        params: list[Any] = [farm_id]
        pond_clause = ""
        if pond_id:
            pond_clause = "AND s.pond_id = ?"
            params.append(pond_id)
        sensors = conn.execute(
            f"""
            SELECT s.* FROM sensors s
            JOIN ponds p ON p.id = s.pond_id
            WHERE s.farm_id = ? {pond_clause}
              AND s.enabled = 1 AND s.status = 'active' AND p.status = 'active'
            ORDER BY s.pond_id, s.sort_order, s.id
            """,
            params,
        ).fetchall()
        for sensor in sensors:
            latest = conn.execute(
                "SELECT timestamp FROM sensor_readings WHERE sensor_id = ? ORDER BY timestamp DESC LIMIT 1",
                (sensor["id"],),
            ).fetchone()
            if latest:
                try:
                    age = (now - datetime.fromisoformat(latest["timestamp"])).total_seconds()
                    if age < 4:
                        continue
                except ValueError:
                    pass
            timestamp = now.isoformat(timespec="seconds")
            conn.execute(
                """
                INSERT INTO sensor_readings
                (farm_id, pond_id, sensor_id, sensor_type, value, unit, status, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, 'normal', ?)
                """,
                (
                    sensor["farm_id"], sensor["pond_id"], sensor["id"], sensor["type"],
                    mock_value(sensor), sensor["unit"], timestamp,
                ),
            )
            conn.execute(
                "UPDATE sensors SET communication_status = 'online', updated_at = ? WHERE id = ?",
                (timestamp, sensor["id"]),
            )


def sensor_dict(conn: sqlite3.Connection, sensor: sqlite3.Row, include_reading: bool = True) -> dict[str, Any]:
    result = dict(sensor)
    result["enabled"] = bool(result["enabled"])
    if include_reading:
        reading = conn.execute(
            """
            SELECT value, unit, status, timestamp FROM sensor_readings
            WHERE sensor_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1
            """,
            (sensor["id"],),
        ).fetchone()
        result["latest"] = dict(reading) if reading else None
    return result


def realtime_payload(farm_id: int, pond_id: int | None = None) -> list[dict[str, Any]]:
    refresh_mock_readings(farm_id, pond_id)
    params: list[Any] = [farm_id]
    pond_clause = ""
    if pond_id:
        pond_clause = "AND p.id = ?"
        params.append(pond_id)
    with get_conn() as conn:
        ponds = conn.execute(
            f"""
            SELECT p.* FROM ponds p
            WHERE p.farm_id = ? {pond_clause} AND p.status = 'active'
            ORDER BY p.sort_order, p.id
            """,
            params,
        ).fetchall()
        payload = []
        for pond in ponds:
            sensors = conn.execute(
                """
                SELECT * FROM sensors
                WHERE pond_id = ? AND enabled = 1 AND status = 'active'
                ORDER BY sort_order, id
                """,
                (pond["id"],),
            ).fetchall()
            sensor_items = [sensor_dict(conn, sensor) for sensor in sensors]
            online = all(item["communication_status"] == "online" for item in sensor_items) if sensor_items else False
            payload.append({**dict(pond), "online": online, "sensors": sensor_items})
    return payload


@app.on_event("startup")
def startup() -> None:
    migrate_schema()
    seed_database()


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


@app.get("/api/sensor-types")
def sensor_types(_: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    return [{"type": key, **value} for key, value in SENSOR_TYPES.items()]


@app.get("/api/farms")
def get_farms(user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    ids = accessible_farm_ids(user)
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    with get_conn() as conn:
        rows = conn.execute(
            f"""
            SELECT f.*, COUNT(CASE WHEN p.status != 'deleted' THEN 1 END) AS pond_count
            FROM farms f LEFT JOIN ponds p ON p.farm_id = f.id
            WHERE f.id IN ({placeholders}) AND f.status != 'deleted'
            GROUP BY f.id ORDER BY f.id
            """,
            ids,
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/farms")
def create_farm(payload: FarmPayload, user: dict[str, Any] = Depends(require_admin)) -> dict[str, Any]:
    now = datetime.now().isoformat(timespec="seconds")
    with get_conn() as conn:
        cursor = conn.execute(
            "INSERT INTO farms (name, location, active, status, created_at) VALUES (?, ?, ?, ?, ?)",
            (payload.name, payload.location, int(payload.status == "active"), payload.status, now),
        )
        farm_id = cursor.lastrowid
        for index in range(1, payload.pond_count + 1):
            conn.execute(
                """
                INSERT INTO ponds (farm_id, name, code, sort_order, status, remark, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'active', '', ?, ?)
                """,
                (farm_id, f"{index}号池", f"P{index:02d}", index, now, now),
            )
    return {"success": True, "id": farm_id}


@app.put("/api/farms/{farm_id}")
def update_farm(farm_id: int, payload: FarmPayload, user: dict[str, Any] = Depends(require_admin)) -> dict[str, bool]:
    ensure_farm_access(user, farm_id)
    with get_conn() as conn:
        conn.execute(
            "UPDATE farms SET name = ?, location = ?, status = ?, active = ? WHERE id = ?",
            (payload.name, payload.location, payload.status, int(payload.status == "active"), farm_id),
        )
    return {"success": True}


@app.delete("/api/farms/{farm_id}")
def delete_farm(farm_id: int, user: dict[str, Any] = Depends(require_admin)) -> dict[str, bool]:
    ensure_farm_access(user, farm_id)
    with get_conn() as conn:
        conn.execute("UPDATE farms SET status = 'deleted', active = 0 WHERE id = ?", (farm_id,))
        conn.execute("UPDATE ponds SET status = 'deleted' WHERE farm_id = ?", (farm_id,))
        conn.execute("UPDATE sensors SET status = 'deleted', enabled = 0 WHERE farm_id = ?", (farm_id,))
    return {"success": True}


@app.get("/api/farms/{farm_id}/ponds")
def get_farm_ponds(farm_id: int, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    ensure_farm_access(user, farm_id)
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT p.*, COUNT(CASE WHEN s.status != 'deleted' THEN 1 END) AS sensor_count
            FROM ponds p LEFT JOIN sensors s ON s.pond_id = p.id
            WHERE p.farm_id = ? AND p.status != 'deleted'
            GROUP BY p.id ORDER BY p.sort_order, p.id
            """,
            (farm_id,),
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/farms/{farm_id}/ponds")
def create_pond(farm_id: int, payload: PondPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    ensure_farm_access(user, farm_id)
    require_editor(user)
    now = datetime.now().isoformat(timespec="seconds")
    with get_conn() as conn:
        cursor = conn.execute(
            """
            INSERT INTO ponds (farm_id, name, code, sort_order, status, remark, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (farm_id, payload.name, f"P{int(datetime.now().timestamp())}", payload.sort_order, payload.status, payload.remark, now, now),
        )
    return {"success": True, "id": cursor.lastrowid}


@app.put("/api/ponds/{pond_id}")
def update_pond(pond_id: int, payload: PondPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    require_editor(user)
    with get_conn() as conn:
        pond = get_pond_or_404(conn, pond_id)
        ensure_farm_access(user, pond["farm_id"])
        conn.execute(
            "UPDATE ponds SET name = ?, sort_order = ?, status = ?, remark = ?, updated_at = ? WHERE id = ?",
            (payload.name, payload.sort_order, payload.status, payload.remark, datetime.now().isoformat(timespec="seconds"), pond_id),
        )
    return {"success": True}


@app.delete("/api/ponds/{pond_id}")
def delete_pond(pond_id: int, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    require_editor(user)
    with get_conn() as conn:
        pond = get_pond_or_404(conn, pond_id)
        ensure_farm_access(user, pond["farm_id"])
        conn.execute("UPDATE ponds SET status = 'deleted', updated_at = ? WHERE id = ?", (datetime.now().isoformat(timespec="seconds"), pond_id))
        conn.execute("UPDATE sensors SET status = 'deleted', enabled = 0 WHERE pond_id = ?", (pond_id,))
    return {"success": True}


@app.get("/api/ponds/{pond_id}/sensors")
def get_pond_sensors(pond_id: int, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    with get_conn() as conn:
        pond = get_pond_or_404(conn, pond_id)
        ensure_farm_access(user, pond["farm_id"])
        rows = conn.execute(
            "SELECT * FROM sensors WHERE pond_id = ? AND status != 'deleted' ORDER BY sort_order, id",
            (pond_id,),
        ).fetchall()
        return [sensor_dict(conn, row) for row in rows]


@app.post("/api/ponds/{pond_id}/sensors")
def create_sensor(pond_id: int, payload: SensorPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    require_editor(user)
    if payload.type not in SENSOR_TYPES:
        raise HTTPException(status_code=400, detail="不支持的传感器类型")
    with get_conn() as conn:
        pond = get_pond_or_404(conn, pond_id)
        selected = ensure_farm_access(user, payload.farm_id)
        if pond["farm_id"] != selected:
            raise HTTPException(status_code=400, detail="水池和养殖场不匹配")
        now = datetime.now().isoformat(timespec="seconds")
        definition = SENSOR_TYPES[payload.type]
        cursor = conn.execute(
            """
            INSERT INTO sensors
            (farm_id, pond_id, name, type, unit, address, register, data_type, enabled,
             min_limit, max_limit, low_alarm, high_alarm, sort_order, remark, status,
             communication_status, communication_failures, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'online', 0, ?, ?)
            """,
            (
                selected, pond_id, payload.name, payload.type, payload.unit or definition["unit"],
                payload.address, payload.register, payload.data_type, int(payload.enabled),
                payload.min_limit, payload.max_limit, payload.low_alarm, payload.high_alarm,
                payload.sort_order, payload.remark, now, now,
            ),
        )
        sensor_id = cursor.lastrowid
        sensor = conn.execute("SELECT * FROM sensors WHERE id = ?", (sensor_id,)).fetchone()
        for point in range(30):
            timestamp = (datetime.now() - timedelta(minutes=(29 - point) * 5)).isoformat(timespec="seconds")
            conn.execute(
                """
                INSERT INTO sensor_readings
                (farm_id, pond_id, sensor_id, sensor_type, value, unit, status, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, 'normal', ?)
                """,
                (selected, pond_id, sensor_id, payload.type, mock_value(sensor, point), sensor["unit"], timestamp),
            )
    return {"success": True, "id": sensor_id}


@app.put("/api/sensors/{sensor_id}")
def update_sensor(sensor_id: int, payload: SensorPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    require_editor(user)
    if payload.type not in SENSOR_TYPES:
        raise HTTPException(status_code=400, detail="不支持的传感器类型")
    with get_conn() as conn:
        sensor = get_sensor_or_404(conn, sensor_id)
        selected = ensure_farm_access(user, payload.farm_id)
        if sensor["farm_id"] != selected:
            raise HTTPException(status_code=403, detail="无权修改该传感器")
        target_pond_id = payload.pond_id or sensor["pond_id"]
        target_pond = get_pond_or_404(conn, target_pond_id)
        if target_pond["farm_id"] != selected:
            raise HTTPException(status_code=400, detail="目标水池不属于当前养殖场")
        conn.execute(
            """
            UPDATE sensors SET pond_id = ?, name = ?, type = ?, unit = ?, address = ?, register = ?,
                data_type = ?, enabled = ?, min_limit = ?, max_limit = ?, low_alarm = ?,
                high_alarm = ?, sort_order = ?, remark = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                target_pond_id, payload.name, payload.type, payload.unit, payload.address, payload.register,
                payload.data_type, int(payload.enabled), payload.min_limit, payload.max_limit,
                payload.low_alarm, payload.high_alarm, payload.sort_order, payload.remark,
                datetime.now().isoformat(timespec="seconds"), sensor_id,
            ),
        )
    return {"success": True}


@app.delete("/api/sensors/{sensor_id}")
def delete_sensor(sensor_id: int, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    require_editor(user)
    with get_conn() as conn:
        sensor = get_sensor_or_404(conn, sensor_id)
        ensure_farm_access(user, sensor["farm_id"])
        conn.execute(
            "UPDATE sensors SET status = 'deleted', enabled = 0, updated_at = ? WHERE id = ?",
            (datetime.now().isoformat(timespec="seconds"), sensor_id),
        )
    return {"success": True}


@app.get("/api/farms/{farm_id}/realtime")
def farm_realtime(farm_id: int, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    ensure_farm_access(user, farm_id)
    return realtime_payload(farm_id)


@app.get("/api/ponds/{pond_id}/realtime")
def pond_realtime(pond_id: int, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    with get_conn() as conn:
        pond = get_pond_or_404(conn, pond_id)
        ensure_farm_access(user, pond["farm_id"])
    rows = realtime_payload(pond["farm_id"], pond_id)
    if not rows:
        raise HTTPException(status_code=404, detail="水池不可用")
    return rows[0]


@app.get("/api/sensors/{sensor_id}/history")
def sensor_history(
    sensor_id: int,
    start_time: str | None = None,
    end_time: str | None = None,
    range_key: str | None = Query(None, alias="range"),
    user: dict[str, Any] = Depends(current_user),
) -> list[dict[str, Any]]:
    with get_conn() as conn:
        sensor = get_sensor_or_404(conn, sensor_id)
        ensure_farm_access(user, sensor["farm_id"])
        if not start_time:
            hours = {"30m": 0.5, "1h": 1, "6h": 6, "12h": 12, "24h": 24, "7d": 168}.get(range_key or "24h", 24)
            start_time = (datetime.now() - timedelta(hours=hours)).isoformat(timespec="seconds")
        end_time = end_time or datetime.now().isoformat(timespec="seconds")
        rows = conn.execute(
            """
            SELECT id, farm_id, pond_id, sensor_id, sensor_type, value, unit, status, timestamp
            FROM sensor_readings
            WHERE sensor_id = ? AND timestamp BETWEEN ? AND ?
            ORDER BY timestamp
            """,
            (sensor_id, start_time, end_time),
        ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/farms/{farm_id}/alarms")
def farm_alarms(farm_id: int, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    ensure_farm_access(user, farm_id)
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT a.*, f.name AS farm_name, p.name AS pond_name, s.name AS sensor_name, s.unit
            FROM alarm_logs a
            JOIN farms f ON f.id = a.farm_id
            JOIN ponds p ON p.id = a.pond_id
            JOIN sensors s ON s.id = a.sensor_id
            WHERE a.farm_id = ? AND p.status != 'deleted' AND s.status != 'deleted'
            ORDER BY a.created_at DESC
            """,
            (farm_id,),
        ).fetchall()
    return [dict(row) for row in rows]


@app.put("/api/alarms/{alarm_id}/confirm")
def confirm_alarm(alarm_id: int, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    with get_conn() as conn:
        alarm = conn.execute("SELECT farm_id FROM alarm_logs WHERE id = ?", (alarm_id,)).fetchone()
        if not alarm:
            raise HTTPException(status_code=404, detail="报警不存在")
        ensure_farm_access(user, alarm["farm_id"])
        conn.execute(
            "UPDATE alarm_logs SET status = 'confirmed', confirmed_at = ?, confirmed_by = ? WHERE id = ?",
            (datetime.now().isoformat(timespec="seconds"), user["id"], alarm_id),
        )
    return {"success": True}


@app.get("/api/dashboard")
def dashboard(farm_id: int | None = None, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    selected = ensure_farm_access(user, farm_id)
    realtime = realtime_payload(selected)
    with get_conn() as conn:
        farm = dict(conn.execute("SELECT * FROM farms WHERE id = ?", (selected,)).fetchone())
        sensor_count = conn.execute(
            "SELECT COUNT(*) FROM sensors WHERE farm_id = ? AND status = 'active' AND enabled = 1", (selected,)
        ).fetchone()[0]
        online_count = conn.execute(
            """
            SELECT COUNT(*) FROM sensors
            WHERE farm_id = ? AND status = 'active' AND enabled = 1 AND communication_status = 'online'
            """,
            (selected,),
        ).fetchone()[0]
        alarm_count = conn.execute(
            "SELECT COUNT(*) FROM alarm_logs WHERE farm_id = ? AND status = 'pending'", (selected,)
        ).fetchone()[0]
    return {
        "farm": farm,
        "summary": {
            "pond_count": len(realtime),
            "sensor_count": sensor_count,
            "online_count": online_count,
            "pending_alarm_count": alarm_count,
        },
        "ponds": realtime,
    }


# Compatibility endpoints retained for the current frontend transition.
@app.get("/api/ponds")
def ponds_compat(farm_id: int | None = None, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    return get_farm_ponds(ensure_farm_access(user, farm_id), user)


@app.get("/api/latest")
def latest_compat(farm_id: int | None = None, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    return realtime_payload(ensure_farm_access(user, farm_id))


@app.get("/api/alarms")
def alarms_compat(farm_id: int | None = None, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    return farm_alarms(ensure_farm_access(user, farm_id), user)


@app.post("/api/alarms/{alarm_id}/handle")
def handle_alarm_compat(alarm_id: int, user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    return confirm_alarm(alarm_id, user)


@app.get("/api/sensors")
def sensors_compat(farm_id: int | None = None, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    selected = ensure_farm_access(user, farm_id)
    refresh_mock_readings(selected)
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT s.*, p.name AS pond_name FROM sensors s
            JOIN ponds p ON p.id = s.pond_id
            WHERE s.farm_id = ? AND s.status != 'deleted' AND p.status != 'deleted'
            ORDER BY p.sort_order, s.sort_order, s.id
            """,
            (selected,),
        ).fetchall()
        return [{**sensor_dict(conn, row), "pond_name": row["pond_name"]} for row in rows]


@app.get("/api/feeding/plans")
def feeding_plans(farm_id: int | None = None, user: dict[str, Any] = Depends(current_user)) -> list[dict[str, Any]]:
    selected = ensure_farm_access(user, farm_id)
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT fp.*, p.name AS pond_name FROM feed_plans fp
            JOIN ponds p ON p.id = fp.pond_id
            WHERE fp.farm_id = ? AND p.status != 'deleted'
            ORDER BY fp.feed_time, fp.id
            """,
            (selected,),
        ).fetchall()
    return [dict(row) for row in rows]


@app.post("/api/feeding/plans")
def save_feeding_plan(payload: FeedPlanPayload, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    selected = ensure_farm_access(user, payload.farm_id)
    require_editor(user)
    with get_conn() as conn:
        pond = get_pond_or_404(conn, payload.pond_id)
        if pond["farm_id"] != selected:
            raise HTTPException(status_code=400, detail="水池不属于当前养殖场")
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
        rows = conn.execute(
            "SELECT id, name FROM ponds WHERE farm_id = ? AND status != 'deleted' ORDER BY sort_order, id",
            (selected,),
        ).fetchall()
    return [{"id": row["id"], "name": f"{row['name']}摄像头", "location": row["name"], "status": "reserved"} for row in rows]


@app.post("/api/gateway/ingest")
def gateway_ingest(
    payload: GatewayPayload,
    x_gateway_token: str | None = Header(default=None),
) -> dict[str, Any]:
    if x_gateway_token != GATEWAY_TOKEN:
        raise HTTPException(status_code=401, detail="网关令牌无效")
    count = 0
    with get_conn() as conn:
        pond = get_pond_or_404(conn, payload.pond_id)
        if pond["farm_id"] != payload.farm_id:
            raise HTTPException(status_code=400, detail="水池和养殖场不匹配")
        for item in payload.readings:
            sensor = get_sensor_or_404(conn, item.sensor_id)
            if sensor["farm_id"] != payload.farm_id or sensor["pond_id"] != payload.pond_id:
                raise HTTPException(status_code=400, detail="传感器归属不匹配")
            timestamp = item.timestamp or datetime.now().isoformat(timespec="seconds")
            conn.execute(
                """
                INSERT INTO sensor_readings
                (farm_id, pond_id, sensor_id, sensor_type, value, unit, status, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (payload.farm_id, payload.pond_id, item.sensor_id, sensor["type"], item.value, sensor["unit"], item.status, timestamp),
            )
            conn.execute(
                "UPDATE sensors SET communication_status = 'online', updated_at = ? WHERE id = ?",
                (timestamp, item.sensor_id),
            )
            count += 1
    return {"success": True, "inserted": count}


@app.get("/api/admin/users")
def admin_users(_: dict[str, Any] = Depends(require_admin)) -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT u.id, u.username, u.display_name, u.role, u.active,
                   GROUP_CONCAT(f.name, '、') AS farms
            FROM users u
            LEFT JOIN user_farms uf ON uf.user_id = u.id
            LEFT JOIN farms f ON f.id = uf.farm_id AND f.status != 'deleted'
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


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "mode": "dynamic-mock-plc", "version": "0.3.0"}


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
