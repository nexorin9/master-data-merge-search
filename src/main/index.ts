/**
 * 桌面评审台 · 主进程完整入口（Task 49 / 50 / 51 / 52 编排）。
 *
 * 启动顺序：单实例锁 → whenReady → 加载配置 → 建工作区 → 起本机 h3 服务 →
 * 注册 IPC 白名单 → 建主窗口（默认隐藏）→ 建托盘。
 *
 * 生命周期：
 *   - 第二个实例：直接 quit；first-instance 的 second-instance 事件聚焦已有窗口；
 *   - 关闭窗口只隐藏不退出（托盘常驻）；真正退出走托盘「退出评审台」；
 *   - 退出前 flush 工作区几何与状态、停本机服务、毁托盘。
 *
 * 失败兜底：配置缺失 / 服务起不来写日志；渲染层加载失败由 window.ts 显示错误页，
 * 绝不白屏，也绝不因缺凭据而以空壳继续运行。
 */
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { loadConfig, type AppConfig } from '../shared/config'
import { createMdmClient, type MergeSuggestionBody } from '../core/retrieval/mdm-client'
import { createWorkspace, defaultWorkspaceBaseDir, type Workspace } from './workspace'
import { createLocalServer, type LocalServerHandlers } from './local-server'
import { registerIpcChannels, type IpcHandlers } from './ipc-channels'
import {
  browserWindowFactory,
  createWindowManager,
  type BoundsStore,
  type WindowManager,
} from './window'
import {
  createTray,
  electronTrayDeps,
  type ReviewSnapshot,
  type TrayActions,
  type TrayController,
} from './tray'

/** 七条白名单通道的真实实现：读候选/提交建议走 MDM，其余读写本机工作区。 */
function buildHandlers(config: AppConfig, workspace: Workspace): {
  ipc: IpcHandlers
  local: LocalServerHandlers
} {
  const mdm = createMdmClient(config)

  function recordOf(payload: unknown): Record<string, unknown> {
    return typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {}
  }

  const ipc: IpcHandlers = {
    'batch:list': (payload) => {
      const p = recordOf(payload)
      return mdm.getCandidates(
        typeof p.status === 'string' ? p.status : 'pending',
        typeof p.cursor === 'string' ? p.cursor : '',
      )
    },
    'candidate:evaluate': (payload) => {
      const candidateId = String(recordOf(payload).candidate_id ?? '')
      const existing = workspace.snapshot().suggestions[candidateId]
      return { ok: true, data: existing ?? null, code: existing ? undefined : 'NOT_EVALUATED' }
    },
    'conclusion:get': (payload) => {
      const candidateId = String(recordOf(payload).candidate_id ?? '')
      const found = workspace.snapshot().suggestions[candidateId]
      return { ok: found !== undefined, data: found ?? null, code: found ? undefined : 'NOT_FOUND' }
    },
    'suggestion:submit': async (payload) => {
      const p = recordOf(payload)
      const candidateId = String(p.candidate_id ?? '')
      const body = p.body as MergeSuggestionBody | undefined
      if (!candidateId || !body) {
        return { ok: false, code: 'BAD_PAYLOAD', message: '缺少 candidate_id 或 body' }
      }
      const key = typeof p.idempotency_key === 'string' ? p.idempotency_key : undefined
      const result = await mdm.postMergeSuggestion(candidateId, body, key)
      if (result.receipt) {
        const state = workspace.snapshot()
        state.receipts[candidateId] = result.receipt
        state.updated_at = new Date().toISOString()
        workspace.write(state)
      }
      return { ok: result.ok, data: result.data, code: result.code, message: result.error }
    },
    'followup:ask': (payload) => {
      const p = recordOf(payload)
      const candidateId = String(p.candidate_id ?? '')
      const state = workspace.snapshot()
      const session = state.followups[candidateId]
      return { ok: true, data: session ?? null, code: session ? undefined : 'NO_SESSION' }
    },
    'suggestion:export': () => {
      const state = workspace.snapshot()
      return {
        ok: true,
        data: {
          suggestions: state.suggestions,
          receipts: state.receipts,
          exported_at: state.updated_at,
        },
      }
    },
    'tray:check-new': () => mdm.getCandidates('pending', ''),
  }

  // 本机服务与 IPC 共用同一份处理函数，杜绝两处各写一套业务口径。
  const local: LocalServerHandlers = { ...ipc }
  return { ipc, local }
}

/** 应用级共享状态，避免闭包顺序问题（second-instance 可能早于 bootstrap 完成）。 */
interface DesktopState {
  windowManager: WindowManager
  trayController: TrayController | null
  shutdown(): Promise<void>
}

let desktop: DesktopState | null = null

