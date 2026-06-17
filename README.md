# 金梦湾渔业水质在线监测平台

这是“金梦湾渔业水质在线监测平台”的半成品演示项目。

## GitHub Pages 静态演示版

`docs/` 目录是 GitHub Pages 专用静态预览版：

- 不连接后端
- 不连接 FastAPI
- 不连接 SQLite 数据库
- 不连接 PLC、RS485 或真实传感器
- 所有页面都使用 `assets/js/mock-data.js` 的虚拟数据
- `assets/js/api.js` 中 `DATA_MODE = "mock"`

GitHub Pages 发布时请选择：

```text
Branch: main
Folder: /docs
```

发布后，大家可以直接通过 GitHub Pages 打开首页预览。

## 静态页面

- `docs/index.html`：首页总览
- `docs/device.html`：设备管理
- `docs/analysis.html`：水质分析
- `docs/alarm.html`：报警记录
- `docs/settings.html`：参数设置

## 第一版在线指标

第一版在线监测指标为：

- DO，单位 `mg/L`
- pH
- 盐度/EC，单位 `ppt`
- 水温，单位 `℃`
- 水位，单位 `cm`
- ORP，单位 `mV`
- 室温，单位 `℃`

氨氮和亚硝酸盐第一版不采购在线传感器，采用试剂盒人工检测并录入。

## 后端开发版本

仓库中仍保留 `backend/`、`requirements.txt` 等后端开发文件，供后续接入 FastAPI 和 SQLite 使用。GitHub Pages 静态演示版不会运行这些后端代码。
