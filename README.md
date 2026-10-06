# 城市地下管网巡检养护管理系统

面向城市地下管线登记建档、巡检任务、缺陷记录、外出维修、修复验收与设施档案全流程的地下管网巡检养护管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/api/flow-service.ts   流量测点状态机：采集、异常判定、校准与设备联动
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/generated/        流水线产物（gitignore，构建前自动生成）
│   ├── flow-samples/         流量监测样例输入（合法样例 + 用于演练失败的非法样例）
│   └── scripts/flow-pipeline.mjs  构建前自动运行的五环节本地流水线
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

`npm run dev` / `npm run build` 会先通过 `predev` / `prebuild` 钩子自动跑**流量监测本地流水线**（见下节），
样例数据没准备好或校验不过时，dev/build 直接中断。

## 流量监测本地流水线

把「测点数据采集 → 异常判定 → 校准申请 → 恢复在线」串成一条本地开发流程，
脚本在 `frontend/scripts/flow-pipeline.mjs`（纯 Node、零依赖），按五个环境环节顺序执行：

| 环节 | 作用 | 失败表现 |
| --- | --- | --- |
| `[1/5] 环境检查` | Node 版本 ≥ 18、`src/` 目录、样例文件在位、工作目录可写；清空上次暂存目录 | 卡在环境检查并给出修复提示 |
| `[2/5] 样例准备` | 读取并解析 `flow-samples/flow-monitor.samples.json`，写入暂存目录 | JSON 损坏时中断在样例准备 |
| `[3/5] 数据校验` | 校验监测点编号（`FLOW-0000` 格式/不重复/绑定设备存在）、监测时段（日期格式、开始早于结束、历史早于本期）、四项指标（齐全、数值、在合法范围内） | 逐条列出问题并中断在数据校验 |
| `[4/5] 异常判定` | 未上报判**离线**；指标越过 `thresholds` 业务阈值判**数据异常**；其余在线 | 阈值定义缺失/越界时中断 |
| `[5/5] 校准联动与发布` | 合并 append-only 历史台账，原子发布 `src/generated/flow-monitor.seed.json` | — |

- 每次运行都**重建暂存目录** `.flow-pipeline/staging`，失败时整体删除，修好重跑不残留上次结果；
  产物先写临时文件再 `rename`，不会留下半个 `flow-monitor.seed.json`。
- **历史时段数据不能被重跑覆盖**：历史台账 `.flow-pipeline/flow-readings.history.jsonl` 以
  「监测点编号 + 时段」为主键，已有时段只追加、永不覆盖；只有本期时段会随重跑刷新。
- 应用侧历史读数独立存于 localStorage（`…:flow-readings`），同一「测点+时段」重复采集会被拒绝。

手动运行：

```bash
cd frontend
npm run flow:pipeline                                   # 用默认样例重跑
node scripts/flow-pipeline.mjs --period=2026-10-06      # 指定本期监测时段
node scripts/flow-pipeline.mjs --sample=flow-samples/flow-monitor.invalid.json  # 演练失败阻断
npm run flow:reset                                      # 清空本地产物与历史台账后重跑
node scripts/verify-flow.mjs                            # 全流程逻辑校验（采集/判定/校准/联动/历史不覆盖）
```

或在仓库根目录用 `make flow-pipeline`。

### 校准联动

流量测点状态机为：在线/离线/数据异常 `--申请校准-->` 待校准 `--完成校准-->` 已校准
`--恢复在线-->` 在线；动作合法性集中在 `frontend/src/api/flow-service.ts`，页面只按
`availableFlowActions(status)` 渲染按钮。

- 流量测点「申请校准」时，其「关联设备」同步变为**待校准**，监测设备页顶部「待校准设备」数量 **+1**；
- 「完成校准」后设备回到**运行中**、待校准数量 **-1**，并把该测点监测时段记入设备「最近校准」；
- 监测设备页每次加载都读最新存储，跨页联动立即可见（可在两页之间切换验证）。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 管线登记 | `pipeline` | 管线 | 管线编号、管线类型、起点位置 |
| 巡检任务 | `inspection` | 巡检任务 | 任务编号、巡检区域、巡检人员 |
| 缺陷记录 | `defect` | 缺陷记录 | 缺陷编号、所属管线、缺陷类型 |
| 外出维修 | `out_repair` | 外出维修 | 派遣编号、缺陷来源、维修人员 |
| 维修验收 | `repair_accept` | 维修验收记录 | 验收编号、关联维修、验收人员 |
| 管道检测 | `pipe_detect` | 检测记录 | 检测编号、检测管段、检测方式 |
| 井盖设施 | `manhole` | 井盖设施 | 井盖编号、所属道路、井盖类型 |
| 泵站运行 | `pump_station` | 泵站 | 泵站编号、泵站名称、所在区域 |
| 排水管网 | `drain_network` | 排水管段 | 管段编号、上游节点、下游节点 |
| 水质监测 | `water_quality` | 水质监测记录 | 监测编号、取样点位、取样日期 |
| 流量监测 | `flow_monitor` | 流量监测点 | 监测点编号、监测点位、监测时段 |
| 应急事件 | `emergency` | 应急事件 | 事件编号、事件类型、事发地点 |
| 漏水检测 | `leak_detect` | 漏水检测记录 | 检测编号、检测管段、检测方法 |
| 非开挖修复 | `trenchless` | 非开挖修复记录 | 修复编号、修复管段、修复工艺 |
| 管道清洗 | `pipe_cleaning` | 管道清洗记录 | 清洗编号、清洗管段、清洗方式 |
| 设施档案 | `facility_archive` | 设施档案 | 档案编号、设施名称、设施类别 |
| 监测设备 | `monitor_device` | 监测设备 | 设备编号、设备类型、安装位置 |
| 施工队伍 | `contractor` | 施工队伍 | 队伍编号、队伍名称、资质等级 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `underground-pipeline-inspection:entries` 这一项，或调用 `resetModule(模块)`。
