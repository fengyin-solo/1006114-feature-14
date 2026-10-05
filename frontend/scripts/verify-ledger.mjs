/**
 * 纯逻辑冒烟测试（node --import tsx 不依赖第三方，手写极简 TS 转译用 esbuild 不便，
 * 因此本文件直接用 JS 引编译产物不可行——改为用 vite 的 esbuild 临时转译后执行）。
 *
 * 运行：node scripts/verify-ledger.mjs
 * 不进生产包，仅用于本地核对口径。
 */
import { build, transform } from 'esbuild'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const root = process.cwd()

async function loadTs(relative, outDir) {
  const full = path.join(root, relative)
  await build({
    entryPoints: [full],
    outdir: outDir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    alias: { '@': path.join(root, 'src') },
  })
  const name = path.basename(relative).replace(/\.ts$/, '.js')
  return import(pathToFileURL(path.join(outDir, name)).href)
}

const tmp = path.join(root, 'node_modules', '.verify-tmp')
await rm(tmp, { recursive: true, force: true })
await mkdir(tmp, { recursive: true })

// 给本地存储层一个最小 localStorage 垫片（Node 20 自带 crypto）。
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
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

const csv = await loadTs('src/data/csv.ts', tmp)
const ledger = await loadTs('src/data/segment-ledger.ts', tmp)
const zipMod = await loadTs('src/data/zip.ts', tmp)

// 构造一批样例行，覆盖分卷/缺栏/出厂。
function row(id, model, mold, cage, prod, cure, strength, ship, status) {
  return {
    id, status, pending: status !== '已出厂', abnormal: false,
    '管片编号': `SEGM-${String(id).padStart(4, '0')}`,
    '管片型号': model, '生产模具': mold, '钢筋笼批号': cage,
    '生产日期': prod, '养护天数': cure, '出厂强度': strength,
    '出厂日期': ship, '检验人员': '王质检', '生产状态': status,
  }
}
const rows = [
  row(2, 'K块', 'MD-01', 'G1', '2026-10-02', 28, 52, '2026-10-04', '已出厂'),
  row(1, 'K块', 'MD-01', 'G0', '2026-09-01', 28, 51, '2026-09-28', '已出厂'),
  row(3, 'K块', 'MD-02', 'G2', '2026-10-03', '', '', '', '待出厂'),
  row(4, 'L块', 'MD-03', 'G3', '2026-10-05', 3, '', '', '养护中'),
]
const groups = ledger.groupSegmentRows(rows)
check('按型号+模具分出 3 卷', groups.length === 3, `got ${groups.length}`)
check('组内行按生产日期排序', groups[0].rows[0].id === 1 && groups[0].rows[1].id === 2)

const month = '2026-10'
check('本月出厂数=1（10月只出厂 id2）', ledger.monthShippedCount(rows, month) === 1,
  `got ${ledger.monthShippedCount(rows, month)}`)

const files = [
  ...groups.map(ledger.buildLedgerFile),
  ledger.buildMissingFile(groups),
  ledger.buildDeliveryFile(rows, month, '一工区'),
]
const parsedK = csv.parseCsv(files[0].content)
check('台账卷表头四列', JSON.stringify(parsedK[0]) === JSON.stringify(['管片编号', '钢筋笼批号', '养护天数', '出厂强度']))
check('台账卷行数=2 且首行 SEGM-0001', parsedK.length === 3 && parsedK[1][0] === 'SEGM-0001', JSON.stringify(parsedK))
const missing = files.find((f) => f.kind === 'missing')
const missingText = missing.content
check('缺栏清单点名到 养护天数 与 出厂强度', missingText.includes('养护天数') && missingText.includes('出厂强度'))
check('缺栏清单点到具体编号 SEGM-0003', missingText.includes('SEGM-0003'))
check('完整四列行不在缺栏清单里', !missingText.includes('SEGM-0001'))

// 分块与 CRC
const text = files[0].content
const pieces = []
const bytes = ledger.toUtf8(text)
for (let i = 0; i < bytes.length; i += 20) pieces.push(bytes.slice(i, i + 20))
const merged = new Uint8Array(bytes.length)
let off = 0
for (const p of pieces) { merged.set(p, off); off += p.length }
check('分块拼回 CRC 一致', ledger.crc32(merged) === ledger.crc32(bytes))

// 交付文件总数行
const delivery = files.find((f) => f.kind === 'delivery').content
check('交付清单含本月合计=1', delivery.includes('本月出厂数合计,1'), delivery.split('\n').slice(-1)[0])

// CSV 转义/解析往返（含逗号、引号、换行的字段必须被 csvLine 加引号）
const escaped = csv.buildCsv([['a,b', '带"引号', '行\r\n内']])
const back = csv.parseCsv(escaped)
check('CSV 引号/逗号/换行往返', back[0][0] === 'a,b' && back[0][1] === '带"引号' && back[0][2] === '行\r\n内', JSON.stringify(back))

