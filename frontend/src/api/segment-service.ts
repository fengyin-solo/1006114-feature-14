import { parseCsv } from '@/data/csv'
import {
  deleteJob,
  findActivePackingJob,
  getChunk,
  getJobRecord,
  listJobRecords,
  putChunk,
  saveJobRecord,
} from '@/data/export-store'
import { saveRows } from '@/data/local-store'
import {
  SEGMENT_COLUMNS,
  SEGMENT_KEY,
  buildDeliveryFile,
  buildLedgerFile,
  buildManifestText,
  buildMissingFile,
  crc32,
  currentMonth,
  groupSegmentRows,
  makeFilePlan,
  monthShippedCount,
  packageChecksum,
  querySegmentRows,
  toUtf8,
} from '@/data/segment-ledger'
import type {
  EntryRow,
  ExportFilePlan,
  ExportJobRecord,
  SegmentImportFailure,
  SegmentImportResult,
} from '@/data/types'
import { ServiceError } from '@/data/types'
import { buildZip } from '@/data/zip'
import { LEDGER_WORK_AREA, useSessionStore } from '@/stores/session'

/**
 * 管片台账服务：所有写操作（导出打包、导入补数、登记覆盖）统一在这里鉴权，
 * 页面按钮隐藏只是体验，真正的边界在这里——越权当场拒绝（FORBIDDEN）。
 */

const CHUNK_SIZE = 64 * 1024
const VALID_STATUSES = ['待浇筑', '养护中', '待出厂', '已出厂']
const FINAL_STATUS = '已出厂'

function requireLedgerManager(action: string): void {
  const session = useSessionStore()
  if (!session.canManageLedger) {
    throw new ServiceError(
      'FORBIDDEN',
      `越权操作已拒绝：${action}仅限${LEDGER_WORK_AREA}资料员，当前账号「${session.account.name}」（${session.account.role}/${session.account.workArea}）只能查看。`,
    )
  }
}

/** 按 UTF-8 字符边界切块：单字符多字节时退到该字符长度，保证续传拼回不乱码。 */
function splitByUtf8(text: string, chunkSize: number): Uint8Array[] {
  const bytes = toUtf8(text)
  const chunks: Uint8Array[] = []
  for (let start = 0; start < bytes.length; ) {
    let end = Math.min(start + chunkSize, bytes.length)
    while (end < bytes.length) {
      const byte = bytes[end]
      // UTF-8 后续字节形如 10xxxxxx；落在这种位置就往后挪，直到遇到字符首字节。
      if ((byte & 0xc0) !== 0x80) {
        break
      }
      end += 1
    }
    chunks.push(bytes.slice(start, end))
    start = end
  }
  if (chunks.length === 0) {
    chunks.push(new Uint8Array(0))
  }
  return chunks
}

export type SegmentPackageBuild = {
  rows: EntryRow[]
  files: { path: string; kind: ExportFilePlan['kind']; model: string; mold: string; rows: EntryRow[]; content: string }[]
  plan: ExportFilePlan[]
  checksum: string
  month: string
  monthShipped: number
}

/**
 * 唯一打包口径：传入与页面完全相同的筛选条件，取 querySegmentRows 的结果。
 * 页面看到的行数 == 包清单里的总行数 == 各卷行数之和。
 */
export function buildSegmentPackage(
  filters: Record<string, string>,
  now: Date = new Date(),
  statusFilter = '',
): SegmentPackageBuild {
  let rows = querySegmentRows(filters)
  if (statusFilter) {
    rows = rows.filter((row) => String(row.status) === statusFilter)
  }
  const groups = groupSegmentRows(rows)
  const files = [
    ...groups.map(buildLedgerFile),
  ]
  const month = currentMonth(now)
  const monthShipped = monthShippedCount(rows, month)
  const delivery = buildDeliveryFile(rows, month, LEDGER_WORK_AREA)
  // 缺栏清单按台账卷逐组生成，缺哪栏就在文件里点名到列、到管片编号。
  const missing = buildMissingFile(groups)
  files.push(missing, delivery)
  const checksum = packageChecksum(files.map((file) => ({ path: file.path, content: file.content })))
  const plan = files.map((file) => makeFilePlan(file, CHUNK_SIZE))
  return { rows, files, plan, checksum, month, monthShipped }
}

