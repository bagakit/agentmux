import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  shell,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import {
  AgentMuxControlServer,
  type AgentExecutorId,
  type AgentMuxControlRequest,
  type AgentMuxControlResult
} from '@agentmux/core'
import type {
  AgentLaunchInput,
  AgentSessionControl,
  AppConfig,
  BrowserAnnotationMarker,
  BrowserBounds,
  BrowserPng,
  BrowserViewport,
  CreateWorkspacePathInput,
  CreateWorktreeForBranchInput,
  CreateWorkspaceInput,
  DesktopControlResponse,
  HostConfig,
  MoveWorkspacePathInput,
  SessionControl,
  TerminalLaunchInput,
  WorkspaceFileWriteInput,
  WorkspaceRecord
} from '../shared/contracts.js'
import {
  CONTROL_CANCEL_CHANNEL,
  CONTROL_REQUEST_CHANNEL,
  CONTROL_RESPONSE_CHANNEL
} from '../shared/contracts.js'
import { terminalPalette } from '../shared/terminal-palettes.js'
import { BrowserViewManager } from './browser-view-manager.js'
import { BrowserProfileManager } from './browser-profile-manager.js'
import { nativeImageFromBrowserPng } from './browser-image.js'
import { ConfigStore } from './config-store.js'
import { DesktopControlIpcBridge } from './control-ipc-bridge.js'
import { normalizeExternalUrl } from './external-url.js'
import { FileObservationRegistry } from './file-observation-registry.js'
import { runOwnerDisposals } from './owner-disposal.js'
import { RuntimeController } from './runtime-controller.js'
import { ScratchTopics } from './scratch-topics.js'
import { saveRuntimeConfig } from './runtime-config-transaction.js'
import { WorkspaceFiles } from './workspace-files.js'
import { WorktreeService } from './worktree-service.js'

function workspace(config: AppConfig, id: string): WorkspaceRecord {
  const item = config.workspaces.find((entry) => entry.id === id)
  if (!item) throw new Error(`Unknown workspace: ${id}`)
  return item
}

export async function openExternalFromRenderer(
  event: Pick<IpcMainInvokeEvent, 'sender'>,
  renderer: WebContents,
  rawUrl: string
): Promise<void> {
  if (event.sender !== renderer) throw new Error('Untrusted external URL sender')
  await shell.openExternal(normalizeExternalUrl(rawUrl))
}

