<template>
  <div class="app-shell">
    <aside class="app-side">
      <h1 class="app-title">盾构隧道掘进施工管理平台</h1>
      <nav class="nav-list">
        <RouterLink v-for="item in navItems" :key="item.path" :to="item.path" class="nav-item">
          {{ item.label }}
        </RouterLink>
      </nav>
    </aside>
    <main class="app-main">
      <header class="app-head">
        <span class="head-desc">面向盾构机台账、掘进环次、管片拼装、同步注浆、渣土外运、地表沉降监测与轴线纠偏的一体化盾构隧道施工管理平台。</span>
        <span class="head-user">
          当前账号：{{ store.account.name }}（{{ store.account.role }}·{{ store.account.workArea }}）
          <label class="account-switch">
            切换
            <select :value="store.accountId" @change="onSwitchAccount">
              <option v-for="account in ACCOUNTS" :key="account.id" :value="account.id">
                {{ account.name }}｜{{ account.role }}｜{{ account.workArea }}
              </option>
            </select>
          </label>
        </span>
      </header>
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { useSessionStore, ACCOUNTS } from '@/stores/session'

const store = useSessionStore()

function onSwitchAccount(event: Event) {
  store.switchAccount((event.target as HTMLSelectElement).value)
}

const navItems = [{ label: "运营概览", path: "/" }, { label: "盾构机台账", path: "/shield" }, { label: "掘进环次", path: "/ring" }, { label: "管片拼装", path: "/segment" }, { label: "同步注浆", path: "/grouting" }, { label: "渣土外运", path: "/muck" }, { label: "地表沉降", path: "/settlement" }, { label: "轴线偏差", path: "/axis" }, { label: "刀具磨损", path: "/cutter" }, { label: "管片生产", path: "/segmentprod" }, { label: "浆液拌制", path: "/mortar" }, { label: "洞内通风", path: "/ventilation" }, { label: "建筑监测", path: "/building" }, { label: "管线探查", path: "/utility" }, { label: "进度节点", path: "/progress" }, { label: "试验检测", path: "/testing" }, { label: "应急演练", path: "/drill" }, { label: "班组进场", path: "/crew" }, { label: "安全巡检", path: "/safety" }]
</script>
