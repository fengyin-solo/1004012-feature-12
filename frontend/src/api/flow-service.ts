import { listReadings, listRows, saveReadings, saveRows } from '@/data/local-store'
import { flowMetricDefs, flowPeriod } from '@/data/generated-seed'
import type { ActionResult, EntryRow, FlowReading } from '@/data/types'

// 流量测点状态机集中在这里，页面只负责调用：
//   在线/离线/数据异常 --申请校准--> 待校准 --完成校准--> 已校准 --恢复在线--> 在线
//   任意已上报状态 --标记异常--> 数据异常；离线/数据异常 --数据采集(补报)--> 在线或数据异常
export const FLOW_STATUSES = ['在线', '离线', '数据异常', '待校准', '已校准'] as const
const CLOSED_STATUSES = new Set(['在线', '已校准'])
const DEVICE_PENDING_STATUS = '待校准'
const DEVICE_RUNNING_STATUS = '运行中'

export type CollectInput = {
  period: string
  rangeStart: string
  rangeEnd: string
  values: Record<string, number>
}

export type CollectResult = ActionResult & { status?: string; reasons?: string[] }

function findPoint(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

function isClosed(status: string): boolean {
  return CLOSED_STATUSES.has(status)
}

// 依据业务阈值做异常判定，判定逻辑与流水线 [4/5] 异常判定保持一致。
export function judgeByThreshold(values: Record<string, number>): { status: string; reasons: string[] } {
  const defs = flowMetricDefs()
  const reasons: string[] = []
  for (const [name, def] of Object.entries(defs)) {
    const value = values[name]
    if (typeof value !== 'number' || Number.isNaN(value)) {
      reasons.push(`${name}不是有效数值`)
      continue
    }
    if (value < def.min || value > def.max) {
      reasons.push(`${name}=${value} 超出有效范围 [${def.min}, ${def.max}]${def.unit ? ` ${def.unit}` : ''}`)
      continue
    }
    if (typeof def.warnMin === 'number' && value < def.warnMin) {
      reasons.push(`${name}=${value} 低于业务下限 ${def.warnMin}`)
    }
    if (typeof def.warnMax === 'number' && value > def.warnMax) {
      reasons.push(`${name}=${value} 超过业务上限 ${def.warnMax}`)
    }
  }
  return { status: reasons.length ? '数据异常' : '在线', reasons }
}

// 哪些动作在当前状态下允许点，页面按它渲染按钮，状态判断不放进组件。
export function availableFlowActions(status: string): string[] {
  switch (status) {
    case '在线':
      return ['标记异常']
    case '离线':
      return ['数据采集', '申请校准']
    case '数据异常':
      return ['数据采集', '申请校准', '恢复在线']
    case '待校准':
      return ['完成校准', '恢复在线']
    case '已校准':
      return ['恢复在线']
    default:
      return []
  }
}

function patchPoint(row: EntryRow, patch: { status?: string; pending?: boolean; abnormal?: boolean; 数据状态?: string }): EntryRow {
  return { ...row, ...patch }
}

function replacePoint(rows: EntryRow[], id: number, next: EntryRow): EntryRow[] {
  return rows.map((row) => (Number(row.id) === id ? next : row))
}

// 数据采集：同一（测点+时段）已有读数时拒绝——历史时段数据不能被覆盖。
export function collectFlowReading(id: number, input: CollectInput): CollectResult {
  const rows = listRows('flow_monitor')
  const point = findPoint(rows, id)
  if (!point) {
    return { ok: false, message: `没有找到编号为 ${id} 的流量监测点` }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.period)) {
    return { ok: false, message: '监测时段应为 YYYY-MM-DD 格式' }
  }
  if (input.rangeEnd <= input.rangeStart) {
    return { ok: false, message: '监测时段的结束时间必须晚于开始时间' }
  }
  const readings = listReadings()
  const duplicated = readings.some(
    (row) => row.pointCode === String(point['监测点编号']) && row.period === input.period,
  )
  if (duplicated) {
    return { ok: false, message: `${point['监测点编号']} 在 ${input.period} 已有采集读数，历史时段数据不能覆盖` }
  }

  const judgement = judgeByThreshold(input.values)
  const metricText: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.values)) {
    metricText[name] = String(value)
  }
  const next: EntryRow = {
    ...point,
    status: judgement.status,
    pending: !isClosed(judgement.status),
    abnormal: judgement.status === '数据异常',
    监测时段: input.period,
    ...metricText,
    数据状态: judgement.reasons.length ? judgement.reasons.join('；') : '数据正常',
  }
  saveRows('flow_monitor', replacePoint(rows, id, next))
  const reading: FlowReading = {
    pointCode: String(point['监测点编号']),
    period: input.period,
    rangeStart: input.rangeStart,
    rangeEnd: input.rangeEnd,
    values: { ...input.values },
  }
  saveReadings([...readings, reading])
  return {
    ok: true,
    status: judgement.status,
    reasons: judgement.reasons,
    message:
      judgement.status === '数据异常'
        ? `采集完成并判定为数据异常：${judgement.reasons.join('；')}`
        : '采集完成，指标在业务阈值内，测点在线',
  }
}

