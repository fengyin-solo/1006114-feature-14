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

    <section class="delivery-panel">
      <header class="delivery-head">
        <h3>交付清单 · 管片出厂（与管片生产台账同源）</h3>
        <span class="delivery-tip">台账包内《00_本月出厂交付清单.csv》与下表取的是同一份数据，不会出现两套数</span>
      </header>
      <div class="stat-row">
        <article class="stat-card">
          <span class="stat-label">统计月份</span>
          <strong class="stat-value">{{ delivery.month }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">本月出厂数</span>
          <strong class="stat-value">{{ delivery.monthShipped }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">台账在册总数</span>
          <strong class="stat-value">{{ delivery.total }}</strong>
        </article>
      </div>
      <table class="data-table">
        <thead><tr><th>出厂日期</th><th>出厂管片数</th><th>管片编号</th></tr></thead>
        <tbody>
          <tr v-for="row in delivery.byDay" :key="row.day">
            <td>{{ row.day }}</td>
            <td>{{ row.count }}</td>
            <td>{{ row.nos }}</td>
          </tr>
          <tr v-if="!delivery.byDay.length">
            <td colspan="3" class="empty-state">{{ delivery.month }} 暂无出厂记录</td>
          </tr>
        </tbody>
      </table>
    </section>

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
} from '@/api/local-service'
import { currentMonth, monthShippedCount, querySegmentRows } from '@/data/segment-ledger'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('progress')
const columns = ["节点编号", "节点名称", "计划完成日", "实际完成日", "计划掘进量", "实际掘进量", "偏差天数", "节点状态"]
const actions = ["开始节点", "确认完成", "登记延期"]
const statuses = ["未开始", "进行中", "已完成", "已延期"]
const stats = [{"label": "进行中节点", "value": 0}, {"label": "已完成节点", "value": 0}, {"label": "延期节点", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 交付清单与管片生产台账导出包共用 querySegmentRows/monthShippedCount，两处本月出厂数一致。
const deliveryTick = ref(0)
const delivery = computed(() => {
  deliveryTick.value // 依赖 tick：管片台账变化（含本页动作触发的刷新）时重算。
  const month = currentMonth()
  const segmentRows = querySegmentRows()
  const shipped = segmentRows.filter((row) =>
    String(row.status) === '已出厂' && String(row['出厂日期'] ?? '').startsWith(month))
  const grouped = new Map<string, EntryRow[]>()
  for (const row of shipped) {
    const day = String(row['出厂日期'] ?? '').slice(0, 10)
    const list = grouped.get(day) ?? []
    list.push(row)
    grouped.set(day, list)
  }
  const byDay = [...grouped.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, list]) => ({
      day,
      count: list.length,
      nos: list.map((row) => String(row['管片编号'])).join('、'),
    }))
  return { month, monthShipped: monthShippedCount(segmentRows, month), total: segmentRows.length, byDay }
})

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
  deliveryTick.value += 1
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '进度节点列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.delivery-panel {
  background: #fff; border: 1px solid var(--border); border-radius: 8px;
  padding: 12px; margin-bottom: 12px;
}
.delivery-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.delivery-head h3 { margin: 0; font-size: 15px; }
.delivery-tip { font-size: 12px; color: var(--muted); }
</style>
