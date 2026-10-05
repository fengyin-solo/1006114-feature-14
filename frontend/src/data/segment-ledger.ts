import { buildCsv, csvLine, isBlank } from '@/data/csv'
import { listRows } from '@/data/local-store'
import type { EntryRow, ExportFilePlan } from '@/data/types'

/**
 * 管片生产台账领域层：页面表格、出厂打包、进度节点交付清单、看板统计全部走这里，
 * 保证「两处读到的本月出厂数不能两套」「页面看到的行与打包出来的行必须一样」。
 */

export const SEGMENT_KEY = 'segmentprod'

/** 建设单位台账必交的列 + 完整列（页面口径）。 */
export const SEGMENT_COLUMNS: string[] = [
  '管片编号', '管片型号', '生产模具', '钢筋笼批号',
  '生产日期', '养护天数', '出厂强度', '出厂日期', '检验人员', '生产状态',
]
export const LEDGER_COLUMNS: string[] = [
  '管片编号', '钢筋笼批号', '养护天数', '出厂强度',
]

/** 台账行稳定排序：生产日期升序，同日按管片编号升序。打包与页面都用这一份顺序。 */
export function compareSegmentRows(a: EntryRow, b: EntryRow): number {
  const da = String(a['生产日期'] ?? '')
  const db = String(b['生产日期'] ?? '')
  if (da && db && da !== db) {
    return da < db ? -1 : 1
  }
  if (da !== db) {
    return da ? -1 : 1
  }
  const na = String(a['管片编号'] ?? '')
  const nb = String(b['管片编号'] ?? '')
  if (na !== nb) {
    return na < nb ? -1 : 1
  }
  return Number(a.id) - Number(b.id)
}

export type SegmentFilter = Record<string, string>

/** 唯一列表口径：筛选条件与页面查询框一致；排序固定。页面与导出必须读这同一个结果。 */
export function querySegmentRows(filters: SegmentFilter = {}): EntryRow[] {
  const pairs = Object.entries(filters)
    .map(([field, value]) => [field, value.trim()] as const)
    .filter(([, value]) => value !== '')
  return listRows(SEGMENT_KEY)
    .filter((row) =>
      pairs.every(([field, value]) => String(row[field] ?? '').includes(value)),
    )
    .sort(compareSegmentRows)
}

/** 按 管片型号 + 生产模具 分卷。分组键缺失归入「未分配模具」卷，绝不丢行。 */
export type SegmentGroup = { model: string; mold: string; rows: EntryRow[] }

export function groupSegmentRows(rows: EntryRow[]): SegmentGroup[] {
  const groups = new Map<string, SegmentGroup>()
  for (const row of rows) {
    const model = isBlank(row['管片型号']) ? '未填写型号' : String(row['管片型号'])
    const mold = isBlank(row['生产模具']) ? '未填写模具' : String(row['生产模具'])
    const key = `${model} ${mold}`
    let group = groups.get(key)
    if (!group) {
      group = { model, mold, rows: [] }
      groups.set(key, group)
    }
    group.rows.push(row)
  }
  return [...groups.values()]
    .map((group) => ({ ...group, rows: group.rows.sort(compareSegmentRows) }))
    .sort((a, b) => (a.model === b.model
      ? (a.mold < b.mold ? -1 : a.mold > b.mold ? 1 : 0)
      : (a.model < b.model ? -1 : 1)))
}

/** 本月出厂数：以出厂日期所在年月为准。导出任务与进度交付清单共用这一个函数。 */
export function monthShippedCount(rows: EntryRow[], month: string): number {
  return rows.filter((row) =>
    String(row.status) === '已出厂' && String(row['出厂日期'] ?? '').startsWith(month),
  ).length
}

export function currentMonth(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** 文件名安全化：只保留常见中日韩与字母数字，其余替换，防路径穿越。 */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '_').replace(/[ ._]+$/g, '').replace(/^[ ._]+/g, '') || '未命名'
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let crc = i
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
    table[i] = crc >>> 0
  }
  return table
})()

/** CRC32：给每卷与整包做校验，换机/重导出对不上行数或校验和就能立刻发现。 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function toUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export type MissingColumnNote = {
  column: string
  rowIds: number[]
  segmentNos: string[]
}

/** 点名到列：交建设单位的必交列里哪些行是空的，逐列列清楚（不允许整列静默留空）。 */
export function findMissingColumns(rows: EntryRow[]): MissingColumnNote[] {
  return LEDGER_COLUMNS
    .map((column) => {
      const missing = rows.filter((row) => isBlank(row[column]))
      return {
        column,
        rowIds: missing.map((row) => Number(row.id)),
        segmentNos: missing.map((row) => String(row['管片编号'] ?? `#${row.id}`)),
      }
    })
    .filter((note) => note.rowIds.length > 0)
}

export type LedgerFileContent = {
  path: string
  kind: ExportFilePlan['kind']
  model: string
  mold: string
  rows: EntryRow[]
  content: string
}

