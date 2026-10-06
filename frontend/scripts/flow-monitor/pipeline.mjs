#!/usr/bin/env node
/**
 * 流量监测本地开发流程：把测点数据采集、异常判定、校准申请、恢复在线串成一条可重跑的流程。
 *
 * 用法：
 *   node scripts/flow-monitor/pipeline.mjs run      完整流程（环境检查 → … → 归档与交接清单）
 *   node scripts/flow-monitor/pipeline.mjs prepare  只做准备与校验（npm run build 前自动执行）
 *   node scripts/flow-monitor/pipeline.mjs clean    清理本次运行的中间产物（不动历史归档）
 *
 * 环境变量：
 *   FLOW_MONITOR_PERIOD=YYYY-MM-DD  指定本次监测时段，默认 2026-10-06
 *
 * 约定：
 *   - 样例数据落在 src/data/flow-monitor-seed.json，前端播种和本流程共用；
 *   - 每次运行先清理 dev-data/flow-monitor/current/，重跑不残留上次结果；
 *   - 历史时段只追加不覆盖：早于最新时段的历史时段拒绝重采，归档文件已存在则跳过；
 *   - 校准完成后，关联监测设备从「待校准」恢复「运行中」，监测设备页待校准数量同步变化。
 */
import { buildSampleRows, DEFAULT_PERIOD } from './lib/sample.mjs'
import { judgeRow } from './lib/rules.mjs'
import { isValidDateText, validateRows } from './lib/validate.mjs'
import {
  CURRENT_DIR,
  historyExists,
  historyPath,
  listHistory,
  loadSeed,
  probeWorkRoot,
  resetCurrentDir,
  saveSeed,
  SEED_PATH,
  writeJson,
} from './lib/store.mjs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

class StageError extends Error {
  constructor(stage, message, hint) {
    super(message)
    this.stage = stage
    this.hint = hint
  }
}

const FLOW_KEY = 'flow_monitor'
const DEVICE_KEY = 'monitor_device'

function parsePeriod() {
  const period = (process.env.FLOW_MONITOR_PERIOD || DEFAULT_PERIOD).trim()
  if (!isValidDateText(period)) {
    throw new StageError(
      '环境检查',
      `监测时段「${period}」不是有效的 YYYY-MM-DD 日期`,
      '检查 FLOW_MONITOR_PERIOD 环境变量，例如 FLOW_MONITOR_PERIOD=2026-10-06',
    )
  }
  return period
}

function periodRows(seed, period) {
  return seed[FLOW_KEY].filter((row) => String(row['监测时段']).startsWith(`${period} `))
}

// ---------- 各环节 ----------

function envStage(ctx) {
  const major = Number(process.versions.node.split('.')[0])
  if (major < 18) {
    throw new StageError(
      '环境检查',
      `当前 Node 版本 ${process.version} 过低，流程脚本需要 Node 18 及以上`,
      '先升级 Node，再重新运行本流程',
    )
  }
  try {
    ctx.seed = loadSeed()
  } catch (error) {
    throw new StageError(
      '环境检查',
      `样例数据种子读取失败：${error.message}`,
      '确认 frontend/src/data/flow-monitor-seed.json 存在且是合法 JSON；被改坏时从 git 恢复该文件',
    )
  }
  try {
    probeWorkRoot()
  } catch (error) {
    throw new StageError(
      '环境检查',
      `运行目录不可写：${error.message}`,
      '确认 frontend/dev-data/ 目录权限，或先执行 npm run flow:clean 后重试',
    )
  }
  return [`Node ${process.version}`, `种子数据 ${SEED_PATH.replace(/^.*frontend\//, 'frontend/')} 可读写`]
}

