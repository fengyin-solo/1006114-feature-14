import { canonicalCompare } from '@/domain/segment-ledger'

import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'
const SCHEMA_KEY = 'shield-tunnel-construction:schema-version'
const CURRENT_SCHEMA = 2

// localStorage 写满/不可写时抛出的统一错误：上层据此整批撤销，绝不留半包。
export class StorageQuotaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageQuotaError'
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function storage(): Storage | null {
  if (typeof globalThis === 'undefined') {
    return null
  }
  return (globalThis as { localStorage?: Storage }).localStorage ?? null
}

// schema 1 → 2：存量管片按生产日期（同日按管片编号）重排一遍。
// 这是一次性迁移，跑完写版本号；新播种的数据本身已是该顺序。
function migrate(raw: Record<string, EntryRow[]>, fromVersion: number): Record<string, EntryRow[]> {
  let next = raw
  if (fromVersion < 2 && Array.isArray(next.segmentprod)) {
    next = { ...next, segmentprod: [...next.segmentprod].sort(canonicalCompare) }
  }
  return next
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  const ls = storage()
  if (!ls) {
    return fallback
  }
  const raw = ls.getItem(STORAGE_KEY)
  if (!raw) {
    persist(clone(SEED_ROWS), () => undefined)
    ls.setItem(SCHEMA_KEY, String(CURRENT_SCHEMA))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const version = Number(ls.getItem(SCHEMA_KEY) ?? '1')
    const merged: Record<string, EntryRow[]> = { ...clone(SEED_ROWS), ...parsed }
    const upgraded = version < CURRENT_SCHEMA ? migrate(merged, version) : merged
    if (version < CURRENT_SCHEMA) {
      persist(upgraded, () => undefined)
      ls.setItem(SCHEMA_KEY, String(CURRENT_SCHEMA))
    }
    return upgraded
  } catch (error) {
    if (error instanceof StorageQuotaError) {
      // 迁移写不下：本次会话用升级后的内存数据继续，不动磁盘，不丢数据
      return JSON.parse(raw) as Record<string, EntryRow[]>
    }
    persist(clone(SEED_ROWS), () => undefined)
    ls.setItem(SCHEMA_KEY, String(CURRENT_SCHEMA))
    return fallback
  }
}

// 唯一落盘入口：序列化失败/配额满时把原状态交给 rollback 并抛出，
// 调用方据此整体撤销本次修改（不写半截、不覆盖旧数据）。
function persist(
  data: Record<string, EntryRow[]>,
  rollback: () => void,
): void {
  const ls = storage()
  if (!ls) {
    return
  }
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (error) {
    rollback()
    if (isQuotaError(error)) {
      throw new StorageQuotaError('本地存储空间不足，本次操作已整体撤销，数据维持原样')
    }
    throw error
  }
}

// 浏览器抛 QuotaExceededError（DOMException），测试桩用同名普通 Error，都按配额处理
function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException ||
    error instanceof StorageQuotaError ||
    (error instanceof Error &&
      (error.name === 'QuotaExceededError' ||
        error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
        /quota/i.test(error.message)))
  )
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
  const previous = cache
  const next = { ...allRows(), [key]: rows }
  cache = next
  persist(next, () => {
    cache = previous
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 仅供自测：丢弃内存缓存，强制下一次读取重新走 localStorage 与迁移
export function __resetCacheForTest(): void {
  cache = null
}
