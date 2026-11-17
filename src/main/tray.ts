/**
 * 托盘常驻与待确认角标（Task 50）。
 *
 * 语义：
 *   - 托盘常驻，不弹窗不抢屏；右键菜单三项「打开评审台 / 待确认 N 条 / 检查新批次」
 *     + 分隔线 + 「退出评审台」（真正退出入口，Task 49）；
 *   - 角标数字 = 待人工确认条数（存疑 + 已建议未确认），与顶栏共用同一份状态计数：
 *     countPending(suggestions|followups)，禁止两处各算；
 *   - 更新时机：批次评估结束 / 用户确认或撤销 / 跨天恢复工作区，由外部调用 refresh() 触发；
 *   - 数字为 0 不显示角标；检查新批次只提示不自动弹窗。
 *
 * 可测性：electron 的 Tray / Menu / nativeImage 经依赖注入，纯逻辑（countPending /
 * badgeTitle / buildMenuTemplate）可直接单测，node 环境不真起 GUI。
 */
import type { Menu, Tray, MenuItemConstructorOptions, NativeImage } from 'electron'

/** 待确认计数来源：一份建议/结论快照，形如 Record<id, {status, confirmed}>。 */
export interface ReviewSnapshot {
  /** 已产出归并建议/结论的条目，键为 candidate_id。 */
  suggestions: Record<string, ReviewEntry>
  /** 追问会话（可选），未确认的存疑条目也计入。 */
  followups?: Record<string, ReviewEntry>
}

/** 单条评审记录：只要没被确认/撤销，就仍是「待人工确认」。 */
export interface ReviewEntry {
  status?: string
  confirmed?: boolean
  /** 显式标记已处理（确认或撤销）也视为不再待确认。 */
  resolved?: boolean
  /** 存疑但尚未给出建议，同样待确认。 */
  uncertain?: boolean
}

/** 顶栏与角标共用的待确认计数：存疑 + 已建议未确认，用同一函数、同一快照。 */
export interface PendingCount {
  /** 存疑待确认条数。 */
  uncertain: number
  /** 已给出建议但未确认条数。 */
  suggestedUnconfirmed: number
  /** 合计 = uncertain + suggestedUnconfirmed，即角标数字。 */
  total: number
}

/** 判定单条是否计入待确认（未被确认、未被撤销/解决）。 */
export function isPendingEntry(entry: ReviewEntry | undefined): boolean {
  if (!entry) return false
  if (entry.confirmed === true || entry.resolved === true) return false
  if (typeof entry.status === 'string' && /^(confirmed|rejected|resolved|done)$/i.test(entry.status)) {
    return false
  }
  return true
}

/**
 * 待确认计数（角标与顶栏唯一口径）。
 * 存疑（uncertain=true 且待处理）计入 uncertain；其余待处理条目计入 suggestedUnconfirmed。
 */
export function countPending(snapshot: ReviewSnapshot): PendingCount {
  let uncertain = 0
  let suggestedUnconfirmed = 0
  const pools = [snapshot.suggestions, snapshot.followups ?? {}]
  for (const pool of pools) {
    for (const entry of Object.values(pool)) {
      if (!isPendingEntry(entry)) continue
      if (entry.uncertain === true) uncertain += 1
      else suggestedUnconfirmed += 1
    }
  }
  return { uncertain, suggestedUnconfirmed, total: uncertain + suggestedUnconfirmed }
}

/** 角标文本：数字为 0 时返回空串（不显示），否则显示数字。 */
export function badgeTitle(count: number): string {
  return count > 0 ? String(Math.floor(count)) : ''
}

export interface TrayActions {
  /** 打开评审台窗口。 */
  openReviewDesk(): void
  /** 切到「待确认」筛选（在已打开的窗口里）。 */
  focusPending(): void
  /** 检查 MDM 是否有新批次；返回发现的新批次数。 */
  checkNewBatch(): number | Promise<number>
  /** 真正退出应用。 */
  quit(): void
}

export interface TrayMenuDeps {
  actions: TrayActions
  /** 当前待确认数，用于菜单「待确认 N 条」文本。 */
  getPendingCount(): number
  /** 是否发现新批次（用于菜单旁提示，不自动弹窗）。 */
  hasNewBatch?(): boolean
}

