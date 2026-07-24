import { contextBridge, ipcRenderer } from 'electron'
import type { AgentId, AgentRuntimeEvent } from '@agentmux/core'
import type {
  AgentLaunchInput,
  AgentMuxDesktopApi,
  AppConfig,
  CreateWorktreeInput,
  CreateWorkspaceInput,
  FileDocument
} from '../shared/contracts.js'

const api: AgentMuxDesktopApi = {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (config: AppConfig) => ipcRenderer.invoke('config:save', config)
  },
  hosts: {
    check: (hostId: string) => ipcRenderer.invoke('hosts:check', hostId)
  },
  workspaces: {
    chooseLocalFolder: () => ipcRenderer.invoke('workspaces:chooseLocalFolder'),
    add: (input: CreateWorkspaceInput) => ipcRenderer.invoke('workspaces:add', input),
    createWorktree: (input: CreateWorktreeInput) => ipcRenderer.invoke('workspaces:createWorktree', input)
  },
  files: {
    list: (workspaceId: string) => ipcRenderer.invoke('files:list', workspaceId),
    read: (workspaceId: string, path: string) => ipcRenderer.invoke('files:read', workspaceId, path),
    write: (workspaceId: string, document: FileDocument) => ipcRenderer.invoke('files:write', workspaceId, document)
  },
  agents: {
    snapshot: () => ipcRenderer.invoke('agents:snapshot'),
    detect: (agentId: AgentId, hostId: string) => ipcRenderer.invoke('agents:detect', agentId, hostId),
    launch: (input: AgentLaunchInput) => ipcRenderer.invoke('agents:launch', input),
    send: (sessionId: string, text: string, submit = true) => ipcRenderer.invoke('agents:send', sessionId, text, submit),
    interrupt: (sessionId: string) => ipcRenderer.invoke('agents:interrupt', sessionId),
    resize: (sessionId: string, cols: number, rows: number) => ipcRenderer.invoke('agents:resize', sessionId, cols, rows),
    stop: (sessionId: string) => ipcRenderer.invoke('agents:stop', sessionId),
    onEvent(listener: (event: AgentRuntimeEvent) => void) {
      const wrapped = (_event: Electron.IpcRendererEvent, value: AgentRuntimeEvent): void => listener(value)
      ipcRenderer.on('agentmux:event', wrapped)
      return () => ipcRenderer.off('agentmux:event', wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('agentmux', api)
