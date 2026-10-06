#!/usr/bin/env node
/**
 * 流量监测本地流水线（纯 Node、零依赖）：
 *   [1/5] 环境检查 -> [2/5] 样例准备 -> [3/5] 数据校验 -> [4/5] 异常判定 -> [5/5] 校准联动与发布
 *
 * 每次运行都重建暂存目录，产物原子替换；历史台账只追加不覆盖。
 * 任意环节失败都会明确打印卡在哪个环境环节，退出码非 0（构建随之中断）。
 *
 * 用法：
 *   node scripts/flow-pipeline.mjs                  # 用默认样例，时段取样例 period
 *   node scripts/flow-pipeline.mjs --period=YYYY-MM-DD
 *   node scripts/flow-pipeline.mjs --sample=flow-samples/xxx.json
 *   node scripts/flow-pipeline.mjs --reset         # 清空本地产物与历史台账后重跑
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SAMPLE = join(ROOT, 'flow-samples', 'flow-monitor.samples.json')
const RUNTIME_DIR = join(ROOT, '.flow-pipeline')
const STAGE_DIR = join(RUNTIME_DIR, 'staging')
const LEDGER_FILE = join(RUNTIME_DIR, 'flow-readings.history.jsonl')
const OUT_DIR = join(ROOT, 'src', 'generated')
const OUT_FILE = join(OUT_DIR, 'flow-monitor.seed.json')
const METRIC_NAMES = ['瞬时流量', '累计流量', '水位标高', '流速']
const SCHEMA_VERSION = 1

const args = process.argv.slice(2)
const argPeriod = args.find((a) => a.startsWith('--period='))?.split('=')[1]
const argSample = args.find((a) => a.startsWith('--sample='))?.split('=')[1]
const shouldReset = args.includes('--reset')
const SAMPLE_FILE = argSample ? resolve(ROOT, argSample) : DEFAULT_SAMPLE

function info(message) {
  console.log(message)
}
function fail(stage, message, detail) {
  console.error(`\n✗ [${stage}] 失败：${message}`)
  if (detail && detail.length) {
    for (const line of detail) {
      console.error(`    - ${line}`)
    }
  }
  // 任何环节失败都整体删掉暂存目录（包括空目录），保证重跑不残留上次结果。
  rmSync(STAGE_DIR, { recursive: true, force: true })
  console.error(`    已清理暂存目录 ${STAGE_DIR}，修复后重跑不会残留上次结果。\n`)
  process.exit(1)
}

// ── [1/5] 环境检查：确认 Node 版本、目录可写、样例文件在位 ──────────────────
function stageEnv() {
  const stage = '1/5 环境检查'
  info(`\n[${stage}] 检查运行环境…`)
  const major = Number(process.versions.node.split('.')[0])
  if (major < 18) {
    fail(stage, `Node 版本过低（当前 ${process.versions.node}），需要 Node 18 及以上`)
  }
  if (!existsSync(join(ROOT, 'src'))) {
    fail(stage, `缺少 src/ 目录，当前工作目录可能不对：${ROOT}`)
  }
  if (!existsSync(SAMPLE_FILE)) {
    fail(stage, `找不到样例数据文件：${SAMPLE_FILE}`, [
      '检查 --sample 参数，或恢复 flow-samples/flow-monitor.samples.json',
    ])
  }
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true })
    rmSync(STAGE_DIR, { recursive: true, force: true })
    if (shouldReset) {
      rmSync(LEDGER_FILE, { force: true })
      rmSync(OUT_FILE, { force: true })
      info(`    --reset：已清空历史台账与已发布产物`)
    }
    mkdirSync(STAGE_DIR, { recursive: true })
  } catch (error) {
    fail(stage, `工作目录不可写：${error instanceof Error ? error.message : String(error)}`)
  }
  info(`    Node ${process.versions.node}，样例 ${SAMPLE_FILE}`)
}

// ── [2/5] 样例准备：读入样例并解析，暂存到 staging ──────────────────────────
function stagePrepare() {
  const stage = '2/5 样例准备'
  info(`[${stage}] 准备样例数据…`)
  let parsed
  try {
    const raw = readFileSync(SAMPLE_FILE, 'utf-8')
    parsed = JSON.parse(raw)
  } catch (error) {
    fail(stage, `样例文件读取或解析失败：${error instanceof Error ? error.message : String(error)}`, [
      `样例文件：${SAMPLE_FILE}`,
      '修正 JSON 格式后重跑',
    ])
  }
  if (argPeriod) {
    parsed.period = argPeriod
    info(`    --period 覆盖监测时段为 ${argPeriod}`)
  }
  writeFileSync(join(STAGE_DIR, 'samples.parsed.json'), `${JSON.stringify(parsed, null, 2)}\n`)
  return parsed
}

// ── [3/5] 数据校验：监测点编号、监测时段、指标三项逐一检查 ───────────────────
function assertDate(value, errors, where) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    errors.push(`${where}：时段「${value}」应为 YYYY-MM-DD 格式`)
    return false
  }
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) {
    errors.push(`${where}：时段「${value}」不是有效日期`)
    return false
  }
  return true
}

function validateReading(reading, metricDefs, errors, where) {
  const keys = Object.keys(reading)
  for (const name of METRIC_NAMES) {
    if (!keys.includes(name)) {
      errors.push(`${where}：缺少指标「${name}」`)
      continue
    }
    const raw = reading[name]
    if (typeof raw !== 'number' || Number.isNaN(raw)) {
      errors.push(`${where}：指标「${name}」必须是数值，当前为「${raw}」`)
      continue
    }
    const def = metricDefs[name]
    if (!def) {
      // 指标定义缺失属于全局问题，在指标定义环节统一报一次，这里不逐行重复。
      continue
    }
    if (raw < def.min || raw > def.max) {
      errors.push(`${where}：指标「${name}」=${raw} 超出有效范围 [${def.min}, ${def.max}]${def.unit ? ` ${def.unit}` : ''}`)
    }
  }
  if (keys.length !== METRIC_NAMES.length) {
    for (const key of keys) {
      if (!METRIC_NAMES.includes(key)) {
        errors.push(`${where}：出现未登记的指标「${key}」`)
      }
    }
  }
}

function stageValidate(samples) {
  const stage = '3/5 数据校验'
  info(`[${stage}] 校验监测点编号、监测时段与指标…`)
  const errors = []
  const period = String(samples.period ?? '')
  const wherePeriod = '监测时段'
  const periodValid = assertDate(period, errors, wherePeriod)

  if (typeof samples.rangeStart !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(samples.rangeStart)) {
    errors.push(`监测时段：rangeStart「${samples.rangeStart}」应为 YYYY-MM-DD HH:mm 格式`)
  }
  if (typeof samples.rangeEnd !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(samples.rangeEnd)) {
    errors.push(`监测时段：rangeEnd「${samples.rangeEnd}」应为 YYYY-MM-DD HH:mm 格式`)
  } else if (typeof samples.rangeStart === 'string' && samples.rangeEnd <= samples.rangeStart) {
    errors.push(`监测时段：结束 ${samples.rangeEnd} 必须晚于开始 ${samples.rangeStart}`)
  }

  const metricDefs = samples.metrics
  if (!metricDefs || typeof metricDefs !== 'object') {
    fail(stage, '样例缺少 metrics 指标定义', ['在样例文件补充瞬时流量/累计流量/水位标高/流速的量纲与范围'])
  }
  for (const name of METRIC_NAMES) {
    const def = metricDefs[name]
    if (!def || typeof def.min !== 'number' || typeof def.max !== 'number' || def.min > def.max) {
      errors.push(`指标定义：「${name}」缺少合法的 min/max 有效范围`)
    }
  }

  const devices = Array.isArray(samples.devices) ? samples.devices : []
  if (!Array.isArray(samples.devices)) {
    errors.push('监测设备：devices 应为数组')
  }
  const deviceCodes = new Set()
  for (const device of devices) {
    const where = `设备 ${device.code ?? '?'}`
    if (typeof device.code !== 'string' || !/^[A-Z]+-[A-Z0-9]+$/.test(device.code)) {
      errors.push(`${where}：设备编号格式不合法，应为 前缀-序号（如 MONI-F001）`)
    } else if (deviceCodes.has(device.code)) {
      errors.push(`${where}：设备编号重复`)
    }
    deviceCodes.add(device.code)
    if (!device.location || String(device.location).trim() === '') {
      errors.push(`${where}：安装位置不能为空`)
    }
  }

  const points = Array.isArray(samples.points) ? samples.points : []
  if (!Array.isArray(samples.points)) {
    errors.push('流量监测点：points 应为数组')
  }
  const pointCodes = new Set()
  for (const point of points) {
    const where = `监测点 ${point.code ?? '?'}`
    if (typeof point.code !== 'string' || !/^FLOW-\d{4}$/.test(point.code)) {
      errors.push(`${where}：监测点编号格式不合法，应为 FLOW-0001 这样的编号`)
    } else if (pointCodes.has(point.code)) {
      errors.push(`${where}：监测点编号重复`)
    }
    pointCodes.add(point.code)
    if (!deviceCodes.has(point.deviceCode)) {
      errors.push(`${where}：绑定的设备编号「${point.deviceCode}」在设备清单中不存在`)
    }
    if (point.reported) {
      if (!point.values || typeof point.values !== 'object') {
        errors.push(`${where}：标记已上报但缺少 readings 指标数据`)
      } else {
        validateReading(point.values, metricDefs, errors, where)
      }
    } else if (point.values !== null && point.values !== undefined) {
      errors.push(`${where}：未上报测点的指标数据应为 null`)
    }
  }

  const seenHistory = new Set()
  const history = Array.isArray(samples.history) ? samples.history : []
  if (!Array.isArray(samples.history)) {
    errors.push('历史时段：history 应为数组')
  }
  for (const row of history) {
    const where = `历史记录 ${row.pointCode ?? '?'}/${row.period ?? '?'}`
    if (!pointCodes.has(row.pointCode)) {
      errors.push(`${where}：监测点编号在本期测点清单中不存在`)
    }
    if (assertDate(row.period, errors, where)) {
      if (periodValid && row.period >= period) {
        errors.push(`${where}：历史时段 ${row.period} 必须早于本期时段 ${period}`)
      }
    }
    if (typeof row.rangeStart !== 'string' || typeof row.rangeEnd !== 'string' || row.rangeEnd <= row.rangeStart) {
      errors.push(`${where}：时段开始/结束时间缺失或结束早于开始`)
    }
    const key = `${row.pointCode}|${row.period}`
    if (seenHistory.has(key)) {
      errors.push(`${where}：同一测点同一时段重复`)
    }
    seenHistory.add(key)
    if (row.values !== null && row.values !== undefined) {
      validateReading(row.values, metricDefs, errors, where)
    }
  }

  if (errors.length) {
    fail(stage, `共发现 ${errors.length} 个数据问题，已阻断在数据校验环节`, errors)
  }
  info(`    ${points.length} 个测点、${devices.length} 台设备、${history.length} 条历史记录，校验通过`)
}

// ── [4/5] 异常判定：未上报=离线，指标越业务阈值=数据异常 ──────────────────────
function judgePoint(point, thresholds) {
  if (!point.reported) {
    return { status: '离线', reasons: ['监测时段内无数据上报'], abnormal: true }
  }
  const reasons = []
  for (const name of METRIC_NAMES) {
    const bound = thresholds?.[name]
    const value = point.values[name]
    if (!bound) {
      reasons.push(`${name}=${value} 未配置业务阈值，无法判定`)
      continue
    }
    if (typeof bound.warnMin === 'number' && value < bound.warnMin) {
      reasons.push(`${name}=${value} 低于业务下限 ${bound.warnMin}`)
    }
    if (typeof bound.warnMax === 'number' && value > bound.warnMax) {
      reasons.push(`${name}=${value} 超过业务上限 ${bound.warnMax}`)
    }
  }
  if (reasons.length) {
    return { status: '数据异常', reasons, abnormal: true }
  }
  return { status: '在线', reasons: [], abnormal: false }
}

function stageJudge(samples) {
  const stage = '4/5 异常判定'
  info(`[${stage}] 判定离线 / 数据异常…`)
  if (!samples.thresholds || typeof samples.thresholds !== 'object') {
    fail(stage, '样例缺少 thresholds 业务阈值定义', ['在样例文件补充四项指标的 warnMin/warnMax，用于异常判定'])
  }
  for (const name of METRIC_NAMES) {
    const bound = samples.thresholds[name]
    const def = samples.metrics[name]
    if (!bound || typeof bound.warnMin !== 'number' || typeof bound.warnMax !== 'number') {
      fail(stage, `业务阈值「${name}」缺少合法的 warnMin/warnMax`)
    }
    if (bound.warnMin < def.min || bound.warnMax > def.max) {
      fail(stage, `业务阈值「${name}」超出合法量值范围 [${def.min}, ${def.max}]`)
    }
  }
  const judged = samples.points.map((point) => ({
    code: point.code,
    name: point.name,
    deviceCode: point.deviceCode,
    reported: point.reported,
    values: point.reported ? point.values : null,
    judge: judgePoint(point, samples.thresholds),
  }))
  const offline = judged.filter((item) => item.judge.status === '离线')
  const abnormal = judged.filter((item) => item.judge.status === '数据异常')
  const online = judged.filter((item) => item.judge.status === '在线')
  for (const item of judged) {
    info(`    ${item.code} -> ${item.judge.status}${item.judge.reasons.length ? `（${item.judge.reasons.join('；')}）` : ''}`)
  }
  writeFileSync(join(STAGE_DIR, 'judged.json'), `${JSON.stringify(judged, null, 2)}\n`)
  info(`    在线 ${online.length}，离线 ${offline.length}，数据异常 ${abnormal.length}`)
  return judged
}

// ── [5/5] 校准联动与发布：合并 append-only 台账，原子发布产物 ─────────────────
function loadLedger() {
  if (!existsSync(LEDGER_FILE)) {
    return new Map()
  }
  const map = new Map()
  const lines = readFileSync(LEDGER_FILE, 'utf-8').split('\n').filter((line) => line.trim())
  for (const line of lines) {
    const row = JSON.parse(line)
    map.set(`${row.pointCode}|${row.period}`, row)
  }
  return map
}

function stagePublish(samples, judged) {
  const stage = '5/5 校准联动与发布'
  info(`[${stage}] 合并历史台账并发布样例产物…`)
  const ledger = loadLedger()
  let backfilled = 0
  // 历史台账只追加：样例自带的历史记录只在缺失时补齐，已有时段永不覆盖。
  for (const row of samples.history) {
    const key = `${row.pointCode}|${row.period}`
    if (!ledger.has(key)) {
      ledger.set(key, { ...row, source: 'sample' })
      backfilled += 1
    }
  }
  for (const item of judged) {
    const key = `${item.code}|${samples.period}`
    // 本期时段允许随重跑刷新（它不是历史时段）；台账里若已存在本期记录只替换该单条。
    ledger.set(key, {
      pointCode: item.code,
      period: samples.period,
      rangeStart: samples.rangeStart,
      rangeEnd: samples.rangeEnd,
      values: item.values,
      judgeStatus: item.judge.status,
      judgeReasons: item.judge.reasons,
      source: 'pipeline',
    })
  }
  // 以（测点编号 + 时段）排序后重写整个 JSONL：删除的只是本期重算行，历史行顺序稳定。
  const all = [...ledger.values()].sort((a, b) =>
    a.period === b.period ? a.pointCode.localeCompare(b.pointCode) : a.period.localeCompare(b.period),
  )
  writeFileSync(join(STAGE_DIR, 'flow-readings.history.jsonl'), `${all.map((row) => JSON.stringify(row)).join('\n')}\n`)

  const pendingStatuses = new Set(['离线', '数据异常', '待校准'])
  const points = judged.map((item) => {
    const pending = pendingStatuses.has(item.judge.status)
    return {
      id: Number(item.code.slice(-4)),
      status: item.judge.status,
      pending,
      abnormal: item.judge.abnormal,
      监测点编号: item.code,
      监测点位: item.name,
      关联设备: item.deviceCode,
      监测时段: samples.period,
      瞬时流量: item.values ? String(item.values['瞬时流量']) : '未上报',
      累计流量: item.values ? String(item.values['累计流量']) : '未上报',
      水位标高: item.values ? String(item.values['水位标高']) : '未上报',
      流速: item.values ? String(item.values['流速']) : '未上报',
      数据状态: item.judge.reasons.length ? item.judge.reasons.join('；') : '数据正常',
    }
  })

  const devices = samples.devices.map((device, index) => {
    const pending = device.baseStatus !== '运行中'
    return {
      id: index + 1,
      status: device.baseStatus,
      pending,
      abnormal: device.baseStatus === '已故障',
      设备编号: device.code,
      设备类型: device.type,
      安装位置: device.location,
      监测参数: device.params,
      安装日期: device.installDate,
      校准周期: device.cycle,
      最近校准: '—',
      设备状态: device.baseStatus === '已故障' ? '故障停机' : '运行正常',
    }
  })

  const readings = all.map((row) => ({
    pointCode: row.pointCode,
    period: row.period,
    rangeStart: row.rangeStart,
    rangeEnd: row.rangeEnd,
    values: row.values,
  }))

  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    period: samples.period,
    rangeStart: samples.rangeStart,
    rangeEnd: samples.rangeEnd,
    metrics: samples.metrics,
    thresholds: samples.thresholds ?? null,
    points,
    devices,
    readings,
  }
  writeFileSync(join(STAGE_DIR, 'flow-monitor.seed.json'), `${JSON.stringify(artifact, null, 2)}\n`)

  // 原子发布：先在 staging 里写全，再 rename 到正式位置，失败不留半个产物。
  mkdirSync(OUT_DIR, { recursive: true })
  renameSync(join(STAGE_DIR, 'flow-readings.history.jsonl'), LEDGER_FILE)
  const publishedTmp = join(OUT_DIR, '.flow-monitor.seed.json.tmp')
  writeFileSync(publishedTmp, readFileSync(join(STAGE_DIR, 'flow-monitor.seed.json')))
  renameSync(publishedTmp, OUT_FILE)
  rmSync(STAGE_DIR, { recursive: true, force: true })
  info(`    历史台账 ${all.length} 条（本次补齐 ${backfilled} 条），产物已发布到 src/generated/flow-monitor.seed.json`)
  return artifact
}

function main() {
  info('流量监测本地流水线启动')
  stageEnv()
  const samples = stagePrepare()
  stageValidate(samples)
  const judged = stageJudge(samples)
  stagePublish(samples, judged)
  info('\n✓ 流水线完成：样例数据已就绪，可继续 dev / build\n')
}

main()
