import { contextBridge, ipcRenderer } from 'electron'
import type { AgentId } from '@agentmux/core'
import type {
  AgentLaunchInput,
  AgentMuxDesktopApi,
  AgentSessionControl,
  AppConfig,
  BrowserBounds,
  BrowserEvent,
  CreateWorkspacePathInput,
  CreateWorktreeForBranchInput,
  CreateWorkspaceInput,
  FileDocument,
  HostConfig,
  RenameWorkspacePathInput,
  RuntimeEvent,
  SessionControl,
  TerminalLaunchInput
} from '../shared/contracts.js'

const api: AgentMuxDesktopApi = {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (config: AppConfig) => ipcRenderer.invoke('config:save', config)
  },
  hosts: {
    check: (host: HostConfig) => ipcRenderer.invoke('hosts:check', host)
  },
  workspaces: {
    chooseLocalFolder: () => ipcRenderer.invoke('workspaces:chooseLocalFolder'),
    add: (input: CreateWorkspaceInput) => ipcRenderer.invoke('workspaces:add', input),
    listBranches: (workspaceId: string) => ipcRenderer.invoke('workspaces:listBranches', workspaceId),
    openBranch: (workspaceId: string, branch: string) =>
      ipcRenderer.invoke('workspaces:openBranch', workspaceId, branch),
    createWorktreeForBranch: (input: CreateWorktreeForBranchInput) =>
      ipcRenderer.invoke('workspaces:createWorktreeForBranch', input)
  },
  files: {
    readDirectory: (workspaceId: string, path: string) =>
      ipcRenderer.invoke('files:readDirectory', workspaceId, path),
    read: (workspaceId: string, path: string) => ipcRenderer.invoke('files:read', workspaceId, path),
    write: (workspaceId: string, document: FileDocument) => ipcRenderer.invoke('files:write', workspaceId, document),
    create: (workspaceId: string, input: CreateWorkspacePathInput) =>
      ipcRenderer.invoke('files:create', workspaceId, input),
    rename: (workspaceId: string, input: RenameWorkspacePathInput) =>
      ipcRenderer.invoke('files:rename', workspaceId, input),
    delete: (workspaceId: string, path: string) => ipcRenderer.invoke('files:delete', workspaceId, path)
  },
  agents: {
    detect: (agentId: AgentId, hostId: string) => ipcRenderer.invoke('agents:detect', agentId, hostId)
  },
  sessions: {
    snapshot: () => ipcRenderer.invoke('sessions:snapshot'),
    launchAgent: (input: AgentLaunchInput) => ipcRenderer.invoke('sessions:launchAgent', input),
    launchTerminal: (input: TerminalLaunchInput) => ipcRenderer.invoke('sessions:launchTerminal', input),
    attach: (session: SessionControl, afterSequence = 0) =>
      ipcRenderer.invoke('sessions:attach', session, afterSequence),
    detach: (session: SessionControl) => ipcRenderer.invoke('sessions:detach', session),
    write: (session: SessionControl, data: string) => ipcRenderer.invoke('sessions:write', session, data),
    submitPrompt: (session: AgentSessionControl, prompt: string) =>
      ipcRenderer.invoke('sessions:submitPrompt', session, prompt),
    acknowledge: (session: SessionControl, sequence: number) =>
      ipcRenderer.invoke('sessions:acknowledge', session, sequence),
    interrupt: (session: SessionControl) => ipcRenderer.invoke('sessions:interrupt', session),
    resize: (session: SessionControl, cols: number, rows: number) =>
      ipcRenderer.invoke('sessions:resize', session, cols, rows),
    refresh: (session: SessionControl) => ipcRenderer.invoke('sessions:refresh', session),
    stop: (session: SessionControl) => ipcRenderer.invoke('sessions:stop', session),
    onEvent(listener: (event: RuntimeEvent) => void) {
      const wrapped = (_event: Electron.IpcRendererEvent, value: RuntimeEvent): void => listener(value)
      ipcRenderer.on('agentmux:session-event', wrapped)
      return () => ipcRenderer.off('agentmux:session-event', wrapped)
    }
  },
  browser: {
    create: (id: string, url: string) => ipcRenderer.invoke('browser:create', id, url),
    navigate: (id: string, url: string) => ipcRenderer.invoke('browser:navigate', id, url),
    back: (id: string) => ipcRenderer.invoke('browser:back', id),
    forward: (id: string) => ipcRenderer.invoke('browser:forward', id),
    reload: (id: string) => ipcRenderer.invoke('browser:reload', id),
    setBounds: (id: string, bounds: BrowserBounds | null) => ipcRenderer.invoke('browser:setBounds', id, bounds),
    close: (id: string) => ipcRenderer.invoke('browser:close', id),
    onEvent(listener: (event: BrowserEvent) => void) {
      const wrapped = (_event: Electron.IpcRendererEvent, value: BrowserEvent): void => listener(value)
      ipcRenderer.on('agentmux:browser-event', wrapped)
      return () => ipcRenderer.off('agentmux:browser-event', wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('agentmux', api)
