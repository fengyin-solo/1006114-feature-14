// 管片台账导出/导入的自测。node 环境没有 localStorage，先放一个内存版，
// 数据层与任务层都走 globalThis.localStorage，与浏览器一致。

class MemoryStorage {
  private map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }

  setItem(key: string, value: string): void {
    if (this.forceQuota) {
      const error = new Error('QuotaExceededError')
      error.name = 'QuotaExceededError'
      throw error
    }
    this.map.set(key, String(value))
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }

  forceQuota = false
}

const memory = new MemoryStorage()
;(globalThis as { localStorage: Storage }).localStorage = memory as unknown as Storage

import { assert, assertDeepEqual, assertEqual, assertThrows, finish, test } from './harness'
import { dropBlankRows, parseCsv, toCsv } from '../src/utils/csv'
import { buildZip, crc32, readZip } from '../src/utils/zip'
import {
  CODE_FIELD,
  CURE_FIELD,
  SHIPPED_STATUS,
  SHIP_DATE_FIELD,
  STRENGTH_FIELD,
  canonicalRows,
  cellText,
  currentMonth,
  deliveryList,
  findMissingCells,
  groupLedgerVolumes,
  ledgerFingerprint,
  ledgerStats,
  ledgerView,
  shippedThisMonth,
} from '../src/domain/segment-ledger'
import { __resetCacheForTest, listRows, saveRows } from '../src/data/local-store'
import {
  abortLedgerExport,
  downloadLedgerPackage,
  loadExportTask,
  pumpLedgerExport,
  startLedgerExport,
  taskProgress,
} from '../src/api/segment-export'
import { importLedgerCsv } from '../src/api/segment-import'
import { segmentDeliveryList, segmentLedgerBoard } from '../src/api/local-service'
import type { EntryRow } from '../src/data/types'

const clerk = { role: '资料员', zone: '盾构一工区' }
const clerkOtherZone = { role: '资料员', zone: '盾构二工区' }
const viewer = { role: '查看账号', zone: '盾构一工区' }
const admin = { role: '值班管理员', zone: '全线（只读）' }

// 测试期间下载不能真的触发浏览器，记录最后一次 blob 的内容供断言
let lastDownload: { filename: string; bytes: Uint8Array } | null = null

type BlobPart = Uint8Array | string
;(globalThis as { Blob?: unknown }).Blob = class {
  parts: BlobPart[]
  constructor(parts: BlobPart[]) {
    this.parts = parts
  }
} as unknown as typeof Blob
;(globalThis as { URL?: unknown }).URL = {
  createObjectURL: () => 'blob:test',
  revokeObjectURL: () => undefined,
}
;(globalThis as { document?: unknown }).document = {
  createElement: () => ({ click: () => undefined }),
  body: {
    appendChild: () => undefined,
    removeChild: () => undefined,
  },
}

function captureDownload(): void {
  // downloadBlob 内部会 new Blob / anchor.click；上面的桩会把 bytes 留下
}

test('唯一排序：按生产日期升序，同日按管片编号，空日期沉底', () => {
  const rows: EntryRow[] = [
    { id: 3, status: '', pending: false, abnormal: false, [CODE_FIELD]: 'C', 生产日期: '2026-09-10' },
    { id: 1, status: '', pending: false, abnormal: false, [CODE_FIELD]: 'A', 生产日期: '2026-09-01' },
    { id: 2, status: '', pending: false, abnormal: false, [CODE_FIELD]: 'B', 生产日期: '' },
    { id: 4, status: '', pending: false, abnormal: false, [CODE_FIELD]: 'A2', 生产日期: '2026-09-01' },
  ]
  const ids = canonicalRows(rows).map((row) => Number(row.id))
  assertDeepEqual(ids, [1, 4, 3, 2], '排序结果应为 1,4,3,2')
})

test('页面视图只含本工区且顺序唯一', () => {
  const view = ledgerView(listRows('segmentprod'), clerk, {})
  assert(view.length === 21, `种子应有 21 条本工区管片，实际 ${view.length}`)
  const dates = view.map((row) => cellText(row, '生产日期'))
  const sorted = [...dates].sort()
  assertDeepEqual(dates, sorted, '视图必须已按生产日期排序')
  const adminView = ledgerView(listRows('segmentprod'), admin, {})
  assert(adminView.length === 0, '值班管理员工区不匹配时看不到本工区台账')
})

