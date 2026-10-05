import { readInputObservation } from '@agentmux/core/control'
import type { BrowserResultArtifactChunk, BrowserResultReadOptions } from '../shared/browser-result-artifact'
import type { BrowserTaskAssetRunInput, BrowserTaskContent, BrowserTaskBatchInput } from '../shared/browser-task-assets'
import { CONTINUOUS_PROGRESS_CHANGED, SCHEDULE_CHANGED, NATIVE_BROWSER_VISIBILITY_CHANNEL, NATIVE_BROWSER_INPUT_CHANNEL, NATIVE_OVERLAY_WARNING_CHANNEL } from '../shared/contracts'
import type { ContinuousProgressLoop, ContinuousProgressTarget, ContinuousProgressTaskSource } from '@agentmux/core'
import type { DesktopControlRequest } from '../shared/contracts'
import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { unwrapSessionReopenResult } from '../shared/session-reopen-result'
import { unwrapSessionAgentLaunchResult, unconfirmedSessionAgentLaunch } from '../shared/session-agent-launch-result'
import { unwrapSessionLaunchResult } from '../shared/session-launch-result'
import { unwrapSessionObservationResult } from '../shared/session-observation-result'
import type { AgentExecutorId, AgentMuxControlRequest, AgentMuxRunInputData, AgentMuxAgentWriteInput, AgentSessionHistoryPageOptions } from '@agentmux/core'
import {
  AGENT_ATTENTION_ACTIVATE_CHANNEL,
  BROWSER_EVENT_CHANNEL,
  BROWSER_PRESENTATION_EVENT_CHANNEL,
  CONFIG_CHANGED_CHANNEL,
  CONTROL_CANCEL_CHANNEL,
  CONTROL_REQUEST_CHANNEL,
  CONTROL_RESPONSE_CHANNEL,
  TOOLKIT_CHANGED_CHANNEL,
  TOOLKIT_ENDED_CHANNEL,
  SESSION_EVENT_CHANNEL,
  SESSION_HISTORY_OBSERVATION_CHANNEL,
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
  BrowserPresentationGeometry,
  BrowserPresentationOccurrence,
  BrowserPresentationCaptureAck,
  BrowserPresentationActivation,
  BrowserPresentationEvent,
  BrowserEvent,
  BrowserOperator,
  BrowserOperation,
  BrowserStepEvidenceRead,
  BrowserReplayPlan,
  BrowserPng,
  BrowserProfileDeleteApproval,
  BrowserInputHistoryTarget,
  BrowserInputHistoryScope,
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
  SessionHistoryObservationEvent,
  SessionHistoryObservationReady,
  SessionControl,
  SessionAttachResult,
  SessionReplayResult,
  TerminalLaunchInput,
  WorkspaceFileInvalidated,
  WorkspaceFileWriteInput,
  WindowResizeEvent
} from '../shared/contracts.js'
import type {
  CreatePullRequestInput,
  GitHistoryInput,
  GitBranchCompareInput,
  GitBranchDiffDescriptor,
  GitPullStrategy,
  GitPushOptions,
  GitRemoteOptions
} from '../shared/git-contracts.js'

