import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { dialog, ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron'
import { AgentMuxDesktopFocusServer, type AgentId } from '@agentmux/core'
import type {
  AgentLaunchInput,
  AgentSessionControl,
  AppConfig,
  BrowserBounds,
  CreateWorkspacePathInput,
  CreateWorktreeForBranchInput,
  CreateWorkspaceInput,
  DesktopViewFocusRequest,
  DesktopViewFocusResult,
  DesktopViewFocusResponse,
  DesktopViewFocusTarget,
  FileDocument,
  HostConfig,
  RenameWorkspacePathInput,
  SessionControl,
  TerminalLaunchInput,
  WorkspaceRecord
} from '../shared/contracts.js'
import { BrowserViewManager } from './browser-view-manager.js'
import { ConfigStore } from './config-store.js'
import { RuntimeController } from './runtime-controller.js'
import { saveRuntimeConfig } from './runtime-config-transaction.js'
import { WorkspaceFiles } from './workspace-files.js'
import { WorktreeService } from './worktree-service.js'

function workspace(config: AppConfig, id: string): WorkspaceRecord {
  const item = config.workspaces.find((entry) => entry.id === id)
  if (!item) throw new Error(`Unknown workspace: ${id}`)
  return item
}

export async function registerIpc(args: {
  window: BrowserWindow
  configStore: ConfigStore
  runtime: RuntimeController
}): Promise<() => Promise<void>> {
  let config = await args.configStore.get()
  args.runtime.commit(await args.runtime.prepare(config))
  const files = new WorkspaceFiles((id) => args.runtime.executionHost(id))
  const worktrees = new WorktreeService((id) => args.runtime.executionHost(id), args.configStore)
  const browsers = new BrowserViewManager(args.window)
  const channels: string[] = []
  const pendingViewFocus = new Map<string, {
    resolve(value: DesktopViewFocusResult): void
    reject(error: Error): void
    timeout: NodeJS.Timeout
  }>()
  const acceptViewFocus = (event: IpcMainEvent, response: DesktopViewFocusResponse): void => {
    if (event.sender !== args.window.webContents || !response || typeof response.requestId !== 'string') return
    const pending = pendingViewFocus.get(response.requestId)
    if (!pending) return
    pendingViewFocus.delete(response.requestId)
    clearTimeout(pending.timeout)
    if (response.ok) pending.resolve(response.result)
    else {
      const error = Object.assign(new Error(response.message), { code: response.code })
      pending.reject(error)
    }
  }
  const focusView = async (target: DesktopViewFocusTarget): Promise<DesktopViewFocusResult> => (
    await new Promise((resolve, reject) => {
      if (args.window.webContents.isDestroyed()) {
        reject(Object.assign(new Error('Desktop View focus owner is unavailable.'), { code: 'VIEW_FOCUS_UNAVAILABLE' }))
        return
      }
      const request: DesktopViewFocusRequest = { requestId: randomUUID(), target }
      const timeout = setTimeout(() => {
        pendingViewFocus.delete(request.requestId)
        reject(Object.assign(new Error('Desktop View focus request timed out.'), { code: 'VIEW_FOCUS_TIMEOUT' }))
      }, 2_000)
      pendingViewFocus.set(request.requestId, { resolve, reject, timeout })
      args.window.webContents.send('agentmux:view-focus-request', request)
    })
  )
  ipcMain.on('views:focus:response', acceptViewFocus)
  const handle = <TArgs extends unknown[], TResult>(
    channel: string,
    listener: (...values: TArgs) => Promise<TResult> | TResult
  ): void => {
    channels.push(channel)
    ipcMain.handle(channel, (_event, ...values: TArgs) => listener(...values))
  }

  handle('config:get', () => config)
  handle('config:save', async (next: AppConfig) => {
    const saved = await saveRuntimeConfig({ runtime: args.runtime, configWriter: args.configStore, next })
    config = saved
    return saved
  })
  handle('hosts:check', async (input: HostConfig) => {
    try {
      return await args.runtime.checkHost(input)
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  })
  handle('workspaces:chooseLocalFolder', async () => {
    const selection = await dialog.showOpenDialog(args.window, { properties: ['openDirectory'] })
    const path = selection.filePaths[0]
    if (selection.canceled || !path) return null
    const item: WorkspaceRecord = {
      id: randomUUID(),
      name: basename(path),
      hostId: 'local',
      path,
      kind: 'folder'
    }
    config = await args.configStore.save({ ...config, workspaces: [...config.workspaces, item] })
    return item
  })
  handle('workspaces:add', async (input: CreateWorkspaceInput) => {
    args.runtime.executionHost(input.hostId)
    const item: WorkspaceRecord = {
      id: randomUUID(),
      name: input.name?.trim() || input.path.split(/[\\/]/).filter(Boolean).pop() || input.path,
      hostId: input.hostId,
      path: input.path,
      kind: 'folder'
    }
    config = await args.configStore.save({ ...config, workspaces: [...config.workspaces, item] })
    return item
  })
  handle('workspaces:listBranches', async (workspaceId: string) => await worktrees.list(workspaceId, config))
  handle('workspaces:openBranch', async (workspaceId: string, branch: string) => {
    const selection = await worktrees.openBranch(workspaceId, branch, config)
    config = selection.config
    return selection
  })
  handle('workspaces:createWorktreeForBranch', async (input: CreateWorktreeForBranchInput) => {
    const selection = await worktrees.createForBranch(input, config)
    config = selection.config
    return selection
  })
  handle('files:readDirectory', async (workspaceId: string, path: string) =>
    await files.readDirectory(workspace(config, workspaceId), path)
  )
  handle('files:read', async (workspaceId: string, path: string) => await files.read(workspace(config, workspaceId), path))
  handle('files:write', async (workspaceId: string, document: FileDocument) => {
    await files.write(workspace(config, workspaceId), document)
  })
  handle('files:create', async (workspaceId: string, input: CreateWorkspacePathInput) => {
    await files.create(workspace(config, workspaceId), input)
  })
  handle('files:rename', async (workspaceId: string, input: RenameWorkspacePathInput) => {
    await files.rename(workspace(config, workspaceId), input)
  })
  handle('files:delete', async (workspaceId: string, path: string) => {
    await files.delete(workspace(config, workspaceId), path)
  })
  handle('agents:detect', async (agentId: AgentId, hostId: string) => await args.runtime.detect(agentId, hostId, config))
  handle('views:focus', focusView)
  handle('sessions:snapshot', async () => await args.runtime.snapshot(config))
  handle('sessions:launchAgent', async (input: AgentLaunchInput) => await args.runtime.launchAgent(input, config))
  handle('sessions:launchTerminal', async (input: TerminalLaunchInput) => await args.runtime.launchTerminal(input, config))
  channels.push('sessions:attach')
  ipcMain.handle('sessions:attach', async (event, session: SessionControl, afterSequence: number = 0) => {
    const result = await args.runtime.attachSession(event.sender.id, session, afterSequence, config)
    if (!event.sender.isDestroyed()) return result
    await args.runtime.detachSession(event.sender.id, result.attachmentId)
    throw new Error('The Desktop View disappeared before its Session Attachment was delivered.')
  })
  channels.push('sessions:detach')
  ipcMain.handle('sessions:detach', async (event, attachmentId: string) => {
    await args.runtime.detachSession(event.sender.id, attachmentId)
  })
  handle('sessions:write', async (session: SessionControl, data: string) => {
    await args.runtime.write(session, data)
  })
  handle('sessions:submitPrompt', async (session: AgentSessionControl, prompt: string) => {
    await args.runtime.submitPrompt(session, prompt, config)
  })
  handle('sessions:acknowledge', async (session: SessionControl, sequence: number) => {
    await args.runtime.acknowledge(session, sequence)
  })
  handle('sessions:interrupt', async (session: SessionControl) => await args.runtime.interrupt(session))
  handle('sessions:resize', async (session: SessionControl, cols: number, rows: number) => {
    await args.runtime.resize(session, cols, rows)
  })
  handle('sessions:refresh', async (session: SessionControl) => await args.runtime.refresh(session, config))
  handle('sessions:stop', async (session: SessionControl) => await args.runtime.stopSession(session))
  handle('browser:create', async (id: string, url: string) => await browsers.create(id, url))
  handle('browser:navigate', async (id: string, url: string) => await browsers.navigate(id, url))
  handle('browser:back', async (id: string) => await browsers.back(id))
  handle('browser:forward', async (id: string) => await browsers.forward(id))
  handle('browser:reload', async (id: string) => await browsers.reload(id))
  handle('browser:setBounds', (id: string, bounds: BrowserBounds | null) => browsers.setBounds(id, bounds))
  handle('browser:close', (id: string) => browsers.close(id))
  const detach = args.runtime.attach(args.window.webContents)
  const externalFocus = new AgentMuxDesktopFocusServer({ focus: focusView })
  await externalFocus.start()
  return async () => {
    await externalFocus.stop()
    detach()
    browsers.dispose()
    ipcMain.removeListener('views:focus:response', acceptViewFocus)
    for (const pending of pendingViewFocus.values()) {
      clearTimeout(pending.timeout)
      pending.reject(Object.assign(new Error('Desktop View focus owner was disposed.'), { code: 'VIEW_FOCUS_UNAVAILABLE' }))
    }
    pendingViewFocus.clear()
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