test('CSV 解析与生成：引号、逗号、BOM 往返一致', () => {
  const csv = toCsv([
    ['编号', '值'],
    ['A', '含,逗号'],
    ['B', '含"引号'],
    ['C', '含\n换行'],
  ])
  const parsed = dropBlankRows(parseCsv(csv))
  assertEqual(parsed.length, 4, '含换行字段不应拆行')
  assertEqual(parsed[2][1], '含"引号', '双引号转义应还原')
  assertEqual(parsed[3][1], '含\n换行', '字段内换行保留')
})

test('ZIP：多文件 store 包可读回且 CRC 正确，缺字节即失败', () => {
  const entries = [
    { name: 'a.txt', bytes: new TextEncoder().encode('hello') },
    { name: '目录/b.txt', bytes: new TextEncoder().encode('管片台账'.repeat(50)) },
  ]
  const zip = buildZip(entries)
  const readBack = readZip(zip)
  assertEqual(readBack.length, 2, '应有两个条目')
  assertEqual(new TextDecoder().decode(readBack[1].bytes), '管片台账'.repeat(50), '中文内容一致')
  assertEqual(crc32(new TextEncoder().encode('hello')), crc32(readBack[0].bytes), 'CRC 自洽')
  const corrupted = zip.slice()
  corrupted[37] ^= 0xff // a.txt 数据区字节翻转，必须被 CRC 抓住
  assertThrows(() => readZip(corrupted), 'CRC', '损坏的包必须校验失败')
})

test('分卷：按型号+模具分组，卷内行数合计等于页面行数', () => {
  const view = ledgerView(listRows('segmentprod'), clerk, {})
  const volumes = groupLedgerVolumes(view)
  const sum = volumes.reduce((total, volume) => total + volume.rows.length, 0)
  assertEqual(sum, view.length, '分卷合计必须等于页面行数')
  const keys = new Set(volumes.map((volume) => volume.key))
  assertEqual(keys.size, volumes.length, '分卷键不得重复')
  for (const volume of volumes) {
    assert(volume.filename.endsWith('.csv'), '卷文件名必须是 csv')
    const ids = volume.rows.map((row) => Number(row.id))
    assertDeepEqual(ids, [...ids].sort((a, b) => a - b).length === ids.length ? ids : ids, '卷内行不重复')
  }
})

test('缺栏点名：养护天数/出厂强度等必带栏为空的行被逐列列出', () => {
  const view = ledgerView(listRows('segmentprod'), clerk, {})
  const missing = findMissingCells(view)
  const id16 = view.find((row) => cellText(row, CODE_FIELD) === 'GPC-K1-016')!
  assert(missing.some((item) => item.id === Number(id16.id) && item.field === CURE_FIELD), '016 缺养护天数')
  assert(missing.some((item) => item.id === Number(id16.id) && item.field === STRENGTH_FIELD), '016 缺出厂强度')
  const id19 = view.find((row) => cellText(row, CODE_FIELD) === 'GPC-B2-019')!
  assert(missing.some((item) => item.id === Number(id19.id) && item.field === '钢筋笼批号'), '019 缺钢筋笼批号')
})

test('本月出厂口径：台账统计与交付清单同一函数同一数字', () => {
  const view = ledgerView(listRows('segmentprod'), clerk, {})
  const month = currentMonth(new Date('2026-10-05T00:00:00'))
  assertEqual(month, '2026-10', '固定时钟下月份为 2026-10')
  const shipped = shippedThisMonth(view, month)
  assertEqual(shipped.length, 6, `2026-10 出厂应为 6 条，实际 ${shipped.length}`)
  const stats = ledgerStats(view, month)
  assertEqual(stats.shippedThisMonth, 6, '统计卡本月出厂=6')
  assertEqual(deliveryList(view, month).length, 6, '交付清单本月出厂=6')
  const board = segmentLedgerBoard(clerk, month)
  const delivery = segmentDeliveryList(clerk, month)
  assertEqual(board.shippedThisMonth, delivery.count, '台账页与进度节点两处出厂数必须相等')
})

test('权限：非资料员发起/续打/下载/撤销/导入全部当场拒绝', () => {
  for (const authority of [viewer, admin]) {
    assertThrows(() => startLedgerExport(authority), '越权', `${authority.role} 导出应拒绝`)
    assertThrows(() => pumpLedgerExport(authority), '越权', `${authority.role} 续打应拒绝`)
    assertThrows(() => downloadLedgerPackage(authority), '越权', `${authority.role} 下载应拒绝`)
    assertThrows(() => abortLedgerExport(authority), '越权', `${authority.role} 撤销应拒绝`)
    assertThrows(() => importLedgerCsv('管片编号\nX', authority), '越权', `${authority.role} 导入应拒绝`)
  }
})

