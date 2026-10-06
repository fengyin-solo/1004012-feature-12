// 样例数据校验：监测点编号、监测时段、监测指标三道关，问题一次性列完再失败。

export const POINT_CODE_PATTERN = /^FLOW-\d{4}$/
export const DEVICE_CODE_PATTERN = /^MONI-\d{4}$/
export const PERIOD_PATTERN = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})-(\d{2}):(\d{2})$/

export const METRIC_FIELDS = ['瞬时流量', '累计流量', '水位标高', '流速']

// 指标量程：空串表示缺数（允许），有值必须是量程内的数值
const METRIC_RANGES = {
  瞬时流量: [0, 100],
  累计流量: [0, 1000000],
  水位标高: [-10, 50],
  流速: [0, 10],
}

export function isValidDateText(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) {
    return false
  }
  const [, year, month, day] = match.map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

function checkPeriodText(text) {
  const match = PERIOD_PATTERN.exec(text)
  if (!match) {
    return '监测时段格式应为「YYYY-MM-DD HH:MM-HH:MM」'
  }
  const [, year, month, day, startHour, startMinute, endHour, endMinute] = match.map(Number)
  if (!isValidDateText(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)) {
    return `监测时段日期「${year}-${month}-${day}」不是有效日期`
  }
  const start = startHour * 60 + startMinute
  const end = endHour * 60 + endMinute
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59 || start >= end) {
    return '监测时段的起止时间不合理（开始必须早于结束，且在当天内）'
  }
  return null
}

/**
 * 校验流量监测行（含历史时段）：编号格式、关联设备、时段格式、指标量程、编号+时段唯一。
 * 返回问题清单，空数组表示通过。
 */
export function validateRows(rows, deviceCodes) {
  const problems = []
  const seenKeys = new Map()
  rows.forEach((row, index) => {
    const label = `第 ${index + 1} 行（id=${row.id}）`
    const code = String(row['监测点编号'] ?? '')
    if (!POINT_CODE_PATTERN.test(code)) {
      problems.push(`${label}：监测点编号「${code}」不符合 FLOW-0000 格式`)
    }
    const device = String(row['关联设备编号'] ?? '')
    if (!DEVICE_CODE_PATTERN.test(device)) {
      problems.push(`${label}：关联设备编号「${device}」不符合 MONI-0000 格式`)
    } else if (!deviceCodes.has(device)) {
      problems.push(`${label}：关联设备编号「${device}」在监测设备台账里不存在`)
    }
    const periodText = String(row['监测时段'] ?? '')
    const periodError = checkPeriodText(periodText)
    if (periodError) {
      problems.push(`${label}：${periodError}，当前为「${periodText}」`)
    }
    for (const field of METRIC_FIELDS) {
      const raw = String(row[field] ?? '').trim()
      if (raw === '') {
        continue // 缺数留给异常判定处理
      }
      const value = Number(raw)
      const [min, max] = METRIC_RANGES[field]
      if (!Number.isFinite(value)) {
        problems.push(`${label}：指标「${field}」的值「${raw}」不是数值`)
      } else if (value < min || value > max) {
        problems.push(`${label}：指标「${field}」的值「${raw}」超出量程 ${min}~${max}`)
      }
    }
    const key = `${code}|${periodText}`
    if (seenKeys.has(key)) {
      problems.push(
        `${label}：与第 ${seenKeys.get(key) + 1} 行重复，同一监测点同一时段只能有一条记录`,
      )
    } else {
      seenKeys.set(key, index)
    }
  })
  return problems
}
