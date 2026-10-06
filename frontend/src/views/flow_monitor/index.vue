<template>
  <section class="page" data-module="flow_monitor">
    <header class="page-head">
      <div>
        <h2>流量监测管理</h2>
        <p class="page-desc">测点数据采集、异常判定、校准申请与恢复在线的本地全流程；样例由构建前流水线准备并校验。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出流量监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionMap.get(Number(row.id)) ?? []"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无流量监测数据，请先运行流量监测流水线</td>
        </tr>
      </tbody>
    </table>

    <section class="collect-panel" v-if="collectTarget">
      <h3>数据采集 · {{ collectTarget['监测点编号'] }}（{{ collectTarget['监测点位'] }}）</h3>
      <form class="filter-bar" @submit.prevent="submitCollect">
        <label class="filter-item">
          <span>监测日期</span>
          <input v-model="collectForm.period" type="date" />
        </label>
        <label class="filter-item">
          <span>开始时间</span>
          <input v-model="collectForm.rangeStart" placeholder="2026-10-06 00:00" />
        </label>
        <label class="filter-item">
          <span>结束时间</span>
          <input v-model="collectForm.rangeEnd" placeholder="2026-10-06 08:00" />
        </label>
        <label v-for="metric in metricNames" :key="metric" class="filter-item">
          <span>{{ metric }}（{{ metricDefs[metric]?.unit }}）</span>
          <input v-model.number="collectForm.values[metric]" type="number" step="0.01" />
        </label>
        <button class="btn primary" type="submit">提交采集并判定</button>
        <button class="btn ghost" type="button" @click="cancelCollect">取消</button>
      </form>
      <p class="page-desc">合法范围与业务阈值来自流水线产物；同一测点同一时段已采集过会被拒绝，历史数据不覆盖。</p>
    </section>

    <section class="history-panel">
      <h3>历史时段读数（只追加，重跑不覆盖）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>监测点编号</th>
            <th>监测时段</th>
            <th>开始</th>
            <th>结束</th>
            <th v-for="metric in metricNames" :key="metric">{{ metric }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(reading, index) in readings" :key="`${reading.pointCode}-${reading.period}-${index}`">
            <td>{{ reading.pointCode }}</td>
            <td>{{ reading.period }}</td>
            <td>{{ reading.rangeStart }}</td>
            <td>{{ reading.rangeEnd }}</td>
            <td v-for="metric in metricNames" :key="metric">{{ reading.values ? reading.values[metric] : '未上报' }}</td>
          </tr>
          <tr v-if="!readings.length">
            <td :colspan="metricNames.length + 4" class="empty-state">暂无历史时段读数</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条流量监测记录 · 本期时段 {{ periodLabel || '—' }}</span>
      <span v-if="message" :class="messageOk ? 'success-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  availableFlowActions,
  collectFlowReading,
  runFlowAction,
} from '@/api/flow-service'
import { listReadings } from '@/data/local-store'
import { flowArtifactReady, flowMetricDefs, flowMetricNames, flowPeriod } from '@/data/generated-seed'
import type { EntryRow, FlowReading } from '@/data/types'

const meta = moduleMeta('flow_monitor')
const columns = meta.fields
const statuses = [...meta.statuses]
const metricNames = flowMetricNames()
const metricDefs = flowMetricDefs()
const currentPeriod = flowPeriod()

const rows = ref<EntryRow[]>([])
const readings = ref<FlowReading[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const collectTarget = ref<EntryRow | null>(null)
const collectForm = reactive({
  period: currentPeriod.period,
  rangeStart: currentPeriod.rangeStart,
  rangeEnd: currentPeriod.rangeEnd,
  values: Object.fromEntries(metricNames.map((name) => [name, 0])) as Record<string, number>,
})

const actionMap = computed(() => {
  const map = new Map<number, string[]>()
  for (const row of rows.value) {
    const actions = availableFlowActions(String(row.status))
    // 数据采集是表单入口，离线/数据异常行用它打开采集面板
    map.set(Number(row.id), actions.includes('数据采集') ? ['数据采集', ...actions.filter((a) => a !== '数据采集')] : actions)
  }
  return map
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const countByStatus = (status: string) => rows.value.filter((row) => String(row.status) === status).length

const stats = computed(() => [
  { label: '在线测点', value: countByStatus('在线') },
  { label: '离线测点', value: countByStatus('离线') },
  { label: '异常测点', value: countByStatus('数据异常') },
  { label: '待校准测点', value: countByStatus('待校准') },
  { label: '已校准测点', value: countByStatus('已校准') },
])

const periodLabel = computed(() =>
  currentPeriod.period ? `${currentPeriod.period} ${currentPeriod.rangeStart}~${currentPeriod.rangeEnd}` : '',
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function runAction(action: string, row: EntryRow) {
  message.value = ''
  if (action === '数据采集') {
    collectTarget.value = row
    collectForm.period = currentPeriod.period
    collectForm.rangeStart = currentPeriod.rangeStart
    collectForm.rangeEnd = currentPeriod.rangeEnd
    collectForm.values = Object.fromEntries(metricNames.map((name) => [name, 0]))
    return
  }
  const result = runFlowAction(Number(row.id), action)
  notify(result.ok, result.message)
  if (result.ok) {
    reload()
  }
}

function cancelCollect() {
  collectTarget.value = null
  message.value = ''
}

function submitCollect() {
  if (!collectTarget.value) {
    return
  }
  const result = collectFlowReading(Number(collectTarget.value.id), {
    period: collectForm.period,
    rangeStart: collectForm.rangeStart,
    rangeEnd: collectForm.rangeEnd,
    values: { ...collectForm.values },
  })
  notify(result.ok, result.message)
  if (result.ok) {
    collectTarget.value = null
    reload()
  }
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    readings.value = listReadings()
    if (!flowArtifactReady()) {
      notify(false, '未找到流水线产物，正在使用内置兜底数据；构建前会自动运行流水线')
    }
  } catch (error) {
    notify(false, error instanceof Error ? error.message : '流量监测列表读取失败')
  }
}

onMounted(reload)
</script>
