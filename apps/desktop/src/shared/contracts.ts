import type {
  AgentCatalogEntry,
  AgentMuxAgentContinuityResult,
  AgentCapabilities,
  AgentDisplayState,
  AgentExecutorConfig,
  AgentExecutorId,
  AgentProviderId,
  AgentMuxClientEvent,
  AgentMuxEvidenceSource,
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentMuxRunDataEvent,
  AgentMuxRunRef,
  AgentMuxRunReplayGap,
  AgentMuxRunState,
  AgentMuxControlError,
  AgentMuxControlErrorCode,
  AgentMuxControlRequest,
  AgentMuxControlResult,
  AgentTimelineItem,
  AgentTimelineSnapshot
} from '@agentmux/core'
import {
  SCRATCH_WORKSPACE_ID,
  SCRATCH_WORKSPACE_NAME,
  type ScratchTopicSnapshot
} from './scratch-topics'

export { SCRATCH_WORKSPACE_ID, SCRATCH_WORKSPACE_NAME }
export type { ScratchTopicSnapshot } from './scratch-topics'

export type LocalHostConfig = {
  id: 'local'
  kind: 'local'
  label: string
}

export type SshHostConfig = {
  id: string
  kind: 'ssh'
  label: string
  hostname: string
  user?: string
  port?: number
  identityFile?: string
}

export type HostConfig = LocalHostConfig | SshHostConfig

export type { AgentExecutorConfig, AgentExecutorId, AgentTimelineItem, AgentTimelineSnapshot }

export type WorkspaceRecord = {
  id: string
  name: string
  hostId: string
  path: string
  kind: 'folder' | 'worktree'
  repoPath?: string
  branch?: string
}

/**
 * Reserved id for the always-present "no project" scratch workspace. It is a real
 * `kind:'folder'` record backed by a dedicated on-disk directory (so it satisfies the
 * strict config schema and every file/launch path works unchanged), rendered distinctly
 * in the sidebar. See `ConfigStore.get` (main) for provisioning.
 */
export function isScratchWorkspaceId(id: string | null | undefined): boolean {
  return id === SCRATCH_WORKSPACE_ID
}

export type TerminalThemeId = 'graphite' | 'catppuccin-mocha'

export type AppearanceConfig = {
  terminalTheme: TerminalThemeId
}

export type BrowserToolbarConfig = {
  selectElement: boolean
  screenshot: boolean
  devTools: boolean
  viewport: boolean
  more: boolean
}

export type BrowserConfig = {
  toolbar: BrowserToolbarConfig
}

export type AppConfig = {
  version: 7
  hosts: HostConfig[]
  executors: Record<AgentExecutorId, AgentExecutorConfig>
  workspaces: WorkspaceRecord[]
  appearance: AppearanceConfig
  browser: BrowserConfig
}

export type FileDocument = {
  path: string
  content: string
  revision: string
}

export type WorkspaceFileReadResult =
  | { status: 'read'; document: FileDocument }
  | { status: 'deleted' }
  | { status: 'error'; code: string; message: string }

export type WorkspaceFileWriteInput = {
  path: string
  content: string
  expectedRevision: string | null
}

export type WorkspaceFileWriteResult =
  | { status: 'written'; revision: string }
  | { status: 'conflict'; observedRevision: string | null }
  | { status: 'error'; code: string; message: string }

export type WorkspaceFileInvalidated = {
  workspaceId: string
  path: string
}

export type WorkspaceDirectoryEntry = {
  name: string
  path: string
  isDirectory: boolean
  isSymlink: boolean
}

export type CreateWorkspacePathInput = {
  path: string
  kind: 'file' | 'directory'
}

export type WorkspacePathRef = {
  workspaceId: string
  path: string
}

export type MoveWorkspacePathInput = {
  source: WorkspacePathRef
  destination: WorkspacePathRef
}

export type WorkspacePathMoveResult =
  | { status: 'moved' }
  | {
      status: 'error'
      code: string
      message: string
      finalLocation: 'source' | 'unknown'
    }

export type CreateWorkspaceInput = {
  hostId: string
  path: string
  name?: string
}

export type CreateWorktreeForBranchInput = {
  workspaceId: string
  branch: string
  path: string
}

export type WorkspaceBranchRecord = {
  name: string
  worktreePath: string | null
  workspaceId: string | null
  isCurrent: boolean
}