/** 构造右键菜单模板（三项业务 + 分隔线 + 退出），文本与行为集中定义便于断言。 */
export function buildMenuTemplate(deps: TrayMenuDeps): MenuItemConstructorOptions[] {
  const count = deps.getPendingCount()
  const newHint = deps.hasNewBatch?.() ? ' · 有新批次' : ''
  return [
    { label: '打开评审台', click: () => deps.actions.openReviewDesk() },
    {
      label: `待确认 ${count} 条`,
      click: () => deps.actions.focusPending(),
    },
    {
      label: `检查新批次${newHint}`,
      click: () => {
        void Promise.resolve(deps.actions.checkNewBatch()).catch(() => 0)
      },
    },
    { type: 'separator' },
    { label: '退出评审台', click: () => deps.actions.quit() },
  ]
}

/** electron 依赖的注入桩，node 测试用假对象实现。 */
export interface TrayElectronDeps {
  createTray(icon: NativeImage): TrayLike
  createImage(): NativeImage
  buildFromTemplate(template: MenuItemConstructorOptions[]): unknown
}

export interface TrayLike {
  setContextMenu(menu: unknown): void
  setToolTip(text: string): void
  /** macOS 角标文字；数字为 0 时传空串即不显示。 */
  setTitle(title: string): void
  destroy(): void
}

export interface TrayDeps extends TrayElectronDeps {
  actions: TrayActions
  /** 返回与顶栏同一份的待确认计数快照。 */
  getSnapshot(): ReviewSnapshot
  /** 主进程轮询得到的「是否有新批次」状态源；菜单项据此显示提示，托盘不另算一份。 */
  hasNewBatch?(): boolean
  /** 检查新批次的额外提示钩子（如托盘旁气泡），由主进程决定是否实现。 */
  onNewBatch?(count: number): void
  logger?: (line: string) => void
}

export interface TrayController {
  /** 刷新角标与菜单（评估结束 / 确认撤销 / 恢复工作区后调用）。 */
  refresh(): void
  /** 当前角标数字。 */
  getCount(): number
  /** 当前待确认明细计数（存疑 / 已建议未确认 / 合计）。 */
  getPending(): PendingCount
  /** 销毁托盘（退出流程）。 */
  destroy(): void
}

/**
 * 创建托盘控制器。角标数字来自 getSnapshot() 的 countPending，与顶栏同源；
 * refresh() 是统一更新钩子，保证「同一份状态、同一处计算」。
 */
export function createTray(deps: TrayDeps): TrayController {
  const logger = deps.logger ?? ((line: string) => console.error(line))
  const tray = deps.createTray(deps.createImage())
  let current: PendingCount = countPending(deps.getSnapshot())

  function apply(): void {
    tray.setTitle(badgeTitle(current.total))
    tray.setToolTip(
      current.total > 0
        ? `主数据归并检索系统 · 待确认 ${current.total} 条`
        : '主数据归并检索系统 · 无待确认项',
    )
    tray.setContextMenu(
      deps.buildFromTemplate(
        buildMenuTemplate({
          actions: deps.actions,
          getPendingCount: () => current.total,
          // 新批次提示读外部状态源（主进程轮询结果），不在托盘内另算一份。
          hasNewBatch: deps.hasNewBatch,
        }),
      ),
    )
  }

  function refresh(): void {
    current = countPending(deps.getSnapshot())
    apply()
    logger(`[tray] 角标刷新：待确认 ${current.total} 条（存疑 ${current.uncertain} / 已建议未确认 ${current.suggestedUnconfirmed}）`)
  }

  refresh()

  return {
    refresh,
    getCount: () => current.total,
    getPending: () => current,
    destroy: () => tray.destroy(),
  }
}

/** 供入口使用：把 electron 的 Tray/Menu/nativeImage 包装成注入依赖。 */
export function electronTrayDeps(electron: {
  Tray: typeof Tray
  Menu: typeof Menu
  nativeImage: { createEmpty(): NativeImage }
}): Pick<TrayDeps, 'createTray' | 'createImage' | 'buildFromTemplate'> {
  return {
    createImage: () => electron.nativeImage.createEmpty(),
    createTray: (icon) => new electron.Tray(icon),
    buildFromTemplate: (template) => electron.Menu.buildFromTemplate(template),
  }
}
