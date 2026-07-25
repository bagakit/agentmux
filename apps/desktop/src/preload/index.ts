import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { AgentExecutorId, AgentMuxCompositionRequest } from '@agentmux/core'
import {
  COMPOSITION_CANCEL_CHANNEL,
  COMPOSITION_REQUEST_CHANNEL,
  COMPOSITION_RESPONSE_CHANNEL,
  WINDOW_RESIZE_EVENT_CHANNEL
} from '../shared/contracts.js'
import type {
  AgentLaunchInput,
  AgentMuxPreloadApi,
  AgentSessionControl,
  AppConfig,
  BrowserBounds,
  BrowserEvent,
  BrowserPng,
  BrowserViewport,
  CreateWorkspacePathInput,
  CreateWorktreeForBranchInput,
  CreateWorkspaceInput,
  DesktopCompositionCancellation,
  DesktopCompositionResponse,
  HostConfig,
  MoveWorkspacePathInput,
  RuntimeEvent,
  SessionControl,
  TerminalLaunchInput,
  WorkspaceFileInvalidated,
  WorkspaceFileWriteInput,
  WindowResizeEvent
} from '../shared/contracts.js'

const api: AgentMuxPreloadApi = {
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
    write: (workspaceId: string, input: WorkspaceFileWriteInput) => ipcRenderer.invoke('files:write', workspaceId, input),
    observe: (workspaceId: string, path: string) => ipcRenderer.invoke('files:observe', workspaceId, path),
    unobserve: (workspaceId: string, path: string) => ipcRenderer.invoke('files:unobserve', workspaceId, path),
    onInvalidated(listener: (event: WorkspaceFileInvalidated) => void) {
      const wrapped = (_event: Electron.IpcRendererEvent, value: WorkspaceFileInvalidated): void => listener(value)
      ipcRenderer.on('agentmux:workspace-file-invalidated', wrapped)
      return () => ipcRenderer.off('agentmux:workspace-file-invalidated', wrapped)
    },
    create: (workspaceId: string, input: CreateWorkspacePathInput) =>
      ipcRenderer.invoke('files:create', workspaceId, input),
    move: (input: MoveWorkspacePathInput) => ipcRenderer.invoke('files:move', input),
    delete: (workspaceId: string, path: string) => ipcRenderer.invoke('files:delete', workspaceId, path),
    reveal: (workspaceId: string, path: string) => ipcRenderer.invoke('files:reveal', workspaceId, path)
  },
  scratch: {
    listTopics: (workspaceId: string) => ipcRenderer.invoke('scratch:listTopics', workspaceId),
    readTopic: (workspaceId: string, topicId: string) =>
      ipcRenderer.invoke('scratch:readTopic', workspaceId, topicId),
    ensureTopic: (workspaceId: string, topicId: string) =>
      ipcRenderer.invoke('scratch:ensureTopic', workspaceId, topicId),
    renameTitle: (workspaceId: string, topicId: string, title: string) =>
      ipcRenderer.invoke('scratch:renameTitle', workspaceId, topicId, title)
  },
  ui: {
    readClipboardText: () => ipcRenderer.invoke('ui:readClipboardText'),
    writeClipboardText: (text: string) => ipcRenderer.invoke('ui:writeClipboardText', text),
    writeClipboardImage: (image: BrowserPng) => ipcRenderer.invoke('ui:writeClipboardImage', image),
    openExternal: (url: string) => ipcRenderer.invoke('ui:openExternal', url),
    getZoomFactor: () => webFrame.getZoomFactor(),
    onWindowResize(listener: (event: WindowResizeEvent) => void) {
      const wrapped = (_event: Electron.IpcRendererEvent, value: WindowResizeEvent): void => listener(value)
      ipcRenderer.on(WINDOW_RESIZE_EVENT_CHANNEL, wrapped)
      return () => ipcRenderer.off(WINDOW_RESIZE_EVENT_CHANNEL, wrapped)
    }
  },
  providers: {
    list: () => ipcRenderer.invoke('providers:list')
  },
  executors: {
    detect: (executorId: AgentExecutorId, hostId: string) => ipcRenderer.invoke('executors:detect', executorId, hostId)
  },
  composition: {
    onRequest(listener) {
      const wrapped = (_event: Electron.IpcRendererEvent, request: AgentMuxCompositionRequest): void => {
        listener(request)
      }
      ipcRenderer.on(COMPOSITION_REQUEST_CHANNEL, wrapped)
      return () => ipcRenderer.off(COMPOSITION_REQUEST_CHANNEL, wrapped)
    },
    onCancellation(listener) {
      const cancel = (
        _event: Electron.IpcRendererEvent,
        cancellation: DesktopCompositionCancellation
      ): void => {
        listener(cancellation)
      }
      ipcRenderer.on(COMPOSITION_CANCEL_CHANNEL, cancel)
      return () => ipcRenderer.off(COMPOSITION_CANCEL_CHANNEL, cancel)
    },
    respond: (response) => ipcRenderer.send(COMPOSITION_RESPONSE_CHANNEL, response)
  },
  sessions: {
    snapshot: () => ipcRenderer.invoke('sessions:snapshot'),
    launchAgent: (input: AgentLaunchInput) => ipcRenderer.invoke('sessions:launchAgent', input),
    launchTerminal: (input: TerminalLaunchInput) => ipcRenderer.invoke('sessions:launchTerminal', input),
    timeline: (session: AgentSessionControl) => ipcRenderer.invoke('sessions:timeline', session),
    attach: (session: SessionControl, afterSequence = 0) =>
      ipcRenderer.invoke('sessions:attach', session, afterSequence),
    detach: (attachmentId: string) => ipcRenderer.invoke('sessions:detach', attachmentId),
    write: (session: SessionControl, data: string) => ipcRenderer.invoke('sessions:write', session, data),
    submitPrompt: (session: AgentSessionControl, prompt: string) =>
      ipcRenderer.invoke('sessions:submitPrompt', session, prompt),
    acknowledge: (session: SessionControl, sequence: number) =>
      ipcRenderer.invoke('sessions:acknowledge', session, sequence),
    interrupt: (session: SessionControl) => ipcRenderer.invoke('sessions:interrupt', session),
    resize: (attachmentId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('sessions:resize', attachmentId, cols, rows),
    refresh: (session: SessionControl) => ipcRenderer.invoke('sessions:refresh', session),
    recover: (session: SessionControl, workspacePath?: string) =>
      ipcRenderer.invoke('sessions:recover', session, workspacePath),
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
    openDevTools: (id: string) => ipcRenderer.invoke('browser:openDevTools', id),
    setViewport: (id: string, viewport: BrowserViewport) => ipcRenderer.invoke('browser:setViewport', id, viewport),
    captureScreenshot: (id: string) => ipcRenderer.invoke('browser:captureScreenshot', id),
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