export type SegmentExportProgress = {
  jobId: string
  stage: 'staging' | 'assembling' | 'ready' | 'failed' | 'canceled'
  /** 0-1，分卷暂存进度。 */
  staged: number
  total: number
  message: string
}

function newJobId(): string {
  const rand = (crypto as Crypto | undefined)?.getRandomValues
    ? Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')
    : String(Date.now())
  return `seg-${Date.now().toString(36)}-${rand}`
}

/**
 * 创建/复用导出任务并逐卷分块暂存。
 * 反复点击提交：同口径下已在打包的任务直接复用（只入一条），从上次断掉的分块接着写。
 * 返回任务单；任一分块失败任务标 failed，不会产出半成品压缩包。
 */
export async function stageSegmentExport(
  filters: Record<string, string>,
  onProgress?: (progress: SegmentExportProgress) => void,
  now: Date = new Date(),
  statusFilter = '',
): Promise<ExportJobRecord> {
  requireLedgerManager('管片台账导出')
  const session = useSessionStore()
  const pkg = buildSegmentPackage(filters, now, statusFilter)
  const existing = await findActivePackingJob(session.account.id, pkg.checksum)
  let job: ExportJobRecord
  if (existing) {
    job = existing
    if (job.status === 'failed') {
      // 续传：先把失败标记复位为打包中，再从已写分块之后接着打。
      job = { ...job, status: 'packing', failedReason: '' }
      await saveJobRecord(job)
    }
  } else {
    job = {
      id: newJobId(),
      actorId: session.account.id,
      actorName: session.account.name,
      scopeLabel: LEDGER_WORK_AREA,
      createdAt: new Date().toISOString(),
      filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v.trim() !== '')),
      statusFilter,
      rowCount: pkg.rows.length,
      checksum: pkg.checksum,
      month: pkg.month,
      monthShipped: pkg.monthShipped,
      files: pkg.plan,
      snapshot: pkg.rows,
      status: 'packing',
      failedReason: '',
    }
    await saveJobRecord(job)
  }

  try {
    const totalChunks = pkg.plan.reduce((sum, plan) => sum + plan.chunks, 0)
    let doneChunks = 0
    for (const file of pkg.files) {
      const plan = pkg.plan.find((item) => item.path === file.path)
      if (!plan) {
        throw new Error(`打包计划缺失：${file.path}`)
      }
      const pieces = splitByUtf8(file.content, CHUNK_SIZE)
      if (pieces.length !== plan.chunks) {
        throw new Error(`分块数与计划不一致：${file.path}`)
      }
      for (let index = 0; index < pieces.length; index += 1) {
        // 已存在且字节一致的分块直接跳过——断了就从断点续，不重复写。
        const existed = await getChunk(job.id, file.path, index)
        if (existed && crc32(existed) === crc32(pieces[index])) {
          doneChunks += 1
          continue
        }
        await putChunk(job.id, file.path, index, pieces[index])
        doneChunks += 1
        onProgress?.({
          jobId: job.id,
          stage: 'staging',
          staged: doneChunks,
          total: totalChunks,
          message: `正在暂存第 ${doneChunks}/${totalChunks} 块：${file.path}`,
        })
        // 让出主线程，界面能刷新，也让「断」能真的停在某一块。
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    const verified = await verifyStagedPackage(job.id, pkg)
    if (!verified) {
      throw new Error('暂存卷与打包计划校验不一致，已放弃合成')
    }
    const ready: ExportJobRecord = { ...job, status: 'ready', failedReason: '' }
    await saveJobRecord(ready)
    onProgress?.({
      jobId: job.id,
      stage: 'ready',
      staged: totalChunks,
      total: totalChunks,
      message: '分卷已全部暂存并校验通过，可下载完整台账包',
    })
    return ready
  } catch (error) {
    const failed: ExportJobRecord = {
      ...job,
      status: 'failed',
      failedReason: error instanceof Error ? error.message : '分卷暂存失败',
    }
    await saveJobRecord(failed)
    onProgress?.({
      jobId: job.id,
      stage: 'failed',
      staged: 0,
      total: 0,
      message: failed.failedReason,
    })
    throw error
  }
}

/** 逐卷拼回分块并对 CRC、行数做校验，返回 {内容, 字节}。 */
async function assembleStagedFile(
  jobId: string,
  file: { path: string; content: string },
  plan: ExportFilePlan,
): Promise<Uint8Array> {
  const pieces: Uint8Array[] = []
  for (let index = 0; index < plan.chunks; index += 1) {
    const chunk = await getChunk(jobId, plan.path, index)
    if (!chunk) {
      throw new Error(`卷 ${plan.path} 的第 ${index + 1} 块缺失`)
    }
    pieces.push(chunk)
  }
  const total = pieces.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of pieces) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  if (merged.length !== plan.size || crc32(merged) !== plan.crc) {
    throw new Error(`卷 ${plan.path} 校验失败（字节数或 CRC 不符），拒绝合成半包`)
  }
  return merged
}

