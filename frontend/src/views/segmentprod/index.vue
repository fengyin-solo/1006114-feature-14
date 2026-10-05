<template>
  <section class="page" data-module="segmentprod">
    <header class="page-head">
      <div>
        <h2>管片生产管理</h2>
        <p class="page-desc">
          出厂台账按「管片型号 + 生产模具」分卷打包；页面可见行与打包行同口径，缺栏在册子中点名到列。
          当前工区：<strong>{{ store.zone }}</strong>
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记管片</button>
        <button
          class="btn"
          type="button"
          :disabled="!store.canExportLedger"
          :title="store.canExportLedger ? '按当前筛选结果分卷打包' : '仅本工区资料员可导出，当前账号只能查看'"
          @click="startExport"
        >
          导出出厂台账（分卷打包）
        </button>
      </div>
    </header>

    <p v-if="!store.canExportLedger" class="status-legend">
      <span class="legend-item">当前账号「{{ store.role }}」只能查看本页；导出/导入入口仅本工区资料员可用，越权调用会被当场拒绝</span>
    </p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 打包任务：一卷一卷打，断了可从断掉的卷续打；只有全部就绪才允许下载 -->
    <div v-if="task" class="task-card" :class="task.state">
      <div class="task-head">
        <strong>
          台账打包任务（{{ progress.done }}/{{ progress.total }} 卷）
          <span class="task-state">{{ stateText }}</span>
        </strong>
        <span class="task-meta">共 {{ task.totalRows }} 条 · 本月出厂 {{ task.shippedThisMonth }} 条 · 缺栏点名 {{ task.missingCount }} 条</span>
      </div>
      <ul class="volume-list">
        <li v-for="volume in task.volumes" :key="volume.key" :class="volume.state">
          {{ volume.state === 'done' ? '✓' : '…' }} {{ volume.filename }}
          <span class="task-meta">（{{ volume.rowCount }} 条）</span>
        </li>
      </ul>
      <p v-if="task.state === 'failed'" class="error-text">{{ task.failure }}</p>
      <div class="task-actions">
        <button
          v-if="task.state === 'packing'"
          class="btn primary"
          type="button"
          @click="resumeExport"
        >
          从断掉的卷续打
        </button>
        <button
          v-if="task.state === 'ready'"
          class="btn primary"
          type="button"
          @click="finishDownload"
        >
          下载完整册子（ZIP）
        </button>
        <button class="btn ghost" type="button" @click="cancelTask">
          {{ task.state === 'failed' ? '清除作废任务' : '撤销打包（不留半包）' }}
        </button>
      </div>
    </div>

    <!-- 导入补数：已出厂管片回导，同号覆盖不追加 -->
    <div v-if="store.canExportLedger" class="import-card">
      <strong>已出厂管片回导补数</strong>
      <p class="task-meta">
        以「管片编号」为唯一键：同号整行覆盖（空白列不冲掉原值），新号新增并置为已出厂；
        文件内同号重复只入一条；失败行单列原因。
      </p>
      <div class="task-actions">
        <input ref="fileInput" class="btn" type="file" accept=".csv,text/csv" @change="onFilePicked" />
      </div>
      <div v-if="importResult" class="import-result">
        <p>
          共解析 {{ importResult.totalRows }} 行：新增 {{ importResult.inserted }} 条、
          覆盖 {{ importResult.updated }} 条、文件内重复跳过 {{ importResult.duplicatedInFile }} 条、
          校验失败 {{ importResult.failed }} 条。
        </p>
        <ul v-if="importResult.problems.length" class="problem-list">
          <li v-for="(problem, index) in importResult.problems" :key="index" class="error-text">
            第 {{ problem.line }} 行{{ problem.code ? `（${problem.code}）` : '' }}：{{ problem.reason }}
          </li>
        </ul>
        <button class="btn" type="button" @click="downloadFailureReport">下载失败/跳过行清单 CSV</button>
      </div>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      <span class="task-meta">导出将严格按当前查询结果打包</span>
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
          <td v-for="column in columns" :key="column">
            {{ row[column] ?? '—' }}
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无管片生产数据，可先登记管片</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条管片生产记录（本工区，按生产日期升序）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  listSegmentLedger,
  moduleMeta,
  runAction as applyAction,
  segmentLedgerBoard,
} from '@/api/local-service'
import {
  abortLedgerExport,
  downloadLedgerPackage,
  loadExportTask,
  pumpLedgerExport,
  startLedgerExport,
  taskProgress,
  type LedgerExportTask,
} from '@/api/segment-export'
import { importLedgerCsv, type LedgerImportResult } from '@/api/segment-import'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'
import { downloadText } from '@/utils/download'

