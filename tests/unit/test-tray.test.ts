/**
 * 托盘常驻与待确认角标单测（Task 50）。
 *
 * 不真起 Electron：fake Tray / Menu 经依赖注入，断言：
 *   - 右键菜单三项文本与点击行为（打开 / 待确认筛选 / 检查新批次）+ 退出项；
 *   - 角标数字与顶栏计数来自同一份 countPending 快照（存疑 + 已建议未确认）；
 *   - 用户确认后refresh 递减；数字为 0 不显示角标；
 *   - 检查新批次有提示但不自动打开窗口。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  badgeTitle,
  buildMenuTemplate,
  countPending,
  createTray,
  isPendingEntry,
  type ReviewSnapshot,
  type TrayActions,
  type TrayController,
  type TrayDeps,
  type TrayLike,
} from '../../src/main/tray'

/** fake Tray：记录角标标题、tooltip、菜单模板。 */
class FakeTray implements TrayLike {
  title = 'initial'
  tooltip = ''
  menus: unknown[] = []
  destroyed = false
  setContextMenu(menu: unknown): void {
    this.menus.push(menu)
  }
  setToolTip(text: string): void {
    this.tooltip = text
  }
  setTitle(title: string): void {
    this.title = title
  }
  destroy(): void {
    this.destroyed = true
  }
}

/** 用可变的评审快照驱动托盘，模拟工作区状态变化。 */
function makeHarness(initial: ReviewSnapshot, actions?: Partial<TrayActions>) {
  const tray = new FakeTray()
  let snapshot: ReviewSnapshot = initial
  let newBatch = false
  const spies: TrayActions = {
    openReviewDesk: vi.fn(),
    focusPending: vi.fn(),
    checkNewBatch: vi.fn(() => 0),
    quit: vi.fn(),
    ...actions,
  }
  const templates: Array<Array<Record<string, any>>> = []
  const deps: TrayDeps = {
    createImage: () => ({}) as never,
    createTray: () => tray,
    buildFromTemplate: (template) => {
      templates.push(template as Array<Record<string, any>>)
      return { template }
    },
    actions: spies,
    getSnapshot: () => snapshot,
    hasNewBatch: () => newBatch,
    logger: () => {},
  }
  const controller: TrayController = createTray(deps)
  return {
    tray,
    controller,
    spies,
    templates,
    setSnapshot: (next: ReviewSnapshot) => (snapshot = next),
    setNewBatch: (value: boolean) => (newBatch = value),
  }
}

function snap(entries: Record<string, any>, followups: Record<string, any> = {}): ReviewSnapshot {
  return { suggestions: entries, followups }
}

