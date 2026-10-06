// 流量监测本地流程的文件存储：种子数据、本次运行工作区、历史时段归档。
// 种子数据（src/data/flow-monitor-seed.json）是前端播种和流程脚本共用的数据入口；
// dev-data/ 是运行产物目录，current/ 每次运行前清理，history/ 只追加不覆盖。
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

export const SEED_PATH = join(FRONTEND_ROOT, 'src', 'data', 'flow-monitor-seed.json')
export const WORK_ROOT = join(FRONTEND_ROOT, 'dev-data', 'flow-monitor')
export const CURRENT_DIR = join(WORK_ROOT, 'current')
export const HISTORY_DIR = join(WORK_ROOT, 'history')

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function loadSeed() {
  const seed = readJson(SEED_PATH)
  if (!Array.isArray(seed.flow_monitor) || !Array.isArray(seed.monitor_device)) {
    throw new Error(`${SEED_PATH} 结构不对：需要 flow_monitor 和 monitor_device 两个数组`)
  }
  return seed
}

export function saveSeed(seed) {
  writeJson(SEED_PATH, seed)
}

/** 环境检查用：确认工作目录可建可写。 */
export function probeWorkRoot() {
  mkdirSync(WORK_ROOT, { recursive: true })
  const probe = join(WORK_ROOT, '.write-probe')
  writeFileSync(probe, 'ok', 'utf8')
  rmSync(probe)
}

/** 清掉本次运行的中间产物，重跑不残留上次结果；历史归档不在这里，不受影响。 */
export function resetCurrentDir() {
  rmSync(CURRENT_DIR, { recursive: true, force: true })
  mkdirSync(CURRENT_DIR, { recursive: true })
}

export function historyPath(period) {
  return join(HISTORY_DIR, `${period}.json`)
}

export function historyExists(period) {
  return existsSync(historyPath(period))
}

/** 已归档的历史时段（YYYY-MM-DD 升序）。 */
export function listHistory() {
  if (!existsSync(HISTORY_DIR)) {
    return []
  }
  return readdirSync(HISTORY_DIR)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.replace(/\.json$/, ''))
    .sort()
}