export type WorkspaceBranchesSnapshot =
  | {
      kind: 'git-repository'
      hostId: string
      repoPath: string
      branches: WorkspaceBranchRecord[]
    }
  | {
      kind: 'not-a-git-repository'
      hostId: string
      workspacePath: string
    }

export type WorkspaceSelectionResult = {
  config: AppConfig
  workspace: WorkspaceRecord
}

export type AgentLaunchInput = {
  executorId: AgentExecutorId
  hostId: string
  workspacePath: string
  scratchTopicId?: string
  agentSessionId?: string
  createOperationId?: string
  prompt?: string
  cols?: number
  rows?: number
}

export type TerminalLaunchInput = {
  hostId: string
  workspacePath: string
  createOperationId?: string
  shellCommand?: string
  cols?: number
  rows?: number
}

export type AgentSessionControl = {
  kind: 'agent'
  hostId: string
  agentSessionId: string
  run: AgentMuxRunRef
}

export type TerminalSessionControl = {
  kind: 'terminal'
  hostId: string
  runId: string
  run: AgentMuxRunRef
}

export type SessionControl = AgentSessionControl | TerminalSessionControl

export type SessionStatus = {
  state: AgentDisplayState
  source: AgentMuxEvidenceSource
  observedAt: number
  detail?: string
  exitCode?: number
  continuity?: 'unavailable' | 'conflict'
}

type SessionSnapshotBase = {
  id: string
  hostId: string
  workspacePath: string
  label: string
  createdAt: number
  updatedAt: number
  processState: AgentMuxRunState
  interruptionReason?: string
  status: SessionStatus
  latestOutputBytes: number
}

export type SessionSnapshot = SessionSnapshotBase & (
  | {
      kind: 'agent'
      providerId: AgentProviderId
      executorId: AgentExecutorId
      capabilities: AgentCapabilities
      pendingInteraction?: AgentMuxInteractionRequest
      control: AgentSessionControl
    }
  | { kind: 'terminal'; providerId: null; control: TerminalSessionControl }
)

export type RuntimeEvent = {
  type: 'core'
  hostId: string
  event: AgentMuxClientEvent
}

export type RuntimeSnapshot = {
  sessions: SessionSnapshot[]
  timelines: Record<string, AgentTimelineSnapshot>
  recoveryCandidates: AgentSessionRecoveryCandidate[]
}

export type AgentSessionRecoveryCandidate = {
  agentSessionId: string
  hostId: string
  workspacePath: string
  providerId: AgentProviderId
  executorId: AgentExecutorId
  capabilities: AgentCapabilities
  label: string
  createdAt: number
  updatedAt: number
  run: AgentMuxRunRef
}

export type AgentLaunchResult = {
  session: Extract<SessionSnapshot, { kind: 'agent' }>
  timeline: AgentTimelineSnapshot
}

export type SessionAttachResult = {
  attachmentId: string
  session: SessionSnapshot
  replay: AgentMuxRunDataEvent[]
  gap: AgentMuxRunReplayGap | null
}

export type SessionRecoveryResult =
  | { kind: 'terminal-restarted'; session: SessionSnapshot }
  | { kind: 'reattachable' | 'resumed'; session: SessionSnapshot }
  | Extract<AgentMuxAgentContinuityResult, { kind: 'unavailable' | 'retired' | 'conflict' }>

export type HostCheckResult = {
  ok: boolean
  detail: string
}

export type ExecutorDetection = {
  executorId: AgentExecutorId
  providerId: AgentProviderId
  hostId: string
  installed: boolean
}

export type DesktopControlResponse =
  | { requestId: string; ok: true; result: AgentMuxControlResult }
  | { requestId: string; ok: false; error: AgentMuxControlError }

export type DesktopControlCancellation = {
  requestId: string
  code: AgentMuxControlErrorCode
  message: string
}

export const CONTROL_REQUEST_CHANNEL = 'agentmux:control-request'
export const CONTROL_CANCEL_CHANNEL = 'agentmux:control-cancel'
export const CONTROL_RESPONSE_CHANNEL = 'control:response'

export type BrowserSnapshot = {
  id: string
  navigationId: string
  profileId: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  viewport: BrowserViewport
  error: string | null
}

export type BrowserProfileImportedSource = {
  browserLabel: string
  profileLabel: string
  importedAt: number
  importedCookies: number
  skippedCookies: number
}

