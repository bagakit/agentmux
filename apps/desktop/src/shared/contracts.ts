import type {
  AgentCatalogEntry,
  AgentMuxAgentContinuityResult,
  AgentMuxAgentContinuityConflictReason,
  AgentMuxAgentContinuityUnavailableReason,
  AgentCapabilities,
  AgentDisplayState,
  AgentExecutorConfig,
  AgentExecutorId,
  AgentProviderId,
  LaunchOptionSelection,
  AgentMuxClientEvent,
  AgentMuxEvidenceSource,
  AgentMuxInteractionRequest,
  AgentMuxInteractionResponse,
  AgentMuxRunDataEvent,
  AgentMuxRunExitReason,
  AgentMuxRunRef,
  AgentMuxRunReplayGap,
  AgentMuxRunState,
  AgentTerminalCapabilityState,
  AgentTurnUsage,
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
import type { UsageSnapshot } from './process-usage'
import type {
  NotificationDelivery,
  NotificationModeId,
  NotificationSettings
} from './notification-presentation'

export { SCRATCH_WORKSPACE_ID, SCRATCH_WORKSPACE_NAME }
export type { RunUsage, UsageSnapshot } from './process-usage'
export type { ScratchTopicSnapshot } from './scratch-topics'
// Only the two names product code imports through the contracts path are re-exported here; the rest of
// the notification vocabulary is imported straight from ./notification-presentation where it is used.
export type { NotificationDelivery, NotificationModeId } from './notification-presentation'

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
  // Optional so the field can land without a version bump or a migration: `ConfigStore.get` fills the
  // explicit default when it is absent (same shape as the scratch-workspace back-fill), and every read
  // goes through resolveNotificationModeId, which also defaults. Absence therefore never means "off".
  notifications?: NotificationSettings
}

export type FileDocument = {
  path: string
  content: string
  revision: string
}

export type WorkspaceFileReadResult =
  | { status: 'read'; document: FileDocument }
  | { status: 'deleted' }
  // The target exists but is a directory. Not an error: the caller reveals it in the file tree
  // instead of opening it as a document. Path detection is pure-string, so a directory path is a
  // valid clickable link; only Main can tell it is a directory, so Main says so here.
  | { status: 'directory' }
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
  /**
   * Create `branch` from the repository's current HEAD instead of requiring it to already exist.
   *
   * This is what makes a fan-out possible: opening N fresh branches for one bake-off. Without it a
   * caller must create every branch by hand first. When the branch already exists this is refused
   * rather than silently re-pointing it — moving someone's existing branch is never the intent.
   */
  createBranch?: boolean
}

/**
 * One fan-out: the same prompt taken down N lanes, each on its own new branch and worktree.
 *
 * `baseName` is only a stem — the concrete branch names and paths are derived in main by the single
 * planning source, never chosen here, so a re-run of the same request is reproducible and no caller
 * can mint a second naming scheme.
 */
export type RunFanOutInput = {
  workspaceId: string
  prompt: string
  count: number
  baseName: string
  /** Executors to spread the lanes across, reused cyclically when there are fewer than lanes. */
  executorIds: readonly string[]
}

/**
 * What became of one lane. Mirrors the orchestrator's own three states exactly — a partial failure is
 * neither reported as total failure nor dressed up as success, and a lane that built a worktree but
 * could not launch says whether that directory is still on disk, or it becomes an orphan nobody claims.
 */
export type FanOutLaneOutcome =
  | { status: 'launched'; branch: string; path: string; sessionId: string }
  | { status: 'launch-failed'; branch: string; path: string; error: string; worktreeRetained: boolean }
  | { status: 'worktree-failed'; branch: string; path: string; error: string }

/**
 * `rejected` carries the planner's own reason (a count below one, past the ceiling, or no executors).
 * `single` is not a failure: one lane is not a bake-off, so the caller should take the ordinary launch
 * path rather than pay for orchestration to compare a result with nothing.
 */
export type RunFanOutResult =
  | { kind: 'fanout'; lanes: FanOutLaneOutcome[] }
  | { kind: 'single'; executorId: string }
  | { kind: 'rejected'; reason: string }

export type KeepOneOfFanOutInput = {
  keepWorkspaceId: string
  removeWorkspaceIds: readonly string[]
}

/**
 * `retained` means still on disk and still registered: the dirty-tree protection refused it, or git
 * failed. `reason` is git's own words so the user knows what to review before discarding it explicitly.
 */
