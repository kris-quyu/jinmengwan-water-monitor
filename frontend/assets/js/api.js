const DATA_MODE = "mock";

const Api = (() => {
  const SETTINGS_KEY = "ras_settings";
  const ALARM_HANDLED_KEY = "jmw_alarm_handled";

  const SENSOR_DEFINITIONS = {
    do: { key: "do", name: "DO", unit: "mg/L" },
    ph: { key: "ph", name: "pH", unit: "" },
    salinity: { key: "salinity", name: "盐度", unit: "ppt" },
    temperature: { key: "temperature", name: "温度", unit: "℃" },
    waterLevel: { key: "waterLevel", name: "水位", unit: "cm" },
    orp: { key: "orp", name: "ORP", unit: "mV" },
    roomTemperature: { key: "roomTemperature", name: "室温", unit: "℃" }
  };

  const LEVEL_TEXT = {
    warning: "提醒",
    abnormal: "异常",
    danger: "危险",
    normal: "正常",
    "提醒": "提醒",
    "异常": "异常",
    "危险": "危险",
    "正常": "正常"
  };

  const STATUS_TEXT = {
    handled: "已处理",
    pending: "未处理",
    "已处理": "已处理",
    "未处理": "未处理"
  };

  const SENSOR_NAME_TO_KEY = {
    DO: "do",
    pH: "ph",
    "盐度": "salinity",
    "温度": "temperature",
    "水温": "temperature",
    "水位": "waterLevel",
    ORP: "orp",
    "室温": "roomTemperature"
  };

  const defaultSettings = {
    doWarn: 5.0,
    doDanger: 4.0,
    phMin: 7.6,
    phMax: 8.6,
    salinityMin: 8,
    salinityMax: 18,
    tempMin: 26,
    tempMax: 32,
    levelMin: 60,
    levelMax: 95
  };

  const ranges = {
    "30m": { label: "30分钟" },
    "1h": { label: "1小时" },
    "6h": { label: "6小时" },
    "12h": { label: "12小时" },
    "24h": { label: "24小时" }
  };

  async function requestJson(url, options = {}) {
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options
    });
    if (!response.ok) throw new Error(`API request failed: ${response.status}`);
    return response.json();
  }

  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") || fallback;
    } catch (error) {
      return fallback;
    }
  }

  function isBadText(value) {
    const text = String(value || "");
    return !text || [...text].every(char => char === String.fromCharCode(63)) || text.includes("�");
  }

  function normalizeSensorKey(key) {
    if (key === "temp") return "temperature";
    if (key === "level") return "waterLevel";
    if (key === "nh3" || key === "ammonia") return null;
    return key;
  }

  function metricToSensorKey(metric) {
    if (!metric) return null;
    const normalized = normalizeSensorKey(metric);
    if (normalized && SENSOR_DEFINITIONS[normalized]) return normalized;
    return SENSOR_NAME_TO_KEY[metric] || null;
  }

  function normalizeEnabledSensors(enabledSensors) {
    const normalized = Array.isArray(enabledSensors)
      ? enabledSensors.map(normalizeSensorKey).filter(key => key && SENSOR_DEFINITIONS[key])
      : Object.keys(SENSOR_DEFINITIONS);
    return normalized.length ? Array.from(new Set(normalized)) : Object.keys(SENSOR_DEFINITIONS);
  }

  function normalizeMetric(metric) {
    const key = normalizeSensorKey(metric && metric.key);
    if (!key || !SENSOR_DEFINITIONS[key]) return null;
    const definition = SENSOR_DEFINITIONS[key];
    return {
      ...metric,
      key,
      name: isBadText(metric.name) ? definition.name : metric.name,
      unit: isBadText(metric.unit) ? definition.unit : metric.unit
    };
  }

  function normalizeDevice(device) {
    const key = normalizeSensorKey(device && device.key);
    if (!key || !SENSOR_DEFINITIONS[key]) return null;
    const definition = SENSOR_DEFINITIONS[key];
    const sensorName = isBadText(device.sensorName) ? definition.name : device.sensorName;
    return {
      ...device,
      key,
      sensorName,
      unit: isBadText(device.unit) ? definition.unit : device.unit,
      name: isBadText(device.name) ? `${definition.name} 传感器` : device.name
    };
  }

  function normalizePondName(alarm) {
    const direct = alarm.pondName || alarm.pool;
    if (!isBadText(direct) && /号池$/.test(String(direct))) return direct;
    const pondId = alarm.pondId || alarm.poolId || String(direct || "").match(/\d+/)?.[0];
    return pondId ? `${pondId}号池` : "1号池";
  }

  function normalizeAlarm(alarm) {
    if (!alarm) return null;
    const key = metricToSensorKey(alarm.key || alarm.metric || alarm.sensorKey || alarm.sensorName);
    if (!key || !SENSOR_DEFINITIONS[key]) return null;
    const definition = SENSOR_DEFINITIONS[key];
    const level = LEVEL_TEXT[alarm.levelText] || LEVEL_TEXT[alarm.level] || "提醒";
    const status = STATUS_TEXT[alarm.statusText] || STATUS_TEXT[alarm.status] || "未处理";
    return {
      ...alarm,
      key,
      pondName: normalizePondName(alarm),
      pool: normalizePondName(alarm),
      sensorName: definition.name,
      metric: definition.name,
      level,
      levelText: level,
      status,
      statusText: status
    };
  }

  function normalizeLatestData(data) {
    const metrics = (data.metrics || []).map(normalizeMetric).filter(Boolean);
    const devices = (data.devices || []).map(normalizeDevice).filter(Boolean);
    const alarms = (data.alarms || []).map(normalizeAlarm).filter(Boolean);
    const sensorCount = metrics.length;
    return {
      ...data,
      config: {
        ...(data.config || {}),
        enabledSensors: normalizeEnabledSensors(data.config && data.config.enabledSensors)
      },
      system: {
        ...(data.system || {}),
        sensorCount,
        onlineSensorCount: sensorCount,
        onlineDevices: `${sensorCount}/${sensorCount}`
      },
      metrics,
      devices,
      alarms
    };
  }

  function normalizeSensorList(data) {
    const metrics = (data.metrics || []).map(normalizeMetric).filter(Boolean);
    const sensors = (data.sensors || []).map(normalizeDevice).filter(Boolean);
    const allSensors = Object.values(SENSOR_DEFINITIONS).map(definition => ({
      ...definition,
      value: data.allSensors?.find(item => item.key === definition.key)?.value,
      status: "normal",
      enabled: true
    }));
    return { ...data, metrics, sensors, allSensors };
  }

  function normalizeSettings(settings) {
    const { nh3Warn, nh3Danger, ...rest } = settings || {};
    return {
      ...defaultSettings,
      ...rest,
      pondCount: Number(rest.pondCount || 4),
      enabledSensors: normalizeEnabledSensors(rest.enabledSensors)
    };
  }

  function getMockAlarmState() {
    const handledIds = readJson(ALARM_HANDLED_KEY, []);
    return MockData.generateAlarms().map(alarm => ({
      ...alarm,
      status: handledIds.includes(alarm.id) ? "已处理" : alarm.status
    }));
  }

  async function getLatestData() {
    if (DATA_MODE === "api") {
      return normalizeLatestData(await requestJson("/api/latest"));
    }

    const config = MockData.getSystemConfig();
    const metrics = MockData.getRealtimeSensors();
    return normalizeLatestData({
      config,
      system: MockData.getSystemSummary(),
      ponds: MockData.generatePonds(config.pondCount),
      metrics,
      alarms: getMockAlarmState(),
      devices: MockData.getSensorDevices()
    });
  }

  async function getHistoryData(metric, range) {
    const key = normalizeSensorKey(metric) || "do";
    if (DATA_MODE === "api") {
      return requestJson(`/api/history?metric=${encodeURIComponent(key)}&range=${encodeURIComponent(range)}`);
    }
    return MockData.generateHistoryData(key, range);
  }

  async function getAlarmList() {
    const alarms = DATA_MODE === "api" ? await requestJson("/api/alarms") : getMockAlarmState();
    return alarms.map(normalizeAlarm).filter(Boolean);
  }

  async function getSensorList() {
    if (DATA_MODE === "api") {
      return normalizeSensorList(await requestJson("/api/sensors"));
    }

    return normalizeSensorList({
      sensors: MockData.getSensorDevices(),
      metrics: MockData.getRealtimeSensors(),
      allSensors: MockData.sensors,
      operations: MockData.operations,
      exceptions: MockData.exceptions
    });
  }

  async function getSettings() {
    if (DATA_MODE === "api") {
      return normalizeSettings(await requestJson("/api/settings"));
    }

    const saved = readJson(SETTINGS_KEY, {});
    return normalizeSettings({
      ...saved,
      ...MockData.getSystemConfig()
    });
  }

  async function saveSettings(settings) {
    const cleanSettings = normalizeSettings(settings);
    if (DATA_MODE === "api") {
      return requestJson("/api/settings", {
        method: "POST",
        body: JSON.stringify(cleanSettings)
      });
    }

    const { pondCount, enabledSensors, ...thresholdSettings } = cleanSettings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...defaultSettings, ...thresholdSettings }));
    MockData.saveSystemConfig({ pondCount, enabledSensors });
    return { success: true, settings: cleanSettings };
  }

  async function handleAlarm(alarmId) {
    if (DATA_MODE === "api") {
      return requestJson(`/api/alarms/${encodeURIComponent(alarmId)}/handled`, {
        method: "POST"
      });
    }

    const handledIds = readJson(ALARM_HANDLED_KEY, []);
    if (!handledIds.includes(alarmId)) handledIds.push(alarmId);
    localStorage.setItem(ALARM_HANDLED_KEY, JSON.stringify(handledIds));
    return { success: true };
  }

  async function getFeedingPlans() {
    if (DATA_MODE === "api") return requestJson("/api/feeding/plans");
    return [
      { id: 1, pond: "1号池", time: "08:30", feedName: "南美白对虾配合饲料", amountKg: 12.5, enabled: true },
      { id: 2, pond: "2号池", time: "12:30", feedName: "南美白对虾配合饲料", amountKg: 10, enabled: true }
    ];
  }

  async function saveFeedingPlan(plan) {
    if (DATA_MODE === "api") {
      return requestJson("/api/feeding/plans", {
        method: "POST",
        body: JSON.stringify(plan)
      });
    }
    return { success: true, id: Date.now(), ...plan };
  }

  async function getCameras() {
    if (DATA_MODE === "api") return requestJson("/api/cameras");
    return [
      { id: 1, name: "1号池枪机", location: "1号池", streamUrl: "rtsp://example.local/pond1", status: "在线" },
      { id: 2, name: "车间全景", location: "养殖车间", streamUrl: "rtsp://example.local/workshop", status: "在线" }
    ];
  }

  return {
    DATA_MODE,
    SENSOR_DEFINITIONS,
    ranges,
    defaultSettings,
    getLatestData,
    getHistoryData,
    getAlarmList,
    getSensorList,
    getSettings,
    saveSettings,
    handleAlarm,
    getFeedingPlans,
    saveFeedingPlan,
    getCameras
  };
})();