function prepareStage(ctx) {
  const { seed, period } = ctx
  const existing = periodRows(seed, period)
  if (existing.length === 0) {
    const existingPeriods = [
      ...new Set(seed[FLOW_KEY].map((row) => String(row['监测时段']).slice(0, 10))),
    ].sort()
    const latest = existingPeriods[existingPeriods.length - 1]
    if (latest && period < latest) {
      throw new StageError(
        '样例数据准备与校验',
        `时段 ${period} 早于已有历史时段 ${latest}，新增样例会落进历史时段`,
        '历史时段只读；FLOW_MONITOR_PERIOD 请用不早于最新时段的日期',
      )
    }
    const startId = seed[FLOW_KEY].reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    const fresh = buildSampleRows(period, startId)
    seed[FLOW_KEY] = [...seed[FLOW_KEY], ...fresh]
    saveSeed(seed)
    ctx.notes.push(`时段 ${period} 首次准备，新增 ${fresh.length} 条样例`)
  } else {
    ctx.notes.push(`时段 ${period} 已有 ${existing.length} 条样例，保留原样（准备环节不覆盖已有数据）`)
  }
  const deviceCodes = new Set(seed[DEVICE_KEY].map((row) => String(row['设备编号'])))
  const problems = validateRows(seed[FLOW_KEY], deviceCodes)
  if (problems.length > 0) {
    throw new StageError(
      '样例数据准备与校验',
      `校验发现 ${problems.length} 个问题：\n    - ${problems.join('\n    - ')}`,
      '按上面的清单修正 src/data/flow-monitor-seed.json 后重跑；改坏了可以从 git 恢复该文件',
    )
  }
  return ['监测点编号、监测时段、监测指标校验通过']
}

function collectStage(ctx) {
  // 历史时段保护：只允许重采最新时段；早于最新时段的一律拒绝，重跑不能覆盖历史
  const laterPeriods = [
    ...new Set(ctx.seed[FLOW_KEY].map((row) => String(row['监测时段']).slice(0, 10))),
  ]
    .filter((date) => date > ctx.period)
    .sort()
  if (laterPeriods.length > 0) {
    throw new StageError(
      '数据采集',
      `时段 ${ctx.period} 早于已存在的时段（${laterPeriods.join('、')}），属于历史时段，重跑不能覆盖`,
      '历史时段只读；请处理最新时段，或用 FLOW_MONITOR_PERIOD 指定一个更新的时段',
    )
  }
  // 清掉上次运行的中间产物，再重采本时段：重跑不残留
  resetCurrentDir()
  ctx.runStatePath = join(CURRENT_DIR, 'run-state.json')
  ctx.runState = { period: ctx.period, startedAt: new Date().toISOString(), stages: {} }

  const others = ctx.seed[FLOW_KEY].filter(
    (row) => !String(row['监测时段']).startsWith(`${ctx.period} `),
  )
  const startId = others.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const collected = buildSampleRows(ctx.period, startId)
  ctx.seed[FLOW_KEY] = [...others, ...collected]
  saveSeed(ctx.seed)
  ctx.runState.stages.collect = { count: collected.length, ids: collected.map((row) => row.id) }
  return [
    `采集 ${collected.length} 条（${collected.map((row) => row['监测点编号']).join('、')}）`,
    '同时段旧记录已清除重采，历史时段未改动',
  ]
}

function detectStage(ctx) {
  const rows = periodRows(ctx.seed, ctx.period)
  const offline = []
  const abnormal = []
  for (const row of rows) {
    const judged = judgeRow(row)
    row.status = judged.status
    row['数据状态'] = judged['数据状态']
    row.abnormal = judged.abnormal
    row.pending = judged.status !== '已校准'
    if (judged.status === '离线') {
      offline.push(row['监测点编号'])
    }
    if (judged.status === '数据异常') {
      abnormal.push(row['监测点编号'])
    }
  }
  saveSeed(ctx.seed)
  ctx.runState.stages.detect = { offline, abnormal }
  return [
    `离线 ${offline.length} 条${offline.length ? `（${offline.join('、')}）` : ''}`,
    `数据异常 ${abnormal.length} 条${abnormal.length ? `（${abnormal.join('、')}）` : ''}`,
  ]
}

