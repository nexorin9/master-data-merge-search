/**
 * 主窗口创建与生命周期（Task 49）。
 *
 * 语义：
 *   - 默认隐藏（开机不抢屏），由托盘菜单「打开评审台」显式打开；
 *   - 关闭窗口只隐藏不退出（托盘常驻），真正退出走托盘「退出评审台」；
 *   - 尺寸与位置记忆到本机工作区（WorkspaceState.batches 下的保留键，不改 schema）；
 *   - 单实例锁：second-instance 时聚焦已有窗口，不新建窗口；
 *   - 渲染层加载失败显示可读错误页（data: HTML），不白屏，错误写日志。
 *
 * 可测性：electron 通过依赖注入（BrowserWindowLike 工厂 + 日志），node 测试不真起 GUI。
 * 纯逻辑函数（decideWindowAction / clampBounds / buildErrorPage）可直接单测。
 */
import type { BrowserWindow, Rectangle } from 'electron'
import type { WorkspaceState } from '../core/types'

/** 窗口需要的 BrowserWindow 最小能力，便于测试注入桩。 */
export interface BrowserWindowLike {
  loadURL(url: string): Promise<void>
  loadFile(filePath: string): Promise<void>
  show(): void
  hide(): void
  focus(): void
  isVisible(): boolean
  isDestroyed(): boolean
  getBounds(): Rectangle
  setBounds(bounds: Partial<Rectangle>): void
  on(event: 'close', listener: (event: { preventDefault(): void }) => void): void
  once(event: 'closed', listener: () => void): void
}

export type WindowFactory = (options: WindowOptions) => BrowserWindowLike

export interface WindowOptions {
  width: number
  height: number
  minWidth: number
  minHeight: number
  x?: number
  y?: number
  show: boolean
  title: string
  webPreferences: {
    preload: string
    sandbox: boolean
    contextIsolation: boolean
  }
}

/** 工作区读写入口（与 workspace.ts 的 Workspace 同形，取最小子集以便注入）。 */
export interface BoundsStore {
  read(): WorkspaceState
  write(state: WorkspaceState): void
  snapshot(): WorkspaceState
}

/** 窗口几何记忆在工作区里的保留键（放在 batches 下，不触碰 core/schema）。 */
export const WINDOW_BOUNDS_KEY = '__window_bounds__'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export const DEFAULT_BOUNDS: WindowBounds = {
  x: 80,
  y: 60,
  width: 1280,
  height: 860,
}
export const MIN_BOUNDS = { width: 1024, height: 700 }

/** 窗口动作：由「是否锁持有 / 是否已有窗口 / 是否正在退出」纯逻辑决定。 */
export type WindowAction = 'create' | 'focus-existing' | 'quit'

/**
 * 单实例与窗口动作纯逻辑：
 *   - 未拿到单实例锁 → quit（第二个实例直接退出，由 first-instance 聚焦）；
 *   - 拿到锁且已有可用窗口 → focus-existing（关闭再开、activate、second-instance 复用）；
 *   - 拿到锁无窗口 → create。
 */
export function decideWindowAction(opts: {
  lockAcquired: boolean
  hasUsableWindow: boolean
}): WindowAction {
  if (!opts.lockAcquired) return 'quit'
  return opts.hasUsableWindow ? 'focus-existing' : 'create'
}

/** 尺寸下限钳制：小于最小尺寸回落到最小值，非法值回落到默认。 */
export function clampBounds(raw: Partial<WindowBounds> | null | undefined): WindowBounds {
  if (!raw) return { ...DEFAULT_BOUNDS }
  const num = (value: unknown, fallback: number, min?: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
    return min !== undefined ? Math.max(min, Math.round(n)) : Math.round(n)
  }
  return {
    x: num(raw.x, DEFAULT_BOUNDS.x),
    y: num(raw.y, DEFAULT_BOUNDS.y),
    width: num(raw.width, DEFAULT_BOUNDS.width, MIN_BOUNDS.width),
    height: num(raw.height, DEFAULT_BOUNDS.height, MIN_BOUNDS.height),
  }
}

/** 从工作区读回窗口几何（缺失 / 形状非法时回落默认，不抛错）。 */
export function readBounds(store: BoundsStore): WindowBounds {
  const raw = store.read().batches[WINDOW_BOUNDS_KEY] as Partial<WindowBounds> | undefined
  return clampBounds(raw)
}

/** 把当前窗口几何写回工作区（原子写交给 workspace.write 自身保证）。 */
export function persistBounds(store: BoundsStore, bounds: WindowBounds): void {
  const snapshot = store.snapshot()
  store.write({
    ...snapshot,
    batches: { ...snapshot.batches, [WINDOW_BOUNDS_KEY]: clampBounds(bounds) },
  })
}