async function verifyStagedPackage(
  jobId: string,
  pkg: SegmentPackageBuild,
): Promise<boolean> {
  for (const plan of pkg.plan) {
    const file = pkg.files.find((item) => item.path === plan.path)
    if (!file) {
      return false
    }
    // 缺栏/交付清单行不参与台账行数对账，只对 ledger 卷核行数。
    try {
      const bytes = await assembleStagedFile(jobId, file, plan)
      if (plan.kind === 'ledger') {
        const text = new TextDecoder().decode(bytes)
        const lines = parseCsv(text)
        if (lines.length - 1 !== plan.rowCount) {
          return false
        }
      }
    } catch {
      return false
    }
  }
  return true
}

/**
 * 合成并下载完整台账包：全部卷暂存并校验通过后才走到这里。
 * 包清单(manifest)最后一刻生成，包含每卷行数/CRC、总行数、整包校验和，
 * 以及与进度节点一致的本月出厂数。任何异常都不产生下载文件。
 */
export async function downloadSegmentExport(
  jobId: string,
  onProgress?: (progress: SegmentExportProgress) => void,
): Promise<{ filename: string }> {
  requireLedgerManager('管片台账下载')
  const record = await getJobRecord(jobId)
  if (!record) {
    throw new ServiceError('NOT_FOUND', '导出任务不存在或已被清理')
  }
  if (record.status !== 'ready') {
    throw new ServiceError('JOB_NOT_READY', `任务当前状态为「${record.status}」，没有可下载的完整包`)
  }

  const pkg = buildSegmentPackage(record.filters, new Date(record.createdAt), record.statusFilter)
  // 数据若在任务创建后发生变化，行数/校验和必须仍与冻结快照一致，否则要求重打。
  if (pkg.checksum !== record.checksum || pkg.rows.length !== record.rowCount) {
    throw new ServiceError(
      'STALE_EXPORT',
      '台账数据在任务创建后发生变化，旧包已作废，请重新导出，避免页面与包里两套行',
    )
  }

  onProgress?.({ jobId, stage: 'assembling', staged: 0, total: record.files.length, message: '正在合成完整台账包…' })
  try {
    const entries: { path: string; bytes: Uint8Array }[] = []
    let staged = 0
    for (const file of pkg.files) {
      const plan = record.files.find((item) => item.path === file.path)
      if (!plan) {
        throw new Error(`打包计划缺失：${file.path}`)
      }
      entries.push({ path: plan.path, bytes: await assembleStagedFile(jobId, file, plan) })
      staged += 1
      onProgress?.({ jobId, stage: 'assembling', staged, total: record.files.length, message: `校验卷：${plan.path}` })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const manifest = buildManifestText(record.files, {
      scopeLabel: record.scopeLabel,
      month: record.month,
      monthShipped: record.monthShipped,
      rowCount: record.rowCount,
      checksum: record.checksum,
      filters: record.filters,
      actorName: record.actorName,
      createdAt: record.createdAt,
    })
    entries.push({ path: '台账/00_包清单.csv', bytes: toUtf8(manifest) })

    const zip = buildZip(entries, new Date())
    const filename = `管片出厂台账_${record.scopeLabel}_${record.month}_${record.rowCount}行_${record.id}.zip`
    triggerDownload(zip, filename)
    return { filename }
  } catch (error) {
    // 合成失败不留半包：任务保持 ready（暂存卷完好），但本次不触发任何下载。
    onProgress?.({
      jobId,
      stage: 'failed',
      staged: 0,
      total: record.files.length,
      message: error instanceof Error ? error.message : '台账包合成失败，未产生下载文件',
    })
    throw error
  }
}

export async function listSegmentExportJobs(): Promise<ExportJobRecord[]> {
  return listJobRecords()
}

export async function cancelSegmentExport(jobId: string): Promise<void> {
  requireLedgerManager('管片导出任务撤销')
  await deleteJob(jobId)
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  // 延迟回收，确保浏览器已接管下载句柄；中途取消的下载不会有半包落盘（浏览器原子改名）。
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

// ---------------------------------------------------------------------------
// 导入补数：已出厂管片从建设单位回灌养护天数/出厂强度等。
// 按管片编号覆盖（不追加）；同一文件重复编号只入一条（后行覆盖前行）；
// 校验失败的行逐条列原因；任何一行导致持久化失败都整体撤销。
// ---------------------------------------------------------------------------

type ParsedImportRow = {
  line: number
  segmentNo: string
  values: Partial<EntryRow>
}

const IMPORT_FIELDS = SEGMENT_COLUMNS
const NUMBER_FIELDS = new Set(['养护天数', '出厂强度'])
const MAX_LENGTH = 40

function validateImportCell(field: string, raw: string): string | null {
  const value = raw.trim()
  if (value.length > MAX_LENGTH) {
    return `${field}长度不能超过 ${MAX_LENGTH} 个字符`
  }
  if (NUMBER_FIELDS.has(field)) {
    if (!/^\d+(\.\d+)?$/.test(value)) {
      return `${field}必须是非负数字，实际为「${value}」`
    }
    const num = Number(value)
    if (field === '养护天数' && num > 3650) {
      return '养护天数超出合理范围（0-3650）'
    }
    if (field === '出厂强度' && (num <= 0 || num > 200)) {
      return '出厂强度应在 0-200MPa 之间'
    }
  }
  if (field === '生产日期' || field === '出厂日期') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return `${field}必须是 YYYY-MM-DD 格式，实际为「${value}」`
    }
  }
  if (field === '生产状态' && !VALID_STATUSES.includes(value)) {
    return `生产状态必须是 ${VALID_STATUSES.join('/')} 之一，实际为「${value}」`
  }
  return null
}

