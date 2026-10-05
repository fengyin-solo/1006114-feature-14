import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'
const SCHEMA_KEY = 'shield-tunnel-construction:schema'
// 每次需要对存量数据做一次性整理时 +1，并在 migrations 里登记对应动作。
const CURRENT_SCHEMA = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function compareProductionDate(a: EntryRow, b: EntryRow): number {
  const da = String(a['生产日期'] ?? '')
  const db = String(b['生产日期'] ?? '')
  if (da && db && da !== db) {
    return da < db ? -1 : 1
  }
  // 生产日期缺失的沉到最后，同日再按管片编号（即 id）排，保证顺序确定、换机一致。
  if (da !== db) {
    return da ? -1 : 1
  }
  return Number(a.id) - Number(b.id)
}

/** 存量管片按生产日期重排一遍：只整理顺序，不改动业务字段。 */
function migrateSegmentOrder(store: Record<string, EntryRow[]>): void {
  const rows = store['segmentprod']
  if (Array.isArray(rows) && rows.length > 1) {
    store['segmentprod'] = [...rows].sort(compareProductionDate)
  }
}

const MIGRATIONS: Record<number, (store: Record<string, EntryRow[]>) => void> = {
  2: migrateSegmentOrder,
}

function persist(store: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
    window.localStorage.setItem(SCHEMA_KEY, String(CURRENT_SCHEMA))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  let parsed: Record<string, EntryRow[]>
  try {
    parsed = JSON.parse(raw) as Record<string, EntryRow[]>
  } catch {
    persist(fallback)
    return fallback
  }
  const store = { ...fallback, ...parsed }
  const schema = Number(window.localStorage.getItem(SCHEMA_KEY) ?? '1')
  if (schema < CURRENT_SCHEMA) {
    for (let version = Math.max(schema, 1) + 1; version <= CURRENT_SCHEMA; version += 1) {
      MIGRATIONS[version]?.(store)
    }
    persist(store)
  }
  return store
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  if (typeof window !== 'undefined' && window.localStorage) {
    // 先落盘再改内存：setItem 抛错（典型是配额满）时缓存保持原状，
    // 配合调用方实现「存不下就整体撤销」，绝不只落下半批。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    window.localStorage.setItem(SCHEMA_KEY, String(CURRENT_SCHEMA))
  }
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