function calibrateStage(ctx) {
  const rows = periodRows(ctx.seed, ctx.period).filter((row) => row.status === '数据异常')
  const pendingBefore = ctx.seed[DEVICE_KEY].filter((row) => row.status === '待校准').length
  const calibrated = []
  const devicesSynced = []
  for (const row of rows) {
    row.status = '已校准'
    row.pending = false
    row.abnormal = false
    row['数据状态'] = '校准完成'
    calibrated.push(row['监测点编号'])
    // 校准完成同步到关联监测设备：待校准 → 运行中，监测设备页待校准数量跟着变
    const device = ctx.seed[DEVICE_KEY].find((item) => item['设备编号'] === row['关联设备编号'])
    if (device && device.status === '待校准') {
      device.status = '运行中'
      device.pending = true
      device.abnormal = false
      device['最近校准'] = ctx.period
      devicesSynced.push(device['设备编号'])
    }
  }
  const pendingAfter = ctx.seed[DEVICE_KEY].filter((row) => row.status === '待校准').length
  saveSeed(ctx.seed)
  ctx.runState.stages.calibrate = { calibrated, devicesSynced, pendingBefore, pendingAfter }
  return [
    `完成校准 ${calibrated.length} 条${calibrated.length ? `（${calibrated.join('、')}）` : ''}`,
    `监测设备待校准数量：${pendingBefore} → ${pendingAfter}（监测设备页同步生效）`,
  ]
}

function restoreStage(ctx) {
  const rows = periodRows(ctx.seed, ctx.period).filter((row) =>
    ['已校准', '离线'].includes(row.status),
  )
  for (const row of rows) {
    row.status = '在线'
    row.pending = true
    row.abnormal = false
    row['数据状态'] = '已恢复在线'
  }
  saveSeed(ctx.seed)
  ctx.runState.stages.restore = { restored: rows.map((row) => row['监测点编号']) }
  return [`恢复在线 ${rows.length} 条${rows.length ? `（${rows.map((row) => row['监测点编号']).join('、')}）` : ''}`]
}

function archiveStage(ctx) {
  const rows = periodRows(ctx.seed, ctx.period)
  let archiveNote
  if (historyExists(ctx.period)) {
    archiveNote = `历史归档 ${ctx.period}.json 已存在，按约定不覆盖`
  } else {
    writeJson(historyPath(ctx.period), {
      period: ctx.period,
      archivedAt: new Date().toISOString(),
      rows,
      runState: ctx.runState,
    })
    archiveNote = `归档 dev-data/flow-monitor/history/${ctx.period}.json`
  }
  const handoverPath = join(CURRENT_DIR, 'handover.md')
  writeFileSync(handoverPath, buildHandover(ctx), 'utf8')
  return [archiveNote, '交接清单 dev-data/flow-monitor/current/handover.md']
}

// ---------- 交接清单 ----------

function buildHandover(ctx) {
  const { period, runState } = ctx
  const detect = runState.stages.detect ?? { offline: [], abnormal: [] }
  const calibrate = runState.stages.calibrate ?? { calibrated: [], devicesSynced: [], pendingBefore: 0, pendingAfter: 0 }
  const rowsOf = (codes) =>
    periodRows(ctx.seed, period).filter((row) => codes.includes(row['监测点编号']))
  const linesOf = (rows, result) =>
    rows.length
      ? rows.map(
          (row) =>
            `| ${row['监测点编号']} | ${row['监测点位']} | ${row['监测时段']} | ${row['关联设备编号']} | ${result} |`,
        )
      : ['| — | — | — | — | 无 |']
  const historyPeriods = [
    ...new Set(
      ctx.seed[FLOW_KEY].map((row) => String(row['监测时段']).slice(0, 10)),
    ),
  ]
    .filter((item) => item !== period)
    .sort()
  return `# 流量监测交接清单（时段 ${period}）

- 生成时间：${new Date().toISOString()}
- 流程：数据采集 → 异常判定 → 校准申请 → 恢复在线（本地自动流程，重跑不覆盖历史时段）

## 离线测点（${detect.offline.length}）

| 监测点编号 | 监测点位 | 监测时段 | 关联设备 | 处理结果 |
| --- | --- | --- | --- | --- |
${linesOf(rowsOf(detect.offline), '已恢复在线').join('\n')}

## 数据异常测点（${detect.abnormal.length}）

| 监测点编号 | 监测点位 | 监测时段 | 关联设备 | 处理结果 |
| --- | --- | --- | --- | --- |
${linesOf(rowsOf(detect.abnormal), '已校准并恢复在线').join('\n')}

## 已校准记录（${calibrate.calibrated.length}）

${
  calibrate.calibrated.length
    ? calibrate.calibrated
        .map((code, index) => `- ${code}｜关联设备 ${calibrate.devicesSynced[index] ?? '—'}｜校准完成`)
        .join('\n')
    : '- 无'
}

## 监测设备待校准同步

- 校准前待校准设备：${calibrate.pendingBefore} 台
- 校准后待校准设备：${calibrate.pendingAfter} 台（监测设备页待校准数量同步变化）

## 历史时段保护

- 种子数据中的历史时段：${historyPeriods.length ? historyPeriods.join('、') : '无'}（本次流程未改动）
- 已归档历史：${listHistory().join('、') || '无'}（归档文件只追加、不覆盖）
`
}