/**
 * 解析并校验导入文本。返回可入库存的行（已按管片编号去重，后行覆盖前行）与失败行清单。
 * 纯函数，不碰存储，便于整体事务化。
 */
export function parseSegmentImport(text: string): {
  parsed: ParsedImportRow[]
  failures: SegmentImportFailure[]
  dedupedInFile: number
  header: string[]
} {
  const grid = parseCsv(text)
  const failures: SegmentImportFailure[] = []
  if (grid.length === 0) {
    return { parsed: [], failures: [{ line: 0, segmentNo: '', reason: '文件为空，没有可导入的行' }], dedupedInFile: 0, header: [] }
  }
  const header = grid[0].map((cell) => cell.trim())
  const noIndex = header.indexOf('管片编号')
  if (noIndex < 0) {
    return {
      parsed: [],
      header,
      dedupedInFile: 0,
      failures: [{ line: 1, segmentNo: '', reason: '表头缺少必含列「管片编号」，无法按编号覆盖' }],
    }
  }
  const writableFields = IMPORT_FIELDS.filter((field) => field !== '管片编号')
  const columnIndex = new Map<string, number>()
  for (const field of writableFields) {
    const index = header.indexOf(field)
    if (index >= 0) {
      columnIndex.set(field, index)
    }
  }

  const byNo = new Map<string, ParsedImportRow>()
  let dedupedInFile = 0
  for (let line = 2; line <= grid.length; line += 1) {
    const cells = grid[line - 1]
    if (cells.every((cell) => cell.trim() === '')) {
      continue
    }
    const segmentNo = (cells[noIndex] ?? '').trim()
    if (!segmentNo) {
      failures.push({ line, segmentNo: '', reason: '管片编号为空，无法定位要覆盖的管片' })
      continue
    }
    if (segmentNo.length > MAX_LENGTH) {
      failures.push({ line, segmentNo, reason: `管片编号长度不能超过 ${MAX_LENGTH} 个字符` })
      continue
    }

    const values: Partial<EntryRow> = {}
    const reasons: string[] = []
    for (const [field, column] of columnIndex) {
      const raw = cells[column] ?? ''
      if (raw.trim() === '') {
        // 空单元格不覆盖既有数据：补数导入不能把原有值抹空。
        continue
      }
      const reason = validateImportCell(field, raw)
      if (reason) {
        reasons.push(reason)
      } else {
        values[field] = NUMBER_FIELDS.has(field) ? Number(raw.trim()) : raw.trim()
      }
    }
    if (reasons.length > 0) {
      failures.push({ line, segmentNo, reason: reasons.join('；') })
      continue
    }
    if (byNo.has(segmentNo)) {
      dedupedInFile += 1
    }
    byNo.set(segmentNo, { line, segmentNo, values })
  }
  return { parsed: [...byNo.values()], failures, dedupedInFile, header }
}

