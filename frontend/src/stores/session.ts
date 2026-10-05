import { defineStore } from 'pinia'

// 纯前端演示环境里的“账号体系”：没有后端，角色与工区用账号表固化。
// 真正的鉴权必须由服务端签发并在每个写接口上校验；这里的服务层
// （api/segment-*）仍然按同一规则强制判定，页面只做入口隐藏，
// 任何账号拿着入口/链接直接调服务，越权都会被当场拒绝。

export const ROLE_CLERK = '资料员'
export const ROLE_VIEWER = '查看账号'
export const ROLE_ADMIN = '值班管理员'

export type SessionAccount = {
  id: string
  name: string
  role: string
  zone: string
}

// 预置账号：本工区资料员可导出/导入；值班管理员跨工区只读；
// 查看账号在本工区也只读——拿到链接也只能看。
export const ACCOUNTS: SessionAccount[] = [
  { id: 'clerk-1', name: '周资料员', role: ROLE_CLERK, zone: '盾构一工区' },
  { id: 'admin', name: '值班管理员', role: ROLE_ADMIN, zone: '全线（只读）' },
  { id: 'viewer-1', name: '一工区查看账号', role: ROLE_VIEWER, zone: '盾构一工区' },
]

const SESSION_KEY = 'shield-tunnel-construction:session'

function loadAccountId(): string {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem(SESSION_KEY)
    if (saved && ACCOUNTS.some((account) => account.id === saved)) {
      return saved
    }
  }
  return ACCOUNTS[0].id
}

export const useSessionStore = defineStore('session', {
  state: () => {
    const account = ACCOUNTS.find((item) => item.id === loadAccountId()) ?? ACCOUNTS[0]
    return {
      accountId: account.id,
      operator: account.name,
      shiftLabel: '白班 08:00-20:00',
      scope: '盾构隧道掘进施工管理平台',
    }
  },
  getters: {
    account(): SessionAccount {
      return ACCOUNTS.find((item) => item.id === this.accountId) ?? ACCOUNTS[0]
    },
    role(): string {
      return this.account.role
    },
    zone(): string {
      return this.account.zone
    },
    // 台账导出/导入入口只给本工区资料员
    canExportLedger(): boolean {
      return this.account.role === ROLE_CLERK
    },
  },
  actions: {
    login(accountId: string) {
      const account = ACCOUNTS.find((item) => item.id === accountId)
      if (!account) {
        throw new Error(`未知账号 ${accountId}`)
      }
      this.accountId = account.id
      this.operator = account.name
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(SESSION_KEY, account.id)
      }
    },
    setShift(label: string) {
      this.shiftLabel = label
    },
  },
})
