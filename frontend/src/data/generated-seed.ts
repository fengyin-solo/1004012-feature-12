import type { EntryRow } from './types'

// 构建前由 scripts/flow-pipeline.mjs 生成，内容随样例与异常判定结果变化。
// 文件缺失时（比如只做类型检查）退回内联兜底，页面和构建都不会因此崩掉。
const artifactModules = import.meta.glob('../generated/flow-monitor.seed.json', { eager: true }) as Record<
  string,
  { default: FlowSeedArtifact }
>

export type MetricBounds = {
  unit: string
  min: number
  max: number
  warnMin?: number
  warnMax?: number
}

export type FlowReading = {
  pointCode: string
  period: string
  rangeStart: string
  rangeEnd: string
  values: Record<string, number> | null
}

export type FlowSeedArtifact = {
  schemaVersion: number
  generatedAt: string
  period: string
  rangeStart: string
  rangeEnd: string
  metrics: Record<string, MetricBounds>
  thresholds: Record<string, { warnMin: number; warnMax: number }> | null
  points: EntryRow[]
  devices: EntryRow[]
  readings: FlowReading[]
}

const METRIC_NAMES = ['瞬时流量', '累计流量', '水位标高', '流速']

const FALLBACK_ARTIFACT: FlowSeedArtifact = {
  schemaVersion: 1,
  generatedAt: '',
  period: '',
  rangeStart: '',
  rangeEnd: '',
  metrics: {
    瞬时流量: { unit: 'L/s', min: 0, max: 1000, warnMin: 20, warnMax: 500 },
    累计流量: { unit: 'm³', min: 0, max: 20000, warnMin: 0, warnMax: 18000 },
    水位标高: { unit: 'm', min: 0, max: 6, warnMin: 0.2, warnMax: 5.5 },
    流速: { unit: 'm/s', min: 0, max: 3, warnMin: 0.1, warnMax: 2.5 },
  },
  thresholds: null,
  points: [],
  devices: [],
  readings: [],
}

const generated = Object.values(artifactModules)[0]?.default
const artifact: FlowSeedArtifact = generated ? generated : FALLBACK_ARTIFACT

export function flowArtifactReady(): boolean {
  return Boolean(generated)
}

export function flowPeriod(): { period: string; rangeStart: string; rangeEnd: string } {
  return { period: artifact.period, rangeStart: artifact.rangeStart, rangeEnd: artifact.rangeEnd }
}

export function flowMetricNames(): string[] {
  return METRIC_NAMES
}

export function flowMetricDefs(): Record<string, MetricBounds> {
  // 合法范围与业务阈值合并：采集录入既要校验合法范围，又要据此做异常判定。
  const defs: Record<string, MetricBounds> = {}
  for (const name of METRIC_NAMES) {
    const metric = artifact.metrics[name]
    const threshold = artifact.thresholds?.[name]
    defs[name] = {
      unit: metric?.unit ?? '',
      min: metric?.min ?? 0,
      max: metric?.max ?? 0,
      warnMin: threshold?.warnMin,
      warnMax: threshold?.warnMax,
    }
  }
  return defs
}

export function flowSeedPoints(): EntryRow[] {
  return artifact.points.map((row) => ({ ...row }))
}

export function flowSeedDevices(): EntryRow[] {
  return artifact.devices.map((row) => ({ ...row }))
}

export function flowSeedReadings(): FlowReading[] {
  return artifact.readings.map((row) => ({ ...row, values: row.values ? { ...row.values } : null }))
}
