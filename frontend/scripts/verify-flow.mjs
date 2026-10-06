/**
 * 流量监测全流程校验（Vite SSR 加载真实源码与流水线产物，无需浏览器）：
 *   node scripts/verify-flow.mjs
 * 覆盖：采集判定、重复采集拒绝、历史时段不覆盖、申请/完成校准与监测设备页待校准数量联动、动作守卫。
 */
import { createServer } from 'vite'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) {
    failures += 1
    console.log(`    期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

const server = await createServer({
  root: process.cwd(),
  logLevel: 'silent',
  server: { middlewareMode: true },
})
try {
  const flow = await server.ssrLoadModule('/src/api/flow-service.ts')
  const store = await server.ssrLoadModule('/src/data/local-store.ts')

  const point = (id) => store.listRows('flow_monitor').find((row) => Number(row.id) === id)
  const device = (code) => store.listRows('monitor_device').find((row) => row['设备编号'] === code)
  const pendingDeviceCount = () => store.listRows('monitor_device').filter((row) => row.status === '待校准').length

  // 初始状态来自流水线产物：FLOW-0003 数据异常，设备页待校准为 0
  check('初始 FLOW-0003 数据异常', point(3).status, '数据异常')
  check('初始设备页待校准数量', pendingDeviceCount(), 0)
  const history0003 = store.listReadings().find((r) => r.pointCode === 'FLOW-0003' && r.period === '2026-10-04')
  check('历史时段读数初始值', history0003.values['瞬时流量'], 135.6)
  check('初始读数条数', store.listReadings().length, 12)

  // 申请校准：测点待校准，关联设备同步进入待校准（数量 +1）
  const apply = flow.runFlowAction(3, '申请校准')
  check('申请校准返回成功', apply.ok, true)
  check('申请校准后测点状态', point(3).status, '待校准')
  check('申请校准后设备 MONI-F003 状态', device('MONI-F003').status, '待校准')
  check('申请校准后设备页待校准数量', pendingDeviceCount(), 1)

  // 待校准状态不能直接恢复在线之外的跳跃动作
  const illegal = flow.runFlowAction(3, '标记异常')
  check('待校准状态拒绝标记异常', illegal.ok, false)

  // 完成校准：测点已校准，设备回运行中，数量 -1，最近校准同步
  const done = flow.runFlowAction(3, '完成校准')
  check('完成校准返回成功', done.ok, true)
  check('完成校准后测点状态', point(3).status, '已校准')
  check('完成校准后设备 MONI-F003 状态', device('MONI-F003').status, '运行中')
  check('完成校准后最近校准日期', device('MONI-F003')['最近校准'], point(3)['监测时段'])
  check('完成校准后设备页待校准数量', pendingDeviceCount(), 0)

  // 已校准 -> 恢复在线
  const back = flow.runFlowAction(3, '恢复在线')
  check('已校准恢复在线', back.ok && point(3).status === '在线', true)

  // 离线测点数据采集：指标在阈值内 -> 在线，读数追加
  const collect = flow.collectFlowReading(2, {
    period: '2026-10-07',
    rangeStart: '2026-10-07 00:00',
    rangeEnd: '2026-10-07 08:00',
    values: { 瞬时流量: 130.0, 累计流量: 5010.2, 水位标高: 2.05, 流速: 0.83 },
  })
  check('离线测点补报采集成功', collect.ok, true)
  check('补报后测点状态', point(2).status, '在线')
  check('补报后读数条数', store.listReadings().length, 13)

  // 同一（测点+时段）再次采集必须被拒绝，历史数据不覆盖
  const dup = flow.collectFlowReading(2, {
    period: '2026-10-07',
    rangeStart: '2026-10-07 00:00',
    rangeEnd: '2026-10-07 08:00',
    values: { 瞬时流量: 1.0, 累计流量: 1.0, 水位标高: 1.0, 流速: 1.0 },
  })
  check('重复时段采集被拒绝', dup.ok, false)
  check('拒绝后读数条数不变', store.listReadings().length, 13)
  check('原读数未被覆盖', store.listReadings().find((r) => r.pointCode === 'FLOW-0002' && r.period === '2026-10-07').values['瞬时流量'], 130.0)

  // 超阈值采集自动判定数据异常
  const bad = flow.collectFlowReading(1, {
    period: '2026-10-08',
    rangeStart: '2026-10-08 00:00',
    rangeEnd: '2026-10-08 08:00',
    values: { 瞬时流量: 800, 累计流量: 5010.2, 水位标高: 2.05, 流速: 0.83 },
  })
  check('超阈值采集判定数据异常', bad.ok === true && point(1).status === '数据异常', true)

  // 历史时段（2026-10-04）记录始终不被任何操作改动
  check('历史时段数据未被覆盖', history0003.values['瞬时流量'], 135.6)

  // 非法时段格式与结束早于开始
  check('非法时段格式被拒绝', flow.collectFlowReading(2, {
    period: '2026/10/09', rangeStart: 'x', rangeEnd: 'y', values: {},
  }).ok, false)
  check('结束早于开始被拒绝', flow.collectFlowReading(2, {
    period: '2026-10-09', rangeStart: '2026-10-09 08:00', rangeEnd: '2026-10-09 00:00', values: {},
  }).ok, false)
} finally {
  await server.close()
}

if (failures) {
  console.error(`\n✗ 流量流程校验失败 ${failures} 项`)
  process.exit(1)
}
console.log('\n✓ 流量监测全流程校验全部通过')
