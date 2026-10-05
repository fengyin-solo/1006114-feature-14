/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 带业务错误码的失败：权限不足与普通业务失败要分开处理（越权必须当场拒绝）。 */
export class ServiceError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
  }
}

/** 管片台账导入：一行的判定结果。 */
export type SegmentImportFailure = {
  line: number
  segmentNo: string
  reason: string
}

export type SegmentImportResult = {
  ok: boolean
  inserted: number
  updated: number
  /** 同一文件内管片编号重复、按末行覆盖时被顶替的行数（不是失败，只入一条）。 */
  deduped: number
  total: number
  failures: SegmentImportFailure[]
  message: string
}

/** 导出打包：分卷（一个文件 = 一卷）暂存与续传所需的信息。 */
export type ExportFilePlan = {
  /** 包内路径，如 台账/通用环-K块/通用环-K块_MD-01_管片台账.csv */
  path: string
  kind: 'manifest' | 'missing' | 'delivery' | 'ledger'
  model: string
  mold: string
  rowCount: number
  size: number
  crc: number
  chunks: number
}

export type ExportJobRecord = {
  id: string
  actorId: string
  actorName: string
  scopeLabel: string
  createdAt: string
  filters: Record<string, string>
  statusFilter: string
  rowCount: number
  checksum: string
  month: string
  monthShipped: number
  /** 打包计划 + 创建任务时冻结的数据快照，续传就按这份快照接着打。 */
  files: ExportFilePlan[]
  snapshot: EntryRow[]
  status: 'packing' | 'ready' | 'failed' | 'canceled'
  failedReason: string
}