export type FanOutTeardownResult =
  | { status: 'removed'; workspaceId: string; removedPath: string }
  | { status: 'retained'; workspaceId: string; reason: string }

export type KeepOneOfFanOutOutcome = {
  keptWorkspaceId: string
  outcomes: FanOutTeardownResult[]
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

/**
 * One entry from `git status`. `index`/`worktree` are git's own two status columns (X and Y), kept
 * raw so the UI can label states precisely without the parser pre-deciding; the booleans are the
 * common questions derived from them. `origPath` is the pre-rename path, present only for a rename or
 * copy. Every path is repo-root-relative, exactly as git emits it.
 */
export type GitFileChange = {
  path: string
  origPath: string | null
  index: string
  worktree: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
}

/**
 * Result of reading source-control status for a workspace. A discriminated union mirroring
 * `WorkspaceBranchesSnapshot`: a plain folder is a first-class, non-error answer, not a thrown
 * exception. `branch` is null on a detached HEAD.
 */
export type GitStatusResult =
  | {
      kind: 'git-repository'
      hostId: string
      repoPath: string
      branch: string | null
      changes: GitFileChange[]
    }
  | {
      kind: 'not-a-git-repository'
      hostId: string
      workspacePath: string
    }

/**
 * One side (old = HEAD blob, new = worktree file) of a single-file diff. Absent is a first-class
 * state, not empty text: a missing old side is how an added file is drawn, a missing new side a
 * deleted one. `binary` carries no `text` — a file with a NUL byte or one too large to read is
 * reported as binary rather than having raw bytes stuffed into a string field.
 */
export type GitDiffSide =
  | { present: false }
  | { present: true; binary: true }
  | { present: true; binary: false; text: string }

/**
 * A structured single-file diff built by reading blobs, not by parsing unified-diff text. `change`
 * is derived from which sides are present and whether their text differs; `binary` is true when
 * either side is binary. The renderer decides how to draw added/deleted/modified/unchanged from
 * this shape without re-deciding anything the service already knows.
 */
export type GitFileDiff = {
  path: string
  old: GitDiffSide
  new: GitDiffSide
  binary: boolean
  change: 'added' | 'deleted' | 'modified' | 'unchanged'
}

/** How a pull reconciles with its upstream when the caller pins a strategy rather than leaving it to git. */
export type GitPullStrategy = 'ff-only' | 'merge' | 'rebase'

/** Common remote-verb inputs. `remote`/`refspec` default to `origin`/`HEAD` and are `-`-prefix rejected. */
export type GitRemoteOptions = {
  remote?: string
  refspec?: string
}

export type GitPushOptions = GitRemoteOptions & {
  /** Use `--force-with-lease` (never a bare `--force`); opt-in for a deliberate history rewrite. */
  forceWithLease?: boolean
}

/**
 * Outcome of a remote verb (push/pull/fetch). `ok` is success; every failure is a classification of
 * git's own output, and its `message` is already credential-scrubbed — a remote URL can carry a
 * `user:token@`, which must never surface. `no-upstream` is the one benign failure (nothing to push
 * to / compare against); `non-fast-forward` and `diverged` are actionable ("sync first"); `error` is
 * everything else (auth, transport, corruption) surfaced rather than hidden.
 */
export type GitRemoteResult =
  | { kind: 'ok'; message?: undefined }
  | { kind: 'no-upstream'; message: string }
  | { kind: 'non-fast-forward'; message: string }
  | { kind: 'diverged'; message: string }
  | { kind: 'error'; message: string }

/**
 * How far the current branch is ahead of / behind its effective upstream. `upstream` is the resolved
 * full ref name the counts are relative to (the push target `@{push}` when it exists, else the
 * configured `@{upstream}`), or null when the branch has no upstream at all.
 */
export type GitAheadBehind = {
  upstream: string | null
  ahead: number
  behind: number
}

/**
 * The result of probing GitHub CLI availability and authentication for a workspace. Three states the
 * UI must keep distinct: `not-installed` (the gh binary is absent — the fix is to install it),
 * `not-authenticated` (gh is present but logged out — the fix is `gh auth login`), and `authenticated`
 * (ready). Authentication is entirely delegated to `gh auth`; AgentMux only *probes* `gh auth status`
 * and never reads, stores, or forwards a token — gh inherits GH_TOKEN/GITHUB_TOKEN from the process on
 * its own, so this adds no new credential-storage surface.
 */
export type GhAuthProbe =
  | { kind: 'not-installed' }
  | { kind: 'not-authenticated' }
  | { kind: 'authenticated' }

export type CreatePullRequestInput = {
  title: string
  body: string
  base: string
  /** Omitted lets gh infer the current branch, which is the ordinary case. */
  head?: string
  draft?: boolean
}

/**
 * Three outcomes, kept apart because they call for different responses.
 *
 * `refused` is a decision made *before* anything was created — a failed preflight, a missing binary,
 * an empty title — so nothing exists on GitHub and the composer keeps its content for a retry.
 * `failed` means gh ran and did not succeed; the message is already credential-scrubbed. Neither is
 * retried automatically: a write that may have partly landed must never be repeated on its own, or the
 * user ends up with two pull requests.
 */
export type CreatePullRequestResult =
  | { kind: 'created'; url: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; message: string }

export type AgentLaunchInput = {
  executorId: AgentExecutorId
  hostId: string
  workspacePath: string
  scratchTopicId?: string
  agentSessionId?: string
  createOperationId?: string
  prompt?: string
  /**
   * The choice ids the launcher picked for this Provider's declared launch options (DESCRIBE half in
   * {@link AgentCatalogEntry.launchOptions}). Core resolves each choice's argv at spawn; a choice the
   * Provider does not declare fails closed. Absent/empty leaves the Provider's own defaults untouched.
   */
  launchOptions?: LaunchOptionSelection
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
  /**
   * WHY an `exited` Run ended, carried verbatim from Core — synthesized there from the stop intent we
   * recorded and the code/signal the kernel observed. Absent unless the Run exited. Lets the surface tell
   * "you stopped it" (`user-stopped`) apart from "it died" (`crashed`) and from a bare 0 with no intent
   * (`unknown`), which we refuse to dress up as a clean finish.
   */
  exitReason?: AgentMuxRunExitReason
  continuity?: 'unavailable' | 'conflict'
  /**
   * WHY a continuity recovery could not happen, carried verbatim from Core.
   *
   * `continuity` alone answers "did it fail", and folding Core's distinct reasons into that single bit
   * is what makes every dead Agent read as one indistinguishable "resume unavailable". The three cases
   * call for different things from the user — a Provider that cannot resume at all is permanent, a
   * missing handle is about this one Session, and a conflict means something else already owns it — so
   * the reason has to survive the trip to the renderer. Absent for `conflict`, whose own two classes
   * ride on `continuityConflict` instead — see there for why they cannot share this field.
   */
  continuityReason?: AgentMuxAgentContinuityUnavailableReason
  /**
   * WHICH of Core's two conflict classes this is, carried verbatim.
   *
   * A separate field rather than another member of `continuityReason`: that field's union is Core's
   * *unavailable* reasons, and widening it would let a conflict value flow into the `unavailable`
   * branch of every existing switch — the compiler would stop objecting exactly where the two
   * concepts must stay apart.
   *
   * Why it must reach the renderer at all: the two classes call for **opposite** actions.
   * `session-run-changed` means this Agent Session is alive on a NEWER Run (something already resumed
   * it), so "wait" is a wrong instruction — waiting never brings back a Run that has been replaced;
   * the surface should re-read the live Session, which `sessions.refresh` does by stable
   * `agentSessionId`. `lifecycle-busy` means another lifecycle operation holds it right now, which is
   * transient — there waiting IS the right answer. Folding them lost that difference and told half the
   * users to wait for something that will never happen.
   */
  continuityConflict?: AgentMuxAgentContinuityConflictReason
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
      /** Core-owned terminal capability fact; absent means no active degradation marker. */
      terminalCapability?: AgentTerminalCapabilityState
      pendingInteraction?: AgentMuxInteractionRequest
      /**
       * The launch-option choice ids that fixed this Agent's security posture at spawn, projected from
       * the Core Session record so a surface can show what this Agent is ALLOWED to do without asking
       * the user to remember what they picked. This is the DESCRIBE half only — ids, resolved against
       * the Provider's catalog declaration for labels. The argv these ids resolve to never leaves Core.
       * Absent when the create narrowed nothing, in which case the Agent runs on the Provider's own
       * defaults and no scope is displayed rather than a guess.
       */
      launchOptions?: LaunchOptionSelection
      /**
       * 最近一个 turn 的真实原生 token 用量，仅 usage 能力声明的 Provider（claude/codex）会有。缺席读作
       * "此 Provider 不报 token 用量"或"还没有一 turn 的用量"，UI 两者都不显示 0 或估算值。
       */
      turnUsage?: AgentTurnUsage
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
  terminalCapability?: AgentTerminalCapabilityState
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
/** Main -> renderer: the user clicked a notification about this Agent Session. */
export const AGENT_ATTENTION_ACTIVATE_CHANNEL = 'agentmux:agent-attention-activate'

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
    /** Pick a replacement directory while preserving the existing Workspace identity. */
    rebindLocalFolder(workspaceId: string): Promise<WorkspaceRecord | null>
    add(input: CreateWorkspaceInput): Promise<WorkspaceRecord>
    listBranches(workspaceId: string): Promise<WorkspaceBranchesSnapshot>
    openBranch(workspaceId: string, branch: string): Promise<WorkspaceSelectionResult>
    createWorktreeForBranch(input: CreateWorktreeForBranchInput): Promise<WorkspaceSelectionResult>
    runFanOut(input: RunFanOutInput): Promise<RunFanOutResult>
    keepOneOfFanOut(input: KeepOneOfFanOutInput): Promise<KeepOneOfFanOutOutcome>
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
    /**
     * Ask Desktop main to raise a native notification about one Agent Session.
     *
     * The renderer decides WHETHER a state change deserves a person's attention and passes the chosen
     * dwell `mode`; main only delivers, because only main can reach the OS. The result distinguishes
     * `shown` from `unsupported`, and within `shown` reports whether the requested mode was honoured
     * or the platform downgraded it — so a caller never assumes a persistent banner it did not get.
     */
    notifyAgentAttention(input: {
      sessionId: string
      title: string
      body: string
      mode: NotificationModeId
    }): Promise<NotificationDelivery>
    /**
     * Fires when the user clicks one of those notifications, carrying the Session id it was about.
     * Main focuses the window; WHERE to go inside it stays with the renderer, which owns View/Region.
     */
    onAgentAttentionActivate(listener: (sessionId: string) => void): () => void
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
    // Set the Agent's live security posture in-band. The renderer sends the picked mode id; Core resolves
    // the Provider's declared keystroke and writes it over the PTY-input transport (bytes never cross IPC).
    setPosture(session: AgentSessionControl, modeId: string): Promise<void>
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
  /**
   * 进程资源用量。**只在有人订阅时才采样**——折叠态一次 `ps` 都不发生。
   *
   * 做成订阅而不是"查一次"，是因为零开销这件事必须由生命周期本身保证：给一个查询接口，
   * 调用方一开定时器就又回到了常驻轮询，而那不会让任何测试变红。
   */
  resourceUsage: {
    /** 开始采样并接收快照，返回退订函数；最后一个订阅者离开时采样停止。 */
    subscribe(listener: (snapshot: UsageSnapshot) => void): () => void
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
    /** Release only the Main-owned native page surface; the Renderer Region remains present. */
    release(id: string): Promise<void>
    /** Rebuild a previously released native page from the retained Region projection. */
    restore(id: string, input: {
      profileId: string
      viewport: BrowserViewport
    }): Promise<BrowserSnapshot>
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
  /**
   * Local Git source control. Lives on the preload API only, not the shared `AgentMuxDesktopApi`,
   * because it is a Desktop-main capability with no meaningful web-preview mock — the renderer reaches
   * it through `window.agentmux.git`, never through the shared mock `api`.
   */
  git: {
    status(workspaceId: string): Promise<GitStatusResult>
    stage(workspaceId: string, path: string): Promise<void>
    commit(workspaceId: string, message: string): Promise<void>
    diff(workspaceId: string, path: string): Promise<GitFileDiff>
    unstage(workspaceId: string, path: string): Promise<void>
    discard(workspaceId: string, path: string, untracked: boolean): Promise<void>
    push(workspaceId: string, options?: GitPushOptions): Promise<GitRemoteResult>
    pull(workspaceId: string, options?: { strategy?: GitPullStrategy }): Promise<GitRemoteResult>
    fetch(workspaceId: string, options?: GitRemoteOptions): Promise<GitRemoteResult>
    aheadBehind(workspaceId: string): Promise<GitAheadBehind>
  }
  /**
   * GitHub CLI capability probing. Like `git`, a Desktop-main capability with no web-preview mock —
   * the renderer reaches it through `window.agentmux.gh`. Only *probes* `gh auth status`; it never
   * reads or persists a token, so it adds no credential-storage surface.
   */
  gh: {
    authStatus(workspaceId: string): Promise<GhAuthProbe>
    createPullRequest(workspaceId: string, input: CreatePullRequestInput): Promise<CreatePullRequestResult>
  }
}
