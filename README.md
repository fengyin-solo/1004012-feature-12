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
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
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

生产构建（构建前会自动准备并校验流量监测样例数据，见下一节）：

```bash
cd frontend
npm run build
```

## 流量监测本地流程

流量监测点的离线、数据异常、已校准记录不再靠人工整理：`frontend/scripts/flow-monitor/pipeline.mjs`
把**数据采集 → 异常判定 → 校准申请 → 恢复在线**串成一条可重跑的本地流程，跑完自动生成交接清单。

```bash
cd frontend
npm run flow:run       # 完整流程：环境检查 → 准备校验 → 采集 → 判定 → 校准 → 恢复 → 归档交接
npm run flow:prepare   # 只做环境检查 + 样例数据准备与校验（npm run build 前会自动执行这一步）
npm run flow:clean     # 清理本次运行的中间产物（不动历史归档）
```

也可以用 `make flow` / `make flow-prepare` / `make flow-clean`。

流程环节与环境检查：

1. **环境检查**：Node ≥ 18、样例种子可读写、运行目录可写；`FLOW_MONITOR_PERIOD` 非法也在这里报。
2. **样例数据准备与校验**：为当前时段（默认 `2026-10-06`，用 `FLOW_MONITOR_PERIOD=YYYY-MM-DD` 指定）
   准备确定性样例，并校验监测点编号（`FLOW-0000` 格式、编号+时段唯一）、监测时段
   （`YYYY-MM-DD HH:MM-HH:MM`、起止合理）、监测指标（数值且在量程内）、关联设备存在于台账。
3. **数据采集**：清理上次运行的中间产物后重采当前时段，重跑不残留。
4. **异常判定**：指标缺数判离线，瞬时流量 > 80 或流速 > 5 判数据异常。
5. **校准申请**：异常测点完成校准，关联监测设备同步从「待校准」恢复「运行中」，
   监测设备页的待校准数量跟着变化。
6. **恢复在线**：已校准、离线的测点恢复在线。
7. **归档与交接清单**：当前时段归档到 `frontend/dev-data/flow-monitor/history/<时段>.json`，
   交接清单（离线/异常/已校准分类汇总）写到 `frontend/dev-data/flow-monitor/current/handover.md`。

约定：

- **失败定位**：任一环节失败都会打印「流程卡在哪个环节、原因、修复建议」，退出码为 1，
  构建会因此中止；修好后直接重跑即可。
- **重跑不残留**：每次运行先清理 `dev-data/flow-monitor/current/` 再重采当前时段，确定性样例
  保证重跑结果一致。
- **历史时段不被覆盖**：早于最新时段的历史时段拒绝重采；归档文件已存在则跳过；种子里其他
  时段的行不会被改动。
- **设备同步**：页面上对流量监测点执行「申请校准」也会联动更新关联监测设备，和流程脚本同一口径。
- 流程产物 `frontend/dev-data/` 不进 git；样例种子 `frontend/src/data/flow-monitor-seed.json`
  进 git，流程跑出的状态变化可以直接 review 后提交。

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
| 流量监测 | `flow_monitor` | 流量监测点 | 监测点编号、监测点位、监测时段、关联设备编号 |
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
  `frontend/src/data/seed.ts`，其中流量监测、监测设备两个模块由
  `frontend/src/data/flow-monitor-seed.json` 提供（流量监测本地流程维护）。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `underground-pipeline-inspection:entries` 这一项，或调用 `resetModule(模块)`。
