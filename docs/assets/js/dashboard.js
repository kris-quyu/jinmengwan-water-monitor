App.initChrome("dashboard");

function getEl(id) {
  const element = document.getElementById(id);
  if (!element) console.error(`[dashboard] Missing DOM node: #${id}`);
  return element;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function fallbackLatestData() {
  const metrics = [
    { key: "do", name: "DO", unit: "mg/L", value: 6.8, min: 5.0, max: 9.0 },
    { key: "ph", name: "pH", unit: "", value: 8.1, min: 7.6, max: 8.6 },
    { key: "salinity", name: "盐度", unit: "ppt", value: 12, min: 8, max: 18 },
    { key: "temperature", name: "温度", unit: "℃", value: 28.3, min: 26, max: 32 },
    { key: "waterLevel", name: "水位", unit: "cm", value: 79, min: 60, max: 95 },
    { key: "orp", name: "ORP", unit: "mV", value: 220, min: 180, max: 280 },
    { key: "roomTemperature", name: "室温", unit: "℃", value: 27.2, min: 18, max: 36 }
  ];
  const ponds = Array.from({ length: 4 }, (_, index) => ({
    id: index + 1,
    name: `${index + 1}号池`,
    status: "运行中"
  }));
  return {
    system: {
      pondCount: 4,
      sensorCount: 7,
      onlineSensorCount: 7,
      onlineDevices: "7/7",
      todayAlarms: 0,
      status: "运行正常"
    },
    ponds,
    metrics,
    alarms: [
      { time: "2026-06-16 08:10:22", pool: "1号池", metric: "DO", level: "提醒" },
      { time: "2026-06-16 07:42:16", pool: "2号池", metric: "pH", level: "异常" },
      { time: "2026-06-15 19:35:08", pool: "4号池", metric: "水位", level: "异常" },
      { time: "2026-06-15 16:06:51", pool: "1号池", metric: "温度", level: "提醒" },
      { time: "2026-06-15 11:28:23", pool: "2号池", metric: "ORP", level: "提醒" },
      { time: "2026-06-15 08:20:12", pool: "1号池", metric: "室温", level: "提醒" }
    ],
    devices: metrics.map(metric => ({ key: metric.key, name: `${metric.name} 传感器`, status: "在线" }))
  };
}

function createDashboardChart() {
  const chartNode = getEl("dashboardTrend");
  if (!chartNode || !window.echarts) {
    console.error("[dashboard] ECharts is not loaded or #dashboardTrend is missing.");
    return null;
  }
  return App.registerChart(echarts.init(chartNode));
}

const dashboardChart = createDashboardChart();

async function loadLatestData() {
  try {
    const latest = await Api.getLatestData();
    return normalizeLatestData(latest);
  } catch (error) {
    console.error("[dashboard] Api.getLatestData failed. Falling back to mock data.", error);
    return normalizeLatestData(fallbackLatestData());
  }
}

function normalizeLatestData(latest) {
  const fallback = fallbackLatestData();
  const system = { ...fallback.system, ...(latest && latest.system ? latest.system : {}) };
  const metrics = safeArray(latest && latest.metrics).length ? latest.metrics : fallback.metrics;
  const ponds = safeArray(latest && latest.ponds).length ? latest.ponds : fallback.ponds;
  const alarms = safeArray(latest && latest.alarms).length ? latest.alarms : fallback.alarms;
  const devices = safeArray(latest && latest.devices).length ? latest.devices : fallback.devices;
  const sensorCount = Number(system.sensorCount || metrics.length || fallback.system.sensorCount);
  const onlineSensorCount = Number(system.onlineSensorCount || sensorCount);
  return {
    system: {
      ...system,
      pondCount: Number(system.pondCount || ponds.length || fallback.system.pondCount),
      sensorCount,
      onlineSensorCount,
      onlineDevices: system.onlineDevices || `${onlineSensorCount}/${sensorCount}`,
      todayAlarms: Number(system.todayAlarms || 0),
      status: system.status || "运行正常"
    },
    ponds,
    metrics,
    alarms,
    devices
  };
}

function renderStats(system) {
  const target = getEl("systemStats");
  if (!target) return;
  const items = [
    ["养殖池数量", system.pondCount],
    ["传感器数量", system.sensorCount],
    ["设备在线数量", `${system.onlineSensorCount}/${system.sensorCount}`],
    ["今日报警数量", system.todayAlarms]
  ];
  target.innerHTML = items.map(item => `
    <div class="stat-card">
      <div class="stat-label">${item[0]}</div>
      <div class="stat-value">${item[1]}</div>
    </div>
  `).join("");
}

function renderPonds(ponds) {
  const target = getEl("poolMap");
  if (!target) return;
  target.innerHTML = safeArray(ponds).map(pond => `
    <div class="pool">
      <strong>${pond.name || `${pond.id}号池`}</strong>
      <span>${pond.status || "运行中"}</span>
    </div>
  `).join("");
}

function renderMetrics(metrics) {
  const metricCards = getEl("metricCards");
  const waterStatus = getEl("waterStatus");
  const rows = safeArray(metrics);

  if (metricCards) {
    metricCards.innerHTML = rows.map(metric => `
      <div class="metric-card">
        <div class="metric-name">${metric.name || metric.key}</div>
        <div class="metric-value">${metric.value === undefined || metric.value === null ? "--" : metric.value}<span class="metric-unit">${metric.unit || ""}</span></div>
      </div>
    `).join("");
  }

  if (waterStatus) {
    waterStatus.innerHTML = rows.map(metric => `
      <div class="state-line">
        <span>${metric.name || metric.key}</span>
        <strong>${metric.value === undefined || metric.value === null ? "--" : metric.value} ${metric.unit || ""}</strong>
        <span class="tag normal">正常</span>
      </div>
    `).join("");
  }
}

function renderSidebars(alarms, devices) {
  const latestAlarms = getEl("latestAlarms");
  const deviceStatus = getEl("deviceStatus");

  if (latestAlarms) {
    latestAlarms.innerHTML = safeArray(alarms).slice(0, 5).map(alarm => `
      <div class="alarm-line">
        <span>${(alarm.time || "").slice(11)} ${alarm.pondName || alarm.pool || ""} ${alarm.sensorName || alarm.metric || ""}</span>
        ${App.levelBadge(alarm.levelText || alarm.level || "提醒")}
      </div>
    `).join("");
  }

  if (deviceStatus) {
    deviceStatus.innerHTML = safeArray(devices).map(device => `
      <div class="device-line">
        <span>${device.name || device.sensorName || device.key}</span>
        <span class="tag ${device.status === "离线" ? "offline" : "normal"}">${device.status || "在线"}</span>
      </div>
    `).join("");
  }
}

async function renderChart(metrics) {
  if (!dashboardChart) return;
  const rows = safeArray(metrics);
  const preferredKeys = ["do", "ph", "temperature"];
  const selected = preferredKeys
    .map(key => rows.find(metric => metric.key === key))
    .filter(Boolean)
    .concat(rows.filter(metric => !preferredKeys.includes(metric.key)))
    .slice(0, 3);

  if (!selected.length) {
    dashboardChart.clear();
    return;
  }

  try {
    const series = await Promise.all(selected.map(async metric => ({
      name: metric.name || metric.key,
      data: await Api.getHistoryData(metric.key, "30m")
    })));
    dashboardChart.setOption(App.buildLineOption("", series));
  } catch (error) {
    console.error("[dashboard] Failed to render trend chart.", error);
  }
}

async function refreshDashboard() {
  try {
    const latest = await loadLatestData();
    App.setSystemStatus(latest.system.status);
    renderStats(latest.system);
    renderPonds(latest.ponds);
    renderMetrics(latest.metrics);
    renderSidebars(latest.alarms, latest.devices);
    await renderChart(latest.metrics);
  } catch (error) {
    console.error("[dashboard] Refresh failed.", error);
  }
}

refreshDashboard();
setInterval(refreshDashboard, 5000);
