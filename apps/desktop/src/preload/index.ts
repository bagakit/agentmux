import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { AgentExecutorId, AgentMuxControlRequest, AgentMuxRunInputData } from '@agentmux/core'
import {
  AGENT_ATTENTION_ACTIVATE_CHANNEL,
  BROWSER_EVENT_CHANNEL,
  CONTROL_CANCEL_CHANNEL,
  CONTROL_REQUEST_CHANNEL,
  CONTROL_RESPONSE_CHANNEL,
  RESOURCE_USAGE_CHANNEL,
  SESSION_EVENT_CHANNEL,
  WINDOW_RESIZE_EVENT_CHANNEL,
  WORKSPACE_FILE_INVALIDATED_CHANNEL
} from '../shared/contracts.js'
import type {
  AgentAttentionNotifyInput,
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
  RunFanOutInput,
  KeepOneOfFanOutInput,
  CreateWorkspaceInput,
  DesktopControlCancellation,
  DesktopControlResponse,
  HostConfig,
  MoveWorkspacePathInput,
  RemoveWorktreeInput,
  RuntimeEvent,
  SessionControl,
  TerminalLaunchInput,
  UsageSnapshot,
  WorkspaceFileInvalidated,
  WorkspaceFileWriteInput,
  WindowResizeEvent
} from '../shared/contracts.js'
import type {
  CreatePullRequestInput,
  GitPullStrategy,
  GitPushOptions,
  GitRemoteOptions
} from '../shared/git-contracts.js'