/** 创建窗口管理器；store / preload 由入口注入，electron 能力经 browserWindowFactory 适配。 */
function makeWindowManager(store: BoundsStore, preloadPath: string): WindowManager {
  return createWindowManager({
    createWindow: browserWindowFactory(BrowserWindow),
    store,
    preloadPath,
    load: async (window) => {
      const devServerUrl = process.env.ELECTRON_RENDERER_URL
      if (devServerUrl) await window.loadURL(devServerUrl)
      else await window.loadFile(join(__dirname, '../renderer/index.html'))
    },
  })
}

async function bootstrap(): Promise<DesktopState | null> {
  let config: AppConfig
  try {
    config = loadConfig()
  } catch (error) {
    console.error(`[main] 配置加载失败，桌面外壳终止：${error instanceof Error ? error.message : String(error)}`)
    return null
  }

  const workspace = createWorkspace(defaultWorkspaceBaseDir())
  // 跨天恢复工作区：诊断非法状态，autoHeal 修复后落盘，不静默吞。
  const check = workspace.check()
  if (check.status === 'invalid' || check.status === 'read-error') {
    console.error(`[main] 工作区诊断 ${check.status}：${check.error ?? '未知'}（已 autoHeal）`)
    workspace.write(check.state)
  }

  const { ipc: ipcHandlers, local: localHandlers } = buildHandlers(config, workspace)
  registerIpcChannels(ipcHandlers, {
    handle: (channel, listener) =>
      ipcMain.handle(channel, (_event: IpcMainInvokeEvent, payload: unknown) =>
        listener(_event, payload),
      ),
  })

  const localServer = createLocalServer(localHandlers)
  let localUrl = ''
  try {
    localUrl = (await localServer.start()).url
  } catch (error) {
    console.error(`[main] 本机服务启动失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const preloadPath = join(__dirname, '../preload/index.js')
  const windowManager = makeWindowManager(workspace, preloadPath)
  // 创建窗口实例并加载渲染层，但默认隐藏（开机不抢屏），由托盘菜单 / activate 打开。
  windowManager.ensure()

  let trayController: TrayController | null = null
  // 新批次标志：轮询发现后置位，供托盘菜单提示；与角标计数分开，不混为一份状态。
  let newBatchFound = false

  const getSnapshot = (): ReviewSnapshot => {
    const state = workspace.read()
    return {
      suggestions: state.suggestions as ReviewSnapshot['suggestions'],
      followups: state.followups as ReviewSnapshot['followups'],
    }
  }

  const trayActions: TrayActions = {
    openReviewDesk: () => windowManager.open(),
    focusPending: () => {
      windowManager.open()
      trayController?.refresh()
    },
    checkNewBatch: () =>
      Promise.resolve(ipcHandlers['tray:check-new']?.({})).then((result) => {
        const data = (result as { data?: { candidates?: unknown[] } })?.data
        const found = Array.isArray(data?.candidates) ? data!.candidates!.length : 0
        if (found > 0) {
          newBatchFound = true
          // 只提示、不自动弹窗；菜单下次打开即显示「有新批次」。
          trayController?.refresh()
        }
        return found
      }),
    quit: () => app.quit(),
  }

  try {
    trayController = createTray({
      ...electronTrayDeps({ Tray, Menu, nativeImage }),
      actions: trayActions,
      getSnapshot,
      hasNewBatch: () => newBatchFound,
    })
  } catch (error) {
    console.error(`[main] 托盘创建失败：${error instanceof Error ? error.message : String(error)}`)
  }

  console.log(`[main] 桌面外壳就绪${localUrl ? `，本机服务 ${localUrl}` : '（本机服务不可用）'}`)

  return {
    windowManager,
    trayController,
    async shutdown() {
      try {
        windowManager.flush()
        windowManager.destroy()
        trayController?.destroy()
      } finally {
        await localServer.stop()
        // 退出前最后 flush 一次工作区，保证几何与状态落盘。
        workspace.write(workspace.snapshot())
      }
    },
  }
}

const lockAcquired = app.requestSingleInstanceLock()
if (!lockAcquired) {
  // 单实例锁未拿到：第二个实例直接退出，由 first-instance 聚焦已有窗口。
  app.quit()
} else {
  app.on('second-instance', () => {
    desktop?.windowManager.showAndFocus()
  })

  app.whenReady().then(async () => {
    desktop = await bootstrap()
    if (!desktop) {
      app.quit()
      return
    }
  })

  // 关闭所有窗口不退出（托盘常驻）；真正退出只走托盘「退出评审台」。
  app.on('window-all-closed', () => {
    // 刻意不调用 app.quit()。
  })

  app.on('activate', () => {
    // macOS 点击 Dock 图标：无窗口时 showAndFocus 会按需创建并打开。
    desktop?.windowManager.showAndFocus()
  })

  app.on('before-quit', () => {
    void desktop?.shutdown()
  })
}
