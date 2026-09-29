import type { BrowserResultArtifactChunk, BrowserResultReadOptions } from '../shared/browser-result-artifact'
import type { BrowserTaskAssetRunInput, BrowserTaskContent } from '../shared/browser-task-assets'
import { CONTINUOUS_PROGRESS_CHANGED, NATIVE_BROWSER_INPUT_CHANNEL, NATIVE_OVERLAY_WARNING_CHANNEL } from '../shared/contracts'
import type { ContinuousProgressLoop, ContinuousProgressTarget, ContinuousProgressTaskSource } from '@agentmux/core'
import type { DesktopControlRequest } from '../shared/contracts'
import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { AgentExecutorId, AgentMuxControlRequest, AgentMuxRunInputData, AgentMuxAgentWriteInput, AgentSessionHistoryPageOptions } from '@agentmux/core'
import {
  AGENT_ATTENTION_ACTIVATE_CHANNEL,
  BROWSER_EVENT_CHANNEL,
  CONFIG_CHANGED_CHANNEL,
  CONTROL_CANCEL_CHANNEL,
  CONTROL_REQUEST_CHANNEL,
  CONTROL_RESPONSE_CHANNEL,
  RESOURCE_USAGE_CHANNEL,
  SESSION_EVENT_CHANNEL,
  WINDOW_RESIZE_EVENT_CHANNEL,
  WORKSPACE_FILE_INVALIDATED_CHANNEL
} from '../shared/contracts.js'
import { withStopTimeout } from '../shared/session-stop-timeout.js'
import type {
  AgentAttentionNotifyInput,
  AgentLaunchInput,
  AgentMuxPreloadApi,
  AgentSessionControl,
  AppConfig,
  BrowserBounds,
  BrowserEvent,
  BrowserOperator,
  BrowserOperation,
  BrowserStepEvidenceRead,
  BrowserReplayPlan,
  BrowserPng,
  BrowserProfileDeleteApproval,
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
  GitBranchCompareInput,
  GitBranchDiffDescriptor,
  GitPullStrategy,
  GitPushOptions,
  GitRemoteOptions
} from '../shared/git-contracts.js'