const api: AgentMuxPreloadApi = {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (config: AppConfig) => ipcRenderer.invoke('config:save', config)
  },
  hosts: {
    check: (host: HostConfig) => ipcRenderer.invoke('hosts:check', host)
  },
  workspaces: {
    appearance: (id: string) => ipcRenderer.invoke('workspaces:appearance', id),
    chooseLocalFolder: () => ipcRenderer.invoke('workspaces:chooseLocalFolder'),
    rebindLocalFolder: (workspaceId: string) => ipcRenderer.invoke('workspaces:rebindLocalFolder', workspaceId),
    add: (input: CreateWorkspaceInput) => ipcRenderer.invoke('workspaces:add', input),
    listBranches: (workspaceId: string) => ipcRenderer.invoke('workspaces:listBranches', workspaceId),
    openBranch: (workspaceId: string, branch: string) =>
      ipcRenderer.invoke('workspaces:openBranch', workspaceId, branch),
    createWorktreeForBranch: (input: CreateWorktreeForBranchInput) =>
      ipcRenderer.invoke('workspaces:createWorktreeForBranch', input),
    removeWorktree: (input: RemoveWorktreeInput) =>
      ipcRenderer.invoke('workspaces:removeWorktree', input),
    worktreeRemovalNotice: (workspaceId: string) =>
      ipcRenderer.invoke('workspaces:worktreeRemovalNotice', workspaceId),
    runFanOut: (input: RunFanOutInput) => ipcRenderer.invoke('workspaces:runFanOut', input),
    keepOneOfFanOut: (input: KeepOneOfFanOutInput) =>
      ipcRenderer.invoke('workspaces:keepOneOfFanOut', input)
  },
  git: {
    status: (workspaceId: string) => ipcRenderer.invoke('git:status', workspaceId),
    stage: (workspaceId: string, path: string) => ipcRenderer.invoke('git:stage', workspaceId, path),
    commit: (workspaceId: string, message: string) =>
      ipcRenderer.invoke('git:commit', workspaceId, message),
    diff: (workspaceId: string, workspacePath: string) =>
      ipcRenderer.invoke('git:diff', workspaceId, workspacePath),
    unstage: (workspaceId: string, path: string) => ipcRenderer.invoke('git:unstage', workspaceId, path),
    discard: (workspaceId: string, path: string, untracked: boolean) =>
      ipcRenderer.invoke('git:discard', workspaceId, path, untracked),
    push: (workspaceId: string, options?: GitPushOptions) => ipcRenderer.invoke('git:push', workspaceId, options),
    pull: (workspaceId: string, options?: { strategy?: GitPullStrategy }) =>
      ipcRenderer.invoke('git:pull', workspaceId, options),
    fetch: (workspaceId: string, options?: GitRemoteOptions) => ipcRenderer.invoke('git:fetch', workspaceId, options),
    aheadBehind: (workspaceId: string) => ipcRenderer.invoke('git:aheadBehind', workspaceId)
  },
  gh: {
    prReadiness: (workspaceId: string) => ipcRenderer.invoke('gh:prReadiness', workspaceId),
    createPullRequest: (workspaceId: string, input: CreatePullRequestInput) =>
      ipcRenderer.invoke('gh:createPullRequest', workspaceId, input)
  },
  files: {
    readDirectory: (workspaceId: string, path: string) =>
      ipcRenderer.invoke('files:readDirectory', workspaceId, path),
    read: (workspaceId: string, path: string) => ipcRenderer.invoke('files:read', workspaceId, path),
    readBookmark: (workspaceId: string, path: string) =>
      ipcRenderer.invoke('files:readBookmark', workspaceId, path),
    write: (workspaceId: string, input: WorkspaceFileWriteInput) => ipcRenderer.invoke('files:write', workspaceId, input),
    observe: (workspaceId: string, path: string) => ipcRenderer.invoke('files:observe', workspaceId, path),
    unobserve: (workspaceId: string, path: string) => ipcRenderer.invoke('files:unobserve', workspaceId, path),
    onInvalidated(listener: (event: WorkspaceFileInvalidated) => void) {
      const wrapped = (_event: Electron.IpcRendererEvent, value: WorkspaceFileInvalidated): void => listener(value)
      ipcRenderer.on(WORKSPACE_FILE_INVALIDATED_CHANNEL, wrapped)
      return () => ipcRenderer.off(WORKSPACE_FILE_INVALIDATED_CHANNEL, wrapped)
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
    rendererUpdateReady: (token: string) => ipcRenderer.invoke('ui:rendererUpdateReady', token),
    captureScreenshot: () => ipcRenderer.invoke('ui:captureScreenshot'),
    listAgentSkills: (sessionId: string) => ipcRenderer.invoke('ui:listAgentSkills', sessionId),
    listWorkspaceSkills: (workspaceId: string, providerId: string) => ipcRenderer.invoke('ui:listWorkspaceSkills', workspaceId, providerId),
    readClipboardText: () => ipcRenderer.invoke('ui:readClipboardText'),
    writeClipboardText: (text: string) => ipcRenderer.invoke('ui:writeClipboardText', text),
    writeClipboardImage: (image: BrowserPng) => ipcRenderer.invoke('ui:writeClipboardImage', image),
    openExternal: (url: string) => ipcRenderer.invoke('ui:openExternal', url),
    chooseFiles: (input?: { defaultPath?: string }) => ipcRenderer.invoke('ui:chooseFiles', input),
    savePastedImage: (input: { bytes: Uint8Array; extension: string }) =>
      ipcRenderer.invoke('ui:savePastedImage', input),
    readPastedImage: (path: string) => ipcRenderer.invoke('ui:readPastedImage', path),
    revealCrashLog: () => ipcRenderer.invoke('ui:revealCrashLog'),
    notifyAgentAttention: (input: AgentAttentionNotifyInput) =>
      ipcRenderer.invoke('ui:notifyAgentAttention', input),
    onAgentAttentionActivate(listener: (sessionId: string) => void) {
      const wrapped = (_event: Electron.IpcRendererEvent, sessionId: string): void => listener(sessionId)
      ipcRenderer.on(AGENT_ATTENTION_ACTIVATE_CHANNEL, wrapped)
      return () => ipcRenderer.off(AGENT_ATTENTION_ACTIVATE_CHANNEL, wrapped)
    },
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
  control: {
    onRequest(listener) {
      const wrapped = (_event: Electron.IpcRendererEvent, request: AgentMuxControlRequest): void => {
        listener(request)
      }
      ipcRenderer.on(CONTROL_REQUEST_CHANNEL, wrapped)
      return () => ipcRenderer.off(CONTROL_REQUEST_CHANNEL, wrapped)
    },
    onCancellation(listener) {
      const cancel = (
        _event: Electron.IpcRendererEvent,
        cancellation: DesktopControlCancellation
      ): void => {
        listener(cancellation)
      }
      ipcRenderer.on(CONTROL_CANCEL_CHANNEL, cancel)
      return () => ipcRenderer.off(CONTROL_CANCEL_CHANNEL, cancel)
    },
    respond: (response: DesktopControlResponse) => ipcRenderer.send(CONTROL_RESPONSE_CHANNEL, response)
  },
  sessions: {
    snapshot: () => ipcRenderer.invoke('sessions:snapshot'),
    launchAgent: (input: AgentLaunchInput) => ipcRenderer.invoke('sessions:launchAgent', input),
    launchTerminal: (input: TerminalLaunchInput) => ipcRenderer.invoke('sessions:launchTerminal', input),
    timeline: (session: AgentSessionControl) => ipcRenderer.invoke('sessions:timeline', session),
    attach: (session: SessionControl, afterSequence = 0) =>
      ipcRenderer.invoke('sessions:attach', session, afterSequence),
    detach: (attachmentId: string) => ipcRenderer.invoke('sessions:detach', attachmentId),
    write: (session: SessionControl, data: AgentMuxRunInputData) => ipcRenderer.invoke('sessions:write', session, data),
    submitPrompt: (session: AgentSessionControl, prompt: string, operationId?: string) =>
      ipcRenderer.invoke('sessions:submitPrompt', session, prompt, operationId),
    respondInteraction: (session, response) =>
      ipcRenderer.invoke('sessions:respondInteraction', session, response),
    setPosture: (session: AgentSessionControl, modeId: string) =>
      ipcRenderer.invoke('sessions:setPosture', session, modeId),
    resume: (session: AgentSessionControl, prompt: string, operationId: string) =>
      ipcRenderer.invoke('sessions:resume', session, prompt, operationId),
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
      ipcRenderer.on(SESSION_EVENT_CHANNEL, wrapped)
      return () => ipcRenderer.off(SESSION_EVENT_CHANNEL, wrapped)
    }
  },
  resourceUsage: {
    subscribe(listener: (snapshot: UsageSnapshot) => void) {
      const wrapped = (_event: Electron.IpcRendererEvent, value: UsageSnapshot): void => listener(value)
      ipcRenderer.on(RESOURCE_USAGE_CHANNEL, wrapped)
      void ipcRenderer.invoke('resourceUsage:subscribe')
      return () => {
        ipcRenderer.off(RESOURCE_USAGE_CHANNEL, wrapped)
        // 退订必须一路传到主进程：只摘掉监听器会让采样继续跑，而面板已经关了。
        void ipcRenderer.invoke('resourceUsage:unsubscribe')
      }
    }
  },
  browser: {
    create: (id: string, url: string) => ipcRenderer.invoke('browser:create', id, url),
    navigate: (id: string, url: string) => ipcRenderer.invoke('browser:navigate', id, url),
    back: (id: string) => ipcRenderer.invoke('browser:back', id),
    forward: (id: string) => ipcRenderer.invoke('browser:forward', id),
    reload: (id: string) => ipcRenderer.invoke('browser:reload', id),
    switchProfile: (id: string, profileId: string) => ipcRenderer.invoke('browser:switchProfile', id, profileId),
    listProfiles: () => ipcRenderer.invoke('browser:listProfiles'),
    createProfile: (label: string) => ipcRenderer.invoke('browser:createProfile', label),
    deleteProfile: (profileId: string) => ipcRenderer.invoke('browser:deleteProfile', profileId),
    detectProfileImportSources: () => ipcRenderer.invoke('browser:detectProfileImportSources'),
    importProfile: (sourceToken: string, label: string) =>
      ipcRenderer.invoke('browser:importProfile', sourceToken, label),
    openDevTools: (id: string) => ipcRenderer.invoke('browser:openDevTools', id),
    setViewport: (id: string, viewport: BrowserViewport) => ipcRenderer.invoke('browser:setViewport', id, viewport),
    captureScreenshot: (id: string) => ipcRenderer.invoke('browser:captureScreenshot', id),
    runScript: (id: string, code: string) => ipcRenderer.invoke('browser:runScript', id, code),
    selectElement: (id: string) => ipcRenderer.invoke('browser:selectElement', id),
    answerAppLink: (id: string, allow: boolean, remember: boolean) =>
      ipcRenderer.invoke('browser:answerAppLink', id, allow, remember),
    cancelElementSelection: (id: string) => ipcRenderer.invoke('browser:cancelElementSelection', id),
    setAnnotationMarkers: (id, navigationId, markers) =>
      ipcRenderer.invoke('browser:setAnnotationMarkers', id, navigationId, markers),
    setBounds: (id: string, bounds: BrowserBounds | null) => ipcRenderer.invoke('browser:setBounds', id, bounds),
    release: (id: string) => ipcRenderer.invoke('browser:release', id),
    restore: (id: string, input: { profileId: string; viewport: BrowserViewport }) =>
      ipcRenderer.invoke('browser:restore', id, input),
    close: (id: string) => ipcRenderer.invoke('browser:close', id),
    onEvent(listener: (event: BrowserEvent) => void) {
      const wrapped = (_event: Electron.IpcRendererEvent, value: BrowserEvent): void => listener(value)
      ipcRenderer.on(BROWSER_EVENT_CHANNEL, wrapped)
      return () => ipcRenderer.off(BROWSER_EVENT_CHANNEL, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('agentmux', api)
