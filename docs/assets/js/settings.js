App.initChrome("settings");

const labels = {
  doWarn: "DO提醒值",
  doDanger: "DO危险值",
  phMin: "pH下限",
  phMax: "pH上限",
  salinityMin: "盐度下限",
  salinityMax: "盐度上限",
  tempMin: "温度下限",
  tempMax: "温度上限",
  levelMin: "水位下限",
  levelMax: "水位上限"
};

const fields = document.getElementById("settingsFields");
const form = document.getElementById("settingsForm");
const saveTip = document.getElementById("saveTip");

async function renderSettings() {
  const [latest, values, sensorMeta] = await Promise.all([
    Api.getLatestData(),
    Api.getSettings(),
    Api.getSensorList()
  ]);
  App.setSystemStatus(latest.system.status);
  fields.innerHTML = `
    <div class="setting-card">
      <label for="pondCount">养殖池数量</label>
      <input id="pondCount" name="pondCount" type="number" min="1" max="50" step="1" value="${values.pondCount}">
    </div>
    <div class="setting-card sensor-setting-card">
      <label>传感器启用列表</label>
      <div class="sensor-checkbox-grid">
        ${sensorMeta.allSensors.map(sensor => `
          <label class="checkbox-item">
            <input type="checkbox" name="enabledSensors" value="${sensor.key}" ${values.enabledSensors.includes(sensor.key) ? "checked" : ""}>
            <span>${sensor.name}${sensor.unit ? `（${sensor.unit}）` : ""}</span>
          </label>
        `).join("")}
      </div>
      <div class="stat-label">传感器数量：<strong id="sensorCountPreview">${values.enabledSensors.length}</strong></div>
    </div>
    ${Object.keys(Api.defaultSettings).map(key => `
      <div class="setting-card">
        <label for="${key}">${labels[key]}</label>
        <input id="${key}" name="${key}" type="number" step="0.1" value="${values[key]}">
      </div>
    `).join("")}
    <div class="setting-card sensor-setting-card">
      <label>人工检测记录</label>
      <div class="record-item">检测时间、池号、氨氮 mg/L、亚硝酸盐 mg/L、备注</div>
      <div class="stat-label">第一版作为人工试剂盒检测录入入口占位，不作为在线传感器。</div>
    </div>
  `;

  fields.querySelectorAll('input[name="enabledSensors"]').forEach(input => {
    input.addEventListener("change", updateSensorCountPreview);
  });
}

function updateSensorCountPreview() {
  const preview = document.getElementById("sensorCountPreview");
  if (!preview) return;
  preview.textContent = form.querySelectorAll('input[name="enabledSensors"]:checked').length;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const data = {
    pondCount: Number(form.elements.pondCount.value),
    enabledSensors: Array.from(form.querySelectorAll('input[name="enabledSensors"]:checked')).map(input => input.value)
  };
  Object.keys(Api.defaultSettings).forEach(key => {
    data[key] = Number(form.elements[key].value);
  });
  await Api.saveSettings(data);
  await renderSettings();
  saveTip.classList.add("show");
  setTimeout(() => saveTip.classList.remove("show"), 1800);
});

renderSettings();