export type BrowserProfileSummary = {
  id: string
  label: string
  createdAt: number
  isDefault: boolean
  source: BrowserProfileImportedSource | null
}

export type BrowserProfileImportSourceSummary = {
  token: string
  browserLabel: string
  profileLabel: string
}

export const BROWSER_VIEWPORT_PRESETS = {
  responsive: null,
  mobile: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 }
} as const

export type BrowserViewport = keyof typeof BROWSER_VIEWPORT_PRESETS

export const BROWSER_PNG_MAX_BASE64_CHARS = 24 * 1024 * 1024
export const BROWSER_PNG_MAX_BYTES = 18 * 1024 * 1024
export const BROWSER_PNG_MAX_PIXELS = 32 * 1024 * 1024
export const BROWSER_PNG_MAX_DIMENSION = 16_384

export type BrowserPng = {
  mimeType: 'image/png'
  dataUrl: string
  width: number
  height: number
  byteLength: number
}

export type BrowserScreenshotCapture = {
  browserId: string
  navigationId: string
  image: BrowserPng
}

export type BrowserElementRect = {
  x: number
  y: number
  width: number
  height: number
}

export type BrowserElementSelection = {
  browserId: string
  navigationId: string
  pageTitle: string
  pageUrl: string
  tagName: string
  role: string
  accessibleName: string
  selector: string
  text: string
  nearbyText: string[]
  attributes: Record<string, string>
  html: string
  rectViewport: BrowserElementRect
  rectPage: BrowserElementRect
  isFixed: boolean
}

export type BrowserAnnotationMarker = {
  id: string
  index: number
  rectViewport: BrowserElementRect
  rectPage: BrowserElementRect
  isFixed: boolean
}

export type BrowserEvent =
  | { type: 'updated'; browser: BrowserSnapshot }
  | { type: 'closed'; id: string }

export type BrowserBounds = {
  x: number
  y: number
  width: number
  height: number
}

export const WINDOW_RESIZE_EVENT_CHANNEL = 'agentmux:window-resize'

export type WindowResizeEvent = {
  active: boolean
}