const api: AgentMuxPreloadApi = {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (config: AppConfig, expected: AppConfig) => ipcRenderer.invoke('config:save', config, expected),
    onChange: (listener) => {
      const receive = (_event: unknown, config: AppConfig) => listener(config)
      ipcRenderer.on(CONFIG_CHANGED_CHANNEL, receive)
      return () => ipcRenderer.removeListener(CONFIG_CHANGED_CHANNEL, receive)
    }
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
    createZoneResource: (input: import('../shared/space-addresses').SpaceZoneResourceInput) =>
      ipcRenderer.invoke('workspaces:createZoneResource', input),
    removeWorktree: (input: RemoveWorktreeInput) =>
      ipcRenderer.invoke('workspaces:removeWorktree', input),
    worktreeRemovalNotice: (workspaceId: string) =>
      ipcRenderer.invoke('workspaces:worktreeRemovalNotice', workspaceId),
    runFanOut: (input: RunFanOutInput) => ipcRenderer.invoke('workspaces:runFanOut', input),
    keepOneOfFanOut: (input: KeepOneOfFanOutInput) =>
      ipcRenderer.invoke('workspaces:keepOneOfFanOut', input)
  },
  git: {
    compareBranches: (workspaceId: string, input: GitBranchCompareInput) =>
      ipcRenderer.invoke('git:compareBranches', workspaceId, input),
    branchDiff: (workspaceId: string, descriptor: GitBranchDiffDescriptor) =>
      ipcRenderer.invoke('git:branchDiff', workspaceId, descriptor),
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
    readPreview: (workspaceId: string, path: string, options?: import('../shared/workspace-file-preview').WorkspaceFilePreviewReadOptions) =>
      ipcRenderer.invoke('files:readPreview', workspaceId, path, options),
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
    openSystem: (workspaceId: string, path: string) => ipcRenderer.invoke('files:openSystem', workspaceId, path),
    reveal: (workspaceId: string, path: string) => ipcRenderer.invoke('files:reveal', workspaceId, path)
  },
  scratch: {
    listTopics: (workspaceId: string) => ipcRenderer.invoke('scratch:listTopics', workspaceId),
    readTopic: (workspaceId: string, topicId: string) =>
      ipcRenderer.invoke('scratch:readTopic', workspaceId, topicId),
    ensureMote: (workspaceId: string, topicId: string) =>
      ipcRenderer.invoke('scratch:ensureMote', workspaceId, topicId),
    ensureTopic: (workspaceId: string, topicId: string) =>
      ipcRenderer.invoke('scratch:ensureTopic', workspaceId, topicId),
    renameTitle: (workspaceId: string, topicId: string, title: string) =>
      ipcRenderer.invoke('scratch:renameTitle', workspaceId, topicId, title),
    setWikiEnabled: (workspaceId: string, topicId: string, enabled: boolean) =>
      ipcRenderer.invoke('scratch:setWikiEnabled', workspaceId, topicId, enabled),
    resetWiki: (workspaceId: string, topicId: string) =>
      ipcRenderer.invoke('scratch:resetWiki', workspaceId, topicId)
  },
  demands: {
    list: () => ipcRenderer.invoke('demands:list'),
    create: (input) => ipcRenderer.invoke('demands:create', input),
    update: (id, patch) => ipcRenderer.invoke('demands:update', id, patch),
    confirmAlignment: (id, expectedRevision) => ipcRenderer.invoke('demands:confirmAlignment', id, expectedRevision),
    acceptGrounding: (id, expectedAlignmentRevision, expectedSubmissionId, acceptGaps) => ipcRenderer.invoke('demands:acceptGrounding', id, expectedAlignmentRevision, expectedSubmissionId, acceptGaps),
    delete: (id) => ipcRenderer.invoke('demands:delete', id),
    linkSession: (id, sessionId) => ipcRenderer.invoke('demands:linkSession', id, sessionId),
    unlinkSession: (id, sessionId) => ipcRenderer.invoke('demands:unlinkSession', id, sessionId),
    activity: (id, input) => ipcRenderer.invoke('demands:activity', id, input),
    decision: (id, input) => ipcRenderer.invoke('demands:decision', id, input)
  },
  ui: {
    onNativeBrowserInput(listener) {
      const wrapped = (_event: Electron.IpcRendererEvent, input: import('../shared/native-overlay').NativeBrowserInput): void => listener(input)
      ipcRenderer.on(NATIVE_BROWSER_INPUT_CHANNEL, wrapped)
      return () => ipcRenderer.off(NATIVE_BROWSER_INPUT_CHANNEL, wrapped)
    },
    publishNativeOverlays: (regions) => ipcRenderer.invoke('ui:publishNativeOverlays', regions),
    onNativeOverlayWarning(listener) {
      const wrapped = (_event: Electron.IpcRendererEvent, warning: string): void => listener(warning)
      ipcRenderer.on(NATIVE_OVERLAY_WARNING_CHANNEL, wrapped)
      return () => ipcRenderer.off(NATIVE_OVERLAY_WARNING_CHANNEL, wrapped)
    },
    requestStorageFlush: () => ipcRenderer.invoke('ui:requestStorageFlush'),
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
    setAgentAttentionCount: (count: number) => ipcRenderer.invoke('ui:setAgentAttentionCount', count),
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
      const wrapped = (_event: Electron.IpcRendererEvent, request: DesktopControlRequest): void => {
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
  continuousProgress: {
    list: (target: ContinuousProgressTarget) => ipcRenderer.invoke('continuousProgress:list', target),
    create: (target: ContinuousProgressTarget, intervalMs: number, prompt: string, taskSource?: ContinuousProgressTaskSource) => ipcRenderer.invoke('continuousProgress:create', target, intervalMs, prompt, taskSource),
    action: (target: ContinuousProgressTarget, loopId: string, action: 'pause' | 'resume' | 'stop' | 'check') => ipcRenderer.invoke('continuousProgress:action', target, loopId, action),
    pauseForInput: (control: AgentSessionControl) => ipcRenderer.invoke('continuousProgress:pauseForInput', control),
    onChanged(listener: (loop: ContinuousProgressLoop) => void) {
      const wrapped = (_event: Electron.IpcRendererEvent, loop: ContinuousProgressLoop): void => listener(loop)
      ipcRenderer.on(CONTINUOUS_PROGRESS_CHANGED, wrapped)
      return () => ipcRenderer.off(CONTINUOUS_PROGRESS_CHANGED, wrapped)
    }
  },
  sessions: {
    creation: (hostId: string, agentSessionId: string) => ipcRenderer.invoke('sessions:creation', hostId, agentSessionId),
    snapshot: () => ipcRenderer.invoke('sessions:snapshot'),
    launchAgent: (input: AgentLaunchInput) => ipcRenderer.invoke('sessions:launchAgent', input),
    launchTerminal: (input: TerminalLaunchInput) => ipcRenderer.invoke('sessions:launchTerminal', input),
    historySources: () => ipcRenderer.invoke('sessions:historySources'),
    timeline: (session: import('../shared/contracts.js').SessionHistoryReference) => ipcRenderer.invoke('sessions:timeline', session),
    historyPage: (session: import('../shared/contracts.js').SessionHistoryReference, options?: AgentSessionHistoryPageOptions) =>
      ipcRenderer.invoke('sessions:historyPage', session, options),
    attach: (session: SessionControl, afterSequence = 0) =>
      ipcRenderer.invoke('sessions:attach', session, afterSequence),
    refreshAttachment: (session: SessionControl, attachmentId: string | null, afterByte: number) =>
      ipcRenderer.invoke('sessions:refreshAttachment', session, attachmentId, afterByte),
    replay: (attachmentId: string, afterByte: number) =>
      ipcRenderer.invoke('sessions:replay', attachmentId, afterByte),
    detach: (attachmentId: string) => ipcRenderer.invoke('sessions:detach', attachmentId),
    write: (session: SessionControl, data: AgentMuxRunInputData, source: AgentMuxAgentWriteInput['source']) => ipcRenderer.invoke('sessions:write', session, data, source),
    paste: (session: SessionControl, text: string, terminalData: string) => ipcRenderer.invoke('sessions:paste', session, text, terminalData),
    submitPrompt: (session, prompt, operationId, condition, authorAgentSessionId, choice, authorHuman) =>
      ipcRenderer.invoke('sessions:submitPrompt', session, prompt, operationId, condition, authorAgentSessionId, choice, authorHuman),
    respondInteraction: (session, response) =>
      ipcRenderer.invoke('sessions:respondInteraction', session, response),
    setPosture: (session: AgentSessionControl, modeId: string) =>
      ipcRenderer.invoke('sessions:setPosture', session, modeId),
    resume: (session: AgentSessionControl, prompt: string, operationId: string) =>
      ipcRenderer.invoke('sessions:resume', session, prompt, operationId),
    interrupt: (session: SessionControl) => ipcRenderer.invoke('sessions:interrupt', session),
    resize: (attachmentId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('sessions:resize', attachmentId, cols, rows),
    refresh: (session: SessionControl) => ipcRenderer.invoke('sessions:refresh', session),
    recover: (session: SessionControl, workspacePath?: string, operationId?: string) =>
      ipcRenderer.invoke('sessions:recover', session, workspacePath, operationId),
    // 唯一带超时的那条：等 Runtime 收尾必须有上限，否则一次没回执的握手会把关闭按钮永久锁死。
    // 理由与取值见 shared/session-stop-timeout.ts。
    stop: (session: SessionControl) => withStopTimeout(ipcRenderer.invoke('sessions:stop', session)),
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
    forgetAppLinkScheme: (scheme, expected) => ipcRenderer.invoke('browser:forgetAppLinkScheme', scheme, expected),
    create: (id: string, url: string, workspaceId: string | null) => ipcRenderer.invoke('browser:create', id, url, workspaceId),
    navigate: (id: string, url: string) => ipcRenderer.invoke('browser:navigate', id, url),
    back: (id: string) => ipcRenderer.invoke('browser:back', id),
    forward: (id: string) => ipcRenderer.invoke('browser:forward', id),
    reload: (id: string) => ipcRenderer.invoke('browser:reload', id),
    switchProfile: (id: string, profileId: string) => ipcRenderer.invoke('browser:switchProfile', id, profileId),
    listProfiles: () => ipcRenderer.invoke('browser:listProfiles'),
    createProfile: (label: string) => ipcRenderer.invoke('browser:createProfile', label),
    deleteProfile: (profileId: string, approval: BrowserProfileDeleteApproval) => ipcRenderer.invoke('browser:deleteProfile', profileId, approval),
    detectProfileImportSources: () => ipcRenderer.invoke('browser:detectProfileImportSources'),
    importProfile: (sourceToken: string, label: string) =>
      ipcRenderer.invoke('browser:importProfile', sourceToken, label),
    openDevTools: (id: string) => ipcRenderer.invoke('browser:openDevTools', id),
    setViewport: (id: string, viewport: BrowserViewport) => ipcRenderer.invoke('browser:setViewport', id, viewport),
    captureScreenshot: (id: string) => ipcRenderer.invoke('browser:captureScreenshot', id),
    startDemonstration: (id: string) => ipcRenderer.invoke('browser:startDemonstration', id),
    stopDemonstration: (id: string) => ipcRenderer.invoke('browser:stopDemonstration', id),
    getDemonstration: (id: string) => ipcRenderer.invoke('browser:getDemonstration', id),
    getTaskAssets: (id: string) => ipcRenderer.invoke('browser:getTaskAssets', id),
    importTaskAsset: (id: string, name?: string) => ipcRenderer.invoke('browser:importTaskAsset', id, name),
    saveTaskAssetDraft: (id: string, assetId: string, revision: number, content: BrowserTaskContent) => ipcRenderer.invoke('browser:saveTaskAssetDraft', id, assetId, revision, content),
    saveTaskAssetVersion: (id: string, assetId: string, revision: number, content: BrowserTaskContent) => ipcRenderer.invoke('browser:saveTaskAssetVersion', id, assetId, revision, content),
    locateTaskAssetStep: (id: string, assetId: string, revision: number, stepId: string) => ipcRenderer.invoke('browser:locateTaskAssetStep', id, assetId, revision, stepId),
    runTaskAsset: (input: BrowserTaskAssetRunInput) => ipcRenderer.invoke('browser:runTaskAsset', input),
    stopTaskAsset: (id: string, runId: string) => ipcRenderer.invoke('browser:stopTaskAsset', id, runId),
    runScript: (id: string, code: string, operator?: BrowserOperator, operationId?: string) => ipcRenderer.invoke('browser:runScript', id, code, operator, operationId),
    checkOutcomeFields: (id, input) => ipcRenderer.invoke('browser:checkOutcomeFields', id, input),
    verifyOutcome: (id, operationId) => ipcRenderer.invoke('browser:verifyOutcome', id, operationId),
    listOperationHistory: () => ipcRenderer.invoke('browser:listOperationHistory') as Promise<BrowserOperation[]>,
    getOperation: (operationId: string) => ipcRenderer.invoke('browser:getOperation', operationId) as Promise<BrowserOperation | null>,
    getStepEvidence: (operationId: string, sequence: number) => ipcRenderer.invoke('browser:getStepEvidence', operationId, sequence) as Promise<BrowserStepEvidenceRead>,
    readStepResult: (operationId: string, sequence: number, options?: BrowserResultReadOptions) => ipcRenderer.invoke('browser:readStepResult', operationId, sequence, options) as Promise<BrowserResultArtifactChunk>,
    stopOperationById: (operationId: string) => ipcRenderer.invoke('browser:stopOperationById', operationId) as Promise<BrowserOperation | null>,
    replayPlan: (operationId: string) => ipcRenderer.invoke('browser:replayPlan', operationId) as Promise<BrowserReplayPlan | null>,
    runReplay: (id: string, plan: BrowserReplayPlan, operator?: BrowserOperator) => ipcRenderer.invoke('browser:runReplay', id, plan, operator),
    returnControl: (id: string) => ipcRenderer.invoke('browser:returnControl', id),
    selectElement: (id: string) => ipcRenderer.invoke('browser:selectElement', id),
    answerAppLink: (id: string, allow: boolean, remember: boolean) =>
      ipcRenderer.invoke('browser:answerAppLink', id, allow, remember),
    cancelElementSelection: (id: string) => ipcRenderer.invoke('browser:cancelElementSelection', id),
    setAnnotationMarkers: (id, navigationId, markers) =>
      ipcRenderer.invoke('browser:setAnnotationMarkers', id, navigationId, markers),
    setBounds: (id: string, bounds: BrowserBounds | null) => ipcRenderer.invoke('browser:setBounds', id, bounds),
    release: (id: string) => ipcRenderer.invoke('browser:release', id),
    restore: (id: string, input: { workspaceId: string | null; profileId: string; viewport: BrowserViewport }) =>
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
