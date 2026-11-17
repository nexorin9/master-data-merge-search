/**
 * 主窗口生命周期单测（Task 49）。
 *
 * 不真起 Electron GUI：全部经依赖注入 fake BrowserWindowLike + fake BoundsStore，
 * 断言构造参数、单实例锁语义、关闭只隐藏不重复创建、退出前 flush 几何、
 * 尺寸位置记忆、加载失败兜底错误页（纯函数 + 状态逻辑）。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildErrorPage,
  clampBounds,
  createWindowManager,
  decideWindowAction,
  DEFAULT_BOUNDS,
  errorPageUrl,
  MIN_BOUNDS,
  persistBounds,
  readBounds,
  WINDOW_BOUNDS_KEY,
  type BrowserWindowLike,
  type BoundsStore,
  type WindowFactory,
  type WindowOptions,
} from '../../src/main/window'
import { emptyWorkspace } from '../../src/main/workspace'

/** 内存版 BoundsStore（WorkspaceState 形状），带写入计数便于断言 flush。 */
function makeStore(initialBounds?: Partial<typeof DEFAULT_BOUNDS>): BoundsStore & {
  writes: number
  state: ReturnType<typeof emptyWorkspace>
} {
  const state = emptyWorkspace()
  if (initialBounds) state.batches[WINDOW_BOUNDS_KEY] = initialBounds
  const store = {
    state,
    writes: 0,
    read: () => state,
    snapshot: () => structuredClone(state),
    write: (next: ReturnType<typeof emptyWorkspace>) => {
      store.writes += 1
      Object.assign(state, next)
      state.batches = next.batches
    },
  }
  return store
}

/** fake BrowserWindow：记录显隐/焦点/几何/加载调用与生命周期监听器。 */
function makeWindowFactory(onCreate?: (options: WindowOptions) => void): {
  factory: WindowFactory
  windows: FakeWindow[]
} {
  const windows: FakeWindow[] = []
  const factory: WindowFactory = (options) => {
    onCreate?.(options)
    const win = new FakeWindow(options)
    windows.push(win)
    return win
  }
  return { factory, windows }
}

class FakeWindow implements BrowserWindowLike {
  shown = 0
  hidden = 0
  focused = 0
  destroyed = false
  loadedUrls: string[] = []
  loadedFiles: string[] = []
  closeHandlers: Array<(e: { preventDefault(): void }) => void> = []
  closedHandlers: Array<() => void> = []
  bounds: { x: number; y: number; width: number; height: number }

  constructor(readonly options: WindowOptions) {
    this.bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width,
      height: options.height,
    }
  }
  async loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url)
  }
  async loadFile(file: string): Promise<void> {
    this.loadedFiles.push(file)
  }
  show(): void {
    this.shown += 1
  }
  hide(): void {
    this.hidden += 1
  }
  focus(): void {
    this.focused += 1
  }
  isVisible(): boolean {
    return this.shown > this.hidden
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  getBounds() {
    return { ...this.bounds }
  }
  setBounds(b: Partial<typeof this.bounds>): void {
    this.bounds = { ...this.bounds, ...b }
  }
  on(event: 'close', listener: (e: { preventDefault(): void }) => void): void {
    if (event === 'close') this.closeHandlers.push(listener)
  }
  once(event: 'closed', listener: () => void): void {
    if (event === 'closed') this.closedHandlers.push(listener)
  }
  /** 模拟窗口关闭按钮：返回是否调用了 preventDefault。 */
  fireClose(): boolean {
    let prevented = false
    const event = { preventDefault: () => (prevented = true) }
    for (const handler of this.closeHandlers) handler(event)
    return prevented
  }
}

function newManager(
  factory: WindowFactory,
  store: BoundsStore,
  load: (w: BrowserWindowLike) => Promise<void> = async () => {},
) {
  return createWindowManager({
    createWindow: factory,
    store,
    preloadPath: '/app/preload/index.js',
    load,
  })
}

