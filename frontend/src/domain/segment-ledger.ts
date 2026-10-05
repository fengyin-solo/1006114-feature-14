// 管片生产台账的领域口径：唯一排序、页面/打包同一视图、分卷、缺栏点名、
// 本月出厂数、交付清单。页面、导出、导入、进度节点全部从这里取数，不允许各算各的。

import type { EntryRow } from '@/data/types'

export const SEGMENT_KEY = 'segmentprod'

// 台账业务键，也是导出/导入覆盖的唯一键。
export const CODE_FIELD = '管片编号'
export const MODEL_FIELD = '管片型号'
export const MOLD_FIELD = '生产模具'
export const CAGE_FIELD = '钢筋笼批号'
export const CURE_FIELD = '养护天数'
export const STRENGTH_FIELD = '出厂强度'
export const PROD_DATE_FIELD = '生产日期'
export const SHIP_DATE_FIELD = '出厂日期'
export const ZONE_FIELD = '所属工区'
export const SHIPPED_STATUS = '已出厂'

// 交给建设单位的册子每卷必带的四栏，少一栏都要在缺栏清单里点名。
export const LEDGER_REQUIRED_COLUMNS = [CODE_FIELD, CAGE_FIELD, CURE_FIELD, STRENGTH_FIELD] as const
// 册子每卷的完整列：分组键 + 四个必带栏 + 生产日期/出厂日期。
export const LEDGER_VOLUME_COLUMNS = [
  CODE_FIELD,
  MODEL_FIELD,
  MOLD_FIELD,
  CAGE_FIELD,
  CURE_FIELD,
  STRENGTH_FIELD,
  PROD_DATE_FIELD,
  SHIP_DATE_FIELD,
] as const

export type LedgerAuthority = {
  role: string
  zone: string
}

export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === ''
}

export function cellText(row: EntryRow, field: string): string {
  const value = row[field]
  return isBlank(value) ? '' : String(value).trim()
}

// 非法文件名字符替换，防止分卷名里出现路径分隔符。
export function safeNamePart(value: string): string {
  const text = value.trim() === '' ? '未填写' : value.trim()
  return text.replace(/[\\/:*?"<>|\s]+/g, '_')
}

// 唯一排序：生产日期升序，同日再按管片编号。所有页面列表、分卷内行序、
// 存量重排、数据指纹都走它 —— 这是“换台机器行数/行序必须一致”的根。
export function canonicalCompare(a: EntryRow, b: EntryRow): number {
  const dateA = cellText(a, PROD_DATE_FIELD)
  const dateB = cellText(b, PROD_DATE_FIELD)
  if (dateA !== dateB) {
    // 空日期沉底，不污染正常顺序
    if (dateA === '') return 1
    if (dateB === '') return -1
    return dateA < dateB ? -1 : 1
  }
  const codeA = cellText(a, CODE_FIELD) || String(a.id)
  const codeB = cellText(b, CODE_FIELD) || String(b.id)
  return codeA < codeB ? -1 : codeA > codeB ? 1 : Number(a.id) - Number(b.id)
}

export function canonicalRows(rows: EntryRow[]): EntryRow[] {
  return [...rows].sort(canonicalCompare)
}

// 与页面 filterRows 等价的本地匹配：本层不能反向依赖 api/local-service，
// 否则会形成导入/导出 → 服务层 → 领域层的循环依赖。
export function applyViewFilters(
  rows: EntryRow[],
  filters: Record<string, string> = {},
): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => cellText(row, field).includes(value.trim())),
  )
}

// 页面能看到的行 = 本工区 + 筛选 + 唯一排序。导出打包必须吃同一份。
export function ledgerView(
  allRows: EntryRow[],
  authority: LedgerAuthority,
  filters: Record<string, string> = {},
): EntryRow[] {
  const inZone = allRows.filter((row) => cellText(row, ZONE_FIELD) === authority.zone)
  return canonicalRows(applyViewFilters(inZone, filters))
}

export type MissingCell = {
  id: number
  code: string
  field: string
}

