# MSFS 实时航线图 · SimConnect

在浏览器里用地图查看 **微软模拟飞行（MSFS）** 的飞机实时位置、航迹、计划航路，并带 **PFD / ND 综合显示**。数据通过本机 **SimConnect** 经 Python 桥接服务以 HTTP + SSE 推送给网页，无需单独安装 WebSocket 库。
具体详情看[MSFS 实时航线图介绍](https://yuazhi.cn/?article=221)

## 能做什么

- **实时机位与航迹**：地图上显示飞机图标（随航向旋转）与绿色航迹线。
- **导入计划航线**：支持 FSX / MSFS 导出的 AceXML 格式（`.pln`），在地图上画计划航路与航点；飞行中可查看相对「下一航点」等信息。
- **多种底图**：OSM、Carto Voyager、Esri 街道、OpenTopo、Esri 卫星等（可在页面顶部「底图」下拉框切换，选择会记在浏览器本地）。
- **综合仪表**：页面内嵌 CAPT PFD · ND（空速带、姿态仪、高度带、弧模式导航显示等）；主页说明区若提供链接，可另开 **独立 PFD 演示页**（`pfd-full.html`，需仓库中包含该文件）。
- **局域网多设备**：桥接监听 `0.0.0.0`，同一 Wi-Fi 下用手机、平板浏览器打开电脑的 IP 地址即可看到同一套实时数据；在电脑上导入的航线可通过 `/api/plan` 同步到这些页面。

## 环境要求

- Windows，已安装并运行的 **微软模拟飞行**（SimConnect 可用）。
- **64 位 Python 3.10+**（与 `启动.bat` 提示一致；需加入 PATH）。
- 依赖见 `requirements.txt`（主要为 `SimConnect`）。首次运行前可用 `pip` 安装。

## 快速开始

### 1. 安装依赖

在项目根目录执行：

```bash
python -m pip install -r requirements.txt
```

若使用仓库里的 `启动.bat`，在未检测到 `SimConnect` 时会自动尝试执行上述安装。

### 2. 启动桥接服务

**方式 A（推荐）**：双击 **`启动.bat`**。

**方式 B**：在资源管理器中于本目录打开终端，执行：

```bash
python msfs_bridge.py
```

- 服务默认使用 **HTTP 端口 `8764`**。
- 关闭终端窗口即停止服务。
- 首次启动时，程序可能会根据 `build_runways_cn.py` 与 OurAirports 数据生成或更新 **`runways_compact.json`**（用于前方跑道示意等）；需联网时才会自动下载 CSV。

### 3. 在浏览器中打开

在本机浏览器地址栏输入：

```text
http://127.0.0.1:8764/index.html
```

或直接：

```text
http://127.0.0.1:8764/
```

（具体以控制台打印的路径为准。）

### 4. 手机 / 平板（同一局域网）

1. 确保手机与电脑连接 **同一 Wi-Fi**。
2. 在运行 `msfs_bridge.py` 的窗口中查看打印的 **局域网访问地址**（形如 `http://192.168.x.x:8764/...`）。
3. 在手机浏览器中输入该地址。

若无法访问，请在 **Windows 防火墙** 中为 Python 或端口 **8764** 放行入站规则。

## 页面操作说明

| 操作 | 说明 |
|------|------|
| **底图** | 切换地图瓦片来源。 |
| **导入 .pln 航线** | 选择模拟飞行导出的 `.pln` 文件，在地图上显示计划航路。 |
| **适配航线窗口** | 将地图视野缩放到适应当前计划航线。 |
| **清除计划航线** | 清除已导入的计划航路显示。 |
| **跟随飞机** | 地图随飞机位置移动（多分辨率下会兼顾底部仪表面板占用的区域）。 |
| **说明** | 展开简短提示。 |
| **PFD 面板** | 可收起/展开；内含 ND 的 **PLAN** 模式与缩放等控制。 |

状态栏会显示连接与简要数据说明；若模拟飞行未运行或 SimConnect 暂时不可用，页面会提示错误，但仍可能保留上一次有效的机位与航迹（具体以后端逻辑为准）。

## 开发者：HTTP 接口（摘要）

- **`GET /api/stream`**：Server-Sent Events，持续推送飞机状态与航迹等 JSON。
- **`GET /api/plan`**、`**POST /api/plan`**：读取 / 更新多端共享的计划航线（正文为 JSON，含 `title`、`waypoints` 等；有数量与体积限制，详见 `msfs_bridge.py`）。

前端脚本中对应常量：`STREAM_URL`、`PLAN_SYNC_URL`（默认前缀为 `/api/...`，由同一 HTTP 服务提供静态页与 API）。

## 数据与维护

- **`runways_compact.json`**：由 `build_runways_cn.py` 从 OurAirports 的 `airports.csv`、`runways.csv` 生成（中国区跑道等），供桥接计算前方跑道示意；也可手动运行脚本更新。
- **`nav_llm.env.example`**：若后续接入导航相关 LLM，可复制为 `nav_llm.env` 并填写密钥；**勿将含密钥的文件提交到公开仓库**。

## 许可证与第三方

- 地图瓦片版权归各自提供商（页面内可见 Attribution）。
- 机场数据若使用 OurAirports，请遵循其数据说明：[OurAirports](https://ourairports.com/data/)。


**建议**：不要将 `nav_llm.env`、本地缓存或超大私有数据推送到公开仓库；可在 `.gitignore` 中排除 `nav_llm.env`、`__pycache__/`、`*.pyc` 等。

---

如有问题，请结合运行 `msfs_bridge.py` 时控制台输出的地址与错误信息排查 SimConnect、防火墙与 Python 环境。
