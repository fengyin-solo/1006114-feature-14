/**
 * 服务层端到端冒烟：权限拒绝、登记幂等、导入覆盖与失败行、配额满整体撤销、存量重排迁移。
 * 运行：node scripts/verify-service.mjs
 */
import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const tmp = path.join(root, 'node_modules', '.verify-svc')

// 预置「老版本 + 乱序」的管片存档，验证 schema v2 迁移会按生产日期重排。
const legacyRows = [
  { id: 3, status: '待出厂', pending: true, abnormal: false, '管片编号': 'SEGM-0003', '生产日期': '2026-09-20' },
  { id: 1, status: '已出厂', pending: false, abnormal: false, '管片编号': 'SEGM-0001', '生产日期': '2026-08-01' },
  { id: 2, status: '养护中', pending: true, abnormal: false, '管片编号': 'SEGM-0002', '生产日期': '2026-09-01' },
]
const storage = new Map()
storage.set('shield-tunnel-construction:entries', JSON.stringify({ segmentprod: legacyRows }))
storage.set('shield-tunnel-construction:schema', '1')
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
}
// 数据层判的是 window.localStorage，Node 里补一个 window 垫片。
globalThis.window = { localStorage: globalThis.localStorage }

async function loadTs(relative, externals = []) {
  await build({
    entryPoints: [path.join(root, relative)],
    outdir: tmp,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    alias: { '@': path.join(root, 'src') },
    external: externals,
  })
  return import(pathToFileURL(path.join(tmp, path.basename(relative).replace(/\.ts$/, '.js'))).href + `?t=${Date.now()}`)
}

