import {
  LEDGER_VOLUME_COLUMNS,
  MODEL_FIELD,
  MOLD_FIELD,
  canonicalRows,
  cellText,
  currentMonth,
  findMissingCells,
  groupLedgerVolumes,
  isBlank,
  ledgerFingerprint,
  ledgerView,
  safeNamePart,
  shippedThisMonth,
} from '@/domain/segment-ledger'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import { downloadBlob } from '@/utils/download'
import { toCsv } from '@/utils/csv'
import { buildZip, type ZipEntry } from '@/utils/zip'

import { ROLE_CLERK } from '@/stores/session'
import type { LedgerAuthority } from '@/domain/segment-ledger'

// 导出任务：分卷打包，一卷一卷地生成；中途断掉（关页、刷新、配额失败）后，
// 任务记录仍在 localStorage，可从未完成的那一卷接着打，已完成的卷不重打。
// 只有当全部卷 + 说明文件齐备时才合成一个 ZIP 原子下载，磁盘上不会有半包。

export type VolumeState = 'pending' | 'done'
export type ExportState = 'packing' | 'ready' | 'failed'

export type VolumeDraft = {
  key: string
  filename: string
  model: string
  mold: string
  rowCount: number
  state: VolumeState
  csv: string
}

export type LedgerExportTask = {
  id: string
  state: ExportState
  startedAt: string
  finishedAt: string
  zone: string
  month: string
  filtersDigest: string
  filters: Record<string, string>
  fingerprint: string
  totalRows: number
  shippedThisMonth: number
  missingCount: number
  zipName: string
  failure: string
  volumes: VolumeDraft[]
  // 打包瞬间的页面可见行快照（深拷贝），续打按快照重建待办卷，
  // 保证“断前”“断后”属于同一批；数据变了则指纹不符，任务作废。
  snapshot: EntryRow[]
}

const TASK_KEY = 'shield-tunnel-construction:segmentprod-export-task'
const textEncoder = new TextEncoder()

// 越权当场拒绝：只有本工区资料员能发起/续打/下载/撤销导出。
export function assertExporter(authority: LedgerAuthority): void {
  if (authority.role !== ROLE_CLERK) {
    throw new Error('越权操作已拒绝：管片台账导出仅对本工区资料员开放，当前账号只能查看')
  }
}

function storage(): Storage | null {
  if (typeof globalThis === 'undefined') return null
  return (globalThis as { localStorage?: Storage }).localStorage ?? null
}

export function loadExportTask(): LedgerExportTask | null {
  const ls = storage()
  if (!ls) return null
  const raw = ls.getItem(TASK_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as LedgerExportTask
  } catch {
    return null
  }
}

function persistTask(task: LedgerExportTask | null): void {
  const ls = storage()
  if (!ls) return
  try {
    if (task === null) {
      ls.removeItem(TASK_KEY)
    } else {
      ls.setItem(TASK_KEY, JSON.stringify(task))
    }
  } catch {
    // 任务记录写不下：不改变业务数据；下一拍若仍写不下，由调用方按配额失败处理
    throw new Error('导出任务记录无法写入本地存储，请清理浏览器存储后重试')
  }
}

function digestFilters(filters: Record<string, string>): string {
  return Object.entries(filters)
    .filter(([, value]) => value.trim() !== '')
    .map(([key, value]) => `${key}=${value.trim()}`)
    .sort()
    .join(';')
}

function volumeCsv(rows: EntryRow[]): string {
  const table: (string | number)[][] = [LEDGER_VOLUME_COLUMNS.slice()]
  for (const row of rows) {
    table.push(LEDGER_VOLUME_COLUMNS.map((field) => (isBlank(row[field]) ? '' : String(row[field]))))
  }
  return toCsv(table)
}