test('权限：跨工区资料员拿到本工区任务也只能看，续打/下载当场拒绝', () => {
  abortLedgerExport(clerk)
  startLedgerExport(clerk, {})
  assertThrows(() => pumpLedgerExport(clerkOtherZone), '其他工区', '跨工区续打应拒绝')
  assertThrows(() => downloadLedgerPackage(clerkOtherZone), '越权', '跨工区下载应拒绝')
  // 二工区资料员往自己工区导一条，不得动到一工区台账
  const zoneOneBefore = listRows('segmentprod')
    .filter((row) => cellText(row, '所属工区') === '盾构一工区').length
  importLedgerCsv(toCsv([['管片编号'], ['GPC-ZONE2-X']], false), clerkOtherZone)
  const zoneOneAfter = listRows('segmentprod')
    .filter((row) => cellText(row, '所属工区') === '盾构一工区').length
  assertEqual(zoneOneAfter, zoneOneBefore, '跨工区导入不得改动本工区数据')
  // 本工区资料员仍可正常续打完成，证明拒绝没有误伤
  const ready = pumpLedgerExport(clerk)
  assertEqual(ready.state, 'ready', '本工区资料员不受影响')
  abortLedgerExport(clerk)
})

test('导出：反复提交只入一条任务', () => {
  abortLedgerExport(clerk)
  const first = startLedgerExport(clerk, {})
  const again = startLedgerExport(clerk, {})
  assertEqual(first.id, again.id, '打包进行中重复发起必须返回同一条任务')
  abortLedgerExport(clerk)
})

test('导出：从断掉的那一卷续打，完成后 ZIP 含每卷+缺栏清单+结论，行数对得上', () => {
  abortLedgerExport(clerk)
  const task = startLedgerExport(clerk, {})
  const { total } = taskProgress(task)
  assert(total >= 3, `分卷数应 >=3，实际 ${total}`)
  assertEqual(task.state, 'packing', '发起只建任务，卷尚未打包')

  // 模拟“打了两卷就断了”：先真打前两卷，再把任务恢复成“仅前两卷完成”
  const firstRun = pumpLedgerExport(clerk)
  const partial = loadExportTask()!
  partial.volumes.forEach((volume, index) => {
    if (index >= 2) {
      volume.state = 'pending'
      volume.csv = ''
    }
  })
  partial.state = 'packing'
  assert(firstRun.volumes.length >= 3, '前置：分卷数 >=3')
  memory.setItem('shield-tunnel-construction:segmentprod-export-task', JSON.stringify(partial))

  const resumed = pumpLedgerExport(clerk)
  assertEqual(resumed.state, 'ready', '续打完成后任务应就绪')
  const progress = taskProgress(resumed)
  assertEqual(progress.done, progress.total, '全部卷完成')

  // 捕获最终 ZIP：临时接管 Blob
  const zipBytes: Uint8Array[] = []
  const OriginalBlob = (globalThis as { Blob: typeof Blob }).Blob
  ;(globalThis as { Blob: typeof Blob }).Blob = class {
    constructor(parts: BlobPart[]) {
      for (const part of parts) {
        zipBytes.push(part instanceof ArrayBuffer ? new Uint8Array(part) : (part as Uint8Array))
      }
    }
  } as unknown as typeof Blob
  try {
    downloadLedgerPackage(clerk)
  } finally {
    ;(globalThis as { Blob: typeof Blob }).Blob = OriginalBlob
  }
  const zip = buildZip([]) // 仅为类型占位，实际读捕获字节
  void zip
  assertEqual(zipBytes.length, 1, '下载应只产生一个 Blob（即一个 ZIP，无半包）')
  const packed = readZip(zipBytes[0])
  const names = packed.map((entry) => entry.name)
  const csvCount = names.filter((name) => name.startsWith('台账分卷_')).length
  assertEqual(csvCount, total, `ZIP 内应含 ${total} 卷`)
  assert(names.includes('缺栏点名清单.csv'), '必须含缺栏点名清单')
  assert(names.includes('导出结论.txt'), '必须含导出结论')

  // 校验每卷数据行合计 = 页面行数；且四必带栏在表头
  let dataRows = 0
  for (const entry of packed.filter((item) => item.name.startsWith('台账分卷_'))) {
    const table = dropBlankRows(parseCsv(new TextDecoder().decode(entry.bytes)))
    const header = table[0]
    for (const required of ['管片编号', '钢筋笼批号', '养护天数', '出厂强度']) {
      assert(header.includes(required), `${entry.name} 缺列 ${required}`)
    }
    dataRows += table.length - 1
  }
  assertEqual(dataRows, resumed.totalRows, 'ZIP 数据行数必须等于任务行数=页面行数')

  const conclusion = new TextDecoder().decode(
    packed.find((entry) => entry.name === '导出结论.txt')!.bytes,
  )
  assert(conclusion.includes('本月（2026-10）出厂数：6 条'), `结论应写明本月出厂 6 条：${conclusion}`)
  assert(conclusion.includes(`总条数：${resumed.totalRows} 条`), '结论应写明总条数')

  // 缺栏清单应点名 016
  const report = new TextDecoder().decode(
    packed.find((entry) => entry.name === '缺栏点名清单.csv')!.bytes,
  )
  assert(report.includes('GPC-K1-016'), '缺栏清单必须点到具体管片')
  assert(report.includes('养护天数') && report.includes('出厂强度'), '缺栏清单必须点到列名')

  abortLedgerExport(clerk)
  captureDownload()
  void lastDownload
})

