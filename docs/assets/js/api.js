const DATA_MODE = window.JMW_DATA_MODE || (
  ["127.0.0.1", "localhost"].includes(location.hostname) && location.port === "8000" ? "api" : "mock"
);
const API_BASE = "";

const Api = (() => {
  const TOKEN_KEY = "jmw_access_token";
  const FARM_KEY = "jmw_selected_farm";
  const MOCK_KEY = "jmw_v03_pages_mock";

  const SENSOR_TYPES = [
    { type: "do", name: "DO", unit: "mg/L", min: 0, max: 12, default_enabled: true },
    { type: "water_temp", name: "水温", unit: "℃", min: 20, max: 35, default_enabled: true },
    { type: "ph", name: "pH", unit: "", min: 6.5, max: 9.5, default_enabled: true },
    { type: "orp", name: "ORP", unit: "mV", min: 100, max: 500, default_enabled: true },
    { type: "water_level", name: "水位", unit: "cm", min: 40, max: 120, default_enabled: true },
    { type: "salinity", name: "盐度", unit: "‰", min: 0, max: 35, default_enabled: false },
    { type: "ammonia", name: "氨氮", unit: "mg/L", min: 0, max: 2, default_enabled: false },
    { type: "nitrite", name: "亚硝酸盐", unit: "mg/L", min: 0, max: 1, default_enabled: false }
  ];

  function token() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }

  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(FARM_KEY);
  }

  async function request(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (token()) headers.Authorization = `Bearer ${token()}`;
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
    if (response.status === 401 && !path.includes("/auth/login")) {
      clearSession();
      window.location.href = "login.html";
      throw new Error("登录已失效");
    }
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }
    if (!response.ok) throw new Error(data?.detail || `请求失败 (${response.status})`);
    return data;
  }

  function query(path, params = {}) {
    const values = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "");
    const search = new URLSearchParams(values).toString();
    return `${path}${search ? `?${search}` : ""}`;
  }

  function sensorPreset(type) {
    return SENSOR_TYPES.find(item => item.type === type) || { type, name: type, unit: "", min: 0, max: 100 };
  }

  function nowIso(offsetMinutes = 0) {
    return new Date(Date.now() - offsetMinutes * 60000).toISOString();
  }

  function mockValue(type, seed = 0) {
    const wave = Math.sin((Date.now() / 60000 + seed) / 3);
    const base = {
      do: 6.8, water_temp: 28.5, ph: 8.1, orp: 220, water_level: 80,
      salinity: 12, ammonia: 0.18, nitrite: 0.04
    }[type] ?? 10;
    const span = {
      do: 0.5, water_temp: 0.8, ph: 0.12, orp: 18, water_level: 4,
      salinity: 0.8, ammonia: 0.04, nitrite: 0.01
    }[type] ?? 1;
    const decimals = ["ph", "do", "water_temp", "salinity", "ammonia", "nitrite"].includes(type) ? 2 : 0;
    return Number((base + wave * span + (seed % 3) * span * 0.12).toFixed(decimals));
  }

  function defaultMockState() {
    const farms = [
      { id: 1, name: "金梦湾一号养殖场", location: "广东湛江", status: "active" },
      { id: 2, name: "金梦湾二号试验场", location: "广东阳江", status: "active" }
    ];
    const ponds = [];
    const sensors = [];
    let pondId = 1;
    let sensorId = 1;
    farms.forEach((farm, farmIndex) => {
      const count = farmIndex === 0 ? 4 : 3;
      for (let i = 1; i <= count; i += 1) {
        const pond = { id: pondId++, farm_id: farm.id, name: `${i}号池`, sort_order: i, status: "active", remark: "" };
        ponds.push(pond);
        SENSOR_TYPES.filter(item => item.default_enabled).forEach((type, index) => {
          sensors.push({
            id: sensorId++, farm_id: farm.id, pond_id: pond.id, name: type.name, type: type.type, unit: type.unit,
            address: String(i), register: String(40001 + index * 2), data_type: "float32", enabled: true,
            min_limit: type.min, max_limit: type.max, low_alarm: type.min, high_alarm: type.max,
            sort_order: index + 1, remark: "", status: "active", communication_status: "online",
            communication_failures: 0, updated_at: nowIso(i)
          });
        });
      }
    });
    return {
      farms, ponds, sensors,
      alarms: [
        { id: 1, farm_id: 1, pond_id: 1, sensor_id: 1, sensor_type: "do", alarm_type: "low", alarm_level: "warning", value: 5.7, threshold: 6, status: "pending", created_at: nowIso(22), confirmed_at: null },
        { id: 2, farm_id: 1, pond_id: 2, sensor_id: 8, sensor_type: "ph", alarm_type: "high", alarm_level: "abnormal", value: 8.8, threshold: 8.6, status: "pending", created_at: nowIso(51), confirmed_at: null },
        { id: 3, farm_id: 1, pond_id: 3, sensor_id: 14, sensor_type: "orp", alarm_type: "low", alarm_level: "warning", value: 165, threshold: 180, status: "confirmed", created_at: nowIso(83), confirmed_at: nowIso(60) }
      ],
      feedingPlans: [
        { id: 1, farm_id: 1, pond_id: 1, feed_time: "08:30", feed_name: "对虾配合饲料", amount_kg: 10, enabled: true }
      ],
      nextIds: { farm: 3, pond: pondId, sensor: sensorId, alarm: 4, feeding: 2 }
    };
  }

  function loadMock() {
    try {
      const parsed = JSON.parse(localStorage.getItem(MOCK_KEY));
      if (parsed?.farms?.length && parsed?.ponds && parsed?.sensors) return parsed;
    } catch (_) {
      // Ignore damaged demo data and rebuild the static preview store.
    }
    const fresh = defaultMockState();
    saveMock(fresh);
    return fresh;
  }

  function saveMock(data) {
    localStorage.setItem(MOCK_KEY, JSON.stringify(data));
  }

  function activePonds(data, farmId) {
    return data.ponds
      .filter(pond => pond.farm_id === Number(farmId) && pond.status !== "deleted")
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
  }

  function activeSensors(data, pondId) {
    return data.sensors
      .filter(sensor => sensor.pond_id === Number(pondId) && sensor.status !== "deleted")
      .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id)
      .map(sensor => decorateSensor(sensor));
  }

  function decorateSensor(sensor) {
    const preset = sensorPreset(sensor.type);
    const latest = sensor.enabled ? {
      value: mockValue(sensor.type, sensor.id),
      unit: sensor.unit || preset.unit,
      status: "normal",
      timestamp: nowIso(sensor.id % 6)
    } : null;
    return {
      ...sensor,
      name: sensor.name || preset.name,
      unit: sensor.unit ?? preset.unit,
      latest
    };
  }

  function decoratePond(data, pond) {
    const sensors = activeSensors(data, pond.id).filter(sensor => sensor.enabled);
    return {
      ...pond,
      online: sensors.some(sensor => sensor.communication_status === "online"),
      sensor_count: sensors.length,
      sensors
    };
  }

  function decorateAlarm(data, alarm) {
    const farm = data.farms.find(item => item.id === alarm.farm_id);
    const pond = data.ponds.find(item => item.id === alarm.pond_id);
    const sensor = data.sensors.find(item => item.id === alarm.sensor_id);
    const preset = sensorPreset(alarm.sensor_type || sensor?.type);
    return {
      ...alarm,
      farm_name: farm?.name || "--",
      pond_name: pond?.name || `${alarm.pond_id}号池`,
      sensor_name: sensor?.name || preset.name,
      unit: sensor?.unit ?? preset.unit
    };
  }

  function historyRows(sensorId, range = "24h") {
    const data = loadMock();
    const sensor = data.sensors.find(item => item.id === Number(sensorId));
    const points = range === "7d" ? 42 : 30;
    const step = range === "1h" ? 2 : range === "6h" ? 12 : range === "12h" ? 24 : range === "7d" ? 240 : 48;
    return Array.from({ length: points }, (_, index) => {
      const reverse = points - index;
      return {
        sensor_id: Number(sensorId),
        sensor_type: sensor?.type,
        value: mockValue(sensor?.type, sensorId + index),
        unit: sensor?.unit || sensorPreset(sensor?.type).unit,
        status: "normal",
        timestamp: nowIso(reverse * step)
      };
    });
  }

  const mockApi = {
    login: async () => {
      localStorage.setItem(TOKEN_KEY, "github-pages-demo-token");
      return { access_token: "github-pages-demo-token", token_type: "bearer" };
    },
    logout: clearSession,
    hasToken: () => DATA_MODE === "mock" || Boolean(token()),
    getMe: async () => ({ id: 1, username: "demo", display_name: "演示管理员", role: "admin" }),
    getSensorTypes: async () => SENSOR_TYPES,
    getFarms: async () => loadMock().farms.filter(farm => farm.status !== "deleted"),
    createFarm: async payload => {
      const data = loadMock();
      const farm = { id: data.nextIds.farm++, name: payload.name, location: payload.location || "", status: payload.status || "active" };
      data.farms.push(farm);
      saveMock(data);
      return farm;
    },
    updateFarm: async (id, payload) => {
      const data = loadMock();
      const farm = data.farms.find(item => item.id === Number(id));
      Object.assign(farm, payload);
      saveMock(data);
      return farm;
    },
    deleteFarm: async id => {
      const data = loadMock();
      data.farms = data.farms.map(farm => farm.id === Number(id) ? { ...farm, status: "deleted" } : farm);
      saveMock(data);
      return { ok: true };
    },
    getPonds: async farmId => {
      const data = loadMock();
      return activePonds(data, farmId).map(pond => ({ ...pond, sensor_count: activeSensors(data, pond.id).filter(sensor => sensor.enabled).length }));
    },
    createPond: async (farmId, payload) => {
      const data = loadMock();
      const pond = { id: data.nextIds.pond++, farm_id: Number(farmId), name: payload.name, sort_order: payload.sort_order || data.ponds.length + 1, status: payload.status || "active", remark: payload.remark || "" };
      data.ponds.push(pond);
      SENSOR_TYPES.filter(item => item.default_enabled).forEach((type, index) => {
        data.sensors.push({
          id: data.nextIds.sensor++, farm_id: Number(farmId), pond_id: pond.id, name: type.name, type: type.type, unit: type.unit,
          address: String(pond.id), register: String(40001 + index * 2), data_type: "float32", enabled: true,
          min_limit: type.min, max_limit: type.max, low_alarm: type.min, high_alarm: type.max,
          sort_order: index + 1, remark: "", status: "active", communication_status: "online", communication_failures: 0, updated_at: nowIso()
        });
      });
      saveMock(data);
      return pond;
    },
    updatePond: async (pondId, payload) => {
      const data = loadMock();
      const pond = data.ponds.find(item => item.id === Number(pondId));
      Object.assign(pond, payload);
      saveMock(data);
      return pond;
    },
    deletePond: async pondId => {
      const data = loadMock();
      data.ponds = data.ponds.map(pond => pond.id === Number(pondId) ? { ...pond, status: "deleted" } : pond);
      data.sensors = data.sensors.map(sensor => sensor.pond_id === Number(pondId) ? { ...sensor, enabled: false, status: "deleted" } : sensor);
      saveMock(data);
      return { ok: true };
    },
    getPondSensors: async pondId => activeSensors(loadMock(), pondId),
    createSensor: async (pondId, payload) => {
      const data = loadMock();
      const preset = sensorPreset(payload.type);
      const pond = data.ponds.find(item => item.id === Number(pondId));
      const sensor = {
        id: data.nextIds.sensor++, farm_id: payload.farm_id || pond?.farm_id, pond_id: Number(pondId),
        name: payload.name || preset.name, type: payload.type, unit: payload.unit ?? preset.unit,
        address: payload.address || "1", register: payload.register || "0", data_type: payload.data_type || "float32",
        enabled: payload.enabled !== false, min_limit: payload.min_limit, max_limit: payload.max_limit,
        low_alarm: payload.low_alarm, high_alarm: payload.high_alarm, sort_order: payload.sort_order || 0,
        remark: payload.remark || "", status: "active", communication_status: "online", communication_failures: 0, updated_at: nowIso()
      };
      data.sensors.push(sensor);
      saveMock(data);
      return decorateSensor(sensor);
    },
    updateSensor: async (sensorId, payload) => {
      const data = loadMock();
      const sensor = data.sensors.find(item => item.id === Number(sensorId));
      Object.assign(sensor, payload, { pond_id: Number(payload.pond_id || sensor.pond_id), updated_at: nowIso() });
      saveMock(data);
      return decorateSensor(sensor);
    },
    deleteSensor: async sensorId => {
      const data = loadMock();
      data.sensors = data.sensors.map(sensor => sensor.id === Number(sensorId) ? { ...sensor, enabled: false, status: "deleted" } : sensor);
      saveMock(data);
      return { ok: true };
    },
    getDashboard: async farmId => {
      const data = loadMock();
      const farm = data.farms.find(item => item.id === Number(farmId)) || data.farms[0];
      const ponds = activePonds(data, farm.id).map(pond => decoratePond(data, pond));
      const sensors = ponds.flatMap(pond => pond.sensors);
      return {
        farm,
        summary: {
          pond_count: ponds.length,
          sensor_count: sensors.length,
          online_count: sensors.filter(sensor => sensor.communication_status === "online").length,
          pending_alarm_count: data.alarms.filter(alarm => alarm.farm_id === farm.id && alarm.status === "pending").length
        },
        ponds
      };
    },
    getFarmRealtime: async farmId => activePonds(loadMock(), farmId).map(pond => decoratePond(loadMock(), pond)),
    getPondRealtime: async pondId => decoratePond(loadMock(), loadMock().ponds.find(pond => pond.id === Number(pondId))),
    getSensorHistory: async (sensorId, range) => historyRows(sensorId, range),
    getFarmAlarms: async farmId => {
      const data = loadMock();
      return data.alarms.filter(alarm => alarm.farm_id === Number(farmId)).map(alarm => decorateAlarm(data, alarm));
    },
    confirmAlarm: async alarmId => {
      const data = loadMock();
      const alarm = data.alarms.find(item => item.id === Number(alarmId));
      if (alarm) Object.assign(alarm, { status: "confirmed", confirmed_at: nowIso() });
      saveMock(data);
      return decorateAlarm(data, alarm);
    },
    getSensorList: async farmId => {
      const data = loadMock();
      return activePonds(data, farmId).flatMap(pond => activeSensors(data, pond.id).map(sensor => ({ ...sensor, pond_name: pond.name })));
    },
    getFeedingPlans: async farmId => {
      const data = loadMock();
      return data.feedingPlans.filter(plan => plan.farm_id === Number(farmId)).map(plan => ({ ...plan, pond_name: data.ponds.find(pond => pond.id === plan.pond_id)?.name || "--" }));
    },
    saveFeedingPlan: async payload => {
      const data = loadMock();
      const plan = { id: data.nextIds.feeding++, ...payload };
      data.feedingPlans.push(plan);
      saveMock(data);
      return plan;
    },
    getCameras: async farmId => activePonds(loadMock(), farmId).map(pond => ({ id: pond.id, farm_id: Number(farmId), pond_id: pond.id, name: `${pond.name} 摄像头`, location: pond.name, status: "reserved" })),
    getAdminUsers: async () => ([{ id: 1, username: "demo", display_name: "演示管理员", role: "admin", farms: "全部养殖场", active: true }]),
    createUser: async payload => ({ id: Date.now(), ...payload, active: true }),
    selectedFarmId: () => {
      const value = Number(localStorage.getItem(FARM_KEY));
      return Number.isFinite(value) && value > 0 ? value : null;
    },
    setSelectedFarmId: farmId => localStorage.setItem(FARM_KEY, String(farmId))
  };

  const apiMode = {
    login: async (username, password) => {
      const result = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      localStorage.setItem(TOKEN_KEY, result.access_token);
      return result;
    },
    logout: clearSession,
    hasToken: () => Boolean(token()),
    getMe: () => request("/api/auth/me"),
    getSensorTypes: () => request("/api/sensor-types"),
    getFarms: () => request("/api/farms"),
    createFarm: payload => request("/api/farms", { method: "POST", body: JSON.stringify(payload) }),
    updateFarm: (id, payload) => request(`/api/farms/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
    deleteFarm: id => request(`/api/farms/${id}`, { method: "DELETE" }),
    getPonds: farmId => request(`/api/farms/${farmId}/ponds`),
    createPond: (farmId, payload) => request(`/api/farms/${farmId}/ponds`, { method: "POST", body: JSON.stringify(payload) }),
    updatePond: (pondId, payload) => request(`/api/ponds/${pondId}`, { method: "PUT", body: JSON.stringify(payload) }),
    deletePond: pondId => request(`/api/ponds/${pondId}`, { method: "DELETE" }),
    getPondSensors: pondId => request(`/api/ponds/${pondId}/sensors`),
    createSensor: (pondId, payload) => request(`/api/ponds/${pondId}/sensors`, { method: "POST", body: JSON.stringify(payload) }),
    updateSensor: (sensorId, payload) => request(`/api/sensors/${sensorId}`, { method: "PUT", body: JSON.stringify(payload) }),
    deleteSensor: sensorId => request(`/api/sensors/${sensorId}`, { method: "DELETE" }),
    getDashboard: farmId => request(query("/api/dashboard", { farm_id: farmId })),
    getFarmRealtime: farmId => request(`/api/farms/${farmId}/realtime`),
    getPondRealtime: pondId => request(`/api/ponds/${pondId}/realtime`),
    getSensorHistory: (sensorId, range, startTime, endTime) =>
      request(query(`/api/sensors/${sensorId}/history`, { range, start_time: startTime, end_time: endTime })),
    getFarmAlarms: farmId => request(`/api/farms/${farmId}/alarms`),
    confirmAlarm: alarmId => request(`/api/alarms/${alarmId}/confirm`, { method: "PUT" }),
    getSensorList: farmId => request(query("/api/sensors", { farm_id: farmId })),
    getFeedingPlans: farmId => request(query("/api/feeding/plans", { farm_id: farmId })),
    saveFeedingPlan: payload => request("/api/feeding/plans", { method: "POST", body: JSON.stringify(payload) }),
    getCameras: farmId => request(query("/api/cameras", { farm_id: farmId })),
    getAdminUsers: () => request("/api/admin/users"),
    createUser: payload => request("/api/admin/users", { method: "POST", body: JSON.stringify(payload) }),
    selectedFarmId: mockApi.selectedFarmId,
    setSelectedFarmId: mockApi.setSelectedFarmId
  };

  return DATA_MODE === "mock" ? mockApi : apiMode;
})();
