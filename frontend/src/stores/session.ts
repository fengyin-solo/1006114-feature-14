import { defineStore } from 'pinia'

/**
 * 纯前端权限模型：没有后端，账号在仓库内置，当前账号存在 localStorage 里。
 * 导出/导入/登记属于写操作，只放给本工区的资料员；监理等其他账号拿到页面链接也只能看。
 * 真正的拒绝发生在 local-service / segment 领域层，页面按钮只是隐藏，不能当作安全边界。
 */
export type Account = {
  id: string
  name: string
  role: '资料员' | '监理' | '访客'
  /** 所属工区，台账导出只允许本工区的数据责任人发起。 */
  workArea: '一工区' | '二工区'
}

export const ACCOUNTS: Account[] = [
  { id: 'u-001', name: '李资料', role: '资料员', workArea: '一工区' },
  { id: 'u-002', name: '王监理', role: '监理', workArea: '一工区' },
  { id: 'u-003', name: '赵资料', role: '资料员', workArea: '二工区' },
  { id: 'u-004', name: '来访人员', role: '访客', workArea: '一工区' },
]

/** 当前交付的台账归属工区：换个工区的数据时只改这里，权限口径跟着走。 */
export const LEDGER_WORK_AREA: Account['workArea'] = '一工区'

const SESSION_KEY = 'shield-tunnel-construction:session'

function readAccountId(): string {
  if (typeof window !== 'undefined' && window.localStorage) {
    const saved = window.localStorage.getItem(SESSION_KEY)
    if (saved && ACCOUNTS.some((item) => item.id === saved)) {
      return saved
    }
  }
  // 默认以一工区监理（只读）进入，避免一上来就给导出权限。
  return 'u-002'
}

export const useSessionStore = defineStore('session', {
  state: () => {
    const account = ACCOUNTS.find((item) => item.id === readAccountId()) ?? ACCOUNTS[0]
    return {
      accountId: account.id,
      shiftLabel: '白班 08:00-20:00',
      scope: '盾构隧道掘进施工管理平台',
    }
  },
  getters: {
    account(state): Account {
      return ACCOUNTS.find((item) => item.id === state.accountId) ?? ACCOUNTS[0]
    },
    workArea(): Account['workArea'] {
      return this.account.workArea
    },
    /** 台账写操作（导出打包、导入补数、登记）要求：资料员 + 本工区。 */
    canManageLedger(): boolean {
      return this.account.role === '资料员' && this.account.workArea === LEDGER_WORK_AREA
    },
    canOperate(): boolean {
      return this.account.role !== '访客'
    },
  },
  actions: {
    switchAccount(id: string) {
      if (!ACCOUNTS.some((item) => item.id === id)) {
        return
      }
      this.accountId = id
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(SESSION_KEY, id)
      }
    },
    setShift(label: string) {
      this.shiftLabel = label
    },
  },
})