// 逐条、逐栏点名：页面上是空（—）的，册子里同样留空，并在缺栏清单里点到列。
export function findMissingCells(rows: EntryRow[]): MissingCell[] {
  const missing: MissingCell[] = []
  for (const row of rows) {
    for (const field of LEDGER_REQUIRED_COLUMNS) {
      if (isBlank(row[field])) {
        missing.push({ id: Number(row.id), code: cellText(row, CODE_FIELD), field })
      }
    }
  }
  return missing
}

export type LedgerVolume = {
  key: string
  model: string
  mold: string
  filename: string
  rows: EntryRow[]
}

// 打包口径（由我取舍）：管片型号 + 生产模具 合起来一卷；型号/模具缺失的
// 进“未填写”卷，保证一行不漏；卷内沿用唯一排序。
export function groupLedgerVolumes(rows: EntryRow[]): LedgerVolume[] {
  const groups = new Map<string, EntryRow[]>()
  for (const row of rows) {
    const model = cellText(row, MODEL_FIELD) || '未填写'
    const mold = cellText(row, MOLD_FIELD) || '未填写'
    const key = `${model}__${mold}`
    const list = groups.get(key)
    if (list) {
      list.push(row)
    } else {
      groups.set(key, [row])
    }
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const sorted = canonicalRows(list)
      const model = cellText(sorted[0], MODEL_FIELD) || '未填写'
      const mold = cellText(sorted[0], MOLD_FIELD) || '未填写'
      return {
        key,
        model,
        mold,
        filename: `台账分卷_${safeNamePart(model)}_${safeNamePart(mold)}.csv`,
        rows: sorted,
      }
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

export function currentMonth(now: Date = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  return `${now.getFullYear()}-${mm}`
}

// 本月出厂：状态“已出厂”且出厂日期落在该月。台账页与进度节点共用此口径。
export function shippedThisMonth(rows: EntryRow[], month: string = currentMonth()): EntryRow[] {
  return rows.filter(
    (row) =>
      String(row.status) === SHIPPED_STATUS &&
      cellText(row, SHIP_DATE_FIELD).startsWith(month),
  )
}

export type LedgerStats = {
  curing: number
  waiting: number
  shippedThisMonth: number
  total: number
}

export function ledgerStats(rows: EntryRow[], month: string = currentMonth()): LedgerStats {
  return {
    curing: rows.filter((row) => String(row.status) === '养护中').length,
    waiting: rows.filter((row) => String(row.status) === '待出厂').length,
    shippedThisMonth: shippedThisMonth(rows, month).length,
    total: rows.length,
  }
}

export type DeliveryListItem = {
  code: string
  model: string
  mold: string
  shipDate: string
  strength: string
}

// 进度节点的交付清单直接读台账：两处“本月出厂数”来自同一个函数、同一份数据。
export function deliveryList(
  rows: EntryRow[],
  month: string = currentMonth(),
): DeliveryListItem[] {
  return shippedThisMonth(rows, month).map((row) => ({
    code: cellText(row, CODE_FIELD),
    model: cellText(row, MODEL_FIELD),
    mold: cellText(row, MOLD_FIELD),
    shipDate: cellText(row, SHIP_DATE_FIELD),
    strength: cellText(row, STRENGTH_FIELD),
  }))
}

// 数据指纹：页面可见行（含顺序、必带栏取值、状态、出厂日期）的稳定散列。
// 打包进行中台账若发生变化，继续打出来的册子就和当前页面不是同一份了 ——
// 这种“断口续打后数据已变”的任务直接作废重来，不允许凑在一起。
export function ledgerFingerprint(rows: EntryRow[]): string {
  const basis = rows.map((row) =>
    [
      String(row.id),
      cellText(row, CODE_FIELD),
      cellText(row, CAGE_FIELD),
      cellText(row, CURE_FIELD),
      cellText(row, STRENGTH_FIELD),
      cellText(row, SHIP_DATE_FIELD),
      String(row.status),
    ].join('|'),
  )
  // FNV-1a 32 位
  let hash = 0x811c9dc5
  for (const line of basis) {
    for (let i = 0; i < line.length; i += 1) {
      hash ^= line.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    hash ^= 0x0a
  }
  return `${(hash >>> 0).toString(16)}-${rows.length}`
}