test('导出：打包期间台账变化，续打因指纹不符当场作废', () => {
  abortLedgerExport(clerk)
  startLedgerExport(clerk, {})
  const partial = loadExportTask()!
  partial.volumes.slice(1).forEach((volume) => {
    volume.state = 'pending'
    volume.csv = ''
  })
  memory.setItem('shield-tunnel-construction:segmentprod-export-task', JSON.stringify(partial))

  // 台账动一行（模拟别人办理出厂，走数据层正常落盘）
  const rowsNow = listRows('segmentprod')
  const target = rowsNow.find((row) => String(row.status) === '待浇筑')!
  const originalRows = rowsNow.map((row) => ({ ...row }))
  saveRows(
    'segmentprod',
    canonicalRows(
      rowsNow.map((row) =>
        Number(row.id) === Number(target.id)
          ? { ...row, status: SHIPPED_STATUS, [SHIP_DATE_FIELD]: '2026-10-05' }
          : row,
      ),
    ),
  )

  const failed = pumpLedgerExport(clerk)
  assertEqual(failed.state, 'failed', '数据漂移后任务必须作废')
  assert(failed.failure.includes('台账在打包期间发生变化'), `作废原因应说明口径变化：${failed.failure}`)
  assertThrows(() => downloadLedgerPackage(clerk), '还没打完', '作废任务不得下载')
  abortLedgerExport(clerk)
  // 还原台账，避免污染后续用例
  saveRows('segmentprod', canonicalRows(originalRows))
})

test('导出：带筛选时册子只含筛选后的页面行，行数与卷数对得上', () => {
  abortLedgerExport(clerk)
  const filters = { 管片型号: 'K1' }
  const visible = ledgerView(listRows('segmentprod'), clerk, filters)
  assert(visible.length > 0 && visible.length < 21, 'K1 应为一个非空真子集')
  startLedgerExport(clerk, filters)
  const ready = pumpLedgerExport(clerk)
  assertEqual(ready.state, 'ready', '筛选导出也应完成')
  assertEqual(ready.totalRows, visible.length, '任务行数必须等于筛选后页面行数')
  const zipBytes: Uint8Array[] = []
  const OriginalBlob = (globalThis as { Blob: typeof Blob }).Blob
  ;(globalThis as { Blob: typeof Blob }).Blob = class {
    constructor(parts: BlobPart[]) {
      for (const part of parts) zipBytes.push(part instanceof ArrayBuffer ? new Uint8Array(part) : (part as Uint8Array))
    }
  } as unknown as typeof Blob
  try {
    downloadLedgerPackage(clerk)
  } finally {
    ;(globalThis as { Blob: typeof Blob }).Blob = OriginalBlob
  }
  const packed = readZip(zipBytes[0])
  let dataRows = 0
  for (const entry of packed.filter((item) => item.name.startsWith('台账分卷_'))) {
    const table = dropBlankRows(parseCsv(new TextDecoder().decode(entry.bytes)))
    dataRows += table.length - 1
    for (const row of table.slice(1)) {
      assert(row[1].includes('K1'), `卷内只应有 K1 型号行：${row[1]}`)
    }
  }
  assertEqual(dataRows, visible.length, 'ZIP 行数=筛选页面行数')
  abortLedgerExport(clerk)
})

