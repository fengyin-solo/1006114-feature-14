<template>
  <section class="page" data-module="segmentprod">
    <header class="page-head">
      <div>
        <h2>管片生产管理 · 出厂台账</h2>
        <p class="page-desc">
          出厂台账按「管片型号 + 生产模具」分卷打包交建设单位；页面可见行与打包行严格同源，
          缺哪一列在包内《缺栏清单》点名到管片编号。
        </p>
      </div>
      <div class="page-actions">
        <button v-if="canManage" class="btn primary" type="button" @click="openCreate">登记管片</button>
        <button v-if="canManage" class="btn" type="button" :disabled="exporting" @click="startExport">
          {{ exporting ? '打包中…' : '导出出厂台账（分卷ZIP）' }}
        </button>
        <button v-if="canManage" class="btn" type="button" @click="triggerImportPick">导入补数</button>
        <button class="btn ghost" type="button" @click="downloadTemplate">下载导入模板</button>
        <input
          ref="importInput"
          type="file"
          accept=".csv,text/csv"
          style="display: none"
          @change="onImportFile"
        />
        <span v-if="!canManage" class="perm-note">当前账号（{{ session.account.role }}）仅可查看，导出/导入/登记请用本工区资料员账号</span>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p v-if="exportMessage" class="export-banner" :class="exportKind">
      {{ exportMessage }}
    </p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">页面可见（=本次打包口径）：{{ rows.length }} 行</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item">
        <span>生产状态</span>
        <select v-model="statusFilter">
          <option value="">全部</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column" :class="{ 'cell-blank': isBlankCell(row[column]) }">
            {{ isBlankCell(row[column]) ? '（缺）' : row[column] }}
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="!canManage"
              :title="canManage ? '' : '仅本工区资料员可操作'"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">当前筛选条件下没有管片记录</td>
        </tr>
      </tbody>
    </table>

    <section v-if="jobs.length" class="jobs-panel">
      <h3>导出任务（中断后可从断掉的分卷接着打）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>任务</th><th>行数</th><th>本月出厂数</th><th>状态</th><th>创建时间</th><th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in jobs" :key="job.id">
            <td>{{ job.id }}<br /><small>{{ job.actorName }} · {{ job.scopeLabel }}</small></td>
            <td>{{ job.rowCount }}</td>
            <td>{{ job.monthShipped }}</td>
            <td>
              {{ statusLabel(job.status) }}
              <small v-if="job.status === 'failed'" class="error-text">{{ job.failedReason }}</small>
            </td>
            <td><small>{{ formatTime(job.createdAt) }}</small></td>
            <td class="row-actions">
              <button
                v-if="job.status === 'packing' || job.status === 'failed'"
                class="link"
                type="button"
                :disabled="!canManage"
                @click="resumeJob(job)"
              >
                续传打包
              </button>
              <button
                v-if="job.status === 'ready'"
                class="link"
                type="button"
                :disabled="!canManage"
                @click="downloadJob(job)"
              >
                下载完整包
              </button>
              <button class="link danger" type="button" :disabled="!canManage" @click="removeJob(job)">撤销清理</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="importResult" class="import-panel">
      <h3>导入补数结果</h3>
      <p :class="importResult.ok ? 'ok-text' : 'error-text'">{{ importResult.message }}</p>
      <ul class="import-summary">
        <li>按管片编号覆盖：{{ importResult.updated }} 行</li>
        <li>文件内重复编号合并（只入一条）：{{ importResult.deduped }} 行</li>
        <li>失败行：{{ importResult.failures.length }} 行</li>
      </ul>
      <table v-if="importResult.failures.length" class="data-table">
        <thead><tr><th>文件行号</th><th>管片编号</th><th>失败原因</th></tr></thead>
        <tbody>
          <tr v-for="(failure, index) in importResult.failures" :key="`${failure.line}-${index}`">
            <td>{{ failure.line || '—' }}</td>
            <td>{{ failure.segmentNo || '—' }}</td>
            <td>{{ failure.reason }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条管片记录（{{ metrics.month }} 本月出厂 {{ metrics.monthShipped }} 片，与进度节点交付清单同源）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="createOpen" class="modal-mask" @click.self="createOpen = false">
      <form class="modal-card" @submit.prevent="submitCreate">
        <h3>登记 / 覆盖管片（同编号重复提交只入一条）</h3>
        <label v-for="field in createFields" :key="field.key" class="form-item">
          <span>{{ field.label }}</span>
          <input v-model="createForm[field.key]" :type="field.type" :placeholder="field.placeholder" />
        </label>
        <label class="form-item">
          <span>生产状态</span>
          <select v-model="createForm['生产状态']">
            <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
          </select>
        </label>
        <div class="modal-actions">
          <button class="btn primary" type="submit">保存</button>
          <button class="btn ghost" type="button" @click="createOpen = false">取消</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { runAction as applyAction } from '@/api/local-service'
import {
  buildSegmentPackage,
  cancelSegmentExport,
  downloadSegmentExport,
  importSegmentSupplements,
  listSegmentExportJobs,
  segmentLedgerMetrics,
  stageSegmentExport,
  upsertSegment,
} from '@/api/segment-service'
import { buildCsv } from '@/data/csv'
import { SEGMENT_COLUMNS, querySegmentRows } from '@/data/segment-ledger'
import type { EntryRow, ExportJobRecord, SegmentImportResult } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const canManage = computed(() => session.canManageLedger)

const columns = SEGMENT_COLUMNS
const actions = ['开始浇筑', '确认养护', '办理出厂']
const statuses = ['待浇筑', '养护中', '待出厂', '已出厂']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const statusFilter = ref('')
const filterFields = ['管片编号', '管片型号', '生产模具']

const metrics = ref({ total: 0, curing: 0, waiting: 0, monthShipped: 0, month: '' })
const stats = computed(() => [
  { label: '养护中管片', value: metrics.value.curing },
  { label: '待出厂管片', value: metrics.value.waiting },
  { label: `本月出厂数（${metrics.value.month}）`, value: metrics.value.monthShipped },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const exporting = ref(false)
const exportMessage = ref('')
const exportKind = ref('')
const jobs = ref<ExportJobRecord[]>([])
const importInput = ref<HTMLInputElement | null>(null)
const importResult = ref<SegmentImportResult | null>(null)

function isBlankCell(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true
  }
  const text = String(value).trim()
  return text === '' || text === '—' || text === '-'
}

/** 与导出完全相同的取数口径：筛选 + 状态。打包就用这份 filters，保证行数一致。 */
function activeFilters(): Record<string, string> {
  return { ...filters.value }
}

function resetFilters() {
  filters.value = {}
  statusFilter.value = ''
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    // 直接走领域层查询（local-service 的通用导出不再用于本台账），保证页面与打包同源。
    let matched = querySegmentRows(activeFilters())
    if (statusFilter.value) {
      matched = matched.filter((row) => String(row.status) === statusFilter.value)
    }
    rows.value = matched
    total.value = matched.length
    metrics.value = segmentLedgerMetrics()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '管片生产列表读取失败'
  }
}

async function refreshJobs() {
  jobs.value = await listSegmentExportJobs()
}

async function startExport() {
  if (!canManage.value) {
    return
  }
  exporting.value = true
  exportKind.value = ''
  try {
    const job = await stageSegmentExport(activeFilters(), (progress) => {
      exportMessage.value = progress.message
      exportKind.value = progress.stage === 'failed' ? 'is-error' : ''
    }, undefined, statusFilter.value)
    exportMessage.value = `打包完成：页面 ${job.rowCount} 行已全部入卷（本月出厂 ${job.monthShipped} 片），可在下方任务列表下载完整 ZIP。`
    exportKind.value = 'is-ok'
    await refreshJobs()
  } catch (error) {
    exportKind.value = 'is-error'
    exportMessage.value = error instanceof Error ? error.message : '导出失败'
  } finally {
    exporting.value = false
  }
}

async function resumeJob(job: ExportJobRecord) {
  exporting.value = true
  exportKind.value = ''
  try {
    // 续传前核对数据是否仍与冻结快照一致；数据变过则旧包作废，清掉旧任务后重打。
    const fresh = buildSegmentPackage(job.filters, new Date(job.createdAt), job.statusFilter)
    if (fresh.checksum !== job.checksum || fresh.rows.length !== job.rowCount) {
      await cancelSegmentExport(job.id)
      exportMessage.value = `任务 ${job.id} 的台账数据在中断期间发生变化，旧包已作废，已按当前页面口径重新打包。`
      exportKind.value = ''
      await refreshJobs()
    }
    await stageSegmentExport(job.filters, (progress) => {
      exportMessage.value = `${job.id}：${progress.message}`
      exportKind.value = progress.stage === 'failed' ? 'is-error' : ''
    }, undefined, job.statusFilter)
    exportMessage.value = `任务 ${job.id} 已从中断分块续传完成，可下载。`
    exportKind.value = 'is-ok'
    await refreshJobs()
  } catch (error) {
    exportKind.value = 'is-error'
    exportMessage.value = error instanceof Error ? error.message : '续传失败'
  } finally {
    exporting.value = false
  }
}

async function downloadJob(job: ExportJobRecord) {
  exportKind.value = ''
  try {
    const { filename } = await downloadSegmentExport(job.id, (progress) => {
      exportMessage.value = progress.message
    })
    exportMessage.value = `完整台账包已开始下载：${filename}（校验不通过不会产生文件）`
    exportKind.value = 'is-ok'
  } catch (error) {
    exportKind.value = 'is-error'
    exportMessage.value = error instanceof Error ? error.message : '下载失败'
  }
}

async function removeJob(job: ExportJobRecord) {
  try {
    await cancelSegmentExport(job.id)
    await refreshJobs()
    exportMessage.value = `任务 ${job.id} 已撤销，暂存分卷已清理，不会留下半包文件。`
    exportKind.value = ''
  } catch (error) {
    exportKind.value = 'is-error'
    exportMessage.value = error instanceof Error ? error.message : '撤销失败'
  }
}

function triggerImportPick() {
  importResult.value = null
  importInput.value?.click()
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  try {
    const text = await file.text()
    importResult.value = importSegmentSupplements(text)
  } catch (error) {
    // 越权等 ServiceError 在这里接住，当场提示拒绝。
    errorMessage.value = error instanceof Error ? error.message : '导入失败'
  } finally {
    input.value = ''
    reload()
  }
}

function downloadTemplate() {
  const header = ['管片编号', '钢筋笼批号', '养护天数', '出厂强度', '出厂日期', '检验人员']
  const sample = ['SEGM-0004', 'GL-20260920-A01', '28', '52.0', '2026-10-06', '李检验']
  const blob = new Blob([buildCsv([header, sample])], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '管片补数导入模板.csv'
  anchor.click()
  URL.revokeObjectURL(url)
}

const createOpen = ref(false)
const createForm = reactive<Record<string, string>>({})
const createFields = [
  { key: '管片编号', label: '管片编号（覆盖键）', type: 'text', placeholder: '如 SEGM-0004' },
  { key: '管片型号', label: '管片型号', type: 'text', placeholder: '如 通用环-K块' },
  { key: '生产模具', label: '生产模具', type: 'text', placeholder: '如 MD-01' },
  { key: '钢筋笼批号', label: '钢筋笼批号', type: 'text', placeholder: '' },
  { key: '生产日期', label: '生产日期', type: 'date', placeholder: 'YYYY-MM-DD' },
  { key: '养护天数', label: '养护天数', type: 'number', placeholder: '' },
  { key: '出厂强度', label: '出厂强度(MPa)', type: 'number', placeholder: '' },
  { key: '检验人员', label: '检验人员', type: 'text', placeholder: '' },
]

function openCreate() {
  for (const key of Object.keys(createForm)) {
    delete createForm[key]
  }
  createForm['生产状态'] = '待浇筑'
  createOpen.value = true
  errorMessage.value = ''
}

function submitCreate() {
  const draft = {
    管片编号: createForm['管片编号'] ?? '',
    管片型号: createForm['管片型号'],
    生产模具: createForm['生产模具'],
    钢筋笼批号: createForm['钢筋笼批号'],
    生产日期: createForm['生产日期'],
    养护天数: createForm['养护天数'] === '' || createForm['养护天数'] === undefined
      ? ''
      : Number(createForm['养护天数']),
    出厂强度: createForm['出厂强度'] === '' || createForm['出厂强度'] === undefined
      ? ''
      : Number(createForm['出厂强度']),
    检验人员: createForm['检验人员'],
    生产状态: createForm['生产状态'],
  } as Parameters<typeof upsertSegment>[0]
  try {
    const result = upsertSegment(draft)
    errorMessage.value = result.ok ? '' : result.message
    if (result.ok) {
      createOpen.value = false
      exportMessage.value = result.message
      exportKind.value = 'is-ok'
      reload()
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '登记失败'
  }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction('segmentprod', Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function statusLabel(status: ExportJobRecord['status']): string {
  return {
    packing: '分卷暂存中（可续传）',
    ready: '已就绪，可下载',
    failed: '暂存失败',
    canceled: '已撤销',
  }[status]
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

onMounted(() => {
  reload()
  refreshJobs()
})
</script>

<style scoped>
.perm-note { color: #b42318; font-size: 12px; }
.export-banner { padding: 8px 12px; border-radius: 6px; font-size: 13px; }
.export-banner.is-ok { background: #ecfdf3; color: #027a48; border: 1px solid #abefc6; }
.export-banner.is-error { background: #fef3f2; color: #b42318; border: 1px solid #fda29b; }
.cell-blank { color: #b42318; }
.jobs-panel, .import-panel {
  margin-top: 16px; background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px;
}
.jobs-panel h3, .import-panel h3 { margin: 0 0 8px; font-size: 14px; }
.import-summary { font-size: 13px; margin: 4px 0 8px; padding-left: 18px; }
.ok-text { color: #027a48; }
.link.danger { color: #b42318; }
.modal-mask {
  position: fixed; inset: 0; background: rgba(16, 24, 40, 0.45);
  display: flex; align-items: center; justify-content: center; z-index: 20;
}
.modal-card {
  background: #fff; border-radius: 10px; padding: 18px 20px; width: 520px;
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px;
}
.modal-card h3 { grid-column: 1 / -1; margin: 0; }
.form-item { display: flex; flex-direction: column; font-size: 12px; color: var(--muted); gap: 4px; }
.form-item input, .form-item select { padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.modal-actions { grid-column: 1 / -1; display: flex; gap: 8px; justify-content: flex-end; }
</style>
