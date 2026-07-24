import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { dialog, ipcMain, type BrowserWindow } from 'electron'
import type { AgentId } from '@agentmux/core'
import type {
  AgentLaunchInput,
  AppConfig,
  BrowserBounds,
  CreateWorkspacePathInput,
  CreateWorktreeForBranchInput,
  CreateWorkspaceInput,
  FileDocument,
  HostConfig,
  RenameWorkspacePathInput,
  TerminalLaunchInput,
  WorkspaceRecord
} from '../shared/contracts.js'
import { BrowserViewManager } from './browser-view-manager.js'
import { ConfigStore } from './config-store.js'
import { createExecutionHost } from './host-factory.js'
import { RuntimeController } from './runtime-controller.js'
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
}): Promise<() => void> {
  let config = await args.configStore.get()
  await args.runtime.configure(config)
  const files = new WorkspaceFiles((id) => args.runtime.value.hosts.get(id))
  const worktrees = new WorktreeService((id) => args.runtime.value.hosts.get(id), args.configStore)
  const browsers = new BrowserViewManager(args.window)
  const channels: string[] = []
  const handle = <TArgs extends unknown[], TResult>(
    channel: string,
    listener: (...values: TArgs) => Promise<TResult> | TResult
  ): void => {
    channels.push(channel)
    ipcMain.handle(channel, (_event, ...values: TArgs) => listener(...values))
  }

  handle('config:get', () => config)
  handle('config:save', async (next: AppConfig) => {
    args.runtime.assertConfigurable(next)
    const saved = await args.configStore.save(next)
    await args.runtime.configure(saved)
    config = saved
    return saved
  })
  handle('hosts:check', async (input: HostConfig) => {
    const host = createExecutionHost(input)
    try {
      const result = await host.run('tmux', ['-V'], { timeoutMs: 10_000 })
      return {
        ok: result.exitCode === 0,
        detail: result.exitCode === 0 ? result.stdout.trim() : result.stderr.trim() || 'Connection failed'
      }
    } finally {
      await host.dispose()
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
    args.runtime.value.hosts.get(input.hostId)
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
  handle('sessions:snapshot', () => args.runtime.value.snapshot())
  handle('sessions:launchAgent', async (input: AgentLaunchInput) => await args.runtime.launchAgent(input, config))
  handle('sessions:launchTerminal', async (input: TerminalLaunchInput) => await args.runtime.launchTerminal(input))
  handle('sessions:send', async (sessionId: string, text: string, submit?: boolean) => {
    await args.runtime.value.send(sessionId, text, submit ?? true)
  })
  handle('sessions:interrupt', async (sessionId: string) => await args.runtime.value.interrupt(sessionId))
  handle('sessions:resize', async (sessionId: string, cols: number, rows: number) => {
    await args.runtime.value.resize(sessionId, cols, rows)
  })
  handle('sessions:refresh', async (sessionId: string) => await args.runtime.value.refresh(sessionId))
  handle('sessions:stop', async (sessionId: string) => await args.runtime.value.stopSession(sessionId))
  handle('browser:create', async (id: string, url: string) => await browsers.create(id, url))
  handle('browser:navigate', async (id: string, url: string) => await browsers.navigate(id, url))
  handle('browser:back', async (id: string) => await browsers.back(id))
  handle('browser:forward', async (id: string) => await browsers.forward(id))
  handle('browser:reload', async (id: string) => await browsers.reload(id))
  handle('browser:setBounds', (id: string, bounds: BrowserBounds | null) => browsers.setBounds(id, bounds))
  handle('browser:close', (id: string) => browsers.close(id))
  const detach = args.runtime.attach(args.window.webContents)
  return () => {
    detach()
    browsers.dispose()
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
