// 异常判定规则：与页面上「离线 / 数据异常 / 在线」的口径一致，规则只放在这里，流程和引导数据都引用。
import { METRIC_FIELDS } from './validate.mjs'

export const THRESHOLDS = {
  瞬时流量: 80,
  流速: 5,
}

/** 判定一行的状态，返回 { status, 数据状态, abnormal }。 */
export function judgeRow(row) {
  const missing = METRIC_FIELDS.some((field) => String(row[field] ?? '').trim() === '')
  if (missing) {
    return { status: '离线', 数据状态: '缺数离线', abnormal: true }
  }
  const flow = Number(row['瞬时流量'])
  const speed = Number(row['流速'])
  if (flow > THRESHOLDS['瞬时流量'] || speed > THRESHOLDS['流速']) {
    return { status: '数据异常', 数据状态: '指标超阈', abnormal: true }
  }
  return { status: '在线', 数据状态: '正常', abnormal: false }
}
