<template>
  <section class="page" data-module="progress">
    <header class="page-head">
      <div>
        <h2>进度节点管理</h2>
        <p class="page-desc">维护进度节点，围绕节点编号、节点名称、计划完成日、实际完成日做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记进度节点</button>
        <button class="btn" type="button" @click="exportRows">导出进度节点清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 交付清单：直接读管片生产台账，本月出厂数与台账页、导出结论是同一份 -->
    <div class="delivery-card">
      <div class="delivery-head">
        <strong>管片出厂交付清单（{{ delivery.month }}）</strong>
        <label class="filter-item">
          <span>统计月份</span>
          <input type="month" :value="delivery.month" @change="changeMonth" />
        </label>
      </div>
      <p class="task-meta">
        本清单取自管片生产台账（工区：{{ store.zone }}），本月出厂 <strong>{{ delivery.count }}</strong> 环，
        与管片生产页、台账导出结论的本月出厂数完全一致。
      </p>
      <table class="data-table">
        <thead>
          <tr><th>管片编号</th><th>管片型号</th><th>生产模具</th><th>出厂日期</th><th>出厂强度(MPa)</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in delivery.items" :key="item.code">
            <td>{{ item.code }}</td>
            <td>{{ item.model }}</td>
            <td>{{ item.mold }}</td>
            <td>{{ item.shipDate }}</td>
            <td>{{ item.strength || '—' }}</td>
          </tr>
          <tr v-if="!delivery.items.length">
            <td colspan="5" class="empty-state">该月暂无已出厂管片</td>
          </tr>
        </tbody>
      </table>
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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无进度节点数据，可先登记进度节点</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条进度节点记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  segmentDeliveryList,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('progress')
const store = useSessionStore()
const columns = ["节点编号", "节点名称", "计划完成日", "实际完成日", "计划掘进量", "实际掘进量", "偏差天数", "节点状态"]
const actions = ["开始节点", "确认完成", "登记延期"]
const statuses = ["未开始", "进行中", "已完成", "已延期"]
const stats = [{"label": "进行中节点", "value": 0}, {"label": "已完成节点", "value": 0}, {"label": "延期节点", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const authority = computed(() => ({ role: store.role, zone: store.zone }))
const delivery = ref(segmentDeliveryList(authority.value))
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function changeMonth(event: Event) {
  const value = (event.target as HTMLInputElement).value
  if (value) {
    delivery.value = segmentDeliveryList(authority.value, value)
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '进度节点登记入口尚未接入审批流'
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
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    delivery.value = segmentDeliveryList(authority.value, delivery.value.month)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '进度节点列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.delivery-card {
  background: #fff;
  border: 1px solid var(--border);
  border-left: 4px solid #15803d;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.delivery-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; }
.task-meta { color: var(--muted); font-size: 12px; margin: 6px 0; }
</style>
