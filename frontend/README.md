# 前端说明

前端使用原生 HTML、CSS、JavaScript 和 ECharts。

`assets/js/api.js` 是统一数据接口层：

- 本地访问 `http://127.0.0.1:8000` 或 `http://localhost:8000` 时使用 FastAPI 接口。
- GitHub Pages、静态服务器或文件预览时自动使用 mock 数据。

页面入口：

- `login.html`：登录页
- `index.html`：首页总览
- `monitoring.html`：水质实时监测
- `analysis.html`：历史曲线
- `alarm.html`：报警记录
- `settings.html`：参数设置
- `device.html`：设备状态
- `feeding.html`：投喂预留
- `camera.html`：视频监控预留
- `management.html`：用户/养殖场管理
