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
const STATUS_TEXT = {
  pending: "未处理", confirmed: "已确认", online: "在线", offline: "离线",
  active: "启用", disabled: "停用", reserved: "待接入", normal: "正常"
};
const state = { me: null, farms: [], farmId: null, sensorTypes: [], charts: [] };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "--";
}

function statusBadge(value, text) {
  const css = value === "confirmed" || value === "active" ? "normal" : value;
  return `<span class="badge ${escapeHtml(css)}">${escapeHtml(text || STATUS_TEXT[value] || LEVEL_TEXT[value] || value)}</span>`;
}

function sensorType(type) {
  return state.sensorTypes.find(item => item.type === type) || { type, name: type, unit: "" };
}

function latestValue(sensor) {
  return sensor.latest ? `${sensor.latest.value} ${sensor.unit || ""}`.trim() : "--";
}

function showToast(message) {
  document.querySelector(".toast")?.remove();
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

function emptyState(text) {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function openModal(title, content) {
  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "appModal";
  overlay.innerHTML = `
    <section class="modal">
      <div class="modal-head"><h2>${escapeHtml(title)}</h2><button class="icon-btn" data-close-modal title="关闭">×</button></div>
      <div class="modal-body">${content}</div>
    </section>`;
  document.body.append(overlay);
  overlay.addEventListener("click", event => {
    if (event.target === overlay || event.target.closest("[data-close-modal]")) closeModal();
  });
}

function closeModal() {
  document.getElementById("appModal")?.remove();
}

async function confirmAction(title, message) {
  return new Promise(resolve => {
    openModal(title, `
      <p class="confirm-text">${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button class="secondary-btn" id="confirmCancel">取消</button>
        <button class="danger-btn" id="confirmOk">确认删除</button>
      </div>`);
    document.getElementById("confirmCancel").onclick = () => { closeModal(); resolve(false); };
    document.getElementById("confirmOk").onclick = () => { closeModal(); resolve(true); };
  });
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
        <div class="side-brand">金梦湾渔业<br>水质在线监测平台<small>WEB 管理后台 V0.3</small></div>
        <nav class="nav-list">
          ${NAV_ITEMS.map(([key, label, href]) => `<a class="nav-link ${page === key ? "active" : ""}" href="${href}">${label}</a>`).join("")}
        </nav>
        <div class="sidebar-foot">数据模式：动态模拟 PLC<br><span class="status normal">服务运行中</span></div>
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
        <main class="page-content" id="pageRoot">${emptyState("正在加载...")}</main>
      </section>
    </div>`;
  document.getElementById("menuButton").onclick = () => document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("logoutButton").onclick = () => {
    Api.logout();
    window.location.href = "login.html";
  };
}

async function initAuthenticatedPage(page) {
  if (!Api.hasToken()) {
    window.location.href = "login.html";
    return;
  }
  renderShell(page);
  try {
    [state.me, state.farms, state.sensorTypes] = await Promise.all([Api.getMe(), Api.getFarms(), Api.getSensorTypes()]);
    document.getElementById("displayName").textContent = state.me.display_name;
    document.getElementById("roleName").textContent = state.me.role === "admin" ? "系统管理员" : state.me.role === "viewer" ? "只读用户" : "养殖场用户";
    const savedFarm = Api.selectedFarmId();
    state.farmId = state.farms.some(farm => farm.id === savedFarm) ? savedFarm : state.farms[0]?.id;
    const select = document.getElementById("farmSelect");
    select.innerHTML = state.farms.map(farm => `<option value="${farm.id}">${escapeHtml(farm.name)}</option>`).join("");
    if (state.farmId) {
      select.value = String(state.farmId);
      Api.setSelectedFarmId(state.farmId);
    }
    select.onchange = async event => {
      state.farmId = Number(event.target.value);
      Api.setSelectedFarmId(state.farmId);
      disposeCharts();
      await renderPage(page);
    };
    await renderPage(page);
  } catch (error) {
    showError(error);
    document.getElementById("pageRoot").innerHTML = emptyState(error.message);
  }
}

function disposeCharts() {
  state.charts.forEach(instance => instance.dispose());
  state.charts = [];
}

function chart(node, option) {
  if (!window.echarts || !node) return;
  const instance = echarts.init(node);
  instance.setOption(option);
  state.charts.push(instance);
}

function lineOption(name, unit, rows) {
  return {
    color: ["#29d7ff"],
    tooltip: { trigger: "axis", backgroundColor: "#07192d", borderColor: "#29d7ff", textStyle: { color: "#e4f5ff" } },
    grid: { left: 50, right: 18, top: 36, bottom: 34 },
    xAxis: { type: "category", boundaryGap: false, data: rows.map(item => item.timestamp.slice(5, 16).replace("T", " ")), axisLabel: { color: "#86a7bf" }, axisLine: { lineStyle: { color: "#174d79" } } },
    yAxis: { type: "value", name: unit, nameTextStyle: { color: "#86a7bf" }, axisLabel: { color: "#86a7bf" }, splitLine: { lineStyle: { color: "rgba(23,77,121,.35)" } } },
    series: [{ name, type: "line", smooth: true, symbol: "none", data: rows.map(item => item.value), areaStyle: { opacity: .08 } }]
  };
}

function findSensor(pond, type) {
  return pond.sensors.find(sensor => sensor.type === type && sensor.enabled);
}

async function renderDashboard() {
  const [data, alarms] = await Promise.all([Api.getDashboard(state.farmId), Api.getFarmAlarms(state.farmId)]);
  const ponds = data.ponds || [];
  const root = document.getElementById("pageRoot");
  root.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">养殖池数量</div><div class="stat-value">${data.summary.pond_count}<small>个</small></div></div>
      <div class="stat-card"><div class="stat-label">启用传感器</div><div class="stat-value">${data.summary.sensor_count}<small>个</small></div></div>
      <div class="stat-card"><div class="stat-label">传感器在线</div><div class="stat-value">${data.summary.online_count}/${data.summary.sensor_count}</div></div>
      <div class="stat-card"><div class="stat-label">待处理报警</div><div class="stat-value">${data.summary.pending_alarm_count}<small>条</small></div></div>
    </div>
    <div class="content-grid">
      <div class="stack">
        <section class="panel"><h2 class="panel-title">${escapeHtml(data.farm.name)} · 池塘运行状态</h2>
          <div class="pond-grid">${ponds.map(pond => {
            const doSensor = findSensor(pond, "do");
            const temp = findSensor(pond, "water_temp");
            const ph = findSensor(pond, "ph");
            const orp = findSensor(pond, "orp");
            const level = findSensor(pond, "water_level");
            return `<article class="pond-card">
              <div class="pond-card-head"><strong>${escapeHtml(pond.name)}</strong><span class="status ${pond.online ? "online" : "offline"}">${pond.online ? "在线" : "离线"}</span></div>
              <div class="metric-value">${doSensor ? latestValue(doSensor) : "--"}<small>${doSensor ? " DO" : " 未配置 DO"}</small></div>
              <div class="card-meta">${[
                temp ? `水温 ${latestValue(temp)}` : "",
                ph ? `pH ${latestValue(ph)}` : "",
                orp ? `ORP ${latestValue(orp)}` : "",
                level ? `水位 ${latestValue(level)}` : ""
              ].filter(Boolean).join(" · ") || "暂无启用传感器"}</div>
            </article>`;
          }).join("") || emptyState("暂无水池，请先在参数设置中添加水池")}</div>
        </section>
        <section class="panel"><h2 class="panel-title">主要指标趋势</h2><div class="chart" id="dashboardChart"></div></section>
      </div>
      <div class="stack">
        <section class="panel"><h2 class="panel-title">传感器配置概况</h2>
          <div class="metric-grid">${state.sensorTypes.map(type => {
            const count = ponds.reduce((sum, pond) => sum + pond.sensors.filter(sensor => sensor.type === type.type && sensor.enabled).length, 0);
            return `<article class="metric-card"><div class="metric-name">${escapeHtml(type.name)}</div><div class="metric-value">${count}<small> 个</small></div><span class="status ${count ? "normal" : "offline"}">${count ? "已配置" : "未启用"}</span></article>`;
          }).join("")}</div>
        </section>
        <section class="panel"><h2 class="panel-title">最新报警</h2><div class="alarm-list">
          ${alarms.slice(0, 5).map(alarm => `<div class="alarm-item"><div class="line-row"><strong>${escapeHtml(alarm.pond_name)} · ${escapeHtml(alarm.sensor_name)}</strong>${statusBadge(alarm.alarm_level, LEVEL_TEXT[alarm.alarm_level])}</div><p>${formatTime(alarm.created_at)}　当前值 ${alarm.value} ${escapeHtml(alarm.unit)}</p></div>`).join("") || emptyState("暂无报警")}
        </div></section>
      </div>
    </div>`;
  const firstSensor = ponds.flatMap(pond => pond.sensors).find(sensor => sensor.enabled);
  if (firstSensor) {
    const history = await Api.getSensorHistory(firstSensor.id, "24h");
    chart(document.getElementById("dashboardChart"), lineOption(firstSensor.name, firstSensor.unit, history));
  } else {
    document.getElementById("dashboardChart").innerHTML = emptyState("暂无可展示的传感器历史数据");
  }
}

async function renderMonitoring() {
  const ponds = await Api.getFarmRealtime(state.farmId);
  document.getElementById("pageRoot").innerHTML = `
    <div class="notice">实时数据按照每个水池已启用的传感器动态生成。新增、停用或删除传感器后，本页会自动变化。</div>
    <div class="stack" style="margin-top:16px">${ponds.map(pond => `
      <section class="panel">
        <div class="pond-card-head"><h2 class="panel-title" style="margin:0">${escapeHtml(pond.name)}</h2><span class="status ${pond.online ? "online" : "offline"}">${pond.online ? "在线" : "离线"}</span></div>
        <div class="metric-grid" style="margin-top:14px">${pond.sensors.map(sensor => `
          <article class="metric-card"><div class="metric-name">${escapeHtml(sensor.name)}</div><div class="metric-value">${latestValue(sensor)}</div><span class="status ${sensor.communication_status}">${STATUS_TEXT[sensor.communication_status]}</span></article>
        `).join("") || emptyState("该水池暂无启用传感器")}</div>
      </section>`).join("") || emptyState("暂无水池，请先添加水池")}</div>`;
}

async function renderAnalysis() {
  const ponds = await Api.getPonds(state.farmId);
  document.getElementById("pageRoot").innerHTML = `
    <div class="toolbar">
      <div class="field"><label>水池</label><select id="pondSelect">${ponds.map(pond => `<option value="${pond.id}">${escapeHtml(pond.name)}</option>`).join("")}</select></div>
      <div class="field"><label>传感器</label><select id="sensorSelect"></select></div>
      <div class="field"><label>时间范围</label><select id="rangeSelect"><option value="1h">1小时</option><option value="6h">6小时</option><option value="12h">12小时</option><option value="24h" selected>24小时</option><option value="7d">7天</option></select></div>
      <div class="toolbar-actions"><button class="primary-btn" id="analysisQuery">查询</button></div>
    </div>
    <section class="panel"><h2 class="panel-title">传感器历史曲线</h2><div class="chart" id="analysisChart"></div></section>
    <section class="panel" style="margin-top:16px"><h2 class="panel-title">数据明细</h2><div class="table-wrap"><table><thead><tr><th>时间</th><th>传感器</th><th>类型</th><th>数值</th><th>状态</th></tr></thead><tbody id="historyRows"></tbody></table></div></section>`;
  if (!ponds.length) {
    document.getElementById("pageRoot").innerHTML = emptyState("暂无水池，请先添加水池");
    return;
  }
  async function loadSensors() {
    const sensors = await Api.getPondSensors(Number(document.getElementById("pondSelect").value));
    const enabled = sensors.filter(sensor => sensor.enabled);
    document.getElementById("sensorSelect").innerHTML = enabled.map(sensor => `<option value="${sensor.id}">${escapeHtml(sensor.name)} (${escapeHtml(sensorType(sensor.type).name)})</option>`).join("");
    return enabled;
  }
  async function loadHistory() {
    disposeCharts();
    const sensorId = Number(document.getElementById("sensorSelect").value);
    if (!sensorId) {
      document.getElementById("analysisChart").innerHTML = emptyState("该水池暂无启用传感器");
      document.getElementById("historyRows").innerHTML = "";
      return;
    }
    const sensors = await Api.getPondSensors(Number(document.getElementById("pondSelect").value));
    const sensor = sensors.find(item => item.id === sensorId);
    const rows = await Api.getSensorHistory(sensorId, document.getElementById("rangeSelect").value);
    chart(document.getElementById("analysisChart"), lineOption(sensor.name, sensor.unit, rows));
    document.getElementById("historyRows").innerHTML = rows.slice().reverse().slice(0, 100).map(row => `
      <tr><td>${formatTime(row.timestamp)}</td><td>${escapeHtml(sensor.name)}</td><td>${escapeHtml(sensorType(sensor.type).name)}</td><td>${row.value} ${escapeHtml(row.unit)}</td><td>${statusBadge(row.status)}</td></tr>`).join("");
  }
  document.getElementById("pondSelect").onchange = async () => { await loadSensors(); await loadHistory(); };
  document.getElementById("analysisQuery").onclick = () => loadHistory().catch(showError);
  await loadSensors();
  await loadHistory();
}

async function renderAlarms() {
  const alarms = await Api.getFarmAlarms(state.farmId);
  document.getElementById("pageRoot").innerHTML = `
    <section class="panel"><h2 class="panel-title">报警记录</h2><div class="table-wrap"><table>
      <thead><tr><th>时间</th><th>养殖场</th><th>池号</th><th>传感器名称</th><th>当前值</th><th>报警等级</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${alarms.map(alarm => `<tr>
        <td>${formatTime(alarm.created_at)}</td><td>${escapeHtml(alarm.farm_name)}</td><td>${escapeHtml(alarm.pond_name)}</td>
        <td>${escapeHtml(alarm.sensor_name)}</td><td>${alarm.value} ${escapeHtml(alarm.unit)}</td>
        <td>${statusBadge(alarm.alarm_level, LEVEL_TEXT[alarm.alarm_level])}</td><td>${statusBadge(alarm.status)}</td>
        <td>${alarm.status === "pending" ? `<button class="secondary-btn" data-confirm-alarm="${alarm.id}">确认报警</button>` : formatTime(alarm.confirmed_at)}</td>
      </tr>`).join("") || `<tr><td colspan="8">${emptyState("暂无报警记录")}</td></tr>`}</tbody>
    </table></div></section>`;
  document.querySelectorAll("[data-confirm-alarm]").forEach(button => button.onclick = async () => {
    try {
      await Api.confirmAlarm(Number(button.dataset.confirmAlarm));
      showToast("报警已确认");
      await renderAlarms();
    } catch (error) { showError(error); }
  });
}

function pondForm(pond = {}) {
  return `
    <form id="pondForm">
      <div class="field"><label>水池名称</label><input name="name" value="${escapeHtml(pond.name || "")}" required></div>
      <div class="form-grid">
        <div class="field"><label>排序</label><input name="sort_order" type="number" value="${pond.sort_order ?? 0}" required></div>
        <div class="field"><label>状态</label><select name="status"><option value="active" ${pond.status !== "disabled" ? "selected" : ""}>启用</option><option value="disabled" ${pond.status === "disabled" ? "selected" : ""}>停用</option></select></div>
      </div>
      <div class="field"><label>备注</label><input name="remark" value="${escapeHtml(pond.remark || "")}"></div>
      <div class="modal-actions"><button type="button" class="secondary-btn" data-close-modal>取消</button><button class="primary-btn" type="submit">保存</button></div>
    </form>`;
}

function sensorForm(ponds, sensor = {}, selectedPondId = null) {
  const type = sensorType(sensor.type || "do");
  return `
    <form id="sensorForm">
      <div class="form-grid">
        <div class="field"><label>所属水池</label><select name="pond_id">${ponds.map(pond => `<option value="${pond.id}" ${pond.id === (selectedPondId || sensor.pond_id) ? "selected" : ""}>${escapeHtml(pond.name)}</option>`).join("")}</select></div>
        <div class="field"><label>传感器类型</label><select name="type" id="sensorTypeSelect">${state.sensorTypes.map(item => `<option value="${item.type}" ${item.type === (sensor.type || "do") ? "selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></div>
        <div class="field"><label>传感器名称</label><input name="name" id="sensorNameInput" value="${escapeHtml(sensor.name || type.name)}" required></div>
        <div class="field"><label>单位</label><input name="unit" id="sensorUnitInput" value="${escapeHtml(sensor.unit ?? type.unit)}"></div>
        <div class="field"><label>RS485 地址</label><input name="address" value="${escapeHtml(sensor.address || "1")}"></div>
        <div class="field"><label>寄存器地址</label><input name="register" value="${escapeHtml(sensor.register || "0")}"></div>
        <div class="field"><label>数据类型</label><select name="data_type">${["float32", "int16", "uint16", "int32"].map(value => `<option value="${value}" ${value === (sensor.data_type || "float32") ? "selected" : ""}>${value}</option>`).join("")}</select></div>
        <div class="field"><label>排序</label><input name="sort_order" type="number" value="${sensor.sort_order ?? 0}"></div>
        <div class="field"><label>量程下限</label><input name="min_limit" type="number" step="0.01" value="${sensor.min_limit ?? type.min ?? ""}"></div>
        <div class="field"><label>量程上限</label><input name="max_limit" type="number" step="0.01" value="${sensor.max_limit ?? type.max ?? ""}"></div>
        <div class="field"><label>低值报警</label><input name="low_alarm" type="number" step="0.01" value="${sensor.low_alarm ?? type.min ?? ""}"></div>
        <div class="field"><label>高值报警</label><input name="high_alarm" type="number" step="0.01" value="${sensor.high_alarm ?? type.max ?? ""}"></div>
      </div>
      <label class="check-row"><input name="enabled" type="checkbox" ${sensor.enabled !== false ? "checked" : ""}> 启用传感器</label>
      <div class="field"><label>备注</label><input name="remark" value="${escapeHtml(sensor.remark || "")}"></div>
      <div class="modal-actions"><button type="button" class="secondary-btn" data-close-modal>取消</button><button class="primary-btn" type="submit">保存</button></div>
    </form>`;
}

function sensorPayload(form, farmId) {
  const data = Object.fromEntries(new FormData(form));
  const numberOrNull = value => value === "" ? null : Number(value);
  return {
    farm_id: farmId,
    pond_id: Number(data.pond_id),
    name: data.name,
    type: data.type,
    unit: data.unit,
    address: data.address,
    register: data.register,
    data_type: data.data_type,
    enabled: form.elements.enabled.checked,
    min_limit: numberOrNull(data.min_limit),
    max_limit: numberOrNull(data.max_limit),
    low_alarm: numberOrNull(data.low_alarm),
    high_alarm: numberOrNull(data.high_alarm),
    sort_order: Number(data.sort_order || 0),
    remark: data.remark
  };
}

async function renderSettings() {
  const ponds = await Api.getPonds(state.farmId);
  const sensorGroups = await Promise.all(ponds.map(async pond => ({ pond, sensors: await Api.getPondSensors(pond.id) })));
  const root = document.getElementById("pageRoot");
  root.innerHTML = `
    <section class="panel">
      <div class="section-head"><div><h2 class="panel-title">水池管理</h2><p class="hint">新增、停用、排序或软删除当前养殖场的水池。</p></div><button class="primary-btn" id="addPond">新增水池</button></div>
      <div class="table-wrap"><table><thead><tr><th>排序</th><th>水池名称</th><th>状态</th><th>传感器数</th><th>备注</th><th>操作</th></tr></thead><tbody>
        ${ponds.map(pond => `<tr><td>${pond.sort_order}</td><td>${escapeHtml(pond.name)}</td><td>${statusBadge(pond.status)}</td><td>${pond.sensor_count}</td><td>${escapeHtml(pond.remark)}</td><td><button class="secondary-btn" data-edit-pond="${pond.id}">编辑</button> <button class="danger-btn" data-delete-pond="${pond.id}">删除</button></td></tr>`).join("") || `<tr><td colspan="6">${emptyState("暂无水池，请先添加水池")}</td></tr>`}
      </tbody></table></div>
    </section>
    <section class="panel" style="margin-top:16px">
      <div class="section-head"><div><h2 class="panel-title">传感器管理</h2><p class="hint">每个水池可以配置不同类型和数量的传感器。</p></div><button class="primary-btn" id="addSensor" ${ponds.length ? "" : "disabled"}>新增传感器</button></div>
      <div class="table-wrap"><table><thead><tr><th>水池</th><th>名称</th><th>类型</th><th>地址/寄存器</th><th>报警范围</th><th>通讯</th><th>启用</th><th>操作</th></tr></thead><tbody>
        ${sensorGroups.flatMap(group => group.sensors.map(sensor => `<tr>
          <td>${escapeHtml(group.pond.name)}</td><td>${escapeHtml(sensor.name)}</td><td>${escapeHtml(sensorType(sensor.type).name)} / ${escapeHtml(sensor.unit)}</td>
          <td>${escapeHtml(sensor.address)} / ${escapeHtml(sensor.register)}<br><small>${escapeHtml(sensor.data_type)}</small></td>
          <td>${sensor.low_alarm ?? "--"} ~ ${sensor.high_alarm ?? "--"}</td><td>${statusBadge(sensor.communication_status)}</td>
          <td>${statusBadge(sensor.enabled ? "active" : "disabled")}</td>
          <td><button class="secondary-btn" data-edit-sensor="${sensor.id}" data-pond-id="${group.pond.id}">编辑</button> <button class="danger-btn" data-delete-sensor="${sensor.id}">删除</button></td>
        </tr>`)).join("") || `<tr><td colspan="8">${emptyState("暂无传感器，请先新增传感器")}</td></tr>`}
      </tbody></table></div>
    </section>
    <section class="panel" style="margin-top:16px"><h2 class="panel-title">报警阈值说明</h2><p class="hint">报警上下限已合并到每个传感器配置中。相同类型的传感器可以按不同水池设置不同阈值。</p></section>`;

  document.getElementById("addPond").onclick = () => {
    openModal("新增水池", pondForm({ sort_order: ponds.length + 1 }));
    document.getElementById("pondForm").onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      try {
        await Api.createPond(state.farmId, { name: data.name, sort_order: Number(data.sort_order), status: data.status, remark: data.remark });
        closeModal(); showToast("水池已新增"); await renderSettings();
      } catch (error) { showError(error); }
    };
  };
  document.querySelectorAll("[data-edit-pond]").forEach(button => button.onclick = () => {
    const pond = ponds.find(item => item.id === Number(button.dataset.editPond));
    openModal("编辑水池", pondForm(pond));
    document.getElementById("pondForm").onsubmit = async event => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(event.currentTarget));
      try {
        await Api.updatePond(pond.id, { name: data.name, sort_order: Number(data.sort_order), status: data.status, remark: data.remark });
        closeModal(); showToast("水池已更新"); await renderSettings();
      } catch (error) { showError(error); }
    };
  });
  document.querySelectorAll("[data-delete-pond]").forEach(button => button.onclick = async () => {
    const pond = ponds.find(item => item.id === Number(button.dataset.deletePond));
    const ok = await confirmAction("删除水池", `确定删除“${pond.name}”吗？该水池下的传感器将停用，历史数据和报警记录将保留但不再显示。`);
    if (!ok) return;
    try {
      await Api.deletePond(pond.id);
      showToast("水池已删除");
      await renderSettings();
    } catch (error) { showError(error); }
  });

  document.getElementById("addSensor").onclick = () => {
    openModal("新增传感器", sensorForm(ponds, {}, ponds[0].id));
    bindSensorTypeDefaults();
    document.getElementById("sensorForm").onsubmit = async event => {
      event.preventDefault();
      const pondId = Number(event.currentTarget.elements.pond_id.value);
      try {
        await Api.createSensor(pondId, sensorPayload(event.currentTarget, state.farmId));
        closeModal(); showToast("传感器已新增"); await renderSettings();
      } catch (error) { showError(error); }
    };
  };
  document.querySelectorAll("[data-edit-sensor]").forEach(button => button.onclick = () => {
    const group = sensorGroups.find(item => item.pond.id === Number(button.dataset.pondId));
    const sensor = group.sensors.find(item => item.id === Number(button.dataset.editSensor));
    sensor.pond_id = group.pond.id;
    openModal("编辑传感器", sensorForm(ponds, sensor));
    document.getElementById("sensorForm").onsubmit = async event => {
      event.preventDefault();
      try {
        await Api.updateSensor(sensor.id, sensorPayload(event.currentTarget, state.farmId));
        closeModal(); showToast("传感器已更新"); await renderSettings();
      } catch (error) { showError(error); }
    };
  });
  document.querySelectorAll("[data-delete-sensor]").forEach(button => button.onclick = async () => {
    const sensor = sensorGroups.flatMap(group => group.sensors).find(item => item.id === Number(button.dataset.deleteSensor));
    const ok = await confirmAction("删除传感器", `确定删除“${sensor.name}”吗？历史数据会保留，但该传感器不再出现在实时监测和首页。`);
    if (!ok) return;
    try {
      await Api.deleteSensor(sensor.id);
      showToast("传感器已删除");
      await renderSettings();
    } catch (error) { showError(error); }
  });
}

function bindSensorTypeDefaults() {
  const select = document.getElementById("sensorTypeSelect");
  select.onchange = () => {
    const type = sensorType(select.value);
    document.getElementById("sensorNameInput").value = type.name;
    document.getElementById("sensorUnitInput").value = type.unit;
  };
}

async function renderDevices() {
  const sensors = await Api.getSensorList(state.farmId);
  const groups = Object.groupBy
    ? Object.groupBy(sensors, sensor => sensor.pond_name)
    : sensors.reduce((result, sensor) => ((result[sensor.pond_name] ||= []).push(sensor), result), {});
  document.getElementById("pageRoot").innerHTML = `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">传感器总数</div><div class="stat-value">${sensors.length}</div></div>
      <div class="stat-card"><div class="stat-label">已启用</div><div class="stat-value">${sensors.filter(item => item.enabled).length}</div></div>
      <div class="stat-card"><div class="stat-label">在线</div><div class="stat-value">${sensors.filter(item => item.enabled && item.communication_status === "online").length}</div></div>
      <div class="stat-card"><div class="stat-label">通讯失败</div><div class="stat-value">${sensors.reduce((sum, item) => sum + item.communication_failures, 0)}</div></div>
    </div>
    <div class="stack">${Object.entries(groups).map(([pondName, items]) => `<section class="panel"><h2 class="panel-title">${escapeHtml(pondName)}</h2>
      <div class="table-wrap"><table><thead><tr><th>传感器名称</th><th>类型</th><th>地址</th><th>寄存器</th><th>在线/离线</th><th>最后更新时间</th><th>通讯失败</th><th>启用状态</th></tr></thead><tbody>
        ${items.map(sensor => `<tr><td>${escapeHtml(sensor.name)}</td><td>${escapeHtml(sensorType(sensor.type).name)}</td><td>${escapeHtml(sensor.address)}</td><td>${escapeHtml(sensor.register)}</td><td>${statusBadge(sensor.communication_status)}</td><td>${formatTime(sensor.latest?.timestamp || sensor.updated_at)}</td><td>${sensor.communication_failures}</td><td>${statusBadge(sensor.enabled ? "active" : "disabled")}</td></tr>`).join("")}
      </tbody></table></div></section>`).join("") || emptyState("暂无传感器设备")}</div>`;
}

async function renderFeeding() {
  const [plans, ponds] = await Promise.all([Api.getFeedingPlans(state.farmId), Api.getPonds(state.farmId)]);
  document.getElementById("pageRoot").innerHTML = `
    <div class="content-grid">
      <section class="panel"><h2 class="panel-title">投喂计划</h2><div class="table-wrap"><table><thead><tr><th>池塘</th><th>时间</th><th>饲料</th><th>投喂量</th><th>状态</th></tr></thead><tbody>
        ${plans.map(plan => `<tr><td>${escapeHtml(plan.pond_name)}</td><td>${escapeHtml(plan.feed_time)}</td><td>${escapeHtml(plan.feed_name)}</td><td>${plan.amount_kg} kg</td><td>${statusBadge(plan.enabled ? "active" : "disabled")}</td></tr>`).join("") || `<tr><td colspan="5">${emptyState("暂无投喂计划")}</td></tr>`}
      </tbody></table></div></section>
      <section class="panel"><h2 class="panel-title">新增投喂计划</h2>${ponds.length ? `<form id="feedForm">
        <div class="field"><label>池塘</label><select name="pond_id">${ponds.filter(pond => pond.status === "active").map(pond => `<option value="${pond.id}">${escapeHtml(pond.name)}</option>`).join("")}</select></div>
        <div class="field"><label>投喂时间</label><input name="feed_time" type="time" value="08:30" required></div>
        <div class="field"><label>饲料名称</label><input name="feed_name" value="对虾配合饲料" required></div>
        <div class="field"><label>投喂量 (kg)</label><input name="amount_kg" type="number" step="0.1" min="0.1" value="10" required></div>
        <button class="primary-btn" type="submit">保存计划</button></form>` : emptyState("暂无可用水池")}</section>
    </div>`;
  document.getElementById("feedForm")?.addEventListener("submit", async event => {
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
    <div class="notice">视频监控为接口和布局预留，摄像头卡片随当前养殖场的水池配置自动变化。</div>
    <div class="camera-grid" style="margin-top:16px">${cameras.map(camera => `<article class="camera-card"><div class="camera-preview">视频信号待接入</div><div class="pond-card-head" style="margin-top:12px"><strong>${escapeHtml(camera.name)}</strong><span class="status reserved">待接入</span></div><p class="card-meta">${escapeHtml(camera.location)}</p></article>`).join("") || emptyState("暂无水池")}</div>`;
}

async function renderManagement() {
  if (state.me.role !== "admin") {
    document.getElementById("pageRoot").innerHTML = `<div class="panel empty">当前账号无管理员权限。</div>`;
    return;
  }
  const users = await Api.getAdminUsers();
  document.getElementById("pageRoot").innerHTML = `
    <section class="panel"><h2 class="panel-title">用户与养殖场权限</h2><div class="table-wrap"><table><thead><tr><th>用户名</th><th>姓名</th><th>角色</th><th>绑定养殖场</th><th>状态</th></tr></thead><tbody>
      ${users.map(user => `<tr><td>${escapeHtml(user.username)}</td><td>${escapeHtml(user.display_name)}</td><td>${escapeHtml(user.role)}</td><td>${escapeHtml(user.farms || (user.role === "admin" ? "全部养殖场" : "未绑定"))}</td><td>${statusBadge(user.active ? "active" : "disabled")}</td></tr>`).join("")}
    </tbody></table></div></section>
    <div class="content-grid" style="margin-top:16px">
      <section class="panel"><h2 class="panel-title">新增用户</h2><form id="userForm">
        <div class="form-grid"><div class="field"><label>用户名</label><input name="username" required></div><div class="field"><label>姓名</label><input name="display_name" required></div>
        <div class="field"><label>初始密码</label><input name="password" type="password" minlength="6" required></div><div class="field"><label>角色</label><select name="role"><option value="operator">操作员</option><option value="viewer">只读用户</option><option value="admin">管理员</option></select></div></div>
        <div class="field"><label>绑定养殖场</label><select name="farm_id"><option value="">暂不绑定</option>${state.farms.map(farm => `<option value="${farm.id}">${escapeHtml(farm.name)}</option>`).join("")}</select></div>
        <button class="primary-btn" type="submit">创建用户</button></form></section>
      <section class="panel"><h2 class="panel-title">新增养殖场</h2><form id="farmForm">
        <div class="field"><label>养殖场名称</label><input name="name" required></div><div class="field"><label>所在地</label><input name="location"></div>
        <button class="primary-btn" type="submit">创建养殖场</button></form><p class="hint">养殖场创建后，请在参数设置中按需添加水池和传感器。</p></section>
    </div>`;
  document.getElementById("userForm").onsubmit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await Api.createUser({ username: data.username, display_name: data.display_name, password: data.password, role: data.role, farm_ids: data.farm_id ? [Number(data.farm_id)] : [] });
      showToast("用户已创建"); await renderManagement();
    } catch (error) { showError(error); }
  };
  document.getElementById("farmForm").onsubmit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      await Api.createFarm({ name: data.name, location: data.location, status: "active", pond_count: 0 });
      state.farms = await Api.getFarms();
      showToast("养殖场已创建");
      await renderManagement();
    } catch (error) { showError(error); }
  };
}

async function renderPage(page) {
  const handlers = {
    index: renderDashboard, monitoring: renderMonitoring, analysis: renderAnalysis,
    alarm: renderAlarms, settings: renderSettings, device: renderDevices,
    feeding: renderFeeding, camera: renderCameras, management: renderManagement
  };
  document.getElementById("pageRoot").innerHTML = emptyState("正在加载...");
  try {
    await handlers[page]();
  } catch (error) {
    showError(error);
    document.getElementById("pageRoot").innerHTML = `<div class="panel">${emptyState(error.message)}</div>`;
  }
}

window.addEventListener("resize", () => state.charts.forEach(instance => instance.resize()));
document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  if (page === "login") initLogin();
  else initAuthenticatedPage(page);
});
