import {
  CAGE_FIELD,
  CODE_FIELD,
  CURE_FIELD,
  MODEL_FIELD,
  MOLD_FIELD,
  PROD_DATE_FIELD,
  SHIP_DATE_FIELD,
  SHIPPED_STATUS,
  STRENGTH_FIELD,
  ZONE_FIELD,
  canonicalRows,
  cellText,
  isBlank,
} from '@/domain/segment-ledger'
import { StorageQuotaError, listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import { dropBlankRows, parseCsv, toCsv } from '@/utils/csv'

import { ROLE_CLERK } from '@/stores/session'
import type { LedgerAuthority } from '@/domain/segment-ledger'

// 已出厂管片回导补数：
// - 覆盖口径（由我取舍）：以「管片编号」为唯一键，命中本工区同号行则整行覆盖，
//   但导入单元格留空表示“这次不补这一栏”，不拿空值冲掉已有数据；
//   不命中则新增，新增行直接置为「已出厂」。
// - 文件内同号重复：只入一次（先出现的有效行为准，后续重复跳过并单列）。
// - 任一行校验不过：该行不写入，单独列出并写清原因，其余有效行仍落库；
//   只有存储失败（配额）才整体撤销，不允许留下写了一半的库。

export type ImportProblem = {
  line: number
  code: string
  reason: string
}

export type LedgerImportResult = {
  totalRows: number
  upserted: number
  inserted: number
  updated: number
  duplicatedInFile: number
  failed: number
  problems: ImportProblem[]
  reportCsv: string
}

const IMPORT_COLUMNS = [
  CODE_FIELD,
  MODEL_FIELD,
  MOLD_FIELD,
  CAGE_FIELD,
  CURE_FIELD,
  STRENGTH_FIELD,
  PROD_DATE_FIELD,
  SHIP_DATE_FIELD,
] as const

function assertImporter(authority: LedgerAuthority): void {
  if (authority.role !== ROLE_CLERK) {
    throw new Error('越权操作已拒绝：管片台账导入仅对本工区资料员开放，当前账号只能查看')
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isValidDateText(text: string): boolean {
  if (!DATE_RE.test(text)) return false
  const date = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text
}

function isValidNumberText(text: string): boolean {
  return /^\d+(\.\d+)?$/.test(text) && Number(text) >= 0
}

// 覆盖规则：仅用导入文件里的非空列覆盖目标行；空白列保留库内原值。
function mergeRow(existing: EntryRow, incoming: Record<string, string>): EntryRow {
  const merged: EntryRow = { ...existing }
  for (const field of IMPORT_COLUMNS) {
    const value = incoming[field]?.trim() ?? ''
    if (value !== '') {
      merged[field] = value
    }
  }
  // 回导的是“已经出厂”的管片：补齐出厂日期，状态置为已出厂
  if (isBlank(merged[SHIP_DATE_FIELD])) {
    merged[SHIP_DATE_FIELD] = incoming[SHIP_DATE_FIELD]?.trim() || todayText()
  }
  merged.status = SHIPPED_STATUS
  merged.pending = false
  return merged
}

function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}

export function importLedgerCsv(
  content: string,
  authority: LedgerAuthority,
): LedgerImportResult {
  assertImporter(authority)

  const rows = dropBlankRows(parseCsv(content))
  const problems: ImportProblem[] = []
  if (rows.length < 2) {
    return {
      totalRows: 0,
      upserted: 0,
      inserted: 0,
      updated: 0,
      duplicatedInFile: 0,
      failed: 1,
      problems: [{ line: 0, code: '', reason: '文件没有表头或数据行，无法导入' }],
      reportCsv: buildReport([{ line: 0, code: '', reason: '文件没有表头或数据行，无法导入' }]),
    }
  }

  const header = rows[0].map((cell) => cell.trim())
  const codeIndex = header.indexOf(CODE_FIELD)
  if (codeIndex < 0) {
    return {
      totalRows: rows.length - 1,
      upserted: 0,
      inserted: 0,
      updated: 0,
      duplicatedInFile: 0,
      failed: rows.length - 1,
      problems: [{ line: 1, code: '', reason: `表头缺少必带列「${CODE_FIELD}」，无法按管片编号覆盖` }],
      reportCsv: buildReport([
        { line: 1, code: '', reason: `表头缺少必带列「${CODE_FIELD}」，无法按管片编号覆盖` },
      ]),
    }
  }
  const indexOf = (field: string) => header.indexOf(field)

  const stored = listRows('segmentprod')
  // 只在本工区范围内做覆盖匹配；其他工区同号管片不允许从本工区导入改到
  const byCode = new Map(
    stored
      .filter((row) => cellText(row, ZONE_FIELD) === authority.zone)
      .map((row) => [cellText(row, CODE_FIELD), row]),
  )
  const next = [...stored]
  const seenCodes = new Set<string>()

  let inserted = 0
  let updated = 0
  let duplicatedInFile = 0

  for (let r = 1; r < rows.length; r += 1) {
    const line = r + 1
    const cells = rows[r]
    const read = (field: string): string => {
      const index = indexOf(field)
      return index >= 0 ? (cells[index] ?? '').trim() : ''
    }
    const code = read(CODE_FIELD)

    if (code === '') {
      problems.push({ line, code: '', reason: `缺少「${CODE_FIELD}」，无法定位或新增管片` })
      continue
    }
    if (seenCodes.has(code)) {
      // 反复提交 / 文件内重复：只入一条
      duplicatedInFile += 1
      problems.push({ line, code, reason: '与本文件前面的行重复，已按首次出现的内容入一条，本行跳过' })
      continue
    }

    // 逐栏校验：型号/模具/笼批号是文本，不做格式校验；养护天数与强度必须是非负数值；日期格式
    const cure = read(CURE_FIELD)
    if (cure !== '' && !isValidNumberText(cure)) {
      problems.push({ line, code, reason: `「${CURE_FIELD}」应为非负数字，实际为「${cure}」` })
      continue
    }
    const strength = read(STRENGTH_FIELD)
    if (strength !== '' && !isValidNumberText(strength)) {
      problems.push({ line, code, reason: `「${STRENGTH_FIELD}」应为非负数字（MPa），实际为「${strength}」` })
      continue
    }
    const prodDate = read(PROD_DATE_FIELD)
    if (prodDate !== '' && !isValidDateText(prodDate)) {
      problems.push({ line, code, reason: `「${PROD_DATE_FIELD}」日期格式应为 YYYY-MM-DD 且为合法日期，实际为「${prodDate}」` })
      continue
    }
    const shipDate = read(SHIP_DATE_FIELD)
    if (shipDate !== '' && !isValidDateText(shipDate)) {
      problems.push({ line, code, reason: `「${SHIP_DATE_FIELD}」日期格式应为 YYYY-MM-DD 且为合法日期，实际为「${shipDate}」` })
      continue
    }

    const incoming: Record<string, string> = {
      [CODE_FIELD]: code,
      [MODEL_FIELD]: read(MODEL_FIELD),
      [MOLD_FIELD]: read(MOLD_FIELD),
      [CAGE_FIELD]: read(CAGE_FIELD),
      [CURE_FIELD]: cure,
      [STRENGTH_FIELD]: strength,
      [PROD_DATE_FIELD]: prodDate,
      [SHIP_DATE_FIELD]: shipDate,
    }

    seenCodes.add(code)
    const existing = byCode.get(code)
    if (existing) {
      const merged = mergeRow(existing, incoming)
      const targetIndex = next.findIndex((row) => Number(row.id) === Number(existing.id))
      next[targetIndex] = merged
      updated += 1
    } else {
      const id = next.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
      const created: EntryRow = {
        id,
        status: SHIPPED_STATUS,
        pending: false,
        abnormal: false,
        [CODE_FIELD]: code,
        [MODEL_FIELD]: incoming[MODEL_FIELD] || '未填写',
        [MOLD_FIELD]: incoming[MOLD_FIELD] || '未填写',
        [CAGE_FIELD]: incoming[CAGE_FIELD],
        [CURE_FIELD]: incoming[CURE_FIELD],
        [STRENGTH_FIELD]: incoming[STRENGTH_FIELD],
        [PROD_DATE_FIELD]: incoming[PROD_DATE_FIELD],
        [SHIP_DATE_FIELD]: incoming[SHIP_DATE_FIELD] || todayText(),
        检验人员: '',
        [ZONE_FIELD]: authority.zone,
        生产状态: '正常生产',
      }
      next.push(created)
      byCode.set(code, created)
      inserted += 1
    }
  }

  // 校验通过的行先在内存里改完，落盘只发生一次：写不下则整体撤销，
  // saveRows 会把内存缓存也回滚到导入前，不留写了一半的数据。
  try {
    saveRows('segmentprod', canonicalRows(next))
  } catch (error) {
    if (error instanceof StorageQuotaError) {
      throw new StorageQuotaError('导入数据保存失败，已整体撤销，原有管片台账未改动')
    }
    throw error
  }

  return {
    totalRows: rows.length - 1,
    upserted: inserted + updated,
    inserted,
    updated,
    duplicatedInFile,
    failed: problems.filter((problem) => !problem.reason.includes('与本文件前面的行重复')).length,
    problems,
    reportCsv: buildReport(problems),
  }
}

function buildReport(problems: ImportProblem[]): string {
  const table: (string | number)[][] = [['文件行号', '管片编号', '原因']]
  for (const problem of problems) {
    table.push([String(problem.line), problem.code, problem.reason])
  }
  return toCsv(table)
}
