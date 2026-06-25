const SENSOR_DEFINITIONS = {
  do: { name: "DO", unit: "mg/L", field: "do_value" },
  water_temp: { name: "水温", unit: "℃", field: "water_temp" },
  ph: { name: "pH", unit: "", field: "ph_value" },
  orp: { name: "ORP", unit: "mV", field: "orp_value" },
  water_level: { name: "水位", unit: "cm", field: "water_level" },
  salinity: { name: "盐度", unit: "ppt", field: "salinity" },
  room_temp: { name: "室温", unit: "℃", field: "room_temp" }
};

const NAV_ITEMS = [
  ["index", "首页总览", "index.html"],
  ["monitoring", "水质实时监测", "monitoring.html"],
  ["analysis", "历史曲线", "analysis.html"],
  ["alarm", "报警记录", "alarm.html"],
  ["settings", "参数设置", "settings.html"],
  ["device", "设备状态", "device.html"],
  ["feeding", "投喂预留", "feeding.html"],
  ["camera", "视频监控预留", "camera.html"],
  ["management", "用户/养殖场管理", "management.html"]
];

const LEVEL_TEXT = { warning: "提醒", abnormal: "异常", danger: "危险", normal: "正常" };
const STATUS_TEXT = { pending: "未处理", handled: "已处理", online: "在线", offline: "离线", running: "运行中", reserved: "待接入" };
const state = { me: null, farms: [], farmId: null, charts: [] };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}

function formatTime(value) {
  if (!value) return "--";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function statusBadge(value, text) {
  return `<span class="badge ${escapeHtml(value)}">${escapeHtml(text || STATUS_TEXT[value] || LEVEL_TEXT[value] || value)}</span>`;
}

function showToast(message) {
  const old = document.querySelector(".toast");
  if (old) old.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 2600);
}

function showError(error) {
  console.error(error);
  showToast(error.message || "操作失败");
}

function selectedFarm() {
  return state.farms.find(farm => farm.id === state.farmId);
}

async function initLogin() {
  if (Api.hasToken()) {
    try {
      await Api.getMe();
      window.location.href = "index.html";
      return;
    } catch (_) {
      Api.logout();
    }
  }
  document.getElementById("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    const errorNode = document.getElementById("loginError");
    button.disabled = true;
    errorNode.textContent = "";
    try {
      await Api.login(document.getElementById("username").value.trim(), document.getElementById("password").value);
      window.location.href = "index.html";
    } catch (error) {
      errorNode.textContent = error.message;
      button.disabled = false;
    }
  });
}

function renderShell(page) {
  document.body.innerHTML = `
    <div class="app-layout">
      <aside class="sidebar" id="sidebar">
        <div class="side-brand">金梦湾渔业<br>水质在线监测平台<small>WEB 管理后台 V0.2</small></div>
        <nav class="nav-list">
          ${NAV_ITEMS.map(([key, label, href]) => `<a class="nav-link ${page === key ? "active" : ""}" href="${href}">${label}</a>`).join("")}
        </nav>
        <div class="sidebar-foot">数据模式：模拟 PLC<br><span class="status normal">服务运行中</span></div>
      </aside>
      <section class="main-shell">
        <header class="topbar">
          <button class="icon-btn mobile-menu" id="menuButton" title="菜单">☰</button>
          <div class="page-title">${escapeHtml(NAV_ITEMS.find(item => item[0] === page)?.[1] || "")}</div>
          <div class="topbar-spacer"></div>
          <select class="farm-select" id="farmSelect" aria-label="选择养殖场"></select>
          <div class="user-block"><strong id="displayName"></strong><span id="roleName"></span></div>
          <button class="icon-btn" id="logoutButton" title="退出登录">退出</button>
        </header>
        <main class="page-content" id="pageRoot"><div class="empty">正在加载...</div></main>
      </section>
    </div>`;
  document.getElementById("menuButton").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));
  document.getElementById("logoutButton").addEventListener("click", () => {
    Api.logout();
    window.location.href = "login.html";
  });
}