/**
 * 导入补数主入口：
 * - 已有同管片编号 → 覆盖（只覆盖文件里提供了值的列，空列保留原值），不追加新行；
 * - 编号不存在 → 拒绝该行并入失败清单（本入口是「补数」，不是新增登记）；
 * - 全部校验通过的行一次性落库，落库失败整体撤销，已校验结果不算数；
 * - 重复导入同一文件：内容相同的覆盖是幂等的，只入一条。
 */
export function importSegmentSupplements(
  text: string,
  options: { forceStatus?: boolean } = {},
): SegmentImportResult {
  requireLedgerManager('管片台账导入补数')
  const { parsed, failures, dedupedInFile } = parseSegmentImport(text)
  if (failures.some((item) => item.line <= 1)) {
    return {
      ok: false,
      inserted: 0,
      updated: 0,
      deduped: dedupedInFile,
      total: parsed.length + failures.length,
      failures,
      message: failures.map((item) => `第${item.line}行：${item.reason}`).join('；'),
    }
  }

  const current = querySegmentRows()
  const indexByNo = new Map(current.map((row) => [String(row['管片编号']), row]))
  const nextRows = current.map((row) => ({ ...row }))
  const mutableIndex = new Map<string, EntryRow>()
  nextRows.forEach((row) => mutableIndex.set(String(row['管片编号']), row))

  let updated = 0
  for (const item of parsed) {
    const existing = mutableIndex.get(item.segmentNo)
    if (!existing) {
      failures.push({
        line: item.line,
        segmentNo: item.segmentNo,
        reason: '管片编号在本工区台账中不存在，补数导入不允许新增行；如需登记请走登记入口',
      })
      continue
    }
    for (const [field, value] of Object.entries(item.values)) {
      existing[field] = value as string | number
    }
    if (typeof item.values['生产状态'] === 'string') {
      const status = item.values['生产状态']
      existing.status = status
      existing.pending = status !== FINAL_STATUS
      if (!options.forceStatus && status === FINAL_STATUS && !existing['出厂日期']) {
        existing['出厂日期'] = new Date().toISOString().slice(0, 10)
      }
    }
    updated += 1
  }

  if (failures.length > 0 && updated === 0) {
    return {
      ok: false,
      inserted: 0,
      updated: 0,
      deduped: dedupedInFile,
      total: parsed.length,
      failures,
      message: `${failures.length} 行校验未通过，未写入任何数据`,
    }
  }

  // 一次性落库：saveRows 先写 localStorage 再改内存，配额异常直接抛出 → 整体撤销。
  try {
    saveRows(SEGMENT_KEY, nextRows)
  } catch (error) {
    const reason = error instanceof Error ? error.message : '本地存储写入失败'
    return {
      ok: false,
      inserted: 0,
      updated: 0,
      deduped: dedupedInFile,
      total: parsed.length,
      failures: [{ line: 0, segmentNo: '', reason: `整体撤销：${reason}（浏览器存储可能已满）` }],
      message: '存储失败，已整体撤销，台账维持导入前状态',
    }
  }

  return {
    ok: failures.length === 0,
    inserted: 0,
    updated,
    deduped: dedupedInFile,
    total: parsed.length,
    failures,
    message:
      `已按管片编号覆盖 ${updated} 行` +
      (dedupedInFile > 0 ? `，文件内重复编号合并 ${dedupedInFile} 行（只入一条）` : '') +
      (failures.length > 0 ? `，${failures.length} 行未导入（见失败清单）` : ''),
  }
}