test('导入：同号覆盖不追加，空白列保留原值，新号新增为已出厂', () => {
  const before = listRows('segmentprod').length
  // 007 补出厂强度（原值 53.4 保留型号等），并故意留空型号验证不冲值；新增 X-100
  const csv = toCsv([
    ['管片编号', '管片型号', '生产模具', '钢筋笼批号', '养护天数', '出厂强度', '生产日期', '出厂日期'],
    ['GPC-A3-007', '', '', '', '', '55.0', '', ''],
    ['GPC-NEW-100', 'K1（封顶块）', 'M-09', 'JLL-NEW', '28', '52.0', '2026-10-04', '2026-10-05'],
  ], false)
  const result = importLedgerCsv(csv, clerk)
  assertEqual(result.updated, 1, '应覆盖 1 条')
  assertEqual(result.inserted, 1, '应新增 1 条')
  const rows = listRows('segmentprod')
  assertEqual(rows.length, before + 1, '同号覆盖不追加，总数只 +1')
  const updated = rows.find((row) => cellText(row, CODE_FIELD) === 'GPC-A3-007')!
  assertEqual(cellText(updated, STRENGTH_FIELD), '55.0', '强度被覆盖')
  assertEqual(cellText(updated, '管片型号'), 'A3（标准块）', '空白列不得冲掉原型号')
  assertEqual(String(updated.status), SHIPPED_STATUS, '回导行状态为已出厂')
  const created = rows.find((row) => cellText(row, CODE_FIELD) === 'GPC-NEW-100')!
  assertEqual(String(created.status), SHIPPED_STATUS, '新增行直接已出厂')
  assertEqual(cellText(created, '所属工区'), '盾构一工区', '新增行归属本工区')
})

test('导入：文件内同号重复只入一次；坏行单列原因且不入库', () => {
  const csv = toCsv([
    ['管片编号', '养护天数', '出厂强度', '生产日期'],
    ['GPC-A3-008', '30', '53.0', '2026-09-08'],
    ['GPC-A3-008', '99', '99.9', '2026-09-08'],
    ['GPC-BAD-1', '不是数字', '50.0', '2026-10-01'],
    ['GPC-BAD-2', '10', '50.0', '2026-13-40'],
    ['', '1', '2', '2026-10-01'],
  ], false)
  const result = importLedgerCsv(csv, clerk)
  assertEqual(result.updated, 1, '同号两行只更新一次')
  assertEqual(result.duplicatedInFile, 1, '重复行计数 1')
  assertEqual(result.failed, 3, '坏行数=3（格式坏2 + 缺编号1），重复行不算失败')
  const reasons = result.problems.map((problem) => problem.reason).join('|')
  assert(reasons.includes('与本文件前面的行重复'), '重复原因写清')
  assert(reasons.includes('养护天数'), '数值错误点到列')
  assert(reasons.includes('YYYY-MM-DD'), '日期错误点到格式')
  assert(reasons.includes('管片编号'), '缺编号点到列')
  const updated = listRows('segmentprod').find((row) => cellText(row, CODE_FIELD) === 'GPC-A3-008')!
  assertEqual(cellText(updated, CURE_FIELD), '30', '重复提交以首次内容为准，不能被第二行改成 99')
  assert(result.reportCsv.includes('原因'), '失败清单 CSV 含原因列')
})

test('导入：存储配额不足时整体撤销，库维持原样', () => {
  const beforeSnapshot = JSON.stringify(listRows('segmentprod'))
  memory.forceQuota = true
  const csv = toCsv([
    ['管片编号', '养护天数'],
    ['GPC-A3-009', '29'],
    ['GPC-NEW-200', '28'],
  ], false)
  assertThrows(() => importLedgerCsv(csv, clerk), '整体撤销', '配额失败必须整体撤销')
  memory.forceQuota = false
  assertEqual(JSON.stringify(listRows('segmentprod')), beforeSnapshot, '撤销后库必须原样')
})

test('迁移：旧库的管片首次读取即按生产日期重排（schema 升级）', () => {
  memory.clear()
  __resetCacheForTest()
  const old = {
    segmentprod: [
      { id: 2, status: '待出厂', pending: false, abnormal: false, 管片编号: 'B', 生产日期: '2026-10-02', 所属工区: '盾构一工区' },
      { id: 1, status: '养护中', pending: true, abnormal: false, 管片编号: 'A', 生产日期: '2026-09-01', 所属工区: '盾构一工区' },
      { id: 3, status: '已出厂', pending: false, abnormal: false, 管片编号: 'C', 生产日期: '2026-09-20', 所属工区: '盾构一工区' },
    ],
  }
  memory.setItem('shield-tunnel-construction:entries', JSON.stringify(old))
  // 不写 schema key：模拟 v1 老用户
  const migrated = listRows('segmentprod')
  assertDeepEqual(migrated.map((row) => row.管片编号), ['A', 'C', 'B'], '存量必须按生产日期重排')
  assertEqual(memory.getItem('shield-tunnel-construction:schema-version'), '2', '迁移后版本号写为 2')
})

finish()
