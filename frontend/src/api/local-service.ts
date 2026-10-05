import {
  SHIP_DATE_FIELD,
  SHIPPED_STATUS,
  canonicalRows,
  cellText,
  currentMonth,
  deliveryList,
  ledgerStats,
  ledgerView,
} from '@/domain/segment-ledger'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'
import type { LedgerAuthority } from '@/domain/segment-ledger'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 管片办理出厂时自动落出厂日期（台账本月出厂口径依赖它）；已填的不覆盖
  if (key === 'segmentprod' && target === SHIPPED_STATUS && !updated[SHIP_DATE_FIELD]) {
    updated[SHIP_DATE_FIELD] = new Date().toISOString().slice(0, 10)
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, key === 'segmentprod' ? canonicalRows(next) : next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

// 管片生产台账页面取数：本工区 + 筛选 + 唯一排序。
// 与导出打包（api/segment-export）走的是同一个 ledgerView，页面看到的行
// 与打包出来的行必然一致。
export function listSegmentLedger(
  authority: LedgerAuthority,
  filters: Record<string, string> = {},
): PageResult {
  const items = ledgerView(listRows('segmentprod'), authority, filters)
  return { items, total: items.length, page: 1, size: items.length }
}

export type SegmentLedgerBoard = ReturnType<typeof ledgerStats> & { month: string }

// 台账页三张统计卡；month 缺省取当前月。
export function segmentLedgerBoard(authority: LedgerAuthority, month?: string): SegmentLedgerBoard {
  const scopeMonth = month ?? currentMonth()
  const items = ledgerView(listRows('segmentprod'), authority, {})
  return { ...ledgerStats(items, scopeMonth), month: scopeMonth }
}

// 进度节点的交付清单：直接读管片台账，和台账页、导出结论同源同口径，
// 两处读到的本月出厂数不可能是两套。
export function segmentDeliveryList(
  authority: LedgerAuthority,
  month?: string,
) {
  const scopeMonth = month ?? currentMonth()
  const inZone = listRows('segmentprod').filter(
    (row) => cellText(row, '所属工区') === authority.zone,
  )
  return {
    month: scopeMonth,
    count: deliveryList(inZone, scopeMonth).length,
    items: deliveryList(inZone, scopeMonth),
  }
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
