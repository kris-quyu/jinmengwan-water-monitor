const App = (() => {
  const chartInstances = [];

  function initChrome(active) {
    document.querySelectorAll(".nav a").forEach(link => {
      if (link.dataset.page === active) link.classList.add("active");
    });
    tickClock();
    setInterval(tickClock, 1000);
  }

  function setSystemStatus(status) {
    const statusText = document.querySelector("[data-system-status]");
    if (statusText) statusText.textContent = status || "运行正常";
  }

  function tickClock() {
    const target = document.querySelector("[data-current-time]");
    if (!target) return;
    const now = new Date();
    target.textContent = now.toLocaleString("zh-CN", { hour12: false });
  }

  function registerChart(chart) {
    chartInstances.push(chart);
    return chart;
  }

  function bindResize() {
    window.addEventListener("resize", () => {
      chartInstances.forEach(chart => chart.resize());
    });
  }

  function statusClass(level) {
    if (level === "danger" || level === "危险") return "danger";
    if (level === "abnormal" || level === "warning" || level === "异常" || level === "提醒") return "warning";
    return "normal";
  }

  function levelBadge(level) {
    const text = { warning: "提醒", abnormal: "异常", danger: "危险", normal: "正常" }[level] || level;
    return `<span class="tag ${statusClass(level)}">${text}</span>`;
  }

  function buildLineOption(title, seriesList, unit = "") {
    return {
      backgroundColor: "transparent",
      color: ["#29e4ff", "#31e58b", "#ffd45a", "#ff7f50"],
      tooltip: { trigger: "axis", backgroundColor: "rgba(3, 12, 28, 0.92)", borderColor: "#29e4ff", textStyle: { color: "#d8f4ff" } },
      legend: { top: 0, right: 8, textStyle: { color: "#9ec5e5" } },
      grid: { left: 44, right: 18, top: title ? 42 : 28, bottom: 34 },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: seriesList[0].data.map(item => item.time),
        axisLine: { lineStyle: { color: "#2b76bd" } },
        axisLabel: { color: "#80a8c8" },
        splitLine: { show: false }
      },
      yAxis: {
        type: "value",
        name: unit,
        nameTextStyle: { color: "#80a8c8" },
        axisLabel: { color: "#80a8c8" },
        splitLine: { lineStyle: { color: "rgba(43, 157, 255, 0.14)" } }
      },
      series: seriesList.map(item => ({
        name: item.name,
        type: "line",
        smooth: true,
        symbol: "none",
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.1 },
        data: item.data.map(point => point.value)
      }))
    };
  }

  function renderAlarmRows(target, alarms, withAction = false) {
    target.innerHTML = alarms.map(alarm => `
      <tr class="${alarm.level === "危险" ? "danger-row" : ""}">
        <td>${alarm.time}</td>
        <td>${alarm.pondName || alarm.pool}</td>
        <td>${alarm.sensorName || alarm.metric}</td>
        <td>${alarm.value}</td>
        <td>${levelBadge(alarm.levelText || alarm.level)}</td>
        <td>${alarm.content}</td>
        <td>${alarm.statusText || alarm.status}</td>
        ${withAction ? `<td><button data-handle-alarm="${alarm.id}" ${(alarm.statusText || alarm.status) === "已处理" ? "disabled" : ""}>标记已处理</button></td>` : ""}
      </tr>
    `).join("");
  }

  return {
    initChrome,
    setSystemStatus,
    registerChart,
    bindResize,
    levelBadge,
    buildLineOption,
    renderAlarmRows
  };
})();

App.bindResize();