/** 加载失败兜底错误页：HTML 转义，避免凭据 / 路径里的尖括号注入。 */
export function buildErrorPage(message: string): string {
  const safe = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .slice(0, 800)
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>加载失败</title><style>body{font-family:system-ui,sans-serif;background:#1b1b1f;color:#e8e8ea;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}main{max-width:640px;padding:32px;border:1px solid #444;border-radius:12px}h1{font-size:20px;margin:0 0 12px}pre{white-space:pre-wrap;word-break:break-word;color:#ffb4a8;font-size:14px}p{color:#9a9aa2;font-size:13px}</style></head><body><main><h1>评审台加载失败</h1><pre>${safe}</pre><p>请从托盘菜单重试「打开评审台」，或查看主进程日志排查。</p></main></body></html>`
}

/** 把错误页编码成 data: URL，loadURL 即可显示，绝不白屏。 */
export function errorPageUrl(message: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildErrorPage(message))}`
}

export interface WindowManagerDeps {
  createWindow: WindowFactory
  store: BoundsStore
  /** 渲染层入口：dev 用 URL，生产用本地文件路径；二选一由主进程决定。 */
  load: (window: BrowserWindowLike) => Promise<void>
  /** 渲染层加载失败时的兜底页加载函数，默认 loadURL(errorPageUrl)。 */
  loadError?: (window: BrowserWindowLike, message: string) => Promise<void>
  logger?: (line: string) => void
  preloadPath: string
}

export interface WindowManager {
  /** 确保窗口实例存在并加载（不显示），用于开机建窗但不抢屏；重复调用不重复创建。 */
  ensure(): BrowserWindowLike
  /** 打开（已存在则显示并聚焦，不重复创建）。 */
  open(): BrowserWindowLike
  /** 显示并聚焦现有窗口；无窗口时按 open 处理。 */
  showAndFocus(): BrowserWindowLike
  /** 当前窗口（可能已销毁，需配合 isUsable）。 */
  current(): BrowserWindowLike | null
  /** 是否有可复用的存活窗口。 */
  isUsable(): boolean
  /** 关闭窗口（只隐藏，不退出），同时落盘几何。 */
  close(): void
  /** 真正销毁窗口（退出流程调用），同时落盘几何。 */
  destroy(): void
  /** 退出前 flush：把几何写回工作区。 */
  flush(): void
}

/**
 * 创建窗口管理器。所有 electron 能力经 deps 注入；单实例 / 关闭语义在纯逻辑里决定，
 * 这里只编排。加载失败时展示错误页并记录日志，不白屏。
 */
export function createWindowManager(deps: WindowManagerDeps): WindowManager {
  const logger = deps.logger ?? ((line: string) => console.error(line))
  let window: BrowserWindowLike | null = null
  let quitting = false

  function attach(windowToAttach: BrowserWindowLike): void {
    windowToAttach.on('close', (event) => {
      event.preventDefault()
      if (quitting) {
        flushBounds(windowToAttach)
        windowToAttach.hide()
        return
      }
      // 关闭只隐藏不退出：托盘常驻。
      flushBounds(windowToAttach)
      windowToAttach.hide()
    })
    windowToAttach.once('closed', () => {
      if (window === windowToAttach) window = null
    })
  }

  function flushBounds(target: BrowserWindowLike): void {
    try {
      const b = target.getBounds()
      persistBounds(deps.store, { x: b.x, y: b.y, width: b.width, height: b.height })
    } catch (error) {
      logger(`[window] 几何落盘失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function create(): BrowserWindowLike {
    const bounds = readBounds(deps.store)
    const instance = deps.createWindow({
      ...bounds,
      minWidth: MIN_BOUNDS.width,
      minHeight: MIN_BOUNDS.height,
      show: false,
      title: '主数据归并检索系统 · 评审台',
      webPreferences: {
        preload: deps.preloadPath,
        sandbox: false,
        contextIsolation: true,
      },
    })
    window = instance
    attach(instance)
    void deps.load(instance).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      logger(`[window] 渲染层加载失败：${message}`)
      const fallback = deps.loadError
        ? deps.loadError(instance, message)
        : instance.loadURL(errorPageUrl(message))
      void fallback.catch((secondary: unknown) => {
        logger(`[window] 错误页加载失败：${secondary instanceof Error ? secondary.message : String(secondary)}`)
      })
    })
    return instance
  }

  return {
    ensure() {
      if (window && !window.isDestroyed()) return window
      return create()
    },
    open() {
      const instance = this.ensure()
      instance.show()
      instance.focus()
      return instance
    },
    showAndFocus() {
      return this.open()
    },
    current() {
      return window
    },
    isUsable() {
      return !!window && !window.isDestroyed()
    },
    close() {
      if (window && !window.isDestroyed()) {
        flushBounds(window)
        window.hide()
      }
    },
    destroy() {
      quitting = true
      if (window) {
        flushBounds(window)
        window.hide()
      }
    },
    flush() {
      if (window && !window.isDestroyed()) flushBounds(window)
    },
  }
}

/** 供入口使用：把 BrowserWindow 构造器包装为 WindowFactory（类型适配）。 */
export function browserWindowFactory(ctor: typeof BrowserWindow): WindowFactory {
  return (options) => new ctor(options as ConstructorParameters<typeof BrowserWindow>[0]) as unknown as BrowserWindowLike
}
