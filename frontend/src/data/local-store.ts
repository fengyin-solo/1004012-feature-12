import { flowSeedDevices, flowSeedPoints, flowSeedReadings } from './generated-seed'
import { SEED_ROWS } from './seed'
import type { EntryRow, FlowReading } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'underground-pipeline-inspection:entries'
const READINGS_STORAGE_KEY = 'underground-pipeline-inspection:flow-readings'
// 产物结构调整时 bump，避免旧缓存和新字段错配。
const SEED_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function baseSeed(): Record<string, EntryRow[]> {
  return clone(SEED_ROWS)
}

// 流量测点 / 监测设备以流水线产物为准：已存在的记录（用户做过动作）保留，
// 产物里新增的编号追加进来，既同步新样例又不冲掉在浏览器里的操作结果。
function mergeRows(seed: EntryRow[], stored: EntryRow[] | undefined): EntryRow[] {
  if (!stored || !stored.length) {
    return seed
  }
  const storedById = new Map(stored.map((row) => [Number(row.id), row]))
  const merged = seed.map((row) => storedById.get(Number(row.id)) ?? row)
  const seedIds = new Set(seed.map((row) => Number(row.id)))
  for (const row of stored) {
    if (!seedIds.has(Number(row.id))) {
      merged.push(row)
    }
  }
  return merged
}

function buildFallback(): Record<string, EntryRow[]> {
  const fallback = baseSeed()
  fallback.flow_monitor = flowSeedPoints().length ? flowSeedPoints() : fallback.flow_monitor
  fallback.monitor_device = flowSeedDevices().length ? flowSeedDevices() : fallback.monitor_device
  return fallback
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = buildFallback()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]> & { __seedVersion?: number }
    const merged: Record<string, EntryRow[]> = { ...baseSeed(), ...parsed }
    // 流量监测两个模块按编号合并，而不是整段覆盖
    merged.flow_monitor = mergeRows(fallback.flow_monitor, parsed.flow_monitor)
    merged.monitor_device = mergeRows(fallback.monitor_device, parsed.monitor_device)
    delete merged.__seedVersion
    if (parsed.__seedVersion !== SEED_VERSION) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
      window.localStorage.setItem('underground-pipeline-inspection:seed-version', String(SEED_VERSION))
    }
    return merged
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null
let readingsCache: FlowReading[] | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  // 流量监测 / 监测设备的重置基线是流水线产物；历史读数独立保存，重置状态不删历史。
  const rows =
    key === 'flow_monitor' && flowSeedPoints().length
      ? flowSeedPoints()
      : key === 'monitor_device' && flowSeedDevices().length
        ? flowSeedDevices()
        : clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// ── 历史时段读数：只追加，永远不被重跑覆盖 ─────────────────────────────────
function seedReadings(): FlowReading[] {
  return flowSeedReadings()
}

export function listReadings(): FlowReading[] {
  if (readingsCache) {
    return readingsCache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    readingsCache = seedReadings()
    return readingsCache
  }
  const raw = window.localStorage.getItem(READINGS_STORAGE_KEY)
  if (!raw) {
    readingsCache = seedReadings()
    window.localStorage.setItem(READINGS_STORAGE_KEY, JSON.stringify(readingsCache))
    return readingsCache
  }
  try {
    const stored = JSON.parse(raw) as FlowReading[]
    // 同样的（测点+时段）以已存数据为准；产物里新出现的时段只做追加，历史不覆盖。
    const exists = new Set(stored.map((row) => `${row.pointCode}|${row.period}`))
    readingsCache = [...stored]
    for (const row of seedReadings()) {
      if (!exists.has(`${row.pointCode}|${row.period}`)) {
        readingsCache.push(row)
      }
    }
    return readingsCache
  } catch {
    readingsCache = seedReadings()
    window.localStorage.setItem(READINGS_STORAGE_KEY, JSON.stringify(readingsCache))
    return readingsCache
  }
}

export function saveReadings(readings: FlowReading[]): void {
  readingsCache = readings
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(READINGS_STORAGE_KEY, JSON.stringify(readings))
  }
}

export function storageKey(): string {
  return STORAGE_KEY
}