async function initAuthenticatedPage(page) {
  if (!Api.hasToken()) {
    window.location.href = "login.html";
    return;
  }
  renderShell(page);
  try {
    [state.me, state.farms] = await Promise.all([Api.getMe(), Api.getFarms()]);
    document.getElementById("displayName").textContent = state.me.display_name;
    document.getElementById("roleName").textContent = state.me.role === "admin" ? "系统管理员" : "养殖场用户";
    const savedFarm = Api.selectedFarmId();
    state.farmId = state.farms.some(farm => farm.id === savedFarm) ? savedFarm : state.farms[0]?.id;
    const select = document.getElementById("farmSelect");
    select.innerHTML = state.farms.map(farm => `<option value="${farm.id}">${escapeHtml(farm.name)}</option>`).join("");
    if (state.farmId) {
      select.value = String(state.farmId);
      Api.setSelectedFarmId(state.farmId);
    }
    select.addEventListener("change", async event => {
      state.farmId = Number(event.target.value);
      Api.setSelectedFarmId(state.farmId);
      disposeCharts();
      await renderPage(page);
    });
    await renderPage(page);
  } catch (error) {
    showError(error);
    document.getElementById("pageRoot").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
  }
}

function disposeCharts() {
  state.charts.forEach(chart => chart.dispose());
  state.charts = [];
}

function chart(node, option) {
  if (!window.echarts || !node) return;
  const instance = echarts.init(node);
  instance.setOption(option);
  state.charts.push(instance);
}

function lineOption(series, unit = "") {
  return {
    color: ["#29d7ff", "#35d58b", "#ffc857", "#ff7b8a"],
    tooltip: { trigger: "axis", backgroundColor: "#07192d", borderColor: "#29d7ff", textStyle: { color: "#e4f5ff" } },
    legend: { top: 0, textStyle: { color: "#86a7bf" } },
    grid: { left: 48, right: 18, top: 42, bottom: 34 },
    xAxis: { type: "category", boundaryGap: false, data: series[0]?.data.map(item => item.time) || [], axisLabel: { color: "#86a7bf" }, axisLine: { lineStyle: { color: "#174d79" } } },
    yAxis: { type: "value", name: unit, nameTextStyle: { color: "#86a7bf" }, axisLabel: { color: "#86a7bf" }, splitLine: { lineStyle: { color: "rgba(23,77,121,.35)" } } },
    series: series.map(item => ({ name: item.name, type: "line", smooth: true, symbol: "none", data: item.data.map(point => point.value), areaStyle: { opacity: .08 } }))
  };
}