describe('托盘与角标', () => {
  it('countPending：角标 = 存疑 + 已建议未确认，与顶栏同一口径', () => {
    const result = countPending(
      snap(
        {
          a: { uncertain: true }, // 存疑待确认
          b: { status: 'suggested' }, // 已建议未确认
          c: { confirmed: true }, // 已确认
          d: { status: 'rejected' }, // 已撤销
          e: { resolved: true },
        },
        { f: { uncertain: true } }, // 追问里的存疑
      ),
    )
    expect(result).toEqual({ uncertain: 2, suggestedUnconfirmed: 1, total: 3 })
    // 顶栏与角标都以 total 为唯一数字来源
    expect(badgeTitle(result.total)).toBe('3')
  })

  it('isPendingEntry：确认 / 撤销 / 已解决条不计入待确认', () => {
    expect(isPendingEntry(undefined)).toBe(false)
    expect(isPendingEntry({})).toBe(true)
    expect(isPendingEntry({ confirmed: true })).toBe(false)
    expect(isPendingEntry({ status: 'confirmed' })).toBe(false)
    expect(isPendingEntry({ status: 'rejected' })).toBe(false)
    expect(isPendingEntry({ resolved: true })).toBe(false)
  })

  it('右键菜单三项文本 + 行为正确，含独立退出项', () => {
    const h = makeHarness(snap({ a: {}, b: {}, c: {} }))
    const template = h.templates[h.templates.length - 1]
    expect(template.map((item) => item.label)).toEqual([
      '打开评审台',
      '待确认 3 条',
      '检查新批次',
      undefined, // separator
      '退出评审台',
    ])
    expect(template[0].type).toBeUndefined()
    expect(template[3].type).toBe('separator')

    template[0].click?.({} as never)
    template[1].click?.({} as never)
    template[2].click?.({} as never)
    template[4].click?.({} as never)
    expect(h.spies.openReviewDesk).toHaveBeenCalledTimes(1)
    expect(h.spies.focusPending).toHaveBeenCalledTimes(1)
    expect(h.spies.checkNewBatch).toHaveBeenCalledTimes(1)
    expect(h.spies.quit).toHaveBeenCalledTimes(1)
  })

  it('角标数字与 countPending 一致，菜单「待确认 N 条」同步同一计数', () => {
    const h = makeHarness(snap({ a: {}, b: {} }))
    expect(h.controller.getCount()).toBe(2)
    expect(h.tray.title).toBe('2')
    expect(h.tray.tooltip).toContain('待确认 2 条')
    const template = h.templates[h.templates.length - 1]
    expect(template[1].label).toBe('待确认 2 条')
    expect(h.controller.getPending()).toEqual({ uncertain: 0, suggestedUnconfirmed: 2, total: 2 })
  })

  it('用户确认后 refresh：角标递减；全部确认后数字为 0 不显示', () => {
    const h = makeHarness(snap({ a: {}, b: {}, c: {} }))
    expect(h.controller.getCount()).toBe(3)
    expect(h.tray.title).toBe('3')

    // 确认一条
    h.setSnapshot(snap({ a: { confirmed: true }, b: {}, c: {} }))
    h.controller.refresh()
    expect(h.controller.getCount()).toBe(2)
    expect(h.tray.title).toBe('2')

    // 全部确认/撤销
    h.setSnapshot(snap({ a: { confirmed: true }, b: { status: 'rejected' }, c: { resolved: true } }))
    h.controller.refresh()
    expect(h.controller.getCount()).toBe(0)
    expect(h.tray.title).toBe('') // 0 不显示角标
    expect(h.tray.tooltip).toContain('无待确认项')
    expect(badgeTitle(0)).toBe('')
  })

  it('刷新时机：批次评估结束 / 确认撤销 / 跨天恢复都通过 refresh 重算同一快照', () => {
    const h = makeHarness(snap({ a: {} }))
    expect(h.controller.getCount()).toBe(1)
    // 模拟批次评估结束新增两条
    h.setSnapshot(snap({ a: {}, b: {}, c: {}, d: { confirmed: true } }))
    h.controller.refresh()
    expect(h.controller.getCount()).toBe(3)
    // 模拟跨天恢复工作区（快照替换），再刷新
    h.setSnapshot(snap({ z: {} }))
    h.controller.refresh()
    expect(h.controller.getCount()).toBe(1)
    expect(h.tray.title).toBe('1')
  })

  it('检查新批次：发现新批次时菜单提示，不自动打开窗口', () => {
    const h = makeHarness(snap({}), { checkNewBatch: vi.fn(() => 2) })
    h.setNewBatch(true)
    h.controller.refresh()
    const template = h.templates[h.templates.length - 1]
    expect(template[2].label).toContain('有新批次')
    expect(h.spies.openReviewDesk).not.toHaveBeenCalled()
    template[2].click?.({} as never)
    expect(h.spies.checkNewBatch).toHaveBeenCalledTimes(1)
  })

  it('badgeTitle 负数与小数归一：0 或负不显示，正数取整', () => {
    expect(badgeTitle(-5)).toBe('')
    expect(badgeTitle(0)).toBe('')
    expect(badgeTitle(4.9)).toBe('4')
  })

  it('destroy 调用托盘 destroy', () => {
    const h = makeHarness(snap({}))
    h.controller.destroy()
    expect(h.tray.destroyed).toBe(true)
  })
})
