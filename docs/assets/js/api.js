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
    const metric = normalizeMetric(device);
    if (!metric) return null;
    return {
      ...device,
      key: metric.key,
      sensorName: metric.name,
      unit: metric.unit,
      name: isBadText(device.name) ? `${metric.name} 传感器` : device.name
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
    const key = normalizeSensorKey(alarm.key || alarm.metric || alarm.sensorKey || alarm.sensorName);
    if (!key || !SENSOR_DEFINITIONS[key]) return null;
    const definition = SENSOR_DEFINITIONS[key];
    const level = { warning: "提醒", abnormal: "异常", danger: "危险", normal: "正常" }[alarm.level] || alarm.levelText || alarm.level || "提醒";
    const status = { handled: "已处理", pending: "未处理" }[alarm.status] || alarm.statusText || alarm.status || "未处理";
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

  function getMockAlarmState() {
    const handledIds = readJson(ALARM_HANDLED_KEY, []);
    return MockData.generateAlarms().map(alarm => ({
      ...alarm,
      status: handledIds.includes(alarm.id) ? "已处理" : alarm.status
    }));
  }

  async function getLatestData() {
    const config = MockData.getSystemConfig();
    return normalizeLatestData({
      config,
      system: MockData.getSystemSummary(),
      ponds: MockData.generatePonds(config.pondCount),
      metrics: MockData.getRealtimeSensors(),
      alarms: getMockAlarmState(),
      devices: MockData.getSensorDevices()
    });
  }

  async function getHistoryData(metric, range) {
    return MockData.generateHistoryData(normalizeSensorKey(metric) || "do", range);
  }

  async function getAlarmList() {
    return getMockAlarmState().map(normalizeAlarm).filter(Boolean);
  }

  async function getSensorList() {
    const data = {
      sensors: MockData.getSensorDevices(),
      metrics: MockData.getRealtimeSensors(),
      allSensors: MockData.sensors,
      operations: MockData.operations,
      exceptions: MockData.exceptions
    };
    return {
      ...data,
      metrics: data.metrics.map(normalizeMetric).filter(Boolean),
      sensors: data.sensors.map(normalizeDevice).filter(Boolean),
      allSensors: Object.values(SENSOR_DEFINITIONS).map(definition => ({
        ...definition,
        value: data.allSensors.find(item => item.key === definition.key)?.value,
        status: "normal",
        enabled: true
      }))
    };
  }

  async function getSettings() {
    const saved = readJson(SETTINGS_KEY, {});
    return {
      ...defaultSettings,
      ...saved,
      ...MockData.getSystemConfig(),
      enabledSensors: normalizeEnabledSensors(saved.enabledSensors || MockData.getSystemConfig().enabledSensors)
    };
  }

  async function saveSettings(settings) {
    const cleanSettings = {
      ...defaultSettings,
      ...settings,
      enabledSensors: normalizeEnabledSensors(settings.enabledSensors)
    };
    const { pondCount, enabledSensors, ...thresholdSettings } = cleanSettings;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...defaultSettings, ...thresholdSettings }));
    MockData.saveSystemConfig({ pondCount, enabledSensors });
    return { success: true, settings: cleanSettings };
  }

  async function handleAlarm(alarmId) {
    const handledIds = readJson(ALARM_HANDLED_KEY, []);
    if (!handledIds.includes(alarmId)) handledIds.push(alarmId);
    localStorage.setItem(ALARM_HANDLED_KEY, JSON.stringify(handledIds));
    return { success: true };
  }

  async function getFeedingPlans() {
    return [
      { id: 1, pond: "1号池", time: "08:30", feedName: "南美白对虾配合饲料", amountKg: 12.5, enabled: true },
      { id: 2, pond: "2号池", time: "12:30", feedName: "南美白对虾配合饲料", amountKg: 10, enabled: true }
    ];
  }

  async function saveFeedingPlan(plan) {
    return { success: true, id: Date.now(), ...plan };
  }

  async function getCameras() {
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