describe('窗口生命周期', () => {
  it('单实例锁语义：未拿到锁退出；拿到锁有窗口则聚焦；无窗口则创建', () => {
    expect(decideWindowAction({ lockAcquired: false, hasUsableWindow: false })).toBe('quit')
    expect(decideWindowAction({ lockAcquired: false, hasUsableWindow: true })).toBe('quit')
    expect(decideWindowAction({ lockAcquired: true, hasUsableWindow: true })).toBe('focus-existing')
    expect(decideWindowAction({ lockAcquired: true, hasUsableWindow: false })).toBe('create')
  })

  it('关闭只隐藏不销毁；关闭再开不重复创建窗口（复用并聚焦）', () => {
    const { factory, windows } = makeWindowFactory()
    const manager = newManager(factory, makeStore())
    const first = manager.open() as FakeWindow
    let prevented = first.fireClose()
    expect(prevented).toBe(true) // 阻止默认关闭 → 不退出
    expect(first.hidden).toBe(1)
    expect(first.destroyed).toBe(false)
    manager.open() // 再开
    expect(windows).toHaveLength(1) // 未重复创建
    expect(manager.isUsable()).toBe(true)
  })

  it('退出前 flush：close / flush 把当前几何写入工作区', () => {
    const store = makeStore()
    const { factory, windows } = makeWindowFactory()
    const manager = newManager(factory, store)
    const win = manager.open() as FakeWindow
    win.setBounds({ x: 111, y: 222, width: 1440, height: 900 })
    manager.flush()
    const saved = (store.read().batches[WINDOW_BOUNDS_KEY] as typeof DEFAULT_BOUNDS) ?? {}
    expect(saved).toMatchObject({ x: 111, y: 222, width: 1440, height: 900 })
    // 关闭也触发 flush
    win.setBounds({ x: 5, y: 6 })
    win.fireClose()
    expect((store.read().batches[WINDOW_BOUNDS_KEY] as typeof DEFAULT_BOUNDS).x).toBe(5)
    expect(windows).toHaveLength(1)
  })

  it('尺寸位置记忆：创建时读取工作区几何，缺省回落默认，过小平铺到最小值', () => {
    let captured: WindowOptions | null = null
    const store = makeStore({ x: 50, y: 70, width: 1600, height: 1000 })
    const { factory } = makeWindowFactory((o) => (captured = o))
    newManager(factory, store).open()
    expect(captured).toMatchObject({ x: 50, y: 70, width: 1600, height: 1000, show: false })
    expect((captured as unknown as WindowOptions).webPreferences.contextIsolation).toBe(true)

    const small = clampBounds({ width: 10, height: 10 })
    expect(small.width).toBe(MIN_BOUNDS.width)
    expect(small.height).toBe(MIN_BOUNDS.height)
    expect(clampBounds(null)).toEqual(DEFAULT_BOUNDS)
  })

  it('readBounds / persistBounds 往返：读回写入的几何', () => {
    const store = makeStore()
    persistBounds(store, { x: 12, y: 34, width: 1280, height: 860 })
    expect(readBounds(store)).toEqual({ x: 12, y: 34, width: 1280, height: 860 })
    // 非法形状回落默认而不抛错
    store.state.batches[WINDOW_BOUNDS_KEY] = { width: 'oops' }
    expect(readBounds(store)).toEqual(DEFAULT_BOUNDS)
  })

  it('加载失败兜底错误页：不白屏，转义尖括号，走 loadURL(data:)', async () => {
    const load = vi.fn(async () => {
      throw new Error('加载 <script>alert(1)</script> 失败')
    })
    const { factory, windows } = makeWindowFactory()
    const logger = vi.fn()
    const manager = createWindowManager({
      createWindow: factory,
      store: makeStore(),
      preloadPath: '/app/preload/index.js',
      load,
      logger,
    })
    manager.ensure()
    // 等待 load 的 catch 链跑完
    await vi.waitFor(() => expect(logger).toHaveBeenCalled())
    const win = windows[0]
    expect(win.loadedUrls).toHaveLength(1)
    expect(win.loadedUrls[0]).toContain('data:text/html')
    expect(logger.mock.calls[0][0]).toContain('渲染层加载失败')
  })

  it('buildErrorPage 转义 HTML，避免注入；errorPageUrl 可被 loadURL 直接加载', () => {
    const html = buildErrorPage('<img src=x onerror=1> & "quoted"')
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&amp;')
    expect(errorPageUrl('boom')).toMatch(/^data:text\/html;charset=utf-8,/)
  })

  it('destroy：退出流程标记退出意图并 flush，之后 isUsable 为 false', () => {
    const store = makeStore()
    const { factory, windows } = makeWindowFactory()
    const manager = newManager(factory, store)
    const win = manager.open() as FakeWindow
    win.setBounds({ width: 1500, height: 950 })
    manager.destroy()
    expect((store.read().batches[WINDOW_BOUNDS_KEY] as typeof DEFAULT_BOUNDS).width).toBe(1500)
    // destroy 只是隐藏 + 标记，不主动 quit（退出由 app.quit 触发）
    expect(win.hidden).toBeGreaterThan(0)
    win.destroyed = true
    expect(manager.isUsable()).toBe(false)
  })
})