export function runFlowAction(id: number, action: string): ActionResult {
  const rows = listRows('flow_monitor')
  const point = findPoint(rows, id)
  if (!point) {
    return { ok: false, message: `没有找到编号为 ${id} 的流量监测点` }
  }
  const current = String(point.status)
  const allowed = availableFlowActions(current)
  if (!allowed.includes(action)) {
    return { ok: false, message: `测点当前「${current}」，不能执行「${action}」（允许：${allowed.join('、') || '无'}）` }
  }

  const deviceCode = String(point['关联设备'] ?? '')

  if (action === '申请校准') {
    saveRows('flow_monitor', rows.map((row) => (Number(row.id) === id ? patchPoint(row, { status: '待校准', pending: true, abnormal: false }) : row)))
    // 联动监测设备页：关联设备进入待校准，待校准数量 +1（幂等，重复申请不重复计数）。
    const devices = listRows('monitor_device')
    const dIndex = devices.findIndex((device) => String(device['设备编号']) === deviceCode)
    if (dIndex >= 0 && devices[dIndex].status !== DEVICE_PENDING_STATUS) {
      devices[dIndex] = { ...devices[dIndex], status: DEVICE_PENDING_STATUS, pending: true, abnormal: false }
      saveRows('monitor_device', devices)
    }
    return { ok: true, message: `已提交校准申请，测点待校准，设备 ${deviceCode} 同步进入待校准` }
  }

  if (action === '完成校准') {
    saveRows('flow_monitor', rows.map((row) => (Number(row.id) === id ? patchPoint(row, { status: '已校准', pending: false, abnormal: false }) : row)))
    // 校准完成：设备回到运行中，监测设备页待校准数量 -1，最近校准记为本监测时段。
    const devices = listRows('monitor_device')
    const dIndex = devices.findIndex((device) => String(device['设备编号']) === deviceCode)
    if (dIndex >= 0) {
      devices[dIndex] = {
        ...devices[dIndex],
        status: DEVICE_RUNNING_STATUS,
        pending: false,
        abnormal: false,
        最近校准: String(point['监测时段'] ?? flowPeriod().period),
      }
      saveRows('monitor_device', devices)
    }
    return { ok: true, message: `校准完成，设备 ${deviceCode} 已恢复运行，监测设备页待校准数量已同步` }
  }

  if (action === '恢复在线') {
    saveRows(
      'flow_monitor',
      rows.map((row) =>
        Number(row.id) === id
          ? patchPoint(row, {
              status: '在线',
              pending: false,
              abnormal: false,
              数据状态: current === '离线' ? '已补报数据，数据正常' : '数据正常',
            })
          : row,
      ),
    )
    return { ok: true, message: '测点已恢复在线' }
  }

  if (action === '标记异常') {
    saveRows('flow_monitor', rows.map((row) => (Number(row.id) === id ? patchPoint(row, { status: '数据异常', pending: true, abnormal: true }) : row)))
    return { ok: true, message: '测点已标记为数据异常' }
  }

  return { ok: false, message: `未支持的动作「${action}」` }
}
