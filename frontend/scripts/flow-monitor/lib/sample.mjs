// 确定性样例数据：同一时段重跑生成完全一致的内容，不依赖随机数，方便核对与交接。
// 样例覆盖三种典型测点：正常、缺数（离线）、指标超阈（数据异常），正好走完整个流程。

export const DEFAULT_PERIOD = '2026-10-06'
export const PERIOD_SLOT = '08:00-12:00'

const SAMPLE_POINTS = [
  { code: 'FLOW-0001', site: '城东截流井', device: 'MONI-0001', profile: 'normal' },
  { code: 'FLOW-0002', site: '城西调蓄池', device: 'MONI-0002', profile: 'offline' },
  { code: 'FLOW-0003', site: '滨河路泵站前池', device: 'MONI-0003', profile: 'abnormal' },
]

function hash(text) {
  let value = 0
  for (const char of text) {
    value = (value * 31 + char.charCodeAt(0)) >>> 0
  }
  return value
}

/** 在 [min, max] 里按字符串哈希取一个确定值，保留 digits 位小数。 */
function pick(point, period, salt, min, max, digits) {
  const ratio = (hash(`${point}|${period}|${salt}`) % 1000) / 1000
  return (min + ratio * (max - min)).toFixed(digits)
}

function metricsFor(profile, point, period) {
  if (profile === 'offline') {
    // 缺数：指标留空，异常判定时会被判成离线
    return { 瞬时流量: '', 累计流量: '', 水位标高: '', 流速: '' }
  }
  if (profile === 'abnormal') {
    // 指标超阈：瞬时流量、流速超过 rules.mjs 里的阈值
    return {
      瞬时流量: pick(point, period, '瞬时流量', 85, 99, 1),
      累计流量: pick(point, period, '累计流量', 5000, 9000, 1),
      水位标高: pick(point, period, '水位标高', 4.5, 6, 2),
      流速: pick(point, period, '流速', 5.2, 6.5, 2),
    }
  }
  return {
    瞬时流量: pick(point, period, '瞬时流量', 5, 60, 1),
    累计流量: pick(point, period, '累计流量', 500, 8000, 1),
    水位标高: pick(point, period, '水位标高', 2, 4.5, 2),
    流速: pick(point, period, '流速', 0.5, 3, 2),
  }
}

/** 生成指定时段的采集样例行，id 从 startId 开始连续编号。 */
export function buildSampleRows(period, startId) {
  return SAMPLE_POINTS.map((point, index) => ({
    id: startId + index,
    status: '在线',
    pending: true,
    abnormal: false,
    监测点编号: point.code,
    监测点位: point.site,
    监测时段: `${period} ${PERIOD_SLOT}`,
    关联设备编号: point.device,
    ...metricsFor(point.profile, point.code, period),
    数据状态: '待判定',
  }))
}