/** 每一卷台账的 CSV：只放必交四列，表头固定，行数可核。 */
export function buildLedgerFile(group: SegmentGroup): LedgerFileContent {
  const rows = group.rows
  const body = rows.map((row) => LEDGER_COLUMNS.map((column) => {
    const value = row[column]
    return isBlank(value) ? '' : value
  }))
  const content = buildCsv([LEDGER_COLUMNS, ...body])
  const modelPart = safeName(group.model)
  const moldPart = safeName(group.mold)
  return {
    path: `台账/${modelPart}/${modelPart}_${moldPart}_管片台账.csv`,
    kind: 'ledger',
    model: group.model,
    mold: group.mold,
    rows,
    content,
  }
}

/** 缺栏清单：哪一卷的哪几行缺哪一必填列，写清楚管片编号，建设单位照单可查。 */
export function buildMissingFile(groups: SegmentGroup[]): LedgerFileContent {
  const header = ['管片型号', '生产模具', '空缺列', '管片编号', '系统行号']
  const body: string[][] = []
  for (const group of groups) {
    for (const note of findMissingColumns(group.rows)) {
      note.segmentNos.forEach((segmentNo, index) => {
        body.push([group.model, group.mold, note.column, segmentNo, String(note.rowIds[index])])
      })
    }
  }
  if (body.length === 0) {
    body.push(['（无）', '', '必交列全部已填', '', ''])
  }
  return {
    path: '台账/00_缺栏清单.csv',
    kind: 'missing',
    model: '',
    mold: '',
    rows: [],
    content: buildCsv([header, ...body]),
  }
}

/**
 * 交付清单：进度节点页与本台账两处读同一份数字。
 * 本月出厂数严格取自 monthShippedCount，不再各算各的。
 */
export function buildDeliveryFile(rows: EntryRow[], month: string, scopeLabel: string): LedgerFileContent {
  const shipped = rows.filter((row) =>
    String(row.status) === '已出厂' && String(row['出厂日期'] ?? '').startsWith(month))
  const byDay = new Map<string, number>()
  for (const row of shipped) {
    const day = String(row['出厂日期'] ?? '').slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }
  const body = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, count]) => [day, count])
  const header = ['出厂日期', '出厂管片数']
  const totalLine = ['本月出厂数合计', monthShippedCount(rows, month)]
  const metaLines = [
    ['工区', scopeLabel],
    ['统计月份', month],
  ]
  const content = buildCsv([
    ...metaLines.map((line) => line.map(String)),
    [''],
    header,
    ...body,
    totalLine,
  ])
  return {
    path: '台账/00_本月出厂交付清单.csv',
    kind: 'delivery',
    model: '',
    mold: '',
    rows: shipped,
    content,
  }
}

/** 包清单：列清每卷路径/行数/字节/CRC/分块数，整包行数与 CRC 写在头部，供双方核对。 */
export function buildManifestText(
  plan: ExportFilePlan[],
  context: {
    scopeLabel: string
    month: string
    monthShipped: number
    rowCount: number
    checksum: string
    filters: Record<string, string>
    actorName: string
    createdAt: string
  },
): string {
  const head = [
    ['工区', context.scopeLabel],
    ['打包时间', context.createdAt],
    ['打包人', context.actorName],
    ['筛选条件', JSON.stringify(context.filters)],
    ['台账总行数（与页面一致）', context.rowCount],
    ['整包数据CRC32', context.checksum],
    ['统计月份', context.month],
    ['本月出厂数（与进度节点交付清单一致）', context.monthShipped],
    ['文件卷数', plan.length],
  ].map((line) => line.map(String))
  const fileHeader = ['包内路径', '类型', '管片型号', '生产模具', '行数', '字节数', 'CRC32', '分块数']
  const fileBody = plan.map((file) => [
    file.path, file.kind, file.model, file.mold,
    String(file.rowCount), String(file.size), String(file.crc), String(file.chunks),
  ])
  return buildCsv([...head, [''], [fileHeader, ...fileBody].flat()])
}

export function makeFilePlan(file: LedgerFileContent, chunkSize: number): ExportFilePlan {
  const bytes = toUtf8(file.content)
  return {
    path: file.path,
    kind: file.kind,
    model: file.model,
    mold: file.mold,
    rowCount: file.rows.length,
    size: bytes.length,
    crc: crc32(bytes),
    chunks: Math.max(1, Math.ceil(bytes.length / chunkSize)),
  }
}

/** 整包校验和：把「包内路径+文件CRC」串起来再取 CRC；任何一卷换内容都会变。 */
export function packageChecksum(files: { path: string; content: string }[]): string {
  const digestInput = files
    .map((file) => `${csvLine([file.path, String(crc32(toUtf8(file.content)))])}`)
    .join('\n')
  return crc32(toUtf8(digestInput)).toString(16).padStart(8, '0')
}