export async function registerIpc(args: {
  window: BrowserWindow
  configStore: ConfigStore
  runtime: RuntimeController
  workspaceFiles?: WorkspaceFiles
  scratchTopics: ScratchTopics
}): Promise<() => Promise<void>> {
  let config = await args.configStore.get()
  const initialPalette = terminalPalette(config.appearance.terminalTheme)
  args.runtime.setTerminalViewColors({
    foreground: initialPalette.foreground,
    background: initialPalette.background
  })
  args.runtime.commit(await args.runtime.prepare(config))
  const files = args.workspaceFiles ?? new WorkspaceFiles((id) => args.runtime.executionHost(id))
  const worktrees = new WorktreeService((id) => args.runtime.executionHost(id), args.configStore)
  const browserProfiles = new BrowserProfileManager()
  await browserProfiles.initialize()
  const browsers = new BrowserViewManager(args.window, browserProfiles)
  const fileObservations = new FileObservationRegistry()
  const channels: string[] = []
  let acceptingControl = true
  const controlBridge = new DesktopControlIpcBridge({
    isAvailable: () => acceptingControl && !args.window.webContents.isDestroyed(),
    sendRequest: (request) => args.window.webContents.send(CONTROL_REQUEST_CHANNEL, request),
    sendCancellation: (cancellation) => args.window.webContents.send(CONTROL_CANCEL_CHANNEL, cancellation)
  })
  const acceptControl = (event: IpcMainEvent, response: DesktopControlResponse): void => {
    if (event.sender !== args.window.webContents || !response || typeof response.requestId !== 'string') return
    controlBridge.accept(response)
  }
  const executeControl = async (
    request: AgentMuxControlRequest
  ): Promise<AgentMuxControlResult> => await controlBridge.execute(request)
  ipcMain.on(CONTROL_RESPONSE_CHANNEL, acceptControl)
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
    const palette = terminalPalette(saved.appearance.terminalTheme)
    args.runtime.setTerminalViewColors({
      foreground: palette.foreground,
      background: palette.background
    })
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
  handle('files:write', async (workspaceId: string, input: WorkspaceFileWriteInput) =>
    await files.write(workspace(config, workspaceId), input)
  )
  handle('files:observe', async (workspaceId: string, path: string) => {
    const key = `${workspaceId}\0${path}`
    await fileObservations.observe(key, async () => (
      await files.observe(workspace(config, workspaceId), path, () => {
        if (args.window.webContents.isDestroyed()) return
        args.window.webContents.send('agentmux:workspace-file-invalidated', { workspaceId, path })
      })
    ))
  })
  handle('files:unobserve', async (workspaceId: string, path: string) => {
    const key = `${workspaceId}\0${path}`
    await fileObservations.unobserve(key)
  })
  handle('files:create', async (workspaceId: string, input: CreateWorkspacePathInput) => {
    await files.create(workspace(config, workspaceId), input)
  })
  handle('files:move', async (input: MoveWorkspacePathInput) => await files.move(
    workspace(config, input.source.workspaceId),
    workspace(config, input.destination.workspaceId),
    input
  ))
  handle('files:delete', async (workspaceId: string, path: string) => {
    await files.delete(workspace(config, workspaceId), path)
  })
  handle('files:reveal', async (workspaceId: string, path: string) => {
    shell.showItemInFolder(await files.localPathForReveal(workspace(config, workspaceId), path))
  })
  handle('scratch:readTopic', async (workspaceId: string, topicId: string) =>
    await args.scratchTopics.read(workspace(config, workspaceId), topicId)
  )
  handle('scratch:listTopics', async (workspaceId: string) =>
    await args.scratchTopics.list(workspace(config, workspaceId))
  )
  handle('scratch:ensureTopic', async (workspaceId: string, topicId: string) =>
    await args.scratchTopics.ensure(workspace(config, workspaceId), topicId)
  )
  handle('scratch:renameTitle', async (workspaceId: string, topicId: string, title: string) =>
    await args.scratchTopics.renameTitle(workspace(config, workspaceId), topicId, title)
  )
  handle('ui:readClipboardText', () => clipboard.readText())
  handle('ui:writeClipboardText', (text: string) => {
    clipboard.writeText(text)
  })
  channels.push('ui:writeClipboardImage')
  ipcMain.handle('ui:writeClipboardImage', (event, image: BrowserPng) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted clipboard image sender')
    clipboard.writeImage(nativeImageFromBrowserPng(image, (png) => nativeImage.createFromBuffer(png)))
  })
  channels.push('ui:openExternal')
  ipcMain.handle('ui:openExternal', async (event, rawUrl: string) => {
    await openExternalFromRenderer(event, args.window.webContents, rawUrl)
  })
  handle('providers:list', () => args.runtime.providerCatalog())
  handle('executors:detect', async (executorId: AgentExecutorId, hostId: string) => await args.runtime.detect(executorId, hostId, config))
  handle('sessions:snapshot', async () => await args.runtime.snapshot(config))
  channels.push('sessions:launchAgent')
  ipcMain.handle('sessions:launchAgent', async (event, input: AgentLaunchInput) => {
    const result = await args.runtime.launchAgent(input, config)
    if (!event.sender.isDestroyed()) return result
    const primary = Object.assign(
      new Error('The Desktop View disappeared before its Agent launch was delivered.'),
      { code: 'CONTROL_OWNER_LOST' }
    )
    try {
      await args.runtime.stopSession(result.session.control)
    } catch (cleanupError) {
      throw Object.assign(
        new Error(`${primary.message} Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`),
        { code: primary.code, cause: new AggregateError([primary, cleanupError]) }
      )
    }
    throw primary
  })
  handle('sessions:launchTerminal', async (input: TerminalLaunchInput) => await args.runtime.launchTerminal(input, config))
  handle('sessions:timeline', async (session: AgentSessionControl) => await args.runtime.sessionTimeline(session))
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
    await args.runtime.submitPrompt(session, prompt)
  })
  handle('sessions:resume', async (session: AgentSessionControl, prompt: string, operationId: string) => (
    await args.runtime.resumeSession(session, prompt, operationId, config)
  ))
  handle('sessions:acknowledge', async (session: SessionControl, sequence: number) => {
    await args.runtime.acknowledge(session, sequence)
  })
  handle('sessions:interrupt', async (session: SessionControl) => await args.runtime.interrupt(session))
  channels.push('sessions:resize')
  ipcMain.handle('sessions:resize', async (event, attachmentId: string, cols: number, rows: number) => {
    await args.runtime.resizeSessionAttachment(event.sender.id, attachmentId, cols, rows)
  })
  handle('sessions:refresh', async (session: SessionControl) => await args.runtime.refresh(session, config))
  handle('sessions:recover', async (session: SessionControl, workspacePath?: string) => await args.runtime.recoverSession(session, config, workspacePath))
  handle('sessions:stop', async (session: SessionControl) => await args.runtime.stopSession(session))
  handle('browser:create', async (id: string, url: string) => await browsers.create(id, url))
  handle('browser:navigate', async (id: string, url: string) => await browsers.navigate(id, url))
  handle('browser:back', async (id: string) => await browsers.back(id))
  handle('browser:forward', async (id: string) => await browsers.forward(id))
  handle('browser:reload', async (id: string) => await browsers.reload(id))
  channels.push('browser:switchProfile')
  ipcMain.handle('browser:switchProfile', async (event, id: string, profileId: string) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser Profile sender')
    return await browsers.switchProfile(id, profileId)
  })
  channels.push('browser:listProfiles')
  ipcMain.handle('browser:listProfiles', (event) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser Profile sender')
    return browserProfiles.listProfiles()
  })
  channels.push('browser:createProfile')
  ipcMain.handle('browser:createProfile', async (event, label: string) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser Profile sender')
    return await browserProfiles.createProfile(label)
  })
  channels.push('browser:deleteProfile')
  ipcMain.handle('browser:deleteProfile', async (event, profileId: string) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser Profile sender')
    if (browsers.usesProfile(profileId)) {
      throw new Error('Browser Profile is still used by an open Browser')
    }
    await browserProfiles.deleteProfile(profileId)
  })
  channels.push('browser:detectProfileImportSources')
  ipcMain.handle('browser:detectProfileImportSources', async (event) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser Profile sender')
    return await browserProfiles.detectImportSources()
  })
  channels.push('browser:importProfile')
  ipcMain.handle('browser:importProfile', async (event, sourceToken: string, label: string) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser Profile sender')
    return await browserProfiles.importProfile(sourceToken, label)
  })
  handle('browser:openDevTools', (id: string) => browsers.openDevTools(id))
  handle('browser:setViewport', (id: string, viewport: BrowserViewport) => browsers.setViewport(id, viewport))
  handle('browser:captureScreenshot', async (id: string) => await browsers.captureScreenshot(id))
  channels.push('browser:selectElement')
  ipcMain.handle('browser:selectElement', async (event, id: string) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser selection sender')
    return await browsers.selectElement(id)
  })
  channels.push('browser:cancelElementSelection')
  ipcMain.handle('browser:cancelElementSelection', async (event, id: string) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser selection sender')
    await browsers.cancelElementSelection(id)
  })
  channels.push('browser:setAnnotationMarkers')
  ipcMain.handle('browser:setAnnotationMarkers', async (
    event,
    id: string,
    navigationId: string,
    markers: BrowserAnnotationMarker[]
  ) => {
    if (event.sender !== args.window.webContents) throw new Error('Untrusted Browser annotation sender')
    await browsers.setAnnotationMarkers(id, navigationId, markers)
  })
  handle('browser:setBounds', (id: string, bounds: BrowserBounds | null) => browsers.setBounds(id, bounds))
  handle('browser:close', (id: string) => browsers.close(id))
  const detach = args.runtime.attach(args.window.webContents)
  const control = new AgentMuxControlServer({ execute: executeControl })
  await control.start()
  return async () => {
    await runOwnerDisposals([
      () => {
        acceptingControl = false
        ipcMain.removeListener(CONTROL_RESPONSE_CHANNEL, acceptControl)
        controlBridge.dispose()
      },
      async () => await control.stop(),
      () => detach(),
      () => browsers.dispose(),
      async () => await browserProfiles.dispose(),
      async () => await fileObservations.dispose(),
      async () => await files.dispose(),
      () => {
        for (const channel of channels) ipcMain.removeHandler(channel)
      }
    ], 'Failed to dispose Desktop IPC owners.')
  }
}