const api: AgentMuxPreloadApi = {
  readRendererMemory() {
    const sampledAt = Date.now()
    let creationTime: number | null = null
    try { creationTime = process.getCreationTime() } catch { /* Identity remains explicitly unknown. */ }
    try {
      const heap = process.getHeapStatistics()
      return { process: { pid: process.pid, creationTime }, memory: { sampledAt, scope: 'renderer-v8-isolate',
        heap: { usedHeapKib: heap.usedHeapSize, totalHeapKib: heap.totalHeapSize,
          physicalHeapKib: heap.totalPhysicalSize, heapLimitKib: heap.heapSizeLimit }, unavailable: null } }
    } catch {
      return { process: { pid: process.pid, creationTime }, memory: { sampledAt, scope: 'renderer-v8-isolate',
        heap: null, unavailable: 'Renderer V8 heap observation is unavailable.' } }
    }
  },
  notesStorage: {
    inspect: operationId => ipcRenderer.invoke('notesStorage:inspect', operationId),
    change: input => ipcRenderer.invoke('notesStorage:change', input),
    onChange: listener => { const receive = (_event: unknown, snapshot: import('@agentmux/core/notebook-store').NotesStorageSnapshot) => listener(snapshot); ipcRenderer.on('notesStorage:changed', receive); return () => ipcRenderer.removeListener('notesStorage:changed', receive) }
  },
  notebooks: {
    read: () => ipcRenderer.invoke('notebook:read'),
    apply: input => ipcRenderer.invoke('notebook:apply', input),
    onChange: listener => {
      const receive = (_event: unknown, event: import('@agentmux/core/notebook-catalog').NotebookObservation) => listener(event)
      ipcRenderer.on('notebook:changed', receive)
      return () => ipcRenderer.removeListener('notebook:changed', receive)
    }
  },
  spatial: {
    read:()=>ipcRenderer.invoke('spatial:read'),
    commit:input=>ipcRenderer.invoke('spatial:commit',input),
    renameLabel:input=>ipcRenderer.invoke('spatial:renameLabel',input),
    retainLabels:values=>ipcRenderer.invoke('spatial:retainLabels',values),
    confirmNameCommit:operationId=>ipcRenderer.invoke('spatial:confirmNameCommit',operationId),
    nameHistory:input=>ipcRenderer.invoke('spatial:nameHistory',input),
    onChange:listener=>{const receive=(_event:unknown,state:import('@agentmux/core/spatial-graph').AgentMuxSpatialState)=>listener(state);ipcRenderer.on('spatial:changed',receive);return ()=>ipcRenderer.removeListener('spatial:changed',receive)}
  },
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
    check: (host: HostConfig) => ipcRenderer.invoke('hosts:check', host),
    creationTrust: host => ipcRenderer.invoke('hosts:creationTrust', host),
    trustCreationSource: (host, expected) => ipcRenderer.invoke('hosts:trustCreationSource', host, expected),
    upgradeCheck: (host: HostConfig) => ipcRenderer.invoke('hosts:upgradeCheck', host),
    upgrade: (host: HostConfig, expected: import('@agentmux/core').RemoteCoreUpgradeExpected, operationId: string) => ipcRenderer.invoke('hosts:upgrade', host, expected, operationId),
    upgradeInspect: (host: HostConfig, operationId: string) => ipcRenderer.invoke('hosts:upgradeInspect', host, operationId)
  },
  deviceManagement: {
    link: (params) => ipcRenderer.invoke('deviceManagement:link', params),
    ls: (params) => ipcRenderer.invoke('deviceManagement:ls', params),
    revoke: (params) => ipcRenderer.invoke('deviceManagement:revoke', params)
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
    commitDetails: (workspaceId: string, input: import('../shared/git-contracts').GitCommitDetailsInput) =>
      ipcRenderer.invoke('git:commitDetails', workspaceId, input),
    commitDiff: (workspaceId: string, descriptor: import('../shared/git-contracts').GitCommitDiffDescriptor) =>
      ipcRenderer.invoke('git:commitDiff', workspaceId, descriptor),
    projectIdentity: (workspaceId: string) => ipcRenderer.invoke('git:projectIdentity', workspaceId),
    history: (workspaceId: string, input?: GitHistoryInput) =>
      ipcRenderer.invoke('git:history', workspaceId, input),
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
    readPublic: (params: import('@agentmux/core').FileReadParams) => ipcRenderer.invoke('files:readPublic', params),
    createPublic: (params: import('@agentmux/core').FileCreateParams) => ipcRenderer.invoke('files:createPublic', params),
    list: (workspaceId: string, path?: string, limit?: number) => ipcRenderer.invoke('files:list', workspaceId, path, limit),
    readDirectory: (workspaceId: string, path: string) =>
      ipcRenderer.invoke('files:readDirectory', workspaceId, path),
    read: (workspaceId: string, path: string) => ipcRenderer.invoke('files:read', workspaceId, path),
    readPreview: (workspaceId: string, path: string, options?: import('../shared/workspace-file-preview').WorkspaceFilePreviewReadOptions) =>
      ipcRenderer.invoke('files:readPreview', workspaceId, path, options),
    readPreviewResource: request => ipcRenderer.invoke('files:readPreviewResource', request),
    cancelPreviewResource: id => ipcRenderer.invoke('files:cancelPreviewResource', id),
    openHtmlPreview: (workspaceId: string, path: string, content: string) => ipcRenderer.invoke('files:openHtmlPreview', workspaceId, path, content),
    releaseHtmlPreview: (id: string) => ipcRenderer.invoke('files:releaseHtmlPreview', id),
    renderDiagram: (request: import('../shared/file-diagram').FileDiagramRequest) => ipcRenderer.invoke('files:renderDiagram', request),
    cancelDiagram: (id: string) => ipcRenderer.invoke('files:cancelDiagram', id),
    build: (workspaceId: string, request: import('../shared/file-build').FileBuildRequest) => ipcRenderer.invoke('files:build', workspaceId, request),
    inspectBuild: (id: string) => ipcRenderer.invoke('files:inspectBuild', id),
    cancelBuild: (id: string) => ipcRenderer.invoke('files:cancelBuild', id),
    releaseBuild: (id: string) => ipcRenderer.invoke('files:releaseBuild', id),
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
  moteAvatars: {
    list: () => ipcRenderer.invoke('moteAvatars:list'),
    preview: params => ipcRenderer.invoke('moteAvatars:preview', params)
  },
  topics: {
    call: (method, params) => ipcRenderer.invoke('topics:call', method, params)
  },
  spaceObjects: {
    appearance: (target: SpaceObjectImageTarget) => ipcRenderer.invoke('spaceObjects:appearance', target),
    previewAvatar: (target: SpaceObjectImageTarget, input: ObjectAvatarInput) => ipcRenderer.invoke('spaceObjects:previewAvatar', target, input),
    saveAvatar: (target: SpaceObjectImageTarget, input: ObjectAvatarInput) => ipcRenderer.invoke('spaceObjects:saveAvatar', target, input),
    readAvatar: (target: SpaceObjectImageTarget, ref: ObjectAvatarRef) => ipcRenderer.invoke('spaceObjects:readAvatar', target, ref)
  },
  scratch: {
    setMoteArchived: (workspaceId: string, topicId: string, archived: boolean, objectKey: string, expectedVersion: string) =>
      ipcRenderer.invoke('scratch:setMoteArchived', workspaceId, topicId, archived, objectKey, expectedVersion),
    previewMoteAvatar: (workspaceId: string, topicId: string, input: MoteAvatarInput, objectKey: string) => ipcRenderer.invoke('scratch:previewMoteAvatar', workspaceId, topicId, input, objectKey),
    saveMoteAvatar: (workspaceId: string, topicId: string, input: MoteAvatarInput, objectKey: string) => ipcRenderer.invoke('scratch:saveMoteAvatar', workspaceId, topicId, input, objectKey),
    readMoteAvatar: (workspaceId: string, topicId: string, ref: MoteAvatarRef, objectKey: string) => ipcRenderer.invoke('scratch:readMoteAvatar', workspaceId, topicId, ref, objectKey),
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
    prepareGoalStart: (goalId, intent, controlRequestId) => ipcRenderer.invoke('demands:prepareGoalStart', goalId, intent, controlRequestId),
    inspectDispatch: (reference) => ipcRenderer.invoke('demands:inspectDispatch', reference),
    reconcileDispatch: (reference) => ipcRenderer.invoke('demands:reconcileDispatch', reference),
    list: () => ipcRenderer.invoke('demands:list'),
    create: (input, controlRequestId) => ipcRenderer.invoke('demands:create', input, controlRequestId),
    reconcilePmoCreation: (intent, hostId, agentSessionId, createOperationId) => ipcRenderer.invoke('demands:reconcilePmoCreation', intent, hostId, agentSessionId, createOperationId),
    reconcilePmoInput: (intent, session, operationId) => ipcRenderer.invoke('demands:reconcilePmoInput', intent, session, operationId),
    update: (id, patch, controlRequestId, expectedUpdatedAt) => ipcRenderer.invoke('demands:update', id, patch, controlRequestId, expectedUpdatedAt),
    confirmAlignment: (id, expectedRevision) => ipcRenderer.invoke('demands:confirmAlignment', id, expectedRevision),
    acceptGrounding: (id, expectedAlignmentRevision, expectedSubmissionId, acceptGaps) => ipcRenderer.invoke('demands:acceptGrounding', id, expectedAlignmentRevision, expectedSubmissionId, acceptGaps),
    delete: (id) => ipcRenderer.invoke('demands:delete', id),
    linkSession: (id, sessionId) => ipcRenderer.invoke('demands:linkSession', id, sessionId),
    unlinkSession: (id, sessionId) => ipcRenderer.invoke('demands:unlinkSession', id, sessionId),
    activity: (id, input, controlRequestId) => ipcRenderer.invoke('demands:activity', id, input, controlRequestId),
    inspectActivity: (id, operationId) => ipcRenderer.invoke('demands:inspectActivity', id, operationId),
    readActivities: (id) => ipcRenderer.invoke('demands:readActivities', id),
    decision: (id, input) => ipcRenderer.invoke('demands:decision', id, input)
  },
  ui: {
    onNativeBrowserInput(listener) {
      const wrapped = (_event: Electron.IpcRendererEvent, input: import('../shared/native-overlay').NativeBrowserInput): void => listener(input)
      ipcRenderer.on(NATIVE_BROWSER_INPUT_CHANNEL, wrapped)
      return () => ipcRenderer.off(NATIVE_BROWSER_INPUT_CHANNEL, wrapped)
    },
    nativeBrowserVisibility: () => ipcRenderer.invoke('ui:nativeBrowserVisibility'),
    onNativeBrowserVisibility(listener) {
      const wrapped = (_event: Electron.IpcRendererEvent, visibility: import('../shared/native-overlay').NativeBrowserVisibility): void => listener(visibility)
      ipcRenderer.on(NATIVE_BROWSER_VISIBILITY_CHANNEL, wrapped)
      return () => ipcRenderer.off(NATIVE_BROWSER_VISIBILITY_CHANNEL, wrapped)
    },
    publishNativeOverlays: (regions) => ipcRenderer.invoke('ui:publishNativeOverlays', regions),
    onNativeOverlayWarning(listener) {
      const wrapped = (_event: Electron.IpcRendererEvent, warning: string): void => listener(warning)
      ipcRenderer.on(NATIVE_OVERLAY_WARNING_CHANNEL, wrapped)
      return () => ipcRenderer.off(NATIVE_OVERLAY_WARNING_CHANNEL, wrapped)
    },
    requestStorageFlush: () => ipcRenderer.invoke('ui:requestStorageFlush'),
    rendererUpdateReady: (token: string) => ipcRenderer.invoke('ui:rendererUpdateReady', token),
    recordStartupFailure: input => ipcRenderer.invoke('ui:recordStartupFailure', input),
    spatialLinksReady: () => ipcRenderer.invoke('ui:spatialLinksReady'),
    openObjectLink: (url: string) => ipcRenderer.invoke('ui:openObjectLink', url),
    onSpatialLinkIssue(listener) {
      const wrapped = (_event: Electron.IpcRendererEvent, message: string): void => { if (typeof message === 'string') listener(message) }
      ipcRenderer.on('ui:spatialLinkIssue', wrapped)
      return () => ipcRenderer.off('ui:spatialLinkIssue', wrapped)
    },
    captureScreenshot: () => ipcRenderer.invoke('ui:captureScreenshot'),
    listAgentSkills: (sessionId: string) => ipcRenderer.invoke('ui:listAgentSkills', sessionId),
    listWorkspaceSkills: (workspaceId: string, providerId: string) => ipcRenderer.invoke('ui:listWorkspaceSkills', workspaceId, providerId),
    readClipboardText: () => ipcRenderer.invoke('ui:readClipboardText'),
    writeClipboardText: (text: string) => ipcRenderer.invoke('ui:writeClipboardText', text),
    writeClipboardImage: (image: BrowserPng) => ipcRenderer.invoke('ui:writeClipboardImage', image),
    openExternal: (url: string) => ipcRenderer.invoke('ui:openExternal', url),
    exportTheme: document => ipcRenderer.invoke('ui:exportTheme', document),
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
    list: (options?: { observation: true }) => options === undefined
      ? ipcRenderer.invoke('providers:list') : ipcRenderer.invoke('providers:list', options)
  },
  executors: {
    detect: (executorId: AgentExecutorId, hostId: string) => ipcRenderer.invoke('executors:detect', executorId, hostId),
    discover: (hostId: string) => ipcRenderer.invoke('executors:discover', hostId),
    register: (hostId: string, input: import('@agentmux/core').AgentMuxHostExecutorConfigureInput) => ipcRenderer.invoke('executors:register', hostId, input)
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
    goals: goalId => ipcRenderer.invoke('continuousProgress:goals', goalId),
    prepareGoal: (input, caller) => ipcRenderer.invoke('continuousProgress:prepareGoal', input, caller),
    initialGoalInput: (target, loopId, operationId, phase) => ipcRenderer.invoke('continuousProgress:initialGoalInput', target, loopId, operationId, phase),
    goalAction: (goalId, loopId, action, revision, operationId, caller) => ipcRenderer.invoke('continuousProgress:goalAction', goalId, loopId, action, revision, operationId, caller),
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
  schedule: {
    onChanged: listener => {
      const wrapped = (_event: Electron.IpcRendererEvent, loop: ContinuousProgressLoop): void => listener(loop)
      ipcRenderer.on(SCHEDULE_CHANGED, wrapped)
      return () => ipcRenderer.off(SCHEDULE_CHANGED, wrapped)
    },
    list: (params: import('@agentmux/core').ScheduleParamsMap['schedule.list']) => ipcRenderer.invoke('schedule:list', params),
    inspect: (params: import('@agentmux/core').ScheduleParamsMap['schedule.inspect']) => ipcRenderer.invoke('schedule:inspect', params),
    create: (params: import('@agentmux/core').ScheduleParamsMap['schedule.create']) => ipcRenderer.invoke('schedule:create', params),
    pause: (params: import('@agentmux/core').ScheduleParamsMap['schedule.pause']) => ipcRenderer.invoke('schedule:pause', params),
    resume: (params: import('@agentmux/core').ScheduleParamsMap['schedule.resume']) => ipcRenderer.invoke('schedule:resume', params),
    cancel: (params: import('@agentmux/core').ScheduleParamsMap['schedule.cancel']) => ipcRenderer.invoke('schedule:cancel', params)
  },
  sessions: {
    creation: (hostId: string, agentSessionId: string) => ipcRenderer.invoke('sessions:creation', hostId, agentSessionId),
    resolveCreationSessionId: (hostId, createOperationId) => ipcRenderer.invoke('sessions:resolveCreationSessionId', hostId, createOperationId),
    snapshot: () => ipcRenderer.invoke('sessions:snapshot'),
    nativeSessions: input => ipcRenderer.invoke('sessions:nativeSessions', input),
    nativeHistoryPage: input => ipcRenderer.invoke('sessions:nativeHistoryPage', input),
    nativeHistoryResource: input => ipcRenderer.invoke('sessions:nativeHistoryResource', input),
    launchAgent: async (input: AgentLaunchInput, goalPmo?: import('../shared/goal-pmo-origin').GoalPmoIntent) => {
      let result: import('../shared/contracts').SessionAgentLaunchResult
      try { result = await (goalPmo === undefined ? ipcRenderer.invoke('sessions:launchAgent', input) : ipcRenderer.invoke('sessions:launchAgent', input, goalPmo)) }
      catch (error) { throw unconfirmedSessionAgentLaunch(input, error) }
      return unwrapSessionAgentLaunchResult(result)
    },
    launchTerminal: (input: TerminalLaunchInput) => ipcRenderer.invoke('sessions:launchTerminal', input).then(unwrapSessionLaunchResult),
    historySources: (options?: { observation: true }) => options === undefined
      ? ipcRenderer.invoke('sessions:historySources') : ipcRenderer.invoke('sessions:historySources', options),
    confirmNativeSession: (session, input) => ipcRenderer.invoke('sessions:confirmNativeSession', session, input),
    timeline: (session: import('../shared/contracts.js').SessionHistoryReference) => ipcRenderer.invoke('sessions:timeline', session),
    historyPage: (session: import('../shared/contracts.js').SessionHistoryReference, options?: AgentSessionHistoryPageOptions) =>
      ipcRenderer.invoke('sessions:historyPage', session, options),
    historyResource: (session, input) => ipcRenderer.invoke('sessions:historyResource', session, input),
    observeHistory: async (session, listener, options) => {
      const token = crypto.randomUUID()
      let disposed = false
      let releaseAbort: (() => void) | undefined
      const receive = (_event: unknown, payload: SessionHistoryObservationEvent): void => {
        if (!disposed && payload.token === token && payload.observation.agentSessionId === session.agentSessionId) listener(payload.observation)
      }
      const dispose = (): void => {
        if (disposed) return
        disposed = true
        ipcRenderer.removeListener(SESSION_HISTORY_OBSERVATION_CHANNEL, receive)
        try { releaseAbort?.() }
        finally { void ipcRenderer.invoke('sessions:releaseHistoryObservation', token).catch(() => {}) }
      }
      ipcRenderer.on(SESSION_HISTORY_OBSERVATION_CHANNEL, receive)
      try {
        releaseAbort = options?.onAbort?.(dispose)
        if (disposed) {
          releaseAbort?.()
          throw new Error('History observation was cancelled before acquisition.')
        }
        const ready: SessionHistoryObservationReady = await ipcRenderer.invoke('sessions:observeHistory', token, session)
        if (disposed) {
          throw new Error('History observation was released before ready.')
        }
        if ('error' in ready) throw Object.assign(new Error(ready.error.message), { code: ready.error.code })
        return { source: ready.source, dispose }
      } catch (error) { dispose(); throw error }
    },
    attach: async (session: SessionControl, afterSequence = 0) =>
      unwrapSessionObservationResult<SessionAttachResult>(await ipcRenderer.invoke('sessions:attach', session, afterSequence)),
    refreshAttachment: async (session: SessionControl, attachmentId: string | null, afterByte: number) =>
      unwrapSessionObservationResult<SessionAttachResult>(await ipcRenderer.invoke('sessions:refreshAttachment', session, attachmentId, afterByte)),
    replay: async (attachmentId: string, afterByte: number) =>
      unwrapSessionObservationResult<SessionReplayResult>(await ipcRenderer.invoke('sessions:replay', attachmentId, afterByte)),
    detach: (attachmentId: string) => ipcRenderer.invoke('sessions:detach', attachmentId),
    write: (session: SessionControl, data: AgentMuxRunInputData, source: AgentMuxAgentWriteInput['source'], observation?: import('@agentmux/core/control').InputObservationReference) => {
      const parent = readInputObservation(observation)
      return ipcRenderer.invoke('sessions:write', session, data, source, ...(parent ? [parent] : []))
    },
    paste: (session: SessionControl, text: string, terminalData: string, observation?: import('@agentmux/core/control').InputObservationReference) => {
      const parent = readInputObservation(observation)
      return ipcRenderer.invoke('sessions:paste', session, text, terminalData, ...(parent ? [parent] : []))
    },
    recordDeliveryFailure: record => ipcRenderer.invoke('sessions:recordDeliveryFailure', record),
    submitPrompt: (session, prompt, operationId, condition, choice, authorHuman, agentMuxNote, sourceChannel, goalContinuation, goalPmo, goalDispatch) =>
      ipcRenderer.invoke('sessions:submitPrompt', session, prompt, operationId, condition, choice, authorHuman, agentMuxNote, sourceChannel, goalContinuation, goalPmo, goalDispatch),
    replyQuestion: (session, input) => ipcRenderer.invoke('sessions:replyQuestion', session, input),
    submitMessage: (session, message) => ipcRenderer.invoke('sessions:submitMessage', session, message),
    respondInteraction: (session, response) =>
      ipcRenderer.invoke('sessions:respondInteraction', session, response),
    setPosture: (session: AgentSessionControl, modeId: string) =>
      ipcRenderer.invoke('sessions:setPosture', session, modeId),
    reconcileReopen: async (reference: import('../shared/contracts.js').SessionHistoryReference, expectedRetiredAt: number, operationId: string) =>
      unwrapSessionReopenResult(await ipcRenderer.invoke('sessions:reconcile-reopen', reference, expectedRetiredAt, operationId)),
    reopen: async (reference: import('../shared/contracts.js').SessionHistoryReference, expectedRetiredAt: number, operationId: string) =>
      unwrapSessionReopenResult(await ipcRenderer.invoke('sessions:reopen', reference, expectedRetiredAt, operationId)),
    resume: (session: AgentSessionControl, prompt: string, operationId: string, agentMuxNote?: string) =>
      ipcRenderer.invoke('sessions:resume', session, prompt, operationId, agentMuxNote),
    interrupt: (session: SessionControl) => ipcRenderer.invoke('sessions:interrupt', session),
    resize: (attachmentId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('sessions:resize', attachmentId, cols, rows),
    observeStorage: (session: SessionControl) => ipcRenderer.invoke('sessions:observeStorage', session),
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
  toolkit: {
    list: async () => (await ipcRenderer.invoke('toolkit:list')).tools,
    get: async (toolId) => (await ipcRenderer.invoke('toolkit:get', toolId)).snapshot,
    script: async (toolId) => (await ipcRenderer.invoke('toolkit:script', toolId)).script,
    run: async (toolId, input) => (await ipcRenderer.invoke('toolkit:run', toolId, input)).snapshot,
    evaluate: async (toolId, input) => (await ipcRenderer.invoke('toolkit:evaluate', toolId, input)).snapshot,
    action: async (toolId, actionId, input) => (await ipcRenderer.invoke('toolkit:action', toolId, actionId, input)).snapshot,
    stop: async (toolId, executionId) => (await ipcRenderer.invoke('toolkit:stop', toolId, executionId)).snapshot,
    add: async (toolId, value) => ipcRenderer.invoke('toolkit:add', toolId, value),
    update: async (toolId, changes, expected) => ipcRenderer.invoke('toolkit:update', toolId, changes, expected),
    remove: async (toolId, expected) => ipcRenderer.invoke('toolkit:remove', toolId, expected),
    observe(toolId, onSnapshot, onEnd, options) {
      const id = globalThis.crypto.randomUUID()
      let closed = false
      const snapshot = (_event: Electron.IpcRendererEvent, value: any) => {
        if (!closed && value.id === id) onSnapshot(value.snapshot)
      }
      const end = (_event: Electron.IpcRendererEvent, value: any) => { if (!closed && value.id === id) { dispose(); onEnd?.(value.reason) } }
      const dispose = () => {
        if (closed) return
        closed = true
        ipcRenderer.off(TOOLKIT_CHANGED_CHANNEL, snapshot); ipcRenderer.off(TOOLKIT_ENDED_CHANNEL, end)
        void ipcRenderer.invoke('toolkit:release', id).catch(() => {})
      }
      ipcRenderer.on(TOOLKIT_CHANGED_CHANNEL, snapshot); ipcRenderer.on(TOOLKIT_ENDED_CHANNEL, end)
      void ipcRenderer.invoke('toolkit:observe', toolId, id, options).catch(error => {
        if (!closed) { dispose(); onEnd?.(String(error instanceof Error ? error.message : error)) }
      })
      return { dispose }
    }
  },
  browser: {
    listRetainedUploads: () => ipcRenderer.invoke('browser:listRetainedUploads'),
    discardRetainedUpload: selectionId => ipcRenderer.invoke('browser:discardRetainedUpload', selectionId),
    listTargets: workspaceId => ipcRenderer.invoke('browser:listTargets', workspaceId),
    createExternalPairing: workspaceId => ipcRenderer.invoke('browser:createExternalPairing', workspaceId),
    revealExternalExtension: () => ipcRenderer.invoke('browser:revealExternalExtension'),
    stopSharingExternal: id => ipcRenderer.invoke('browser:stopSharingExternal', id),
    onTargetsChanged(listener) {
      const wrapped = (): void => listener()
      ipcRenderer.on('browser:targetsChanged', wrapped)
      return () => ipcRenderer.off('browser:targetsChanged', wrapped)
    },
    forgetAppLinkScheme: (scheme, expected) => ipcRenderer.invoke('browser:forgetAppLinkScheme', scheme, expected),
    create: (id: string, url: string, workspaceId: string | null, rememberedProfileId?: string) => ipcRenderer.invoke('browser:create', id, url, workspaceId, rememberedProfileId),
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
    listInputHistory: (target: BrowserInputHistoryTarget) => ipcRenderer.invoke('browser:listInputHistory', target),
    recordInputHistory: (target: BrowserInputHistoryTarget, text: string) => ipcRenderer.invoke('browser:recordInputHistory', target, text),
    removeInputHistory: (target: BrowserInputHistoryTarget, scope: BrowserInputHistoryScope, text: string) => ipcRenderer.invoke('browser:removeInputHistory', target, scope, text),
    clearInputHistory: (target: BrowserInputHistoryTarget, scope: BrowserInputHistoryScope) => ipcRenderer.invoke('browser:clearInputHistory', target, scope),
    openDevTools: (id: string) => ipcRenderer.invoke('browser:openDevTools', id),
    setViewport: (id: string, viewport: BrowserViewport) => ipcRenderer.invoke('browser:setViewport', id, viewport),
    captureScreenshot: (id: string) => ipcRenderer.invoke('browser:captureScreenshot', id),
    startDemonstration: (id: string) => ipcRenderer.invoke('browser:startDemonstration', id),
    stopDemonstration: (id: string) => ipcRenderer.invoke('browser:stopDemonstration', id),
    getDemonstration: (id: string) => ipcRenderer.invoke('browser:getDemonstration', id),
    getTaskAssets: (id: string) => ipcRenderer.invoke('browser:getTaskAssets', id),
    controlTask: request => ipcRenderer.invoke('browser:controlTask', request),
    importTaskAsset: (id: string, name?: string) => ipcRenderer.invoke('browser:importTaskAsset', id, name),
    saveTaskAssetDraft: (id: string, assetId: string, revision: number, content: BrowserTaskContent) => ipcRenderer.invoke('browser:saveTaskAssetDraft', id, assetId, revision, content),
    saveTaskAssetVersion: (id: string, assetId: string, revision: number, content: BrowserTaskContent) => ipcRenderer.invoke('browser:saveTaskAssetVersion', id, assetId, revision, content),
    locateTaskAssetStep: (id: string, assetId: string, revision: number, stepId: string) => ipcRenderer.invoke('browser:locateTaskAssetStep', id, assetId, revision, stepId),
    runTaskBatch: (input: BrowserTaskBatchInput) => ipcRenderer.invoke('browser:runTaskBatch', input),
    stopTaskBatch: (id: string, batchId: string) => ipcRenderer.invoke('browser:stopTaskBatch', id, batchId),
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
    registerPresentation: (input: { browserId: string; occurrence: BrowserPresentationOccurrence; geometry: BrowserPresentationGeometry }) =>
      ipcRenderer.invoke('browser:registerPresentation', input),
    updatePresentation: (leaseId: string, geometry: BrowserPresentationGeometry) =>
      ipcRenderer.invoke('browser:updatePresentation', leaseId, geometry),
    removePresentation: (leaseId: string) => ipcRenderer.invoke('browser:removePresentation', leaseId),
    armPresentationCapture: (leaseId: string) => ipcRenderer.invoke('browser:armPresentationCapture', leaseId),
    ackPresentationCapture: (captureId: string, ack: BrowserPresentationCaptureAck) =>
      ipcRenderer.invoke('browser:ackPresentationCapture', captureId, ack),
    activatePresentation: (leaseId: string, activation: BrowserPresentationActivation) => ipcRenderer.invoke('browser:activatePresentation', leaseId, activation),
    onPresentationEvent(listener: (event: BrowserPresentationEvent) => void) {
      const wrapped = (_event: Electron.IpcRendererEvent, value: BrowserPresentationEvent): void => listener(value)
      ipcRenderer.on(BROWSER_PRESENTATION_EVENT_CHANNEL, wrapped)
      return () => ipcRenderer.off(BROWSER_PRESENTATION_EVENT_CHANNEL, wrapped)
    },
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
import type { MoteAvatarInput, MoteAvatarRef } from '../shared/mote-avatars.js'

import type { SpaceObjectImageTarget, ObjectAvatarInput, ObjectAvatarRef } from '../shared/object-avatars.js'
