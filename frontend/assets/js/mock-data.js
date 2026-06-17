window.MockData = (() => {
  const CONFIG_KEY = "jmw_system_config";

  const SENSOR_DEFINITIONS = {
    do: { key: "do", name: "DO", unit: "mg/L", value: 6.8, status: "normal", min: 5.0, max: 9.0 },
    ph: { key: "ph", name: "pH", unit: "", value: 8.1, status: "normal", min: 7.6, max: 8.6 },
    salinity: { key: "salinity", name: "盐度", unit: "ppt", value: 12, status: "normal", min: 8, max: 18 },
    temperature: { key: "temperature", name: "温度", unit: "℃", value: 28.3, status: "normal", min: 26, max: 32 },
    waterLevel: { key: "waterLevel", name: "水位", unit: "cm", value: 79, status: "normal", min: 60, max: 95 },
    orp: { key: "orp", name: "ORP", unit: "mV", value: 220, status: "normal", min: 180, max: 280 },
    roomTemperature: { key: "roomTemperature", name: "室温", unit: "℃", value: 27.2, status: "normal", min: 18, max: 36 }
  };

  const defaultSystemConfig = {
    pondCount: 4,
    enabledSensors: ["do", "ph", "salinity", "temperature", "waterLevel", "orp", "roomTemperature"]
  };

  const sensors = Object.values(SENSOR_DEFINITIONS);

  const sensorKeyAliases = {
    temp: "temperature",
    level: "waterLevel",
    nh3: null,
    ammonia: null
  };

  const operations = [
    "08:00 系统自动巡检完成",
    "08:05 传感器在线状态同步完成",
    "08:20 水质数据刷新成功",
    "08:40 系统配置读取完成"
  ];

  const exceptions = [
    "昨日 19:35 4号池水位异常",
    "今日 07:42 2号池 pH 异常"
  ];

  const ranges = {
    "30m": { label: "30分钟", step: 1 },
    "1h": { label: "1小时", step: 2 },
    "6h": { label: "6小时", step: 12 },
    "12h": { label: "12小时", step: 24 },
    "24h": { label: "24小时", step: 48 }
  };

  function normalizeSensorKey(key) {
    if (Object.prototype.hasOwnProperty.call(sensorKeyAliases, key)) return sensorKeyAliases[key];
    return key;
  }

  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") || fallback;
    } catch (error) {
      return fallback;
    }
  }

  function sanitizeEnabledSensors(enabledSensors) {
    const normalized = Array.isArray(enabledSensors)
      ? enabledSensors.map(normalizeSensorKey).filter(key => key && SENSOR_DEFINITIONS[key])
      : defaultSystemConfig.enabledSensors;
    if (Array.isArray(enabledSensors) && enabledSensors.includes("ammonia") && !normalized.includes("roomTemperature")) {
      normalized.push("roomTemperature");
    }
    return normalized.length ? Array.from(new Set(normalized)) : defaultSystemConfig.enabledSensors;
  }

  function getSystemConfig() {
    const saved = readJson(CONFIG_KEY, {});
    const pondCount = Number(saved.pondCount || defaultSystemConfig.pondCount);
    return {
      pondCount: Number.isFinite(pondCount) ? Math.min(50, Math.max(1, pondCount)) : defaultSystemConfig.pondCount,
      enabledSensors: sanitizeEnabledSensors(saved.enabledSensors)
    };
  }

  function saveSystemConfig(config) {
    const pondCount = Number(config.pondCount || defaultSystemConfig.pondCount);
    const nextConfig = {
      pondCount: Number.isFinite(pondCount) ? Math.min(50, Math.max(1, pondCount)) : defaultSystemConfig.pondCount,
      enabledSensors: sanitizeEnabledSensors(config.enabledSensors)
    };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(nextConfig));
    return nextConfig;
  }

  function getEnabledSensors() {
    const config = getSystemConfig();
    return config.enabledSensors.map(key => SENSOR_DEFINITIONS[key]).filter(Boolean);
  }

  function getSensorCount() {
    return getEnabledSensors().length;
  }

  function getPondCount() {
    return getSystemConfig().pondCount;
  }

  function generatePonds(pondCount = getPondCount()) {
    return Array.from({ length: pondCount }, (_, index) => ({
      id: index + 1,
      name: `${index + 1}号池`,
      status: "运行中"
    }));
  }

  function jitter(base, index, span) {
    const wave = Math.sin(index / 3) * span;
    const pulse = Math.cos(index / 5) * span * 0.45;
    return base + wave + pulse;
  }

  function formatValue(sensor, value) {
    if (sensor.key === "waterLevel" || sensor.key === "orp") return Math.round(value);
    if (sensor.key === "ph") return Number(value.toFixed(2));
    return Number(value.toFixed(1));
  }

  function generateHistoryData(sensorKey, rangeKey = "30m") {
    const key = normalizeSensorKey(sensorKey);
    const sensor = SENSOR_DEFINITIONS[key] || sensors[0];
    const range = ranges[rangeKey] || ranges["30m"];
    const now = new Date();
    return Array.from({ length: 30 }, (_, index) => {
      const time = new Date(now.getTime() - (29 - index) * range.step * 60 * 1000);
      const span = sensor.key === "ph" ? 0.08 : Math.max(1, sensor.value * 0.035);
      const value = formatValue(sensor, jitter(sensor.value, index, span));
      return { time: time.toTimeString().slice(0, 5), value };
    });
  }

  function getRealtimeSensors() {
    return getEnabledSensors().map((sensor, index) => {
      const span = sensor.key === "ph" ? 0.03 : Math.max(1, sensor.value * 0.018);
      return {
        ...sensor,
        value: formatValue(sensor, jitter(sensor.value, Date.now() / 5000 + index, span))
      };
    });
  }

  function getSensorDevices() {
    return getEnabledSensors().map((sensor, index) => ({
      key: sensor.key,
      name: `${sensor.name} 传感器`,
      sensorName: sensor.name,
      unit: sensor.unit,
      status: "在线",
      location: `${(index % getPondCount()) + 1}号池`
    }));
  }

  function generateAlarms() {
    const enabled = getEnabledSensors();
    const candidates = [
      { key: "do", value: "4.8 mg/L", level: "提醒", content: "溶解氧接近提醒阈值" },
      { key: "ph", value: "8.7", level: "异常", content: "pH 高于上限" },
      { key: "waterLevel", value: "58 cm", level: "异常", content: "水位低于下限" },
      { key: "temperature", value: "32.8 ℃", level: "提醒", content: "水温偏高" },
      { key: "orp", value: "165 mV", level: "提醒", content: "ORP 低于建议范围" },
      { key: "salinity", value: "19.2 ppt", level: "异常", content: "盐度高于上限" },
      { key: "roomTemperature", value: "35.4 ℃", level: "提醒", content: "室温偏高" }
    ];
    const times = ["2026-06-16 08:10:22", "2026-06-16 07:42:16", "2026-06-15 19:35:08", "2026-06-15 16:06:51", "2026-06-15 11:28:23", "2026-06-15 09:12:37", "2026-06-15 08:20:12"];
    const pondCount = getPondCount();

    return candidates
      .filter(item => enabled.some(sensor => sensor.key === item.key))
      .map((item, index) => {
        const sensor = SENSOR_DEFINITIONS[item.key];
        return {
          id: `${item.key}-${index}`,
          time: times[index],
          pool: `${(index % pondCount) + 1}号池`,
          metric: sensor.name,
          value: item.value,
          level: item.level,
          content: item.content,
          status: index < 2 ? "未处理" : "已处理"
        };
      });
  }

  function getSystemSummary() {
    const pondCount = getPondCount();
    const sensorCount = getSensorCount();
    return {
      pondCount,
      sensorCount,
      onlineSensorCount: sensorCount,
      onlineDevices: `${sensorCount}/${sensorCount}`,
      todayAlarms: 0,
      status: "运行正常"
    };
  }

  return {
    SENSOR_DEFINITIONS,
    defaultSystemConfig,
    sensors,
    operations,
    exceptions,
    ranges,
    getSystemConfig,
    saveSystemConfig,
    getEnabledSensors,
    getSensorCount,
    getPondCount,
    generatePonds,
    generateHistoryData,
    getRealtimeSensors,
    getSensorDevices,
    generateAlarms,
    getSystemSummary
  };
})();