const meta = moduleMeta('segmentprod')
const store = useSessionStore()
const columns = [
  '管片编号', '管片型号', '生产模具', '钢筋笼批号', '养护天数', '出厂强度',
  '生产日期', '出厂日期', '检验人员', '所属工区', '生产状态',
]
const actions = ['开始浇筑', '确认养护', '办理出厂']
const statuses = ['待浇筑', '养护中', '待出厂', '已出厂']
const statMeta = [
  { label: '养护中管片', key: 'curing' },
  { label: '待出厂管片', key: 'waiting' },
  { label: '本月出厂数', key: 'shippedThisMonth' },
] as const

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const stats = ref(statMeta.map((item) => ({ label: item.label, value: 0 })))
const task = ref<LedgerExportTask | null>(null)
const importResult = ref<LedgerImportResult | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const authority = computed(() => ({ role: store.role, zone: store.zone }))
const progress = computed(() =>
  task.value ? taskProgress(task.value) : { done: 0, total: 0 },
)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stateText = computed(() => {
  if (!task.value) return ''
  if (task.value.state === 'packing') return '打包中（可续打）'
  if (task.value.state === 'ready') return '已就绪，可下载'
  return '已作废'
})

function resetFilters() {
  filters.value = {}
  reload()
}

function refreshTask() {
  task.value = loadExportTask()
}

function startExport() {
  errorMessage.value = ''
  try {
    startLedgerExport(authority.value, filters.value)
    // 建任务后立刻打一拍：页面马上有进度；若中途关掉，再进来仍可从断卷续打
    task.value = pumpLedgerExport(authority.value)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '导出发起失败'
  }
}

function resumeExport() {
  errorMessage.value = ''
  try {
    task.value = pumpLedgerExport(authority.value)
    reload()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '续打失败'
    refreshTask()
  }
}

function finishDownload() {
  errorMessage.value = ''
  try {
    downloadLedgerPackage(authority.value)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '下载失败，册子未生成完整'
  }
}

function cancelTask() {
  errorMessage.value = ''
  try {
    abortLedgerExport(authority.value)
    refreshTask()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '撤销失败'
  }
}

function onFilePicked(event: Event) {
  errorMessage.value = ''
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      importResult.value = importLedgerCsv(String(reader.result ?? ''), authority.value)
      reload()
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '导入失败，数据已整体撤销'
    }
    input.value = ''
  }
  reader.onerror = () => {
    errorMessage.value = '文件读取失败，请重新选择'
  }
  reader.readAsText(file, 'utf-8')
}

function downloadFailureReport() {
  if (!importResult.value) return
  downloadText('管片导入失败行清单.csv', importResult.value.reportCsv)
}

function openCreate() {
  errorMessage.value = '管片登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listSegmentLedger(authority.value, filters.value)
    rows.value = payload.items
    total.value = payload.total
    const board = segmentLedgerBoard(authority.value)
    stats.value = statMeta.map((item) => ({ label: item.label, value: board[item.key] }))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '管片生产列表读取失败'
  }
}

onMounted(() => {
  reload()
  refreshTask()
})
</script>

<style scoped>
.task-card,
.import-card {
  background: #fff;
  border: 1px solid var(--border);
  border-left: 4px solid var(--brand);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.task-card.ready { border-left-color: #15803d; }
.task-card.failed { border-left-color: #b42318; }
.task-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.task-meta { color: var(--muted); font-size: 12px; font-weight: normal; }
.task-state { font-size: 12px; color: var(--brand); font-weight: normal; }
.task-card.ready .task-state { color: #15803d; }
.task-card.failed .task-state { color: #b42318; }
.volume-list { margin: 8px 0; padding-left: 18px; font-size: 13px; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 2px 16px; }
.volume-list li.pending { color: var(--muted); }
.task-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.import-card { border-left-color: #7c3aed; margin-top: 4px; }
.import-result { margin-top: 8px; font-size: 13px; }
.problem-list { margin: 6px 0; padding-left: 18px; }
</style>
