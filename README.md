# 金梦湾渔业水质在线监测平台

这是一个前后端分离思路的水质监测后台 V0.2。第一阶段不连接 PLC、昆仑触摸屏、RS485 或真实传感器，由 FastAPI 向 SQLite 写入模拟 PLC 数据，前端始终通过 API 读取。

## 已实现

- JWT 登录与登录状态校验
- 管理员、操作员、只读用户角色基础结构
- 多用户、多养殖场、多池塘
- 普通用户只能访问 `user_farms` 中绑定的养殖场
- 管理员可查看全部养殖场
- 首页总览、实时监测、历史曲线、报警记录
- 参数设置、设备状态、投喂计划
- 视频监控接口与页面预留
- 用户和养殖场管理
- PLC/网关数据上报接口预留
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
  feeding.html            投喂计划
  camera.html             视频监控预留
  management.html         用户/养殖场管理
  assets/js/api.js        前端统一 API 层
  assets/js/app.js        页面壳层与业务渲染
data/jinmengwan.db        启动后自动创建的开发数据库
docs/                     原 GitHub Pages 静态演示版
```

## 启动

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

生产环境部署前必须通过环境变量设置新的 `JWT_SECRET`，并修改演示账号密码。

## 数据表

核心业务表为：

- `users`
- `farms`
- `ponds`
- `devices`
- `sensor_readings`
- `alarm_logs`
- `thresholds`
- `feed_plans`
- `user_farms`

开发数据库为空时，后端会自动创建两个养殖场、池塘、设备、24 小时水质曲线、报警和投喂计划。

## 接入真实 PLC

预留入口：

```http
POST /api/gateway/ingest
X-Gateway-Token: jmw-demo-gateway-token
Content-Type: application/json
```

请求字段包括：

```text
farm_id, pond_id, device_id, do_value, water_temp, ph_value,
orp_value, water_level, salinity, room_temp, system_status,
alarm_status, communication_status, timestamp
```

真实接入时建议由 PLC 将数据上传到现场网关或小主机，再由网关调用该 HTTPS 接口。生产环境需要为每台网关分配独立密钥，并增加重放保护、离线缓存、设备签名和上报日志。

前端无需直接连接 PLC。只要真实数据继续写入 `sensor_readings`，现有首页、实时监测和历史曲线 API 都可以保持不变。

## 主要 API

- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/farms`
- `GET /api/ponds`
- `GET /api/dashboard`
- `GET /api/latest`
- `GET /api/history`
- `GET /api/alarms`
- `POST /api/alarms/{id}/handle`
- `GET/POST /api/settings`
- `GET /api/sensors`
- `GET/POST /api/feeding/plans`
- `GET /api/cameras`
- `POST /api/gateway/ingest`
- `GET/POST /api/admin/users`
- `POST /api/admin/farms`

接口文档：`http://127.0.0.1:8000/docs`