function missingReportCsv(task: LedgerExportTask, rows: EntryRow[]): string {
  const missing = findMissingCells(rows)
  const table: (string | number)[][] = [
    ['管片编号', '所在卷（型号_模具）', '空缺列名', '说明'],
  ]
  const byCode = new Map(rows.map((row) => [Number(row.id), row]))
  for (const item of missing) {
    const row = byCode.get(item.id)
    const model = row ? cellText(row, MODEL_FIELD) || '未填写' : '未填写'
    const mold = row ? cellText(row, MOLD_FIELD) || '未填写' : '未填写'
    table.push([
      item.code,
      `${model}_${mold}`,
      item.field,
      `页面上该列为空，册子里同位置留空，请补录${item.field}`,
    ])
  }
  return toCsv(table)
}

function conclusionText(task: LedgerExportTask): string {
  const lines = [
    '管片生产台账导出结论',
    `导出工区：${task.zone}`,
    `生成时间：${task.finishedAt || task.startedAt}`,
    `数据口径：与台账页面当前可见行完全一致（筛选：${task.filtersDigest || '无'}）`,
    `打包口径：按「管片型号 + 生产模具」分卷，共 ${task.volumes.length} 卷`,
    `总条数：${task.totalRows} 条`,
    `本月（${task.month}）出厂数：${task.shippedThisMonth} 条`,
    `缺栏点名条数：${task.missingCount} 条（明细见「缺栏点名清单.csv」，对应单元格在册子中留空）`,
    '',
    '各卷明细：',
  ]
  for (const volume of task.volumes) {
    lines.push(`- ${volume.filename}：${volume.model} / ${volume.mold}，${volume.rowCount} 条`)
  }
  lines.push('', `数据指纹：${task.fingerprint}`)
  return lines.join('\n')
}

// 反复提交也只入一条：已存在进行中的任务时直接返回该任务，不另起。
export function startLedgerExport(
  authority: LedgerAuthority,
  filters: Record<string, string> = {},
): LedgerExportTask {
  assertExporter(authority)
  const existing = loadExportTask()
  if (existing && existing.state === 'packing') {
    return existing
  }

  // 页面可见什么就打什么：同工区 + 当前筛选 + 唯一排序
  const visible = ledgerView(listRows('segmentprod'), authority, filters)
  const volumes = groupLedgerVolumes(visible).map((volume) => ({
    key: volume.key,
    filename: volume.filename,
    model: volume.model,
    mold: volume.mold,
    rowCount: volume.rows.length,
    state: 'pending' as VolumeState,
    csv: '',
  }))
  const now = new Date()
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '')
  const task: LedgerExportTask = {
    id: `export-${Date.now()}`,
    state: 'packing',
    startedAt: now.toISOString(),
    finishedAt: '',
    zone: authority.zone,
    month: currentMonth(now),
    filtersDigest: digestFilters(filters),
    filters: { ...filters },
    fingerprint: ledgerFingerprint(visible),
    totalRows: visible.length,
    shippedThisMonth: shippedThisMonth(visible, currentMonth(now)).length,
    missingCount: findMissingCells(visible).length,
    zipName: `管片生产台账_${safeNamePart(authority.zone)}_${stamp}.zip`,
    failure: '',
    volumes,
    snapshot: JSON.parse(JSON.stringify(visible)) as EntryRow[],
  }
  persistTask(task)
  // 只建任务、不在这里自动打包：每卷落盘一次是“断点续打”的边界，
  // 由调用方（页面“续打”/测试）逐拍 pump；反复提交时返回的就是同一条 packing 任务。
  return task
}

function failTask(task: LedgerExportTask, reason: string): LedgerExportTask {
  const failed: LedgerExportTask = { ...task, state: 'failed', failure: reason }
  // 失败任务也要落盘，方便页面展示；它不再产生任何下载
  persistTask(failed)
  return failed
}

// 续打前先过身份与归属：非资料员拒绝；资料员也只能动本工区的任务。
function assertOwnsTask(authority: LedgerAuthority, task: LedgerExportTask): void {
  assertExporter(authority)
  if (task.zone !== authority.zone) {
    throw new Error('越权操作已拒绝：该台账打包任务属于其他工区')
  }
}

