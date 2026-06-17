App.initChrome("analysis");

const metricSelect = document.getElementById("metricSelect");
const rangeSelect = document.getElementById("rangeSelect");
const analysisChart = App.registerChart(echarts.init(document.getElementById("analysisChart")));
let metricOptions = [];

async function initControls() {
  const latest = await Api.getLatestData();
  App.setSystemStatus(latest.system.status);
  metricOptions = latest.metrics;
  metricSelect.innerHTML = metricOptions.map(metric => `<option value="${metric.key}">${metric.name}</option>`).join("");
  rangeSelect.innerHTML = Object.entries(Api.ranges).map(([key, range]) => `<option value="${key}">${range.label}</option>`).join("");
  metricSelect.addEventListener("change", renderAnalysis);
  rangeSelect.addEventListener("change", renderAnalysis);
}

function getStatus(metric, value) {
  if (value < metric.min || value > metric.max) return "提醒";
  return "正常";
}

function syncMetricOptions(metrics) {
  const selected = metricSelect.value;
  const nextOptions = metrics.map(metric => metric.key).join(",");
  const currentOptions = Array.from(metricSelect.options).map(option => option.value).join(",");
  if (nextOptions !== currentOptions) {
    metricSelect.innerHTML = metrics.map(metric => `<option value="${metric.key}">${metric.name}</option>`).join("");
    if (metrics.some(metric => metric.key === selected)) metricSelect.value = selected;
  }
}

async function renderAnalysis() {
  const latest = await Api.getLatestData();
  App.setSystemStatus(latest.system.status);
  metricOptions = latest.metrics;
  syncMetricOptions(metricOptions);

  if (!metricOptions.length) {
    analysisChart.clear();
    document.getElementById("analysisTable").innerHTML = "";
    return;
  }

  const metric = metricOptions.find(item => item.key === metricSelect.value) || metricOptions[0];
  metricSelect.value = metric.key;
  const history = await Api.getHistoryData(metric.key, rangeSelect.value);
  analysisChart.setOption(App.buildLineOption("", [{ name: metric.name, data: history }], metric.unit));
  document.getElementById("analysisTable").innerHTML = history.map(item => {
    const status = getStatus(metric, item.value);
    return `
      <tr>
        <td>${item.time}</td>
        <td>${metric.name}</td>
        <td>${item.value}</td>
        <td>${metric.unit}</td>
        <td>${status === "正常" ? '<span class="tag normal">正常</span>' : '<span class="tag warning">提醒</span>'}</td>
      </tr>
    `;
  }).join("");
}

async function initAnalysisPage() {
  await initControls();
  await renderAnalysis();
}

initAnalysisPage();
setInterval(renderAnalysis, 5000);
