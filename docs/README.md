# 金梦湾渔业水质在线监测平台前端

前端使用原生 HTML、CSS、JavaScript 和 ECharts。当前通过 `assets/js/api.js` 统一获取数据。

## 页面

- `index.html`：首页总览
- `device.html`：设备管理
- `analysis.html`：水质分析
- `alarm.html`：报警记录
- `settings.html`：参数设置

## 接口层

`assets/js/api.js` 支持两种模式：

- `DATA_MODE = "api"`：请求 FastAPI 后端。
- `DATA_MODE = "mock"`：使用 `assets/js/mock-data.js` 的本地假数据。

后端启动后访问 `http://127.0.0.1:8000` 即可打开首页。

## 第一版指标口径

在线指标为：DO、pH、盐度/EC、水温、水位、ORP、室温。

氨氮和亚硝酸盐第一版采用试剂盒人工检测并录入，不作为在线传感器显示。
