App.initChrome("alarm");

const alarmTable = document.getElementById("alarmTable");

async function renderAlarms() {
  const [latest, alarms] = await Promise.all([
    Api.getLatestData(),
    Api.getAlarmList()
  ]);
  App.setSystemStatus(latest.system.status);
  App.renderAlarmRows(alarmTable, alarms, true);
}

alarmTable.addEventListener("click", async event => {
  const button = event.target.closest("[data-handle-alarm]");
  if (!button) return;
  await Api.handleAlarm(button.dataset.handleAlarm);
  await renderAlarms();
});

renderAlarms();