async function renderDashboard() {
  const [data, alarms] = await Promise.all([Api.getDashboard(state.farmId), Api.getAlarmList(state.farmId)]);
  const root = document.getElementById("pageRoot");
  const latest = data.latest || [];
  const first = latest[0] || {};
  root.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">养殖池数量</div><div class="stat-value">${data.summary.pond_count}<small>个</small></div></div>
      <div class="stat-card"><div class="stat-label">采集设备</div><div class="stat-value">${data.summary.device_count}<small>台</small></div></div>
      <div class="stat-card"><div class="stat-label">设备在线</div><div class="stat-value">${data.summary.online_count}/${data.summary.device_count}</div></div>
      <div class="stat-card"><div class="stat-label">待处理报警</div><div class="stat-value">${data.summary.pending_alarm_count}<small>条</small></div></div>
    </div>
    <div class="content-grid">
      <div class="stack">
        <section class="panel"><h2 class="panel-title">${escapeHtml(data.farm.name)} · 池塘运行状态</h2>
          <div class="pond-grid">${latest.map(row => `
            <article class="pond-card">
              <div class="pond-card-head"><strong>${escapeHtml(row.pond_name)}</strong><span class="status ${row.communication_status}">${STATUS_TEXT[row.communication_status]}</span></div>
              <div class="metric-value">${row.do_value}<small> mg/L</small></div>
              <div class="card-meta">DO · 水温 ${row.water_temp}℃ · pH ${row.ph_value}</div>
            </article>`).join("")}</div>
        </section>
        <section class="panel"><h2 class="panel-title">重点指标趋势</h2><div class="chart" id="dashboardChart"></div></section>
      </div>
      <div class="stack">
        <section class="panel"><h2 class="panel-title">实时水质</h2>
          <div class="metric-grid">${Object.entries(SENSOR_DEFINITIONS).map(([key, def]) => `
            <article class="metric-card"><div class="metric-name">${def.name}</div><div class="metric-value">${first[def.field] ?? "--"}<small> ${def.unit}</small></div><span class="status normal">正常</span></article>`).join("")}</div>
        </section>
        <section class="panel"><h2 class="panel-title">最新报警</h2><div class="alarm-list">
          ${alarms.slice(0, 5).map(alarm => `<div class="alarm-item"><div class="line-row"><strong>${escapeHtml(alarm.pond_name)} · ${escapeHtml(alarm.sensor_name)}</strong>${statusBadge(alarm.level, LEVEL_TEXT[alarm.level])}</div><p>${formatTime(alarm.created_at)}　${escapeHtml(alarm.message)}</p></div>`).join("") || '<div class="empty">暂无报警</div>'}
        </div></section>
      </div>
    </div>`;
  const history = await Promise.all(["do", "water_temp", "ph"].map(async metric => ({
    name: SENSOR_DEFINITIONS[metric].name,
    data: (await Api.getHistoryData(metric, "24h", state.farmId)).map(row => ({ time: row.timestamp.slice(11, 16), value: row.value }))
  })));
  chart(document.getElementById("dashboardChart"), lineOption(history));
}

async function renderMonitoring() {
  const rows = await Api.getLatestData(state.farmId);
  document.getElementById("pageRoot").innerHTML = `
    <div class="notice">当前数据由后端模拟 PLC 上报。真实网关接入后，本页无需修改。</div>
    <div class="stack" style="margin-top:16px">${rows.map(row => `
      <section class="panel">
        <div class="pond-card-head"><h2 class="panel-title" style="margin:0">${escapeHtml(row.pond_name)}</h2><span class="status ${row.communication_status}">${STATUS_TEXT[row.communication_status]}</span></div>
        <div class="metric-grid" style="margin-top:14px">${Object.values(SENSOR_DEFINITIONS).map(def => `
          <article class="metric-card"><div class="metric-name">${def.name}</div><div class="metric-value">${row[def.field] ?? "--"}<small> ${def.unit}</small></div></article>`).join("")}</div>
        <p class="hint">设备：${escapeHtml(row.device_name)}　最后上报：${formatTime(row.timestamp)}</p>
      </section>`).join("")}</div>`;
}

async function renderAnalysis() {
  const ponds = await Api.getPonds(state.farmId);
  const root = document.getElementById("pageRoot");
  root.innerHTML = `
    <div class="toolbar">
      <div class="field"><label>指标</label><select id="metricSelect">${Object.entries(SENSOR_DEFINITIONS).map(([key, def]) => `<option value="${key}">${def.name}</option>`).join("")}</select></div>
      <div class="field"><label>时间范围</label><select id="rangeSelect"><option value="1h">1小时</option><option value="6h">6小时</option><option value="12h">12小时</option><option value="24h" selected>24小时</option><option value="7d">7天</option></select></div>
      <div class="field"><label>池塘</label><select id="pondSelect"><option value="">全部池塘</option>${ponds.map(pond => `<option value="${pond.id}">${escapeHtml(pond.name)}</option>`).join("")}</select></div>
      <div class="toolbar-actions"><button class="primary-btn" id="analysisQuery">查询</button></div>
    </div>
    <section class="panel"><h2 class="panel-title">历史数据曲线</h2><div class="chart" id="analysisChart"></div></section>
    <section class="panel" style="margin-top:16px"><h2 class="panel-title">数据明细</h2><div class="table-wrap"><table><thead><tr><th>时间</th><th>池塘</th><th>指标值</th></tr></thead><tbody id="historyRows"></tbody></table></div></section>`;
  async function load() {
    disposeCharts();
    const metric = document.getElementById("metricSelect").value;
    const def = SENSOR_DEFINITIONS[metric];
    const rows = await Api.getHistoryData(metric, document.getElementById("rangeSelect").value, state.farmId, document.getElementById("pondSelect").value);
    chart(document.getElementById("analysisChart"), lineOption([{ name: def.name, data: rows.map(row => ({ time: row.timestamp.slice(5, 16).replace("T", " "), value: row.value })) }], def.unit));
    document.getElementById("historyRows").innerHTML = rows.slice().reverse().slice(0, 100).map(row => `<tr><td>${formatTime(row.timestamp)}</td><td>${escapeHtml(row.pond_name)}</td><td>${row.value} ${def.unit}</td></tr>`).join("");
  }
  document.getElementById("analysisQuery").addEventListener("click", () => load().catch(showError));
  await load();
}

async function renderAlarms() {
  const alarms = await Api.getAlarmList(state.farmId);
  document.getElementById("pageRoot").innerHTML = `
    <section class="panel"><h2 class="panel-title">报警记录</h2><div class="table-wrap"><table>
      <thead><tr><th>时间</th><th>池塘</th><th>指标</th><th>数值</th><th>等级</th><th>内容</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${alarms.map(alarm => `<tr><td>${formatTime(alarm.created_at)}</td><td>${escapeHtml(alarm.pond_name)}</td><td>${escapeHtml(alarm.sensor_name)}</td><td>${alarm.value} ${escapeHtml(alarm.unit)}</td><td>${statusBadge(alarm.level, LEVEL_TEXT[alarm.level])}</td><td>${escapeHtml(alarm.message)}</td><td>${statusBadge(alarm.status, STATUS_TEXT[alarm.status])}</td><td>${alarm.status === "pending" ? `<button class="secondary-btn" data-handle="${alarm.id}">标记已处理</button>` : escapeHtml(alarm.handled_by_name || "--")}</td></tr>`).join("")}</tbody>
    </table></div></section>`;
  document.querySelectorAll("[data-handle]").forEach(button => button.addEventListener("click", async () => {
    try {
      await Api.handleAlarm(Number(button.dataset.handle));
      showToast("报警已处理");
      await renderAlarms();
    } catch (error) { showError(error); }
  }));
}

async function renderSettings() {
  const data = await Api.getSettings(state.farmId);
  const values = {};
  data.thresholds.forEach(item => {
    values[`${item.metric}_min`] = item.min_value;
    values[`${item.metric}_max`] = item.max_value;
  });
  const metrics = ["do", "water_temp", "ph", "orp", "water_level"];
  document.getElementById("pageRoot").innerHTML = `
    <section class="panel"><h2 class="panel-title">水质报警阈值</h2>
      <form id="settingsForm"><div class="form-grid">${metrics.map(metric => {
        const def = SENSOR_DEFINITIONS[metric];
        return `<div class="form-section"><h3>${def.name} (${def.unit || "无单位"})</h3>
          <div class="form-grid">
            <div class="field"><label>下限</label><input type="number" step="0.1" name="${metric}_min" value="${values[`${metric}_min`] ?? ""}"></div>
            <div class="field"><label>上限</label><input type="number" step="0.1" name="${metric}_max" value="${values[`${metric}_max`] ?? ""}"></div>
          </div></div>`;
      }).join("")}</div><button class="primary-btn" type="submit">保存参数</button></form>
    </section>
    <section class="panel" style="margin-top:16px"><h2 class="panel-title">人工检测记录</h2><p class="hint">预留录入字段：检测时间、池号、氨氮 mg/L、亚硝酸盐 mg/L、备注。第一阶段暂不接在线氨氮传感器。</p><button class="secondary-btn" disabled>功能预留</button></section>`;
  document.getElementById("settingsForm").addEventListener("submit", async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = {};
    for (const [key, value] of form.entries()) if (value !== "") payload[key] = Number(value);
    try {
      await Api.saveSettings({ farm_id: state.farmId, values: payload });
      showToast("参数已保存");
    } catch (error) { showError(error); }
  });
}

async function renderDevices() {
  const devices = await Api.getSensorList(state.farmId);
  document.getElementById("pageRoot").innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">设备总数</div><div class="stat-value">${devices.length}</div></div>
      <div class="stat-card"><div class="stat-label">在线设备</div><div class="stat-value">${devices.filter(item => item.communication_status === "online").length}</div></div>
      <div class="stat-card"><div class="stat-label">离线设备</div><div class="stat-value">${devices.filter(item => item.communication_status !== "online").length}</div></div>
      <div class="stat-card"><div class="stat-label">通信方式</div><div class="stat-value"><small>网关 API 预留</small></div></div>
    </div>
    <div class="device-grid">${devices.map(device => `<article class="device-card">
      <div class="pond-card-head"><strong>${escapeHtml(device.name)}</strong><span class="status ${device.communication_status}">${STATUS_TEXT[device.communication_status]}</span></div>
      <p class="card-meta">编号：${escapeHtml(device.device_code)}</p><p class="card-meta">位置：${escapeHtml(device.pond_name || "未绑定")}</p><p class="card-meta">最后通信：${formatTime(device.last_seen)}</p>
    </article>`).join("")}</div>`;
}

