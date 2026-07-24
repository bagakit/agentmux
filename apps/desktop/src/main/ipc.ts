import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { dialog, ipcMain, type BrowserWindow } from 'electron'
import type { AgentId } from '@agentmux/core'
import type {
  AgentLaunchInput,
  AppConfig,
  CreateWorktreeInput,
  CreateWorkspaceInput,
  FileDocument,
  WorkspaceRecord
} from '../shared/contracts.js'
import { ConfigStore } from './config-store.js'
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
    config = await args.configStore.save(next)
    await args.runtime.configure(config)
    return config
  })
  handle('hosts:check', async (hostId: string) => {
    const host = args.runtime.value.hosts.get(hostId)
    const result = await host.run('tmux', ['-V'], { timeoutMs: 10_000 })
    return {
      ok: result.exitCode === 0,
      detail: result.exitCode === 0 ? result.stdout.trim() : result.stderr.trim() || 'Connection failed'
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
  handle('workspaces:createWorktree', async (input: CreateWorktreeInput) => {
    const creation = await worktrees.create(input, config)
    config = creation.config
    return creation.workspace
  })
  handle('files:list', async (workspaceId: string) => await files.list(workspace(config, workspaceId)))
  handle('files:read', async (workspaceId: string, path: string) => await files.read(workspace(config, workspaceId), path))
  handle('files:write', async (workspaceId: string, document: FileDocument) => {
    await files.write(workspace(config, workspaceId), document)
  })
  handle('agents:snapshot', () => args.runtime.value.snapshot())
  handle('agents:detect', async (agentId: AgentId, hostId: string) => await args.runtime.detect(agentId, hostId, config))
  handle('agents:launch', async (input: AgentLaunchInput) => await args.runtime.launch(input, config))
  handle('agents:send', async (sessionId: string, text: string, submit?: boolean) => {
    await args.runtime.value.send(sessionId, text, submit ?? true)
  })
  handle('agents:interrupt', async (sessionId: string) => await args.runtime.value.interrupt(sessionId))
  handle('agents:resize', async (sessionId: string, cols: number, rows: number) => {
    await args.runtime.value.resize(sessionId, cols, rows)
  })
  handle('agents:stop', async (sessionId: string) => await args.runtime.value.stopSession(sessionId))
  const detach = args.runtime.attach(args.window.webContents)
  return () => {
    detach()
    for (const channel of channels) ipcMain.removeHandler(channel)
  }
}
