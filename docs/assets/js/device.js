App.initChrome("device");

const chartMap = new Map();
let sensorMeta = { sensors: [], metrics: [], operations: [], exceptions: [] };

function renderDeviceLists(sensors) {
  document.getElementById("sensorList").innerHTML = sensors.map(device => `
    <div class="sensor-item">
      <div>
        <strong>${device.name}</strong>
        <div class="stat-label">${device.location}</div>
      </div>
      <span class="tag ${device.status === "在线" ? "normal" : "offline"}">${device.status}</span>
    </div>
  `).join("");
}

function ensureCharts(metrics) {
  chartMap.forEach(chart => chart.dispose());
  chartMap.clear();
  const wrap = document.getElementById("sensorCharts");
  wrap.innerHTML = metrics.map(metric => `
    <div class="mini-chart-card">
      <div class="mini-chart-title">${metric.name}</div>
      <div class="mini-chart" id="chart-${metric.key}"></div>
    </div>
  `).join("");

  metrics.forEach(metric => {
    chartMap.set(metric.key, App.registerChart(echarts.init(document.getElementById(`chart-${metric.key}`))));
  });
}

async function renderSensorValues() {
  const latest = await Api.getLatestData();
  App.setSystemStatus(latest.system.status);
  document.getElementById("sensorValues").innerHTML = latest.metrics.map(metric => `
    <div class="value-card">
      <div class="metric-name">${metric.name}</div>
      <div class="metric-value">${metric.value}<span class="metric-unit">${metric.unit}</span></div>
      <div class="stat-label">状态：正常</div>
    </div>
  `).join("");
}

async function renderCharts() {
  await Promise.all(sensorMeta.metrics.map(async metric => {
    const chart = chartMap.get(metric.key);
    if (!chart) return;
    const history = await Api.getHistoryData(metric.key, "30m");
    chart.setOption(App.buildLineOption("", [{ name: metric.name, data: history }], metric.unit));
  }));
}

function renderRecords(operations, exceptions) {
  document.getElementById("operationRecords").innerHTML = `<h3 class="panel-title">操作记录</h3>` + operations.map(item => `
    <div class="record-item">${item}</div>
  `).join("");
  document.getElementById("exceptionRecords").innerHTML = `<h3 class="panel-title">异常记录</h3>` + exceptions.map(item => `
    <div class="record-item danger">${item}</div>
  `).join("");
}

async function refreshDevice() {
  const latestMeta = await Api.getSensorList();
  const metricKeys = latestMeta.metrics.map(metric => metric.key).join(",");
  const currentKeys = sensorMeta.metrics.map(metric => metric.key).join(",");
  sensorMeta = latestMeta;
  renderDeviceLists(sensorMeta.sensors);
  if (metricKeys !== currentKeys) ensureCharts(sensorMeta.metrics);
  await renderSensorValues();
  await renderCharts();
}

async function initDevicePage() {
  sensorMeta = await Api.getSensorList();
  renderDeviceLists(sensorMeta.sensors);
  ensureCharts(sensorMeta.metrics);
  renderRecords(sensorMeta.operations, sensorMeta.exceptions);
  await refreshDevice();
}

initDevicePage();
setInterval(refreshDevice, 5000);