async function renderFeeding() {
  const [plans, ponds] = await Promise.all([Api.getFeedingPlans(state.farmId), Api.getPonds(state.farmId)]);
  document.getElementById("pageRoot").innerHTML = `
    <div class="content-grid">
      <section class="panel"><h2 class="panel-title">投喂计划</h2><div class="table-wrap"><table><thead><tr><th>池塘</th><th>时间</th><th>饲料</th><th>投喂量</th><th>状态</th></tr></thead><tbody>
        ${plans.map(plan => `<tr><td>${escapeHtml(plan.pond_name)}</td><td>${escapeHtml(plan.feed_time)}</td><td>${escapeHtml(plan.feed_name)}</td><td>${plan.amount_kg} kg</td><td>${statusBadge(plan.enabled ? "normal" : "offline", plan.enabled ? "启用" : "停用")}</td></tr>`).join("")}
      </tbody></table></div></section>
      <section class="panel"><h2 class="panel-title">新增投喂计划</h2><form id="feedForm">
        <div class="field"><label>池塘</label><select name="pond_id">${ponds.map(pond => `<option value="${pond.id}">${escapeHtml(pond.name)}</option>`).join("")}</select></div>
        <div class="field"><label>投喂时间</label><input name="feed_time" type="time" value="08:30" required></div>
        <div class="field"><label>饲料名称</label><input name="feed_name" value="对虾配合饲料" required></div>
        <div class="field"><label>投喂量 (kg)</label><input name="amount_kg" type="number" step="0.1" min="0.1" value="10" required></div>
        <button class="primary-btn" type="submit">保存计划</button></form></section>
    </div>`;
  document.getElementById("feedForm").addEventListener("submit", async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await Api.saveFeedingPlan({ farm_id: state.farmId, pond_id: Number(data.pond_id), feed_time: data.feed_time, feed_name: data.feed_name, amount_kg: Number(data.amount_kg), enabled: true });
      showToast("投喂计划已保存");
      await renderFeeding();
    } catch (error) { showError(error); }
  });
}