export type AgentMuxDesktopApi = {
  config: {
    get(): Promise<AppConfig>
    save(config: AppConfig): Promise<AppConfig>
  }
  hosts: {
    check(host: HostConfig): Promise<HostCheckResult>
  }
  workspaces: {
    chooseLocalFolder(): Promise<WorkspaceRecord | null>
    add(input: CreateWorkspaceInput): Promise<WorkspaceRecord>
    listBranches(workspaceId: string): Promise<WorkspaceBranchesSnapshot>
    openBranch(workspaceId: string, branch: string): Promise<WorkspaceSelectionResult>
    createWorktreeForBranch(input: CreateWorktreeForBranchInput): Promise<WorkspaceSelectionResult>
  }
  files: {
    readDirectory(workspaceId: string, path: string): Promise<WorkspaceDirectoryEntry[]>
    read(workspaceId: string, path: string): Promise<WorkspaceFileReadResult>
    write(workspaceId: string, input: WorkspaceFileWriteInput): Promise<WorkspaceFileWriteResult>
    observe(workspaceId: string, path: string): Promise<void>
    unobserve(workspaceId: string, path: string): Promise<void>
    onInvalidated(listener: (event: WorkspaceFileInvalidated) => void): () => void
    create(workspaceId: string, input: CreateWorkspacePathInput): Promise<void>
    move(input: MoveWorkspacePathInput): Promise<WorkspacePathMoveResult>
    delete(workspaceId: string, path: string): Promise<void>
    reveal(workspaceId: string, path: string): Promise<void>
  }
  scratch: {
    listTopics(workspaceId: string): Promise<ScratchTopicSnapshot[]>
    readTopic(workspaceId: string, topicId: string): Promise<ScratchTopicSnapshot | null>
    ensureTopic(workspaceId: string, topicId: string): Promise<ScratchTopicSnapshot>
    renameTitle(workspaceId: string, topicId: string, title: string): Promise<ScratchTopicSnapshot>
  }
  ui: {
    readClipboardText(): Promise<string>
    writeClipboardText(text: string): Promise<void>
    writeClipboardImage(image: BrowserPng): Promise<void>
    openExternal(url: string): Promise<void>
    /** Native file picker. Returns absolute paths, or null when dismissed. */
    chooseFiles(input?: { defaultPath?: string }): Promise<string[] | null>
    /** Persists pasted image bytes and returns the path an Agent can read them from. */
    savePastedImage(input: { bytes: Uint8Array; extension: string }): Promise<string>
    getZoomFactor(): number
    onWindowResize(listener: (event: WindowResizeEvent) => void): () => void
  }
  providers: {
    list(): Promise<AgentCatalogEntry[]>
  }
  executors: {
    detect(executorId: AgentExecutorId, hostId: string): Promise<ExecutorDetection>
  }
  control: {
    onRequest(listener: (
      request: AgentMuxControlRequest,
      signal: AbortSignal
    ) => AgentMuxControlResult | Promise<AgentMuxControlResult>): () => void
  }
  sessions: {
    snapshot(): Promise<RuntimeSnapshot>
    launchAgent(input: AgentLaunchInput): Promise<AgentLaunchResult>
    launchTerminal(input: TerminalLaunchInput): Promise<SessionSnapshot>
    timeline(session: AgentSessionControl): Promise<AgentTimelineSnapshot>
    attach(session: SessionControl, afterByte?: number): Promise<SessionAttachResult>
    detach(attachmentId: string): Promise<void>
    write(session: SessionControl, data: string): Promise<void>
    submitPrompt(session: AgentSessionControl, prompt: string): Promise<void>
    respondInteraction(
      session: AgentSessionControl,
      response: AgentMuxInteractionResponse
    ): Promise<void>
    resume(session: AgentSessionControl, prompt: string, operationId: string): Promise<SessionSnapshot>
    acknowledge(session: SessionControl, throughByte: number): Promise<void>
    interrupt(session: SessionControl): Promise<void>
    resize(attachmentId: string, cols: number, rows: number): Promise<void>
    refresh(session: SessionControl): Promise<SessionSnapshot>
    // Recover a session whose PTY was lost (daemon_restart / tmux_* interruption, or exit).
    // The physical PTY cannot be revived, so this mints a *fresh* Run in the same cwd:
    // terminals relaunch the host shell; agents resume via provider-native resume. If the
    // Transport loss remains an error and never authorizes resume.
    // Returns the Core continuity disposition; the renderer rebinds only an attached/resumed
    // Agent or a newly restarted raw Terminal.
    recover(session: SessionControl, workspacePath?: string): Promise<SessionRecoveryResult>
    stop(session: SessionControl): Promise<void>
    onEvent(listener: (event: RuntimeEvent) => void): () => void
  }
  browser: {
    create(id: string, url: string): Promise<BrowserSnapshot>
    navigate(id: string, url: string): Promise<BrowserSnapshot>
    back(id: string): Promise<BrowserSnapshot>
    forward(id: string): Promise<BrowserSnapshot>
    reload(id: string): Promise<BrowserSnapshot>
    switchProfile(id: string, profileId: string): Promise<BrowserSnapshot>
    listProfiles(): Promise<BrowserProfileSummary[]>
    createProfile(label: string): Promise<BrowserProfileSummary>
    deleteProfile(profileId: string): Promise<void>
    detectProfileImportSources(): Promise<BrowserProfileImportSourceSummary[]>
    importProfile(sourceToken: string, label: string): Promise<BrowserProfileSummary>
    openDevTools(id: string): Promise<void>
    setViewport(id: string, viewport: BrowserViewport): Promise<BrowserSnapshot>
    captureScreenshot(id: string): Promise<BrowserScreenshotCapture>
    selectElement(id: string): Promise<BrowserElementSelection | null>
    cancelElementSelection(id: string): Promise<void>
    setAnnotationMarkers(id: string, navigationId: string, markers: BrowserAnnotationMarker[]): Promise<void>
    setBounds(id: string, bounds: BrowserBounds | null): Promise<void>
    close(id: string): Promise<void>
    onEvent(listener: (event: BrowserEvent) => void): () => void
  }
}

export type AgentMuxPreloadApi = Omit<AgentMuxDesktopApi, 'control'> & {
  control: {
    onRequest(listener: (request: AgentMuxControlRequest) => void): () => void
    onCancellation(listener: (cancellation: DesktopControlCancellation) => void): () => void
    respond(response: DesktopControlResponse): void
  }
}