// ZIP 结构：最小解包本地头验证签名与 CRC
const entries = files.map((f) => ({ path: f.path, bytes: ledger.toUtf8(f.content) }))
// node Blob
const blob = zipMod.buildZip(entries, new Date('2026-10-05T08:00:00Z'))
const ab = await blob.arrayBuffer()
const u8 = new Uint8Array(ab)
const view = new DataView(ab)
check('ZIP 本地头签名', view.getUint32(0, true) === 0x04034b50)
check('ZIP EOCD 签名', (() => {
  for (let i = u8.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      const count = view.getUint16(i + 10, true)
      return count === entries.length
    }
  }
  return false
})(), 'eocd entries mismatch')

// 用 Node zlib 层不支持 STORED 解析，这里手工按本地头顺序抽 payload 校验。
let pos = 0
let extractedOk = 0
while (view.getUint32(pos, true) === 0x04034b50) {
  const method = view.getUint16(pos + 8, true)
  const crc = view.getUint32(pos + 14, true)
  const size = view.getUint32(pos + 18, true)
  const nameLen = view.getUint16(pos + 26, true)
  const extraLen = view.getUint16(pos + 28, true)
  const dataStart = pos + 30 + nameLen + extraLen
  const payload = u8.slice(dataStart, dataStart + size)
  if (method === 0 && ledger.crc32(payload) === crc) extractedOk += 1
  pos = dataStart + size
}
check('ZIP 每卷 STORED 且 CRC 全部对得上', extractedOk === entries.length, `${extractedOk}/${entries.length}`)

// 导入解析：覆盖键、数字校验、缺编号
const imp = await loadTs('src/api/segment-service.ts', tmp)
const sampleCsv = csv.buildCsv([
  ['管片编号', '钢筋笼批号', '养护天数', '出厂强度'],
  ['SEGM-0001', 'GNEW', '28', '52.8'],
  ['SEGM-0001', 'GNEW2', '28', '53.1'], // 文件内重复，只留一条（后行覆盖）
  ['SEGM-0003', '', 'abc', ''],       // 养护天数非数字 → 失败行
  ['', 'GX', '1', '1'],               // 无编号 → 失败行
])
const parsed = imp.parseSegmentImport(sampleCsv)
check('导入文件内重复编号合并为 1 条', parsed.parsed.length === 1 && parsed.dedupedInFile === 1)
check('导入取后行覆盖前行 GNEW2', parsed.parsed[0]?.values['钢筋笼批号'] === 'GNEW2')
check('导入失败行=2 且原因清晰', parsed.failures.length === 2 && parsed.failures.every((f) => f.reason.length > 0),
  JSON.stringify(parsed.failures))

// 打包确定性：同数据重建 checksum/plan 必须一致（断点续传与新鲜度校验的前提）
const pkgA = imp.buildSegmentPackage({}, new Date('2026-10-05T00:00:00Z'))
const pkgB = imp.buildSegmentPackage({}, new Date('2026-10-05T00:00:00Z'))
check('同数据打包 checksum 稳定', pkgA.checksum === pkgB.checksum, `${pkgA.checksum} vs ${pkgB.checksum}`)
check('打包行数 == querySegmentRows 全量行数',
  pkgA.rows.length === ledger.querySegmentRows({}).length,
  `${pkgA.rows.length} vs ${ledger.querySegmentRows({}).length}`)
const ledgerRows = pkgA.plan.filter((p) => p.kind === 'ledger').reduce((s, p) => s + p.rowCount, 0)
check('各台账卷行数之和 == 打包总行数', ledgerRows === pkgA.rows.length, `${ledgerRows} vs ${pkgA.rows.length}`)
check('计划行数与各卷文件实际数据行一致（无丢卷/多卷）',
  pkgA.files.filter((f) => f.kind === 'ledger')
    .every((f) => pkgA.plan.find((p) => p.path === f.path).rowCount === f.rows.length))
const manifestText = ledger.buildManifestText(pkgA.plan, {
  scopeLabel: '一工区', month: pkgA.month, monthShipped: pkgA.monthShipped,
  rowCount: pkgA.rows.length, checksum: pkgA.checksum, filters: {}, actorName: '李资料', createdAt: '2026-10-05T08:00:00.000Z',
})
check('包清单写明总行数', manifestText.includes(`台账总行数（与页面一致）,${pkgA.rows.length}`))
check('包清单写明本月出厂数', manifestText.includes(`本月出厂数（与进度节点交付清单一致）,${pkgA.monthShipped}`))
// 状态过滤口径
const shippedPkg = imp.buildSegmentPackage({}, new Date('2026-10-05T00:00:00Z'), '已出厂')
check('状态过滤后包内只剩已出厂行',
  shippedPkg.rows.length > 0 && shippedPkg.rows.every((r) => r.status === '已出厂'))

if (failures > 0) {
  console.error(`\n${failures} 项校验失败`)
  process.exit(1)
}
console.log('\n全部通过')