async function renderCameras() {
  const cameras = await Api.getCameras(state.farmId);
  document.getElementById("pageRoot").innerHTML = `
    <div class="notice">视频监控为接口和布局预留。后续可接入 GB28181、WebRTC 或厂商云平台转码服务。</div>
    <div class="camera-grid" style="margin-top:16px">${cameras.map(camera => `<article class="camera-card"><div class="camera-preview">视频信号待接入</div><div class="pond-card-head" style="margin-top:12px"><strong>${escapeHtml(camera.name)}</strong><span class="status reserved">待接入</span></div><p class="card-meta">${escapeHtml(camera.location)}</p></article>`).join("")}</div>`;
}

async function renderManagement() {
  if (state.me.role !== "admin") {
    document.getElementById("pageRoot").innerHTML = `<div class="panel empty">当前账号无管理员权限。养殖场绑定关系由管理员维护。</div>`;
    return;
  }
  const users = await Api.getAdminUsers();
  document.getElementById("pageRoot").innerHTML = `
    <section class="panel"><h2 class="panel-title">用户与养殖场权限</h2><div class="table-wrap"><table><thead><tr><th>用户名</th><th>姓名</th><th>角色</th><th>绑定养殖场</th><th>状态</th></tr></thead><tbody>
      ${users.map(user => `<tr><td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.display_name)}</td><td>${escapeHtml(user.role)}</td><td>${escapeHtml(user.farms || (user.role === "admin" ? "全部养殖场" : "未绑定"))}</td><td>${statusBadge(user.active ? "normal" : "offline", user.active ? "启用" : "停用")}</td></tr>`).join("")}
    </tbody></table></div></section>
    <div class="content-grid" style="margin-top:16px">
      <section class="panel"><h2 class="panel-title">新增用户</h2><form id="userForm">
        <div class="form-grid"><div class="field"><label>用户名</label><input name="username" required></div><div class="field"><label>姓名</label><input name="display_name" required></div>
        <div class="field"><label>初始密码</label><input name="password" type="password" minlength="6" required></div><div class="field"><label>角色</label><select name="role"><option value="operator">操作员</option><option value="viewer">只读用户</option><option value="admin">管理员</option></select></div></div>
        <div class="field"><label>绑定养殖场</label><select name="farm_id"><option value="">暂不绑定</option>${state.farms.map(farm => `<option value="${farm.id}">${escapeHtml(farm.name)}</option>`).join("")}</select></div>
        <button class="primary-btn" type="submit">创建用户</button></form></section>
      <section class="panel"><h2 class="panel-title">新增养殖场</h2><form id="farmForm">
        <div class="field"><label>养殖场名称</label><input name="name" required></div><div class="field"><label>所在地</label><input name="location"></div><div class="field"><label>池塘数量</label><input name="pond_count" type="number" min="1" max="100" value="4" required></div>
        <button class="primary-btn" type="submit">创建养殖场</button></form></section>
    </div>`;
  document.getElementById("userForm").addEventListener("submit", async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await Api.createUser({ username: data.username, display_name: data.display_name, password: data.password, role: data.role, farm_ids: data.farm_id ? [Number(data.farm_id)] : [] });
      showToast("用户已创建");
      await renderManagement();
    } catch (error) { showError(error); }
  });
  document.getElementById("farmForm").addEventListener("submit", async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await Api.createFarm({ name: data.name, location: data.location, pond_count: Number(data.pond_count) });
      showToast("养殖场已创建，请刷新后选择");
    } catch (error) { showError(error); }
  });
}

async function renderPage(page) {
  const handlers = {
    index: renderDashboard,
    monitoring: renderMonitoring,
    analysis: renderAnalysis,
    alarm: renderAlarms,
    settings: renderSettings,
    device: renderDevices,
    feeding: renderFeeding,
    camera: renderCameras,
    management: renderManagement
  };
  document.getElementById("pageRoot").innerHTML = `<div class="empty">正在加载...</div>`;
  try {
    await handlers[page]();
  } catch (error) {
    showError(error);
    document.getElementById("pageRoot").innerHTML = `<div class="panel empty">${escapeHtml(error.message)}</div>`;
  }
}

window.addEventListener("resize", () => state.charts.forEach(instance => instance.resize()));

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  if (page === "login") initLogin();
  else initAuthenticatedPage(page);
});