// 从断掉的那一卷接着打：已 done 的卷原样保留，只重建 pending 卷。
export function pumpLedgerExport(authority: LedgerAuthority): LedgerExportTask {
  assertExporter(authority)
  const task = loadExportTask()
  if (!task) {
    throw new Error('没有可续打的导出任务，请重新发起导出')
  }
  assertOwnsTask(authority, task)
  if (task.state === 'ready') {
    return task
  }
  if (task.state === 'failed') {
    throw new Error(`导出任务已作废：${task.failure}`)
  }

  // 续打前对账：页面当前可见行必须与发起时同一份（同工区+同一筛选+唯一排序），
  // 行数与指纹一致；否则册子拼出来就和页面对不上 —— 当场作废，不允许凑包。
  const current = ledgerView(listRows('segmentprod'), authority, task.filters)
  const fingerprintNow = ledgerFingerprint(current)
  if (fingerprintNow !== task.fingerprint) {
    return failTask(task, '台账在打包期间发生变化，续打口径与页面已不一致；任务已作废，请重新导出')
  }

  const snapshotRows = canonicalRows(task.snapshot)
  const grouped = groupLedgerVolumes(snapshotRows)
  const byKey = new Map(grouped.map((volume) => [volume.key, volume]))

  try {
    for (const volumeDraft of task.volumes) {
      if (volumeDraft.state === 'done') continue
      const group = byKey.get(volumeDraft.key)
      if (!group || group.rows.length !== volumeDraft.rowCount) {
        return failTask(task, `分卷 ${volumeDraft.filename} 行数对不上，任务已作废，请重新导出`)
      }
      volumeDraft.csv = volumeCsv(group.rows)
      volumeDraft.state = 'done'
      // 每完成一卷就落盘一次：下一次进来从下一卷开始，真正断点续打
      persistTask(task)
    }

    const allDone = task.volumes.every((volume) => volume.state === 'done')
    const totalInVolumes = task.volumes.reduce((sum, volume) => sum + volume.rowCount, 0)
    if (!allDone || totalInVolumes !== task.totalRows) {
      return failTask(
        task,
        `打包行数核对失败：页面 ${task.totalRows} 条，分卷合计 ${totalInVolumes} 条；任务已作废`,
      )
    }

    task.state = 'ready'
    task.finishedAt = new Date().toISOString()
    persistTask(task)
    return task
  } catch (error) {
    return failTask(task, error instanceof Error ? error.message : '打包过程中断')
  }
}

// 撤销：任务记录整体删除，磁盘/页面都不留半包。失败任务也用它清掉。
export function abortLedgerExport(authority: LedgerAuthority): void {
  assertExporter(authority)
  persistTask(null)
}

// 完成下载：此刻才把各卷 + 缺栏清单 + 导出结论合成一个 ZIP。
// buildZip 是一次成型的字节数组，前面任何一步失败都不会走到下载。
export function downloadLedgerPackage(authority: LedgerAuthority): LedgerExportTask {
  assertExporter(authority)
  const task = loadExportTask()
  if (!task) {
    throw new Error('没有可下载的导出包，请先发起导出')
  }
  assertOwnsTask(authority, task)
  if (task.state !== 'ready') {
    throw new Error('册子还没打完，请先续打完成后再下载')
  }

  const rows = canonicalRows(task.snapshot)
  const entries: ZipEntry[] = task.volumes.map((volume) => ({
    name: volume.filename,
    bytes: textEncoder.encode(volume.csv),
  }))
  entries.push({
    name: '缺栏点名清单.csv',
    bytes: textEncoder.encode(missingReportCsv(task, rows)),
  })
  entries.push({
    name: '导出结论.txt',
    bytes: textEncoder.encode(conclusionText(task)),
  })

  const zip = buildZip(entries)
  const buffer = new ArrayBuffer(zip.byteLength)
  new Uint8Array(buffer).set(zip)
  downloadBlob(task.zipName, new Blob([buffer], { type: 'application/zip' }))
  return task
}

// 供测试/页面进度条使用
export function taskProgress(task: LedgerExportTask): { done: number; total: number } {
  return {
    done: task.volumes.filter((volume) => volume.state === 'done').length,
    total: task.volumes.length,
  }
}