/** 多模块共用时从一个入口打一个包，避免 local-store / pinia 被重复实例化。 */
async function loadBundle(entrySource) {
  const entry = path.join(tmp, '_entry.ts')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(entry, entrySource, 'utf-8')
  await build({
    entryPoints: [entry],
    outfile: path.join(tmp, '_bundle.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    alias: { '@': path.join(root, 'src') },
    external: ['pinia'],
  })
  return import(pathToFileURL(path.join(tmp, '_bundle.js')).href + `?t=${Date.now()}`)
}

let failures = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS ${name}`)
  } else {
    failures += 1
    console.error(`FAIL ${name} ${detail}`)
  }
}

// 1) 迁移先于任何 store 读取：首次加载即按生产日期重排。
const localStore = await loadTs('src/data/local-store.ts')
const migrated = localStore.listRows('segmentprod')
check('存量管片按生产日期重排（id 顺序 1,2,3）',
  migrated.map((r) => r.id).join(',') === '1,2,3',
  migrated.map((r) => r.id).join(','))
check('迁移写入 schema=2', storage.get('shield-tunnel-construction:schema') === '2')

// 之后统一用迁移后的 seed（重置成 seed 以便后续断言）。
localStore.resetRows('segmentprod')

// pinia 必须在加载使用 store 的模块前激活；内部模块打成一个 bundle 保证 store 单例。
const { createPinia, setActivePinia } = await import('pinia')
setActivePinia(createPinia())
const bundle = await loadBundle(`
export { listRows, resetRows } from '@/data/local-store'
export * as csv from '@/data/csv'
export { useSessionStore } from '@/stores/session'
export * from '@/api/segment-service'
`)
const csv = bundle.csv
const session = bundle.useSessionStore()
const service = bundle

// 默认监理（u-002）→ 越权当场拒绝
check('默认进入身份是监理', session.account.id === 'u-002')
let denied = null
try {
  service.upsertSegment({ '管片编号': 'SEGM-0001' })
} catch (e) {
  denied = e
}
check('监理登记被当场拒绝(FORBIDDEN)', denied && denied.code === 'FORBIDDEN', String(denied))
let deniedImport = null
try {
  service.importSegmentSupplements('管片编号\nSEGM-0001')
} catch (e) {
  deniedImport = e
}
check('监理导入被当场拒绝', deniedImport && deniedImport.code === 'FORBIDDEN')
let deniedExport = null
try {
  await service.stageSegmentExport({})
} catch (e) {
  deniedExport = e
}
check('监理导出被当场拒绝', deniedExport && deniedExport.code === 'FORBIDDEN')

// 切到本工区资料员
session.switchAccount('u-001')
check('资料员具备台账权限', session.canManageLedger === true)
// 二工区资料员仍然越权
session.switchAccount('u-003')
check('跨工区资料员仍被拒绝', (() => {
  try { service.upsertSegment({ '管片编号': 'X' }); return false } catch (e) { return e.code === 'FORBIDDEN' }
})())
session.switchAccount('u-001')

const before = bundle.listRows('segmentprod')
const countBefore = before.length

// 2) 登记幂等：新编号插入一次；同编号反复提交只覆盖，不追加。
const r1 = service.upsertSegment({
  '管片编号': 'SEGM-TEST1', '管片型号': 'T', '生产模具': 'M', '生产日期': '2026-10-05', '生产状态': '待浇筑',
})
check('新管片登记成功', r1.ok === true)
check('登记后总数+1', bundle.listRows('segmentprod').length === countBefore + 1)
const r2 = service.upsertSegment({
  '管片编号': 'SEGM-TEST1', '钢筋笼批号': 'G-UPDATED', '生产日期': '2026-10-05', '生产状态': '待浇筑',
})
check('重复登记提示覆盖且不新增', r2.ok === true && r2.duplicated === true)
check('反复提交只入一条（总数不变）', bundle.listRows('segmentprod').length === countBefore + 1)
const updated = bundle.listRows('segmentprod').find((r) => r['管片编号'] === 'SEGM-TEST1')
check('覆盖写入钢筋笼批号', updated['钢筋笼批号'] === 'G-UPDATED')

// 3) 导入补数：已出厂管片按编号覆盖；重复文件幂等；不存在编号进失败清单。
const seg4Before = bundle.listRows('segmentprod').find((r) => r['管片编号'] === 'SEGM-0004')
check('SEGM-0004 导入前出厂强度为空', seg4Before['出厂强度'] === '')
const importText = csv.buildCsv([
  ['管片编号', '钢筋笼批号', '养护天数', '出厂强度'],
  ['SEGM-0004', 'GL-20260920-A01', '28', '55.2'],
  ['SEGM-9999', 'G-X', '1', '1'],          // 台账不存在 → 失败行，不新增
  ['SEGM-0008', 'G', '不是数字', ''],      // 数字非法 → 失败行
])
const imp1 = service.importSegmentSupplements(importText)
check('导入返回覆盖 1 行', imp1.updated === 1, JSON.stringify(imp1))
check('导入失败行 2 条且原因具体',
  imp1.failures.length === 2 && imp1.failures.every((f) => /不存在|数字/.test(f.reason)),
  JSON.stringify(imp1.failures))
check('SEGM-0004 出厂强度已补 55.2',
  bundle.listRows('segmentprod').find((r) => r['管片编号'] === 'SEGM-0004')['出厂强度'] === 55.2)
const totalAfterImport = bundle.listRows('segmentprod').length
check('导入未追加新行', totalAfterImport === countBefore + 1)
// 重复导入同一文件：再覆盖一遍同样的值，仍只一条。
const imp2 = service.importSegmentSupplements(importText)
check('重复导入幂等（仍覆盖1行，总数不变）',
  imp2.updated === 1 && bundle.listRows('segmentprod').length === totalAfterImport)

// 4) 配额满：setItem 抛错 → 整体撤销，内存与已落盘数据都维持导入前。
const originalSet = globalThis.localStorage.setItem
globalThis.localStorage.setItem = (k, v) => {
  if (k === 'shield-tunnel-construction:entries') {
    const err = new Error('QuotaExceededError')
    err.name = 'QuotaExceededError'
    throw err
  }
  return storage.set(k, v)
}
const strengthBeforeQuota = bundle.listRows('segmentprod')
  .find((r) => r['管片编号'] === 'SEGM-0007')['出厂强度']
const quotaText = csv.buildCsv([
  ['管片编号', '出厂强度'],
  ['SEGM-0007', '60.0'],
])
const quotaRes = service.importSegmentSupplements(quotaText)
globalThis.localStorage.setItem = originalSet
check('配额满返回失败并提示整体撤销', quotaRes.ok === false && /整体撤销/.test(quotaRes.message), quotaRes.message)
check('整体撤销：SEGM-0007 强度维持原值',
  bundle.listRows('segmentprod').find((r) => r['管片编号'] === 'SEGM-0007')['出厂强度'] === strengthBeforeQuota)

// 5) 本月出厂数与领域口径一致（同源函数）。
const metrics = service.segmentLedgerMetrics(new Date('2026-10-05T00:00:00Z'))
const shippedOct = bundle.listRows('segmentprod')
  .filter((r) => r.status === '已出厂' && String(r['出厂日期']).startsWith('2026-10')).length
check('segmentLedgerMetrics 本月出厂数与直接统计一致', metrics.monthShipped === shippedOct,
  `${metrics.monthShipped} vs ${shippedOct}`)

if (failures > 0) {
  console.error(`\n${failures} 项校验失败`)
  process.exit(1)
}
console.log('\n全部通过')