// ---------- 流程编排 ----------

const STAGES = [
  ['环境检查', envStage],
  ['样例数据准备与校验', prepareStage],
  ['数据采集', collectStage],
  ['异常判定', detectStage],
  ['校准申请', calibrateStage],
  ['恢复在线', restoreStage],
  ['归档与交接清单', archiveStage],
]

function reportFailure(stage, index, total, error) {
  const stageError =
    error instanceof StageError
      ? error
      : new StageError(stage, error.message, '根据上面原因修复后重跑；重跑会自动清理本次中间产物')
  console.error(`[${index}/${total}] ${stage} ✗`)
  console.error('')
  console.error(`✗ 流程卡在「${stageError.stage}」环节（第 ${index}/${total} 步）`)
  console.error(`  原因：${stageError.message}`)
  console.error(`  建议：${stageError.hint}`)
  console.error(
    '  说明：本次运行的中间产物在 frontend/dev-data/flow-monitor/current/，修复后直接重跑即可，不会残留上次结果；历史时段归档不受影响。',
  )
}

function runStages(command) {
  const upto = command === 'prepare' ? 2 : STAGES.length
  const selected = STAGES.slice(0, upto)
  let period
  try {
    period = parsePeriod()
  } catch (error) {
    reportFailure('环境检查', 1, selected.length, error)
    process.exit(1)
  }
  const ctx = { period, notes: [], runState: null, runStatePath: null, seed: null }
  console.log(`流量监测本地流程｜时段 ${ctx.period}｜${command === 'prepare' ? '准备与校验' : '完整流程'}`)
  for (const [index, [name, fn]] of selected.entries()) {
    try {
      const notes = fn(ctx) ?? []
      console.log(`[${index + 1}/${selected.length}] ${name} ✔`)
      for (const note of [...ctx.notes.splice(0), ...notes]) {
        console.log(`    ${note}`)
      }
      if (ctx.runStatePath && ctx.runState) {
        writeJson(ctx.runStatePath, ctx.runState)
      }
    } catch (error) {
      reportFailure(name, index + 1, selected.length, error)
      process.exit(1)
    }
  }
  console.log(`流程完成：${selected.length}/${selected.length} 个环节全部通过`)
}

function clean() {
  resetCurrentDir()
  console.log('已清理 frontend/dev-data/flow-monitor/current/（本次运行的中间产物）')
  const history = listHistory()
  console.log(`历史归档保留不动：${history.length ? history.join('、') : '（暂无归档）'}`)
}

const command = process.argv[2] ?? 'run'
if (command === 'run' || command === 'prepare') {
  runStages(command)
} else if (command === 'clean') {
  clean()
} else {
  console.error(`未知命令「${command}」，可用：run / prepare / clean`)
  process.exit(1)
}