// ---------------------------------------------------------------------------
// 登记入口：按管片编号幂等 upsert，反复提交只入一条。
// ---------------------------------------------------------------------------

export type SegmentDraft = {
  管片编号: string
  管片型号?: string
  生产模具?: string
  钢筋笼批号?: string
  生产日期?: string
  养护天数?: number | ''
  出厂强度?: number | ''
  出厂日期?: string
  检验人员?: string
  生产状态?: string
}

export function upsertSegment(draft: SegmentDraft): { ok: boolean; message: string; duplicated: boolean } {
  requireLedgerManager('管片登记')
  const segmentNo = draft.管片编号?.trim() ?? ''
  if (!segmentNo) {
    return { ok: false, message: '管片编号不能为空', duplicated: false }
  }
  if (draft.生产日期 && !/^\d{4}-\d{2}-\d{2}$/.test(draft.生产日期)) {
    return { ok: false, message: '生产日期必须是 YYYY-MM-DD 格式', duplicated: false }
  }

  const rows = querySegmentRows().map((row) => ({ ...row }))
  const existing = rows.find((row) => String(row['管片编号']) === segmentNo)
  let duplicated = false
  if (existing) {
    // 幂等：同编号重复提交只覆盖一次，绝不追加第二条。
    duplicated = true
    for (const [field, value] of Object.entries(draft)) {
      if (field === '管片编号' || value === '' || value === undefined) {
        continue
      }
      existing[field] = value as string | number
    }
    const status = typeof draft.生产状态 === 'string' ? draft.生产状态 : existing.status
    existing.status = status
    existing.pending = status !== FINAL_STATUS
    saveRows(SEGMENT_KEY, rows)
    return { ok: true, message: `管片 ${segmentNo} 已存在，本次提交按编号覆盖，未新增重复行`, duplicated }
  }

  const id = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const status = draft.生产状态 ?? '待浇筑'
  const row: EntryRow = {
    id,
    status,
    pending: status !== FINAL_STATUS,
    abnormal: false,
    管片编号: segmentNo,
    管片型号: draft.管片型号 ?? '',
    生产模具: draft.生产模具 ?? '',
    钢筋笼批号: draft.钢筋笼批号 ?? '',
    生产日期: draft.生产日期 ?? '',
    养护天数: draft.养护天数 === undefined ? '' : draft.养护天数,
    出厂强度: draft.出厂强度 === undefined ? '' : draft.出厂强度,
    出厂日期: draft.出厂日期 ?? '',
    检验人员: draft.检验人员 ?? '',
    生产状态: status,
  }
  try {
    saveRows(SEGMENT_KEY, [...rows, row])
  } catch (error) {
    return {
      ok: false,
      duplicated: false,
      message: `存不下，整体撤销：${error instanceof Error ? error.message : '本地存储写入失败'}`,
    }
  }
  return { ok: true, message: `管片 ${segmentNo} 已登记`, duplicated: false }
}

/** 页面/进度节点共用的台账指标：两处读到的本月出厂数必须同源。 */
export function segmentLedgerMetrics(now: Date = new Date()): {
  total: number
  curing: number
  waiting: number
  monthShipped: number
  month: string
} {
  const rows = querySegmentRows()
  const month = currentMonth(now)
  return {
    total: rows.length,
    curing: rows.filter((row) => String(row.status) === '养护中').length,
    waiting: rows.filter((row) => String(row.status) === '待出厂').length,
    monthShipped: monthShippedCount(rows, month),
    month,
  }
}
