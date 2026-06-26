# 金梦湾渔业水质在线监测平台

这是一个前后端分离的水质监测后台 V0.3。当前阶段不直接连接 PLC、昆仑触摸屏、RS485 或真实传感器，后端使用 FastAPI + SQLite 生成动态模拟 PLC 数据；前端通过统一 API 层读取数据。

## GitHub Pages 静态预览

GitHub Pages 发布目录使用 `docs/`。`docs/` 已同步 V0.3 前端页面，并且在静态站点环境下自动使用 mock 数据，不会请求 `127.0.0.1:8000` 或 `/api` 后端接口。

发布设置建议选择：

```text
Branch: main
Folder: /docs
```

## 已实现

- JWT 登录与登录状态校验
- 管理员、操作员、只读用户角色
- 多用户、多养殖场、多水池
- 水池新增、编辑、排序、启停和软删除
- 每个水池独立配置传感器、RS485 地址、寄存器、数据类型和报警阈值
- 首页、实时监测、历史曲线、报警记录、参数设置、设备状态按配置动态渲染
- 普通用户只能访问 `user_farms` 绑定的养殖场
- 管理员可查看全部养殖场
- 投喂计划、视频监控和 PLC/网关数据上报接口预留
- 适配电脑和手机浏览器的蓝色工业风界面

## 目录

```text
backend/
  main.py                 FastAPI、JWT、SQLite、权限和 mock 数据
frontend/
  login.html              登录页
  index.html              首页总览
  monitoring.html         水质实时监测
  analysis.html           历史曲线
  alarm.html              报警记录
  settings.html           参数设置
  device.html             设备状态
  feeding.html            投喂预留
  camera.html             视频监控预留
  management.html         用户/养殖场管理
  assets/js/api.js        统一数据接口层
  assets/js/app.js        页面渲染逻辑
docs/                     GitHub Pages 静态演示版
data/jinmengwan.db        启动后自动创建的开发数据库
```

## 本地后端启动

在项目根目录执行：

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
```

浏览器访问：

```text
http://127.0.0.1:8000
```

## 演示账号

| 账号 | 密码 | 权限 |
| --- | --- | --- |
| `admin` | `Admin123!` | 管理员，可查看全部养殖场 |
| `operator1` | `Demo123!` | 仅可查看一号养殖场 |
| `operator2` | `Demo123!` | 仅可查看二号养殖场 |

生产部署前必须通过环境变量设置新的 `JWT_SECRET`，并修改演示账号密码。

## 默认传感器类型

默认每个水池启用：DO、水温、pH、ORP、水位。

盐度为可选在线类型；氨氮和亚硝酸盐为预留类型，默认禁用，可作为后期人工检测或扩展接入。

## 真实 PLC 接入预留

预留入口：

```http
POST /api/gateway/ingest
X-Gateway-Token: jmw-demo-gateway-token
Content-Type: application/json
```

请求体按水池批量提交传感器读数：

```text
farm_id, pond_id,
readings: [{ sensor_id, value, status, timestamp }]
```

真实接入时建议由 PLC 将数据上传到现场网关或小主机，再由网关调用该 HTTPS 接口。前端无需直接连接 PLC，只要真实数据继续写入 `sensor_readings`，现有首页、实时监测和历史曲线 API 可以保持不变。

## 主要 API

- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET/POST/PUT/DELETE /api/farms`
- `GET/POST /api/farms/{farm_id}/ponds`
- `PUT/DELETE /api/ponds/{pond_id}`
- `GET/POST /api/ponds/{pond_id}/sensors`
- `PUT/DELETE /api/sensors/{sensor_id}`
- `GET /api/farms/{farm_id}/realtime`
- `GET /api/ponds/{pond_id}/realtime`
- `GET /api/sensors/{sensor_id}/history`
- `GET /api/farms/{farm_id}/alarms`
- `PUT /api/alarms/{alarm_id}/confirm`
- `GET /api/dashboard`
- `GET/POST /api/feeding/plans`
- `GET /api/cameras`
- `POST /api/gateway/ingest`
- `GET/POST /api/admin/users`

接口文档：`http://127.0.0.1:8000/docs`
