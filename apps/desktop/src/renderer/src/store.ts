import { clampProjectRailWidth, PROJECT_RAIL_DEFAULT_WIDTH } from './lib/project-rail-width'
import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import {
  AGENTMUX_CONTROL_ERROR_CODES,
  type AgentMuxArrangeMode,
  type AgentMuxControlErrorCode,
  type AgentMuxControlRequest,
  type AgentMuxControlResult,
  type AgentMuxExecutorAvailability,
  type AgentMuxRegion
} from '@agentmux/core/control'
import type { AgentCatalogEntry, AgentMuxInteractionResponse, LaunchOptionSelection } from '@agentmux/core'
import { agentPromptExceedsBudget, MAX_AGENT_PROMPT_BYTES } from '@agentmux/core/agent-prompt-budget'
import type {
  AgentLaunchResult,
  AgentSessionRecoveryCandidate,
  AgentTimelineSnapshot,
  AppConfig,
  BrowserEvent,
  CreateWorkspacePathInput,
  FileDocument,
  GitFileDiff,
  HostConfig,
  HostCheckResult,
  ExecutorDetection,
  RuntimeEvent,
  RuntimeSnapshot,
  ScratchTopicSnapshot,
  SessionControl,
  SessionRecoveryResult,
  SessionSnapshot,
  WorkspaceSelectionResult,
  RunFanOutInput,
  RunFanOutResult,
  KeepOneOfFanOutInput,
  KeepOneOfFanOutOutcome,
  RemoveWorktreeInput,
  RemoveWorktreeOutcome,
  CreatePullRequestResult
} from '../../shared/contracts'
import {
  isScratchTopicId,
  scratchTopicIdFromWorkspacePath,
  workspaceOwnsSessionPath
} from '../../shared/scratch-topics'
import { isScratchWorkspaceId } from '../../shared/contracts'
import { api } from './lib/api'
import { presentError } from './lib/error-presentation'
import { steerEntryTargetsRun, steerQueueCanDrainNow } from './lib/agent-steer-queue-drain'
import { reseatActiveWorkspaceId, adoptedConfig } from './lib/active-workspace-reseat'
import { gitBridge, ghBridge } from './lib/git-bridge'
import type { BrowserAnnotation } from './lib/browser-annotations'
import { EMPTY_LAUNCHER_NAMES, type LauncherNameField, type LauncherNames } from './lib/launcher-name-draft'
import { resolveLauncherWorkspaceId } from './lib/launcher-workspace'
import type { OpenDestination, OpenHttpLinkOrigin } from './lib/open-destination'
import { regionFocusClaimsCaret, type RegionFocusCause } from './lib/region-focus'
import { createNoteWithAvailableName } from './lib/note-names'
import { rendererResourceOwnerCounts } from './lib/resource-owner-counts'
import { terminalResourceOwnerCounts } from './lib/terminal-resource-owners'
import { retainedLaneReport, retentionReport } from './lib/worktree-removal-request'
import {
  arrangeWorkbenchControlTab,
  inspectWorkbenchControlRegion,
  inspectWorkbenchControlTab,
  messageTargetCandidates,
  planControlOpen,
  resolveWorkbenchControlRegion,
  resolveWorkbenchControlTab,
  rollbackControlOpen
} from './lib/control'
import {
  activateTab as activateLayoutTab,
  addTabOrThrow,
  addTabPlacement,
  createWorkspaceLayout,
  findGroup,
  findGroupForTab,
  focusGroup,
  removeTab as removeLayoutTab,
  setSplitRatio,
  moveTabToNewGroup as moveLayoutTabToNewGroup,
  setWorkbenchRegionSplitRatio,
  workbenchRegionBounds,
  type SplitDirection,
  type WorkspaceLayout,
  type WorkbenchRegionLayoutPreset
} from '@agentmux/layout'
import {
  describePersistedTabRepairs,
  projectPersistedWorkbench,
  persistedAgentSessionIds,
  restorePersistedWorkbench,
  type PersistedWorkbench
} from './lib/workbench-persistence'
import { reduceBrowserEvent } from './lib/browser-state'
import {
  bumpWorkspaceFileRevision,
  reduceDocumentAttached,
  reduceDocumentContent,
  reduceDocumentLoadFailed,
  reduceDocumentRead,
  reduceDocumentReloaded,
  reduceDocumentSaving,
  reduceDocumentWriteError,
  reduceDocumentWritten,
  reduceFileDelete,
  reduceFileOpened,
  reduceFileRename,
  findFileRenameProjectionCollision,
  reconcileWorkbenchFileProjection,
  type FileDocumentIssue
} from './lib/file-workbench-state'
import {
  advanceDocumentLifetime,
  disposeClosedFileOwners,
  disposeObserversForRemovedWorkspaces,
  documentLifetime,
  fileInvalidationSequences,
  fileOpenRequests,
  fileReadInFlightCounts,
  fileReadRequestIds,
  fileSaveTails,
  fileSurface,
  isScratchTopicDocument,
  regionDiffRequestIds,
  transferFileSaveTail,
  withWorkspaceFileMutation,
  workspaceFileMutationTails
} from './lib/file-document-bookkeeping'
import {
  ownsSessionLaunch,
  pendingAgentLaunchEventId,
  discardPendingAgentLaunch,
  projectRuntimeEvent,
  removeSessionProjection,
  reduceAgentMembershipSnapshot,
  reduceTerminalMembershipSnapshot,
  reduceAgentSessionLaunchAttached,
  reduceDetachedAgentLaunch,
  reduceSessionLaunchAttached,
  reduceSessionLaunchFailed,
  reduceTimelineSnapshot,
  type PendingAgentLaunch,
  type SessionViewMode
} from './lib/session-state'
import {
  TOOL_DOCK_DEFAULT_WIDTH,
  WORKSPACE_TOOL_IDS,
  clampToolDockWidth,
  type WorkspaceTool
} from './lib/surface-tool-dock'
import {
  activeWorkbenchSurface,
  addWorkbenchRegion,
  createWorkbenchTab,
  documentKey,
  fileTabId,
  findWorkbenchRegion,
  focusWorkbenchTabRegion,
  inheritedTopicIdForNewTab,
  initialWorkbenchRegionId,
  tabGroupForTab,
  removeWorkbenchRegion,
  renameWorkbenchTab,
  replaceWorkbenchRegion,
  sessionTabId,
  swapWorkbenchTabRegions,
  tabStillOpen,
  titleWorkbenchSurface,
  topicIdForSession,
  workbenchSurfaces,
  workspaceForSession,
  type AgentWorkbenchSurface,
  type BrowserWorkbenchSurface,
  type LauncherWorkbenchSurface,
  type TerminalWorkbenchSurface,
  type WorkbenchSurface,
  type WorkbenchTab
} from './lib/workbench-tabs'
import { isSessionSurface, surfaceCloseObligations } from './lib/workbench-surface-kinds'
import { resolveSpatialCommit } from './lib/control-spatial-commit'
import {
  applyWorkbenchViewCloseTopology,
  hasAttachedSessionOutsideClosingViews,
  planWorkbenchViewClose,
  reconcileWorkbenchViewClose,
  sameWorkbenchSurfaceOwner,
  workbenchViewCloseAllowsSession,
  workbenchViewCloseAllowsView,
  type WorkbenchViewClosePlan,
  type WorkbenchViewCloseReceipt,
  type WorkbenchViewCloseResource
} from './lib/workbench-view-close'
import { moveTabWithinActiveTopic } from './lib/scratch-topic-layout'
import { isPathWithinSubtree, remapPathWithinSubtree } from './lib/workspace-paths'
import {
  createEmptyFileExplorerViewState,
  revealFileExplorerPath,
  type FileExplorerViewState
} from './lib/file-explorer-selection'
import { moveSessionViewToWorkspace as reduceMoveSessionView } from './lib/move-session-view'
import { promoteRegionToTab as reducePromoteRegionToTab } from './lib/promote-region-to-tab'
import {
  evaluateCreatePrIntent,
  type CreatePrToken,
  type CreatePrIntentState
} from './lib/create-pr-intent'
import {
  evaluatePrEligibility,
  PR_BLOCKER_MESSAGES,
  type PrEligibilityInput
} from './lib/pr-eligibility'
import { decayStaleAgentStatuses as computeDecayedAgentStatuses } from './lib/agent-status-decay'
import {
  createDebouncedPersistentStorage,
  createWriteFencedStorage,
  registerUnloadFlush
} from './lib/persisted-ui-writer'

type ViewMode = SessionViewMode

/**
 * A file Region's diff payload, as loaded from the existing `git.diff` bridge. `loading` gates the
 * spinner; `diff` is the structured single-file diff (HEAD vs worktree) once it lands; `error` is
 * git's own message when the load failed (not a git repo, path escaped the worktree, etc.). The
 * three are not mutually exclusive on purpose: a reload keeps the previous `diff` visible while
 * `loading` is true, and a failed reload keeps the last good `diff` beside the `error`.
 */
export type EditorRegionDiffState = {
  loading: boolean
  diff: GitFileDiff | null
  error: string | null
}
export type MainSurface = 'workbench' | 'board'
export type AsyncCheckState = 'idle' | 'checking' | 'ready' | 'missing' | 'error'
export type ExecutorDetectionState = {
  state: AsyncCheckState
  result?: ExecutorDetection
  detail?: string
  observedAt?: number
}
export type HostCheckState = {
  state: Exclude<AsyncCheckState, 'missing'>
  result?: HostCheckResult
  detail?: string
  observedAt?: number
}

/**
 * One queued steer, carrying the correlation key for its ONE submission attempt. The id is born when the
 * entry is enqueued and dies when the entry drains — it lives ONLY on the entry, never in a persisted
 * field. A failed flush retains the entry (store.ts flushAgentSteerQueue), so the next flush replays it
 * with the SAME `operationId`; Core then recognizes the idempotent replay instead of gating it BUSY. Two
 * distinct prompts are two distinct entries with two distinct ids. Never added to `partialize` — a
 * correlation key for an in-flight attempt is not layout the user meant to keep across a restart.
 *
 * `runId` is the run this steer was typed AT, and it is what makes "stale" a decidable fact rather than
 * a cleanup someone has to remember. The queue is keyed by agentSessionId, which SURVIVES a resume —
 * only the runId changes (api.ts recover swaps `control.run.runId` in place). Without this field a steer
 * queued against a dead run is silently replayed into whatever run next takes that agentSessionId, which
 * is exactly the "silently replaying a stale steer into a fresh session" the composer refuses to offer
 * as a button. See lib/agent-steer-queue-drain.ts for why the check lives at the consumer.
 */
export type AgentSteerQueueEntry = { operationId: string; runId: string; text: string }

type AppState = {
  runtimeOwnershipWarnings: string[]
  environmentWarning: string | null
  /**
   * Agent Session ids whose Region vanished mid-launch even though the Agent itself started healthy
   * (T-005). Ephemeral (never persisted) — a launch race is a within-session fact, not layout the user
   * asked to keep. The list is only ever appended to; it is not the source of truth for what to SHOW —
   * {@link selectDisplacedAgentNotices} re-derives that against live sessions and the current layout, so
   * a stale id is harmless (a re-placed or ended Agent self-heals out of the notice).
   */
  displacedAgentSessionIds: string[]
  restoredWorkbench: PersistedWorkbench | null
  config: AppConfig | null
  providerCatalog: AgentCatalogEntry[]
  sessions: SessionSnapshot[]
  /** Recovery candidates surfaced by Runtime reconciliation for launcher Resume. */
  recoveryCandidates: AgentSessionRecoveryCandidate[]
  // The create page can render this shell directly, but it stays outside the ordinary
  // Session projection until the user claims it.
  warmTerminal: WarmTerminal | null
  unclaimedTerminalSessionIds: string[]
  timelines: Record<string, AgentTimelineSnapshot>
  pendingAgentLaunches: Record<string, PendingAgentLaunch>
  activeWorkspaceId: string | null
  /** 用户拖出来的 Topic 顺序。是一份偏好，不是真相来源——磁盘上没有的不会因它出现。 */
  scratchTopicOrder: string[]
  setScratchTopicOrder(order: readonly string[]): void
  documents: Record<string, FileDocument>
  dirtyDocuments: Record<string, boolean>
  documentGenerations: Record<string, number>
  documentObservationGenerations: Record<string, number>
  documentIssues: Record<string, FileDocumentIssue | undefined>
  savingDocuments: Record<string, boolean>
  // One-shot reveal targets keyed by documentKey. Set when a file is opened with a :line location
  // (e.g. a terminal path link), consumed once by EditorPane on Monaco mount, then cleared. Never
  // persisted — a reveal is a navigation, not document state.
  documentRevealTargets: Record<string, { line: number; column?: number } | undefined>
  lastActiveFileByWorkspace: Record<string, string | undefined>
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
  closingWorkbenchViews: Record<string, WorkbenchViewClosePlan>
  // 键盘请求关整张 Tab 的「意图」——键盘层够不着组件里的确认流（未保存/在跑 Agent 的对话框只活在
  // WorkspaceWorkbench），所以窗口监听只投一个意图，活动 Tab 组件读到它就跑自己既有的 requestTabsClose
  // （与鼠标点 X 同一条路），跑完清掉。同 documentRevealTargets 的 consume-and-clear 套路。
  closeTabRequest: { workspaceId: string; tabGroupId: string; tabId: string; nonce: number } | null
  // 键盘请求关某一格 Region 的「意图」——理由同 closeTabRequest：那格的未保存确认（dirty→确认对话框）
  // 只活在承载它的 WorkbenchRegionNode 里，与鼠标点这一格的 X 是同一个决定出口。键盘层够不着那份状态，
  // 于是窗口监听只投意图，命中的那一格读到就跑自己既有的确认流，跑完清掉。裸调 closeRegion 会静默弃掉
  // 未存改动——鼠标点 X 不会那样。
  closeRegionRequest: { workspaceId: string; tabId: string; regionId: string; nonce: number } | null
  // 「把打字光标（DOM caret）搬进这一格」的一次性意图，按 regionId 定位——同 closeRegionRequest 的
  // consume-and-clear 套路。存在的理由：键盘方向导航搬焦点时只改 activeRegionId（绿环），而看不见的
  // DOM 焦点仍停在上一格的 xterm/Monaco 上，敲的字全进了上一格。承载被点名那格的表面（TerminalView /
  // EditorPane）读到就把 .focus() 搬过来、再清掉。只在键盘那一路投递（见 regionFocusClaimsCaret）：
  // 指针点击那一路原生 mousedown 已经把焦点放对了，再夺一次会打断原生行为。不持久化（是一次导航，
  // 不是布局事实）。browser 那格没有消费者——原生 WebContentsView 的聚焦是另一条路；一条无人认领的
  // 意图停在这里是惰性的（下一次投递会覆盖它）。
  regionCaretFocus: { regionId: string; nonce: number } | null
  workspaceFileRevisions: Record<string, number>
  fileExplorerStates: Record<string, FileExplorerViewState | undefined>
  viewModes: Record<string, ViewMode>
  executorDetections: Record<string, ExecutorDetectionState>
  hostChecks: Record<string, HostCheckState>
  browserAnnotationsByBrowserId: Record<string, BrowserAnnotation[]>
  agentComposerDrafts: Record<string, string>
  agentSteerQueues: Record<string, AgentSteerQueueEntry[]>
  /**
   * 启动对话框里填的两个可选名字，按 launcher 的 regionId 存——与 {@link agentComposerDrafts} 同一
   * 归属、同一生命周期。这里不是"手改名"那一档：手改名按 session id 存在 {@link agentNames}，而这两个
   * 名字在启动成功之前还没有 session 可挂。
   *
   * 为什么不能留在组件的 useState 里：启动的一瞬间本 region 就被换成 pending agent surface，
   * NewTabSurface 随即卸载；启动失败翻回 launcher（reduceSessionLaunchFailed 沿用同一 regionId）
   * 重挂的是一个 useState('') 的新实例，用户填的名字就没了——正是 prompt 当初被搬进 store 要修的
   * 那份用户报告（"报错退回初始页、之前输入没缓存"），名字这两格当时没跟上同一修法。
   */
  launcherNameDrafts: Record<string, LauncherNames>
  /**
   * 用户手改的 Agent 显示名，按 Agent Session id 存。这是《显示名与身份》优先级链最高的那一档——
   * 名字只用于显示，绝不进入 id/寻址：这里的 key 是既有的 session id（寻址身份），value 只是一个
   * 展示字符串，改它不动任何地址。Tab 手改名不在这里——它是 WorkbenchTab.name，与 Tab 同生命周期。
   */
  agentNames: Record<string, string>
  mainSurface: MainSurface
  projectRailOpen: boolean
  /**
   * 折叠起来的 Project 分组，key 由 {@link projectGroupKey} 从 hostId + 父目录派生。
   *
   * 只存**折叠**的那些（默认展开）：分组是从磁盘路径派生的，用户新加一个项目就可能凭空多出一组，
   * 而它该是展开的。存"折叠集合"时新分组天然展开；存"展开集合"则要为每个新分组补一条记录，
   * 漏了就默认折叠——那是把一个派生结构当成了需要注册的实体。
   */
  collapsedProjectGroups: Record<string, true>
  toolsOpen: boolean
  tabMenuOpen: boolean
  workspaceTool: WorkspaceTool
  projectRailWidth: number
  toolDockWidth: number
  /**
   * 编辑器换行开关。**全局一个位**，不是按文件——它是一种查看偏好（像主题），不是文档的属性；
   * 用户打开一个长行文件想换行，通常下一个长行文件也想换行。持久化（进 partialize 白名单），
   * 与 toolsOpen 等表面偏好同一档：重开要还在。默认关（off），与 Monaco 默认一致，长行仍可横向滚。
   */
  editorWordWrap: boolean
  /**
   * 每个文件 Region 当前是「编辑」还是「diff」显示模式，按 regionId 存。
   *
   * 关键决策：diff 不是新的 surface kind，而是既有 file Region 的一个**显示模式**。理由——一个 diff
   * 没有独立于其文件的身份（同一个 workspace+path），而新增 surface kind 要改 Core 里已发货的 Control
   * 协议（AgentMuxRegion 枚举了每一种 kind）外加渲染层约七处 union 落点，为零新增身份付跨包代价。
   * 所以 diff 是这张 file Region 的一个瞬态 UI 位，与 viewModes（session 的终端/对话切换）同构。
   *
   * 不持久化：diff 依赖 git HEAD，是一个瞬时视图；重开该回到编辑态而不是复活一个可能已过期的 diff。
   * 缺省即 'edit'。生命周期随 Region：Region 关掉时由 reconcile/close 出口一并清掉，不留孤儿。
   */
  editorRegionModes: Record<string, 'edit' | 'diff'>
  /**
   * 每个文件 Region 已加载的 diff 负载（含加载中/失败态），按 regionId 存。由 `loadRegionDiff` 从既有
   * `window.agentmux.git.diff`（HEAD blob vs 工作区）取——不新开任何 git shell-out。与 editorRegionModes
   * 同生命周期、同不持久化。
   */
  editorRegionDiffs: Record<string, EditorRegionDiffState | undefined>
  loading: boolean
  error: string | null
  /** Last transient error remains available after dismissal/navigation for a deliberate reopen. */
  lastError: string | null
  errorDismissed: boolean
  initialize(): Promise<() => void>
  selectWorkspace(id: string): Promise<void>
  activateWorkspaceSelection(result: WorkspaceSelectionResult): void
  runFanOut(input: RunFanOutInput): Promise<RunFanOutResult>
  keepOneOfFanOut(input: KeepOneOfFanOutInput): Promise<KeepOneOfFanOutOutcome | null>
  /**
   * 撤掉一条 worktree 的登记。
   *
   * 为什么这条动作必须落在 store 而不是留在面板里：`removed` 带回来的 `config` 是**权威的新配置**，
   * 而 `activeWorkspaceId` 是指进它的一个引用。面板自己 await 完就把 config 丢掉时，store 仍持有那条
   * 已经不存在的记录——`App.tsx` 照它找活动 Workspace 会得到 undefined，界面渲染成空白，屏幕上没有
   * 任何一句话解释刚才发生了什么。批量收尾（`keepOneOfFanOut`）一直是走 store 的，单条却绕过了它，
   * 那道不对称就是这个缺陷本身。
   */
  removeWorktree(input: RemoveWorktreeInput): Promise<RemoveWorktreeOutcome>
  createPullRequest(input: {
    workspaceId: string
    title: string
    body: string
    draft?: boolean
    token: CreatePrToken
    current: CreatePrIntentState
    /** Optional: when present the ladder runs first so blockers surface as actionable copy. */
    eligibility?: PrEligibilityInput
  }): Promise<CreatePullRequestResult>
  focusTabGroup(workspaceId: string, tabGroupId: string): void
  activateTab(workspaceId: string, tabGroupId: string, tabId: string): void
  executeControl(
    request: AgentMuxControlRequest,
    signal?: AbortSignal
  ): Promise<AgentMuxControlResult>
  selectSession(id: string, tabGroupId?: string): void
  openLauncher(tabGroupId?: string): void
  closeTab(
    workspaceId: string,
    tabGroupId: string,
    tabId: string,
    options?: { keepAgentSessions?: boolean }
  ): Promise<boolean>
  moveTab(
    workspaceId: string,
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    targetIndex: number
  ): void
  moveTabToNewGroup(
    workspaceId: string,
    tabId: string,
    sourcePaneId: string,
    targetPaneId: string,
    direction: SplitDirection
  ): void
  // `cause` 决定这次落焦除了搬绿环要不要把 DOM caret 也搬进去（键盘导航要，指针点击不要——原生 mousedown
  // 已把焦点放对）。判定是纯的（regionFocusClaimsCaret），这里只按它的结果投/不投 caret 意图。默认 'pointer'：
  // 调用方不显式说明时按最保守的一路走，不夺焦。
  focusRegion(workspaceId: string, tabId: string, regionId: string, cause?: RegionFocusCause): void
  // 被点名那格的表面消费完 caret 意图后调它清除（只清自己那条 nonce，避免抹掉更晚一次导航投的新意图）。
  clearRegionCaretFocus(nonce: number): void
  // Explicitly relocate one Session projection (the Region named by regionId) into another
  // workspace's View. This moves DISPLAY identity only — the Agent's cwd is Core's
  // session.workspacePath and is never touched. Navigation reuses focusRegion; a closing source
  // View is refused via reportError rather than half-moved.
  moveSessionViewToWorkspace(regionId: string, targetWorkspaceId: string): void
  splitRegion(
    workspaceId: string,
    tabId: string,
    regionId: string,
    direction: SplitDirection
  ): void
  /**
   * 重排一个 Tab 的格子。与控制协议的 `arrange` 是同一个引擎（arrangeWorkbenchControlTab），
   * 「要补几个格」由它自己从 preset 推导，这里不重算——见那个函数的注释。
   *
   * 形参是引擎自己那个三档 union（`AgentMuxArrangeMode`），不是裸的 preset。此前它只收 preset，
   * 于是引擎支持的另两档（`balance` 均分、`active-first` 把当前格挪到第一位）**GUI 根本表达不出来**，
   * 只有命令行能触达（#486）。那不是「菜单忘了加一项」——是这个签名把它们挡在了外面：想加菜单项
   * 得先改签名，而不改签名就只能在渲染层另找一条路去调引擎，那就是第二个调用点、第二份推导。
   * 收成引擎自己的 union 之后，加一档新的重排方式在这条路上不需要改任何签名。
   */
  arrangeTabRegions(workspaceId: string, tabId: string, mode: AgentMuxArrangeMode): void
  // 把一个 Tab 里两格的位置互换（#471）：右键某一格选「和另一格换位」。纯布局代数
  // （swapWorkbenchRegions），只换 id 在骨架上的位置，内容与所有 ratio 一字不动。
  swapRegions(workspaceId: string, tabId: string, regionIdA: string, regionIdB: string): void
  // 把一个 Tab 里某一格单独变成它自己的 Tab（#487，「单独变成一个 tab」）：右键某一格选「Move to New
  // Tab」。纯布局代数（promoteRegionToTab）——把这一格从源 Tab 的分屏树里摘出来，作为一张新 Tab 的
  // 唯一一格，落在源 Tab 紧邻其后的位置并激活。只剩一格的 Tab 促升无意义（它已经就是一张 Tab），是 no-op。
  promoteRegionToTab(workspaceId: string, tabId: string, regionId: string): void
  closeRegion(workspaceId: string, tabId: string, regionId: string): Promise<void>
  // 键盘关 Tab 的入口：只投意图，真正的关闭（含确认）由活动 Tab 组件消费。见 closeTabRequest 状态注释。
  requestCloseTab(workspaceId: string, tabGroupId: string, tabId: string): void
  clearCloseTabRequest(nonce: number): void
  // 键盘关某一格的入口：只投意图，含未保存确认的真正关闭由承载该格的组件消费。见 closeRegionRequest 注释。
  requestCloseRegion(workspaceId: string, tabId: string, regionId: string): void
  clearCloseRegionRequest(nonce: number): void
  updateRegionSplitRatio(workspaceId: string, tabId: string, nodePath: string, ratio: number): void
  updateSplitRatio(workspaceId: string, nodePath: string, ratio: number): void
  setViewMode(sessionId: string, mode: ViewMode): void
  /** 翻转编辑器换行的全局位。 */
  toggleEditorWordWrap(): void
  /**
   * 把一个文件 Region 切到 diff 模式并（若还没有）加载它的 diff；再次调用（mode 'edit'）切回编辑。
   * diff 两侧走既有 git.diff 桥，不新开 shell-out。regionId 承载模式，workspaceId+path 定位文件。
   */
  setEditorRegionMode(regionId: string, workspaceId: string, path: string, mode: 'edit' | 'diff'): Promise<void>
  /** 重新拉取一个已在 diff 模式的 Region 的 diff（用户点「刷新」，或改动落盘后想看最新差异）。 */
  reloadRegionDiff(regionId: string, workspaceId: string, path: string): Promise<void>
  /**
   * 从 Changes 面板点一个文件：打开它（走既有 openFile），并把它的 canonical Region 切到 diff 模式。
   * 是「minimal end-to-end」那条路——点变更 → 看该文件的 diff。regionId 由 openFile 的落点唯一决定
   * （`initialWorkbenchRegionId(fileTabId(...))`），所以这里在 openFile 之后据同一规则算出它、再 setEditorRegionMode，
   * 而不是让调用方各自推导 regionId（推错就切错 Region 的模式）。
   */
  openFileDiff(path: string): Promise<void>
  setMainSurface(surface: MainSurface): void
  toggleProjectRail(): void
  toggleProjectGroup(key: string): void
  setTabMenuOpen(open: boolean): void
  setWorkspaceTool(tool: WorkspaceTool): void
  toggleTools(): void
  setProjectRailWidth(width: number): void
  setToolDockWidth(width: number): void
  updateFileExplorerState(
    workspaceId: string,
    update: (current: FileExplorerViewState) => FileExplorerViewState
  ): void
  detectExecutors(hostId: string): Promise<void>
  checkHost(host: HostConfig): Promise<void>
  /**
   * 打开一个文件面。
   *
   * `workspaceId` 缺省时按活动 Workspace 解析——绝大多数调用方是用户当场点的，那正是他想要的。
   * 但**异步**调用方（先建文件再打开、先读 diff 再切模式）必须显式传自己开头解析出来的那一个：
   * 不传就等于在同一条路上解析两次，中间用户切了侧栏就漂移，而症状不是报错而是静默开错文件。
   */
  openFile(
    path: string,
    tabGroupId?: string,
    location?: { line: number; column?: number },
    workspaceId?: string
  ): Promise<void>
  /**
   * 给一个已在板上、但还没有文档的文件面装上它的文档。
   *
   * 这条路只有一个来源：从持久化恢复出来的文件面。它只带 `{regionId,kind,workspaceId,path}`，
   * 没有任何内容，而 EditorPane 一旦 `documents[key]` 缺失就渲染「不可用」——于是 tab 在、
   * 点开报不可用，看起来像文件坏了。由 EditorPane 自己调用而不是启动时扫一遍，是为了覆盖
   * 非活动 Workspace 的文件面（启动扫描只能对着活动 Workspace 解析路径，那些 tab 会一直坏到
   * 下次重启）。注意隐藏 tab 是刻意保持挂载的，所以冷启动会读该 group 的每个文件面而不只是
   * 活动那个——代价是每个打开着的文件面一次 read，换来每个恢复出的 tab 首次点击就能用。
   * 与 `openFile` 分开是因为后者还负责「打开」——它会激活 Tab、可能搬动它、并写 reveal
   * target，而这里 Tab 已经在用户留下的位置上了。
   */
  attachPersistedFileDocument(workspaceId: string, path: string): Promise<void>
  clearDocumentRevealTarget(key: string): void
  createScratchTopic(): Promise<ScratchTopicSnapshot>
  openScratchTopic(topicId: string): Promise<void>
  renameScratchTopic(topicId: string, title: string): Promise<ScratchTopicSnapshot>
  /**
   * 给一个 Agent 设用户手改名（传空清除，交还派生链）。只写 `agentNames[sessionId]`，不碰 session id、
   * run、寻址或 Core——名字是纯展示投影，永不进 Core Session 事实。
   */
  renameAgent(sessionId: string, name: string | null): void
  /**
   * 给一张 Tab 设用户手改名（传空清除，交还默认策略）。只改 `WorkbenchTab.name` 一个字段，id 与三级
   * 地址原样不动。用户手改后，"单 Agent 对齐 / 多 Region 家族名"两条自动策略对这张 Tab 永久停手。
   */
  renameTab(tabId: string, name: string | null): void
  /**
   * 在当前 Workspace 里建文件或目录，返回**它实际用的**那个 workspaceId。
   *
   * 返回值不是给日志的：调用方建完常要接着打开它，而 openFile 会自己再解析一次活动 Workspace。
   * 两次解析之间只要有一个 await（本地建文件也有 IPC，远端可达 15s），用户点一下侧栏就漂移，
   * 症状是**开错文件**而不是报错——名字撞上另一个项目里的同名文件时界面上一切正常。
   * 所以解析必须只发生一次，然后把结果交给下游，而不是让下游自己再问一遍。
   */
  createPath(input: CreateWorkspacePathInput): Promise<string>
  /**
   * 在这个 launcher 的 Workspace 里建一条按日期命名的笔记并打开它，返回真正建出来的文件名。
   *
   * 命名判定在 `lib/note-names.ts`：写入面是 `O_CREAT | O_EXCL`（撞名失败而非截断），所以名字必须
   * 是一个候选序列、由文件系统裁决，不能先列目录再挑（那是 check-then-act，同一 tick 两条笔记会
   * 挑中同一个名字）。
   *
   * 签名与 `launchAgent` / `launchTerminal` / `promoteWarmTerminal` / `createBrowser` 同形，且
   * 「落在哪个 Workspace」走与它们**完全同一条**判定（`resolveLauncherWorkspaceId`）。此前这里只读
   * `activeWorkspaceId`，于是 launcher 挂在绑定 A 的 Tab 上而活动 Workspace 是 B 时（切侧栏即可），
   * 界面写着「Start in A」、其余四个动作都落 A，而笔记建到 B——零报错，看起来一切正常。
   * `tabGroupId` 这里不消费落点（笔记由 openFile 自己挂 Tab），但仍然收下：它是这一族动作的共同
   * 形状，缺了它调用方就得为「笔记」记一条特例。
   */
  createNote(
    tabGroupId?: string,
    launcher?: { tabId: string; regionId: string }
  ): Promise<string>
  renamePath(path: string, nextPath: string): Promise<void>
  deletePath(path: string): Promise<void>
  updateDocument(tabId: string, content: string, regionId?: string): void
  saveDocument(tabId: string, regionId?: string): Promise<void>
  overwriteDocument(tabId: string, regionId?: string): Promise<void>
  reloadDocument(tabId: string, regionId?: string): Promise<void>
  refreshDocument(workspaceId: string, path: string): Promise<void>
  launchBoardAgent(
    workspaceId: string,
    executorId: string,
    prompt: string,
    topicId?: string
  ): Promise<void>
  launchAgent(
    executorId: string,
    prompt: string,
    tabGroupId: string,
    launcher?: { tabId: string; regionId: string },
    launchOptions?: LaunchOptionSelection,
    /**
     * 启动对话框里填的名字。两个都留空是正常情况——此时不写任何名字，显示名交还派生链
     * （见 lib/display-name.ts 的优先级链）。名字在这里写而不由调用方写，是因为 sessionId
     * 与 tabId 都在本函数内部生成，从不出参。
     */
    names?: { agentName?: string | undefined; tabName?: string | undefined }
  ): Promise<void>
  launchTerminal(
    tabGroupId: string,
    launcher?: { tabId: string; regionId: string },
    workspacePath?: string
  ): Promise<void>
  // Idempotent for one host + cwd. Failures stay local to the create page.
  //
  // `ownerLauncherId` 是**哪个 launcher 挂载点在请求**。槽只有一个而 launcher 每个挂载点一个（分屏、
  // 每个 group 的空占位），归属必须由槽记着、不能由各个 launcher 各自推断，否则它们会同时挂
  // TerminalView 到同一个 PTY 上并对着它轮流 resize。同 key 再请求会把归属**转移**过来（不重开 PTY）。
  prewarmTerminal(workspaceId: string, ownerLauncherId: string): void
  // Claims the exact warm shell or uses the ordinary Terminal launch path if none exists.
  promoteWarmTerminal(
    tabGroupId: string,
    launcher?: { tabId: string; regionId: string }
  ): Promise<void>
  createBrowser(
    tabGroupId: string,
    launcher?: { tabId: string; regionId: string },
    url?: string
  ): Promise<void>
  openHttpLink(origin: OpenHttpLinkOrigin, url: string, destination: OpenDestination): Promise<void>
  applyBrowserEvent(event: BrowserEvent): void
  addBrowserAnnotation(annotation: BrowserAnnotation): void
  deleteBrowserAnnotation(browserId: string, annotationId: string): void
  clearBrowserAnnotations(browserId: string): void
  setAgentComposerDraft(sessionId: string, text: string): void
  /**
   * 写启动对话框的一格名字。`field` 只有 'agentName' | 'tabName' 两种，两格共用一条 action：
   * 一格一个 setter 会让"启动成功要清掉这个 region 的名字草稿"变成两处要记得改的地方。
   */
  setLauncherNameDraft(regionId: string, field: LauncherNameField, value: string): void
  appendAgentComposerDraft(sessionId: string, text: string): void
  clearAgentComposerDraftIfUnchanged(sessionId: string, expectedText: string): void
  /** Queue a steer. `false` means it was refused (empty, not an Agent, or over the size budget) and the caller must keep the draft. */
  enqueueAgentSteer(sessionId: string, text: string): boolean
  flushAgentSteerQueue(sessionId: string): Promise<void>
  send(sessionId: string, text: string): Promise<void>
  respondInteraction(sessionId: string, response: AgentMuxInteractionResponse): Promise<void>
  setPosture(sessionId: string, modeId: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  refreshSession(sessionId: string): Promise<void>
  recoverSession(sessionId: string): Promise<void>
  stopSession(sessionId: string): Promise<void>
  canonicalizeAgentLaunch(result: AgentLaunchResult): Promise<AgentLaunchResult | null>
  resyncTimeline(sessionId: string): Promise<void>
  applyEvent(event: RuntimeEvent): void
  /**
   * 把所有已陈旧的 `working` Agent 降为中性态（见 lib/agent-status-decay）。传 `now` 而非内部读
   * Date.now()，判定才可断言、测试才不 flake。什么都不该降时不写入，避免无谓的重渲染。
   */
  decayStaleAgentStatuses(now: number): void
  setConfig(config: AppConfig): void
  reportError(error: unknown): void
  dismissError(): void
  reopenError(): void
}

function emptyRuntimeSnapshot(): RuntimeSnapshot {
  return {
    sessions: [],
    timelines: {},
    recoveryCandidates: []
  }
}

function startupWorkflowWarning(step: string, error: unknown, recovery: string): string {
  return `${step} did not complete: ${presentError(error)}. ${recovery}`
}

function controlFailure(
  code: AgentMuxControlErrorCode,
  detail: string,
  extra?: object
): Error & { code: AgentMuxControlErrorCode } {
  return Object.assign(new Error(detail), { code }, extra)
}

const CONTROL_ERROR_CODES: ReadonlySet<string> = new Set(AGENTMUX_CONTROL_ERROR_CODES)

function isControlErrorCode(value: unknown): value is AgentMuxControlErrorCode {
  return typeof value === 'string' && CONTROL_ERROR_CODES.has(value)
}

function controlCancellation(signal?: AbortSignal): Error & { code: AgentMuxControlErrorCode } {
  if (!(signal?.reason instanceof Error)) {
    return controlFailure('CONTROL_CANCELLED', 'Desktop Control request was cancelled.')
  }
  const source = signal.reason as Error & { code?: unknown }
  return Object.assign(source, { code: isControlErrorCode(source.code) ? source.code : 'CONTROL_CANCELLED' as const })
}

function normalizeHttpLinkUrl(rawUrl: string): string {
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Link URL protocol is not allowed: ${url.protocol}`)
  }
  return url.toString()
}

async function settleWorkbenchViewCloseResources<Resource extends WorkbenchViewCloseResource>(
  resources: readonly Resource[],
  close: (resource: Resource) => Promise<void>
): Promise<WorkbenchViewCloseReceipt[]> {
  const results = await Promise.allSettled(resources.map(close))
  return results.map((result, index) => result.status === 'fulfilled'
    ? { key: resources[index]!.key, status: 'fulfilled' }
    : { key: resources[index]!.key, status: 'rejected', reason: result.reason })
}

function workbenchViewCloseFailure(receipts: readonly WorkbenchViewCloseReceipt[]): Error {
  const reasons = receipts.flatMap((receipt) => receipt.status === 'rejected'
    ? [receipt.reason instanceof Error ? receipt.reason : new Error(String(receipt.reason))]
    : [])
  return reasons.length === 1
    ? reasons[0]!
    : new AggregateError(reasons, 'Multiple View resources could not be closed.')
}

function sessionOwnsControl(session: SessionSnapshot, control: SessionControl): boolean {
  return session.control.kind === control.kind &&
    session.control.hostId === control.hostId &&
    session.control.run.runId === control.run.runId
}

function hasAttachedSessionView(tabs: Readonly<Record<string, WorkbenchTab>>, sessionId: string): boolean {
  return Object.values(tabs).some((tab) => workbenchSurfaces(tab).some((surface) => (
    isSessionSurface(surface) &&
    surface.phase === 'attached' &&
    surface.sessionId === sessionId
  )))
}

function projectRecoveredSession(
  state: AppState,
  previousSessionId: string,
  session: SessionSnapshot
): Pick<AppState, 'sessions' | 'tabs'> {
  const tabs = { ...state.tabs }
  if (session.id !== previousSessionId) {
    for (const tab of Object.values(state.tabs)) {
      let nextTab = tab
      for (const surface of workbenchSurfaces(tab)) {
        if (
          isSessionSurface(surface) &&
          surface.sessionId === previousSessionId
        ) {
          nextTab = replaceWorkbenchRegion(nextTab, surface.regionId, {
            ...surface,
            sessionId: session.id
          })
        }
      }
      if (nextTab !== tab) tabs[tab.id] = nextTab
    }
  }
  return {
    tabs,
    sessions: [
      ...state.sessions.filter((item) => item.id !== previousSessionId && item.id !== session.id),
      session
    ]
  }
}

function continuityFailureDetail(
  result: Extract<SessionRecoveryResult, { kind: 'unavailable' | 'conflict' }>
): string {
  if (result.kind === 'conflict') {
    // 按 Core 给的**类别**分，不按 currentRun 在不在场猜。这两件事本来就不是同一个判据：
    // run 已被换掉才有 currentRun，而「另一个操作占着」也可能带着它。此前这里按 currentRun 猜，
    // 于是一条 session-run-changed 只要 currentRun 缺失就被说成「另一个操作占着」——
    // 又一处替 Core 猜类别的地方。
    switch (result.reason) {
      case 'session-run-changed':
        return result.currentRun
          ? `This Agent Session now belongs to Run ${result.currentRun.runId}; the stale Run was not resumed.`
          : 'This Agent Session already moved to a newer Run; the stale Run was not resumed.'
      case 'lifecycle-busy':
        return 'Another lifecycle operation owns this Agent Session; no new Run was started.'
    }
  }
  switch (result.reason) {
    case 'unknown-session':
      return 'Core has no current or retired binding for this Agent Session.'
    case 'native-handle-unavailable':
      return 'This Agent Session has no verified Provider handle for native resume.'
    case 'provider-resume-unsupported':
      return 'This Provider does not support native session resume.'
    case 'provider-unavailable':
      return 'The required Provider executable or resume capability is unavailable on this Host.'
  }
}

/**
 * 一次恢复失败投在 Session 状态上的**全部** continuity 字段，一处产出。
 *
 * 为什么必须共用而不是两个出口各写一遍：这些字段有两个写入点（启动时的候选投影
 * `recoveryCandidateSession`，和用户点「恢复」走的 `recoverSession`），而它们要写的是同一组字段。
 * 各写一遍的代价实测过——`continuityConflict` 曾只加在前一处，后一处照旧折叠，于是**用户主动点恢复
 * 的那条路**仍旧把 session-run-changed 说成「等一下」。两处该联动的写入分居两地必然 drift，
 * 所以收成一个函数：一处守住，两条路都守住。
 */
function continuityStatusFields(
  recovery: Extract<SessionRecoveryResult, { kind: 'unavailable' | 'conflict' }>
): Pick<
  SessionSnapshot['status'],
  'continuity' | 'continuityReason' | 'continuityConflict' | 'detail'
> {
  return {
    continuity: recovery.kind,
    // Core 给的原因原样带过来，不折进「失败了」这一个位。三类各要求用户做不同的事，只有 Core 知道是哪一类。
    ...(recovery.kind === 'unavailable' ? { continuityReason: recovery.reason } : {}),
    // conflict 自己还有两类，而它们要求的动作**相反**（重读 vs 等）。丢掉这一项，
    // 就等于对其中一半的用户说「等一个已经被换掉、永远不会回来的 Run」。
    ...(recovery.kind === 'conflict' ? { continuityConflict: recovery.reason } : {}),
    detail: continuityFailureDetail(recovery)
  }
}

/**
 * Project a Core recovery failure into the Session snapshot the surface renders.
 *
 * Exported for assertion: the reason Core gave is the whole payload of this projection, and a test
 * that seeds `continuityReason` into a fixture proves nothing about whether this function ever wrote
 * it. Asserting on the RETURNED snapshot is what makes dropping the field turn red.
 */
export function recoveryCandidateSession(
  candidate: AgentSessionRecoveryCandidate,
  recovery: Extract<SessionRecoveryResult, { kind: 'unavailable' | 'conflict' }>
): SessionSnapshot {
  return {
    id: candidate.agentSessionId,
    kind: 'agent',
    providerId: candidate.providerId,
    executorId: candidate.executorId,
    capabilities: candidate.capabilities,
    ...(candidate.terminalCapability
      ? { terminalCapability: structuredClone(candidate.terminalCapability) }
      : {}),
    hostId: candidate.hostId,
    workspacePath: candidate.workspacePath,
    label: candidate.label,
    createdAt: candidate.createdAt,
    updatedAt: Math.max(candidate.updatedAt, Date.now()),
    processState: 'interrupted',
    status: {
      state: 'error',
      source: 'run-process',
      observedAt: Date.now(),
      // 两条路共用同一处产出，见 continuityStatusFields 的说明：这些字段各写一遍必然 drift。
      ...continuityStatusFields(recovery)
    },
    latestOutputBytes: 0,
    control: {
      kind: 'agent',
      hostId: candidate.hostId,
      agentSessionId: candidate.agentSessionId,
      run: { ...candidate.run }
    }
  }
}

export function executorDetectionKey(hostId: string, executorId: string): string {
  return `${hostId}\0${executorId}`
}

/**
 * store 的五态 {@link AsyncCheckState} → Control 线上的四态可用性——**唯一一处映射。**
 *
 * 两套词汇本就该只在这里相遇：store 那套（idle/checking/ready/missing/error）是 UI 检查生命周期，
 * Control 那套（unknown/check-failed/missing/available）是发现结论。逐个写死、不留 default：
 *   - `idle`（还没开始查）与 `checking`（正在查）→ `unknown`：都是「此刻没有结论」。
 *   - `ready` → `available`，`missing` → `missing`，`error`（catch 分支）→ `check-failed`。
 * 若在每个 list.agents 调用点各内联一次这个 switch，就是第二处会漂移的映射（本仓库被 per-call-site
 * 副本咬过多次）；收成一处、由 tsc 的穷尽性钉住（漏一个 AsyncCheckState 成员就编译不过）。
 */
export function executorAvailabilityFromCheckState(state: AsyncCheckState | undefined): AgentMuxExecutorAvailability {
  switch (state) {
    case 'ready': return 'available'
    case 'missing': return 'missing'
    case 'error': return 'check-failed'
    case 'checking':
    case 'idle':
    case undefined: return 'unknown'
  }
}

const detectionRequestIds = new Map<string, number>()
const hostCheckRequestIds = new Map<string, number>()
const timelineResyncs = new Map<string, { requested: boolean; promise: Promise<void> }>()

/**
 * Load a file Region's diff from the EXISTING git bridge — HEAD blob (old) vs worktree file (new).
 *
 * There is no new shell-out here: `window.agentmux.git.diff` is the same Desktop-main capability the
 * Changes panel already reaches, and it returns a structured {@link GitFileDiff} (both sides read as
 * blobs, never parsed from unified-diff text). This wrapper only owns the loading/error presentation
 * and the stale-result guard. The two sides' directionality is fixed downstream in `diffEditorSides`.
 */
async function loadRegionDiff(regionId: string, workspaceId: string, path: string): Promise<void> {
  const requestId = (regionDiffRequestIds.get(regionId) ?? 0) + 1
  regionDiffRequestIds.set(regionId, requestId)
  useAppStore.setState((state) => ({
    editorRegionDiffs: {
      ...state.editorRegionDiffs,
      // Keep the previous diff visible during a reload; only flip loading and clear the last error.
      [regionId]: { loading: true, diff: state.editorRegionDiffs[regionId]?.diff ?? null, error: null }
    }
  }))
  const lookup = gitBridge()
  if (!lookup.available) {
    if (regionDiffRequestIds.get(regionId) !== requestId) return
    useAppStore.setState((state) => ({
      editorRegionDiffs: {
        ...state.editorRegionDiffs,
        [regionId]: { loading: false, diff: null, error: lookup.reason }
      }
    }))
    return
  }
  try {
    const diff = await lookup.bridge.diff(workspaceId, path)
    if (regionDiffRequestIds.get(regionId) !== requestId) return
    useAppStore.setState((state) => ({
      editorRegionDiffs: { ...state.editorRegionDiffs, [regionId]: { loading: false, diff, error: null } }
    }))
  } catch (error) {
    if (regionDiffRequestIds.get(regionId) !== requestId) return
    useAppStore.setState((state) => ({
      editorRegionDiffs: {
        ...state.editorRegionDiffs,
        // A failed reload keeps the last good diff beside the error rather than blanking the pane.
        [regionId]: { loading: false, diff: state.editorRegionDiffs[regionId]?.diff ?? null, error: presentError(error) }
      }
    }))
  }
}

/**
 * Drop editor-region mode/diff state for Regions no longer on the board. The two maps are keyed by
 * regionId, and a file Region's id is deterministic (`region:file:ws:path`), so a closed-then-reopened
 * file would otherwise resurrect its stale `diff` mode and its old diff payload — the opposite of the
 * decision that diff is transient and reopening returns to edit. Called after every close/reconcile that
 * changes the live tab set; a no-op when nothing was pruned so it never forces a spurious render.
 */
function pruneEditorRegionState(tabs: Readonly<Record<string, WorkbenchTab>>): void {
  const live = new Set(
    Object.values(tabs).flatMap((tab) => workbenchSurfaces(tab).map((surface) => surface.regionId))
  )
  useAppStore.setState((state) => {
    const modes = Object.fromEntries(
      Object.entries(state.editorRegionModes).filter(([regionId]) => live.has(regionId))
    )
    const diffs = Object.fromEntries(
      Object.entries(state.editorRegionDiffs).filter(([regionId]) => live.has(regionId))
    )
    const modesChanged = Object.keys(modes).length !== Object.keys(state.editorRegionModes).length
    const diffsChanged = Object.keys(diffs).length !== Object.keys(state.editorRegionDiffs).length
    if (!modesChanged && !diffsChanged) return state
    return { editorRegionModes: modes, editorRegionDiffs: diffs }
  })
}

async function refreshFileDocument(
  workspaceId: string,
  path: string,
  expectedLifetime = documentLifetime(documentKey(workspaceId, path))
): Promise<void> {
  const key = documentKey(workspaceId, path)
  if (documentLifetime(key) !== expectedLifetime || !useAppStore.getState().documents[key]) return
  const requestId = (fileReadRequestIds.get(key) ?? 0) + 1
  fileReadRequestIds.set(key, requestId)
  fileReadInFlightCounts.set(key, (fileReadInFlightCounts.get(key) ?? 0) + 1)
  try {
    let result
    try {
      result = await api.files.read(workspaceId, path)
    } catch (error) {
      result = {
        status: 'error' as const,
        code: typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'WORKSPACE_FILE_READ_FAILED',
        message: presentError(error)
      }
    }
    if (documentLifetime(key) !== expectedLifetime || fileReadRequestIds.get(key) !== requestId) return
    useAppStore.setState((state) => reduceDocumentRead(state, workspaceId, path, result))
  } finally {
    const remaining = (fileReadInFlightCounts.get(key) ?? 1) - 1
    if (remaining === 0) fileReadInFlightCounts.delete(key)
    else fileReadInFlightCounts.set(key, remaining)
  }
}

/**
 * Load the document for a file Region that has one persisted but not loaded.
 *
 * A file surface is only `{regionId,kind,workspaceId,path}` — the restore path rebuilds the layout,
 * but nothing in a surface holds content, and `EditorPane` renders its unavailable state for any
 * surface whose `documents[key]` is missing. Every other way a file surface appears (Explorer click,
 * terminal link, chat link) loads the document as part of opening it; restore was the one entrance
 * that produced a surface with no document behind it, so the user saw a Tab that is present and
 * reports "unavailable" — which reads as a broken file rather than an unloaded one.
 *
 * This is called by the pane that would otherwise render that unavailable state, rather than by a
 * startup sweep, so that a file Region in a Workspace the user has not switched back to yet is
 * covered too: a sweep can only resolve paths against the active Workspace, and would leave those
 * Tabs broken until the next restart with no later trigger (`selectWorkspace` does not load).
 *
 * Do not read this as "only the visible Tab reads its file". Hidden Tabs stay mounted on purpose —
 * that is what keeps a terminal instance alive across Tab switches (see hidden-tab-terminal-retention),
 * and `ownerPresent: false` also keeps a document-less file surface out of the memory-budget parking
 * set, so `released` is false and this does fire. So a cold start reads every persisted file Region in
 * the Workspace's Tab group, not just the active one. That is affordable — one `files.read` per open
 * file Region, the same read a click would do — and it is what makes every restored Tab work on first
 * click instead of only the one that happened to be active. If that cost ever stops being affordable,
 * the fix is to gate the read on real visibility, NOT to move it back into a startup sweep.
 *
 * It reads through the same `api.files` seam as a click, but must not reuse `openFile`: that one
 * also *opens* — it targets the active group, can move the Tab, and writes reveal targets. Here the
 * Tab already exists exactly where the user left it, so only the document is missing.
 */
async function loadPersistedFileDocument(workspaceId: string, path: string): Promise<void> {
  const key = documentKey(workspaceId, path)
  const state = useAppStore.getState()
  // Three ways this is already answered: the document is here, a read is in flight, or a previous read
  // recorded why it cannot be loaded. The third is the one that has to live here rather than only in
  // the calling pane — otherwise every caller would need to remember the stop condition, and a known
  // unreadable path would be re-read once per caller.
  if (state.documents[key] || fileOpenRequests.has(key) || state.documentIssues[key]) return
  const openedLifetime = advanceDocumentLifetime(key)
  const request = Promise.resolve().then(async () => {
    try {
      // Capture the invalidation counter BEFORE reading, the same way `openFile` does. A watcher can
      // report the file changed while this read is in flight, and that report lands nowhere:
      // `refreshFileDocument` early-returns while `documents[key]` is still absent. Without the
      // comparison below, the pane would hold content one revision stale with no `changed` flag until
      // the next disk change — the first save would still be caught by the revision check, but the
      // user would be told "changed on disk" about a change that happened before they ever saw the file.
      const invalidationSequence = fileInvalidationSequences.get(key) ?? 0
      await api.files.observe(workspaceId, path)
      const result = await api.files.read(workspaceId, path)
      if (result.status !== 'read') {
        await api.files.unobserve(workspaceId, path)
        // Say which failure it was. A file deleted while the app was closed is the same fact as one
        // deleted while open, so it lands in the same existing issue kind — whose failure state already
        // offers Reveal (falling back to the nearest surviving ancestor). Recording it also tells the
        // pane to stop asking: without an issue there is nothing to distinguish "not loaded yet" from
        // "cannot be loaded", and the pane would re-read a known-bad path on every dependency change.
        useAppStore.setState((state) => reduceDocumentLoadFailed(state, workspaceId, path,
          result.status === 'deleted'
            ? { kind: 'deleted' }
            : result.status === 'directory'
              // The persisted path is now a directory. Not a read error — the same "this is not a
              // document" fact the click path reports, without hijacking the Files dock the way a
              // deliberate click does: nothing the user just did warrants moving their tool panel.
              ? { kind: 'read-error', code: 'WORKSPACE_FILE_IS_DIRECTORY', message: `Not a file: ${path}` }
              : { kind: 'read-error', code: result.code, message: result.message }))
        return false
      }
      // A Workspace removed from config between restarts, or a second load that won this race, must
      // not install a document for a surface that is no longer there.
      if (documentLifetime(key) !== openedLifetime || useAppStore.getState().documents[key]) {
        await api.files.unobserve(workspaceId, path)
        return false
      }
      useAppStore.setState((state) => reduceDocumentAttached(state, workspaceId, path, result.document))
      // Only now can a refresh land: `refreshFileDocument` needs the document to already be here.
      // Dropping the open request first is what lets it run — it takes the same in-flight slot.
      if (fileOpenRequests.get(key) === request) fileOpenRequests.delete(key)
      if ((fileInvalidationSequences.get(key) ?? 0) !== invalidationSequence) {
        await refreshFileDocument(workspaceId, path, openedLifetime)
      }
      return true
    } catch (error) {
      // An IPC fault, not a read verdict. Record it as a read error for the same reason the verdict
      // paths do: it is the pane's only stop condition, and without one this surface sits on the
      // generic unavailable state with no way to tell the user what went wrong. Retry is the Retry
      // button on that state, not a silent loop.
      await api.files.unobserve(workspaceId, path).catch(() => undefined)
      useAppStore.setState((state) => reduceDocumentLoadFailed(state, workspaceId, path, {
        kind: 'read-error',
        code: 'WORKSPACE_FILE_READ_FAILED',
        message: error instanceof Error ? error.message : String(error)
      }))
      useAppStore.getState().reportError(error)
      return false
    } finally {
      if (fileOpenRequests.get(key) === request) fileOpenRequests.delete(key)
    }
  })
  fileOpenRequests.set(key, request)
  await request
}

async function enqueueFileSave(
  tabId: string,
  overwrite: boolean,
  regionId?: string
): Promise<void> {
  const initialTab = useAppStore.getState().tabs[tabId]
  const initialSurface = fileSurface(initialTab, regionId)
  if (!initialSurface) return
  const key = documentKey(initialSurface.workspaceId, initialSurface.path)
  const previous = fileSaveTails.get(key) ?? Promise.resolve()
  const mutation = workspaceFileMutationTails.get(initialSurface.workspaceId) ?? Promise.resolve()
  const operation = Promise.all([previous.catch(() => {}), mutation.catch(() => {})]).then(async () => {
    const state = useAppStore.getState()
    const tab = state.tabs[tabId]
    const surface = fileSurface(tab, regionId)
    if (!surface) return
    const currentKey = documentKey(surface.workspaceId, surface.path)
    const document = state.documents[currentKey]
    const issue = state.documentIssues[currentKey]
    if (!document) return
    const hasOverwriteConflict = overwrite && (issue?.kind === 'changed' || issue?.kind === 'deleted')
    if (!state.dirtyDocuments[currentKey] && !hasOverwriteConflict) return
    if (!overwrite && (issue?.kind === 'changed' || issue?.kind === 'deleted' || issue?.kind === 'read-error')) return
    if (overwrite && issue?.kind !== 'changed' && issue?.kind !== 'deleted') return
    const generation = state.documentGenerations[currentKey] ?? 0
    const observationGeneration = state.documentObservationGenerations[currentKey] ?? 0
    const savedLifetime = documentLifetime(currentKey)
    let expectedRevision: string | null = document.revision
    if (overwrite) expectedRevision = issue?.kind === 'changed' ? issue.observed.revision : null
    useAppStore.setState((current) => reduceDocumentSaving(current, surface.workspaceId, surface.path, true))
    let result
    try {
      result = await api.files.write(surface.workspaceId, {
        path: surface.path,
        content: document.content,
        expectedRevision
      })
    } catch (error) {
      result = {
        status: 'error' as const,
        code: typeof error === 'object' && error !== null && 'code' in error
          ? String(error.code)
          : 'WORKSPACE_FILE_WRITE_FAILED',
        message: presentError(error)
      }
    }
    if (documentLifetime(currentKey) !== savedLifetime || !useAppStore.getState().documents[currentKey]) return
    if (result.status === 'written') {
      const receiptState = useAppStore.getState()
      const needsReconciliation =
        (fileReadInFlightCounts.get(currentKey) ?? 0) > 0 ||
        (receiptState.documentObservationGenerations[currentKey] ?? 0) !== observationGeneration
      fileReadRequestIds.set(currentKey, (fileReadRequestIds.get(currentKey) ?? 0) + 1)
      useAppStore.setState((current) => {
        const next = reduceDocumentWritten(
          current,
          surface.workspaceId,
          surface.path,
          generation,
          result.revision,
          expectedRevision,
          observationGeneration
        )
        return isScratchTopicDocument(surface)
          ? {
              ...next,
              workspaceFileRevisions: bumpWorkspaceFileRevision(
                current.workspaceFileRevisions,
                surface.workspaceId
              )
            }
          : next
      })
      if (needsReconciliation) await refreshFileDocument(surface.workspaceId, surface.path, savedLifetime)
      return
    }
    if (result.status === 'error') {
      useAppStore.setState((current) => reduceDocumentWriteError(current, surface.workspaceId, surface.path, result.code, result.message))
      return
    }
    useAppStore.setState((current) => reduceDocumentSaving(current, surface.workspaceId, surface.path, false))
    await refreshFileDocument(surface.workspaceId, surface.path, savedLifetime)
  })
  const tail = operation.then(() => {}, () => {})
  fileSaveTails.set(key, tail)
  try {
    await operation
  } finally {
    if (fileSaveTails.get(key) === tail) fileSaveTails.delete(key)
  }
}

type SessionMembershipResync = {
  events: Array<{
    event: RuntimeEvent
    pendingLaunchAgentSessionId: string | null
  }>
  overflowed: boolean
}
const MAX_SESSION_MEMBERSHIP_EVENTS = 256
let regionCaretFocusNonce = 0
let sessionMembershipResync: SessionMembershipResync | null = null
let runtimeSubscriptionCount = 0

function enqueueSessionMembershipEvent(
  entry: SessionMembershipResync,
  event: RuntimeEvent,
  pendingLaunchAgentSessionId: string | null = null
): void {
  entry.events.push({ event, pendingLaunchAgentSessionId })
  if (entry.events.length <= MAX_SESSION_MEMBERSHIP_EVENTS) return
  entry.events.shift()
  entry.overflowed = true
}

function startSessionMembershipResync(
  event?: RuntimeEvent,
  options: { reportFailure?: boolean } = {}
): void {
  if (sessionMembershipResync) {
    if (event) enqueueSessionMembershipEvent(sessionMembershipResync, event)
    return
  }
  const entry: SessionMembershipResync = {
    events: event ? [{ event, pendingLaunchAgentSessionId: null }] : [],
    overflowed: false
  }
  sessionMembershipResync = entry
  void (async () => {
    try {
      while (sessionMembershipResync === entry) {
        // Everything already queued happened before this snapshot and is covered by its
        // canonical baseline. Only events that arrive while the snapshot is in flight
        // need ordered replay afterward.
        entry.events.length = 0
        entry.overflowed = false
        const snapshot = await api.sessions.snapshot()
        if (entry.overflowed) continue
        const events = entry.events.splice(0)
        let membershipGap = false
        const timelineGaps = new Set<string>()
        useAppStore.setState((state) => {
          const protectedAgentSessionIds = new Set(events.flatMap((pending) => (
            pending.pendingLaunchAgentSessionId ? [pending.pendingLaunchAgentSessionId] : []
          )))
          let projected = reduceAgentMembershipSnapshot(state, snapshot, protectedAgentSessionIds)
          projected = reduceTerminalMembershipSnapshot(projected, snapshot)
          for (const pending of events) {
            if (
              pending.pendingLaunchAgentSessionId &&
              pendingAgentLaunchEventId(projected, pending.event) === pending.pendingLaunchAgentSessionId
            ) {
              continue
            }
            const reduced = projectRuntimeEvent(projected, pending.event)
            projected = reduced.state
            membershipGap ||= reduced.sessionMembershipGap === true
            if (reduced.timelineGapSessionId) timelineGaps.add(reduced.timelineGapSessionId)
          }
          return { ...projected, runtimeOwnershipWarnings: snapshot.runtimeOwnershipWarnings ?? [] }
        })
        for (const sessionId of timelineGaps) void useAppStore.getState().resyncTimeline(sessionId)
        if (!membershipGap) return
      }
    } catch (error) {
      // A best-effort retry launched after an initial startup outage must not replace the richer
      // service-window warning that already explains the failed step. Event-driven resyncs still
      // surface their failure through the ordinary Store error channel.
      if (options.reportFailure !== false) useAppStore.getState().reportError(error)
    } finally {
      if (sessionMembershipResync === entry) sessionMembershipResync = null
    }
  })()
}

type WarmTerminal = {
  // Prevents a shell from being reused for the wrong host or working directory.
  key: string
  /**
   * 哪个 launcher 挂载点拥有这个槽——只有它渲染 live preview。
   *
   * 槽是**全局单个**（一台机器上不该为没人认领的 shell 攒 N 个 PTY），而 launcher 是**每个挂载点
   * 一个**：分屏能在同一个 Tab 里开出好几个，空分组占位又能在每个 group 里各有一个，它们的 warmKey
   * 完全一样（同 host 同 cwd）。没有 owner 这个字段时，每个 launcher 都认为
   * `warmTerminal.key === warmKey` 成立，于是**都**挂一个 TerminalView 到同一个 run 上。attach 那侧
   * 不会抛（同一个 identity 走 readRunReplay），所以没有任何报错——但两个 view 各有自己的 FitAddon
   * 与 ResizeObserver，尺寸不同就对着同一个 PTY 轮流 resize，网格来回跳、两边的 xterm 都在错误的
   * 行列上重排。
   *
   * 所以「谁拥有」必须是槽自己的一部分，而不是各个 launcher 各自推断。取值来自组件侧的
   * `warmLauncherId({ tabGroupId, regionId })`（见 `lib/warm-terminal-preview.ts`）：每个挂载点都有、
   * 同胞之间互不相同、且跨重渲染稳定。**不可直接用 regionId**——空分组占位没有 region，而那恰是新建
   * workspace 的第一眼，可缺席的字段当不了归属键；那个函数缺 region 时退到所属 group 并各自加前缀。
   */
  ownerLauncherId: string
  ready: Promise<SessionSnapshot | null>
  session: SessionSnapshot | null
}

export function warmTerminalKey(hostId: string, workspacePath: string): string {
  return `${hostId}\0${workspacePath}`
}

async function stopTerminalSession(session: SessionSnapshot): Promise<boolean> {
  try {
    await api.sessions.stop(session.control)
    return true
  } catch {
    return false
  }
}

async function stopWarmTerminal(held: WarmTerminal | null): Promise<string | null> {
  if (!held) return null
  const session = await held.ready.catch(() => null)
  if (!session) return null
  return await stopTerminalSession(session) ? session.id : null
}

function trackUnclaimedTerminalSession(ids: readonly string[], sessionId: string): string[] {
  return ids.includes(sessionId) ? [...ids] : [...ids, sessionId]
}

function forgetUnclaimedTerminalSession(ids: readonly string[], sessionId: string): string[] {
  return ids.filter((id) => id !== sessionId)
}

if (typeof window !== 'undefined') {
  window.addEventListener('agentmux:resource-owner-counts', (event) => {
    const target = event as CustomEvent<Record<string, number | boolean>>
    const resourceWindow = window as typeof window & {
      __agentmuxMonacoEditorCount?: () => number
      __agentmuxMonacoModelCount?: () => number
    }
    Object.assign(target.detail, rendererResourceOwnerCounts({
      documentCount: Object.keys(useAppStore.getState().documents).length,
      runtimeSubscriptionCount,
      terminalOwners: terminalResourceOwnerCounts(),
      ...(resourceWindow.__agentmuxMonacoEditorCount
        ? { monacoEditorCount: resourceWindow.__agentmuxMonacoEditorCount }
        : {}),
      ...(resourceWindow.__agentmuxMonacoModelCount
        ? { monacoModelCount: resourceWindow.__agentmuxMonacoModelCount }
        : {})
    }))
    target.detail.observed = true
  })
}

function newTabGroupId(): string {
  return `tab-group:${crypto.randomUUID()}`
}

function newRegionId(): string {
  return `region:${crypto.randomUUID()}`
}

function newLauncherTab(workspaceId: string, topicId?: string): WorkbenchTab {
  const tabId = `launcher:${crypto.randomUUID()}`
  const surface: LauncherWorkbenchSurface = {
    regionId: initialWorkbenchRegionId(tabId),
    kind: 'launcher',
    workspaceId
  }
  const tab = createWorkbenchTab(tabId, surface)
  return topicId ? { ...tab, topicId } : tab
}

type PersistedAppState = {
  agentComposerDrafts?: Record<string, string>
  documents?: Record<string, FileDocument>
  dirtyDocuments?: Record<string, boolean>
  restoredWorkbench: PersistedWorkbench
  unclaimedTerminalSessionIds: string[]
  scratchTopicOrder?: string[]
  agentNames?: Record<string, string>
  activeWorkspaceId?: string | null
  mainSurface?: MainSurface
  projectRailOpen?: boolean
  collapsedProjectGroups?: Record<string, true>
  toolsOpen?: boolean
  workspaceTool?: WorkspaceTool
  projectRailWidth?: number
  toolDockWidth?: number
  editorWordWrap?: boolean
}

export type RestoredUiState = Pick<
  AppState,
  | 'activeWorkspaceId'
  | 'mainSurface'
  | 'projectRailOpen'
  | 'collapsedProjectGroups'
  | 'toolsOpen'
  | 'workspaceTool'
  | 'projectRailWidth'
  | 'toolDockWidth'
  | 'editorWordWrap'
>

/**
 * 折叠集合的读回。只收「key 是字符串、值恰好是 true」的条目。
 *
 * 一条坏记录不该让整份布局回退到默认：逐条筛比整体丢弃更贴近这个函数已有的立场（缺字段走默认、
 * 坏枚举走默认）。收成 `true` 而不是任意真值，是因为写入侧只写 true——读回时放宽会让"存折叠集合"
 * 这个约定在读写两侧不一致。
 */
function restoredCollapsedGroups(candidate: unknown): Record<string, true> {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return {}
  const restored: Record<string, true> = {}
  for (const [key, value] of Object.entries(candidate)) {
    if (key !== '' && value === true) restored[key] = true
  }
  return restored
}

/**
 * Validate persisted presentation state at the configuration boundary. Persisted JSON is user data,
 * not a trusted in-memory AppState: a removed Workspace, an old enum value, or a corrupt dock width
 * must not make startup render an unusable surface. Missing fields intentionally resolve to the
 * current defaults, which keeps older records readable without a compatibility branch.
 */
export function restorePersistedUiState(
  config: AppConfig,
  persisted: Pick<
    PersistedAppState,
    | 'activeWorkspaceId'
    | 'mainSurface'
    | 'projectRailOpen'
    | 'collapsedProjectGroups'
    | 'toolsOpen'
    | 'workspaceTool'
    | 'projectRailWidth'
  | 'toolDockWidth'
    | 'editorWordWrap'
  >
): RestoredUiState {
  return {
    activeWorkspaceId: reseatActiveWorkspaceId(config, persisted.activeWorkspaceId),
    mainSurface: restoredMainSurface(persisted.mainSurface),
    projectRailOpen: restoredBoolean(persisted.projectRailOpen, true),
    collapsedProjectGroups: restoredCollapsedGroups(persisted.collapsedProjectGroups),
    toolsOpen: restoredBoolean(persisted.toolsOpen, true),
    workspaceTool: restoredWorkspaceTool(persisted.workspaceTool),
    projectRailWidth: clampProjectRailWidth(persisted.projectRailWidth ?? PROJECT_RAIL_DEFAULT_WIDTH),
    toolDockWidth: clampToolDockWidth(
      typeof persisted.toolDockWidth === 'number'
        ? persisted.toolDockWidth
        : TOOL_DOCK_DEFAULT_WIDTH
    ),
    editorWordWrap: restoredBoolean(persisted.editorWordWrap, false)
  }
}

const nonBrowserWorkbenchStorage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined
}

function workbenchStorage(): StateStorage {
  return typeof window === 'undefined' ? nonBrowserWorkbenchStorage : window.localStorage
}

// A failed hydration must not be followed by the initial `set(...)` overwriting the only durable
// copy of the user's layout with an empty default. Reads remain available while hydration runs;
// writes are opened only after startup has either loaded the record or explicitly finished with a
// visible warning. This is a narrow write fence, not a second persistence store.
//
// 闸本身住在 lib 里（`createWriteFencedStorage`）：留在这个模块里时它是一个 `let` 加一行 `if`，
// 于是「闸关着时写入真的被拦了吗」在测试里不可观测，只能靠扫源码文本判断那个名字还在——实测把
// 那行 `if` 删掉，五个持久化测试文件 62 条全绿。这里剩下的只有转发，没有可以被掏空的判断。
const workbenchWriteFence = createWriteFencedStorage({
  getItem: (name) => workbenchStorage().getItem(name),
  setItem: (name, value) => workbenchStorage().setItem(name, value),
  removeItem: (name) => workbenchStorage().removeItem(name)
})
const guardedWorkbenchStorage: StateStorage = workbenchWriteFence.storage

/** 放行持久化写入。启动路径上的两个开启点都只走这一处。 */
function openPersistWrites(): void {
  workbenchWriteFence.openWrites()
}

// A layout gesture (dock drag, split-ratio, tab reorder) produces many state changes per second.
// Debounce the durable writes so the newest value lands once after the gesture settles instead of
// synchronously on every frame; the trailing flush closes the in-memory window a hard shutdown would
// otherwise lose. Only layout presentation facts reach here — `partialize` already excludes PTY,
// scrollback, PID and Provider transcript state, so nothing runtime-owned is ever written.
const persistentWorkbenchStorage = createDebouncedPersistentStorage(guardedWorkbenchStorage)

// Renderer-side trailing flush on unload: force any debounced layout write to disk now so a quit or
// navigation mid-drag still keeps the last layout change. This complements the main process's
// `session.flushStorageData()` on window close — this lands the debounced value into localStorage,
// and main forces Chromium's async localStorage buffer to disk. A DOM-less environment gets a no-op.
if (typeof window !== 'undefined') {
  registerUnloadFlush(() => persistentWorkbenchStorage.flush())
}

let persistHydrationPromise: Promise<void> | null = null
let persistHydrationError: unknown | null = null

/**
 * Persist hydration is an input to startup recovery, not a background UI nicety. Zustand starts
 * hydration asynchronously, so reading `restoredWorkbench` before this barrier can make a cold
 * launch look like a brand-new window and permanently skip Agent recovery for that launch.
 *
 * Keep one in-flight promise so React StrictMode or another startup caller cannot trigger two
 * storage reads. The promise is cleared after settlement to allow an explicit later rehydrate
 * (for example after a storage repair) without keeping a stale promise forever.
 */
async function ensurePersistHydrated(): Promise<unknown | null> {
  if (useAppStore.persist.hasHydrated()) return null
  if (!persistHydrationPromise) {
    persistHydrationError = null
    persistHydrationPromise = Promise.resolve()
      .then(() => useAppStore.persist.rehydrate())
      .catch((error: unknown) => {
        // A broken storage layer is a Renderer workflow failure, not proof that a healthy Agent is
        // dead. Keep startup moving with the in-memory defaults and leave a durable, visible warning
        // on the completed shell below.
        persistHydrationError = error
      })
      .then(() => {
        if (!useAppStore.persist.hasHydrated() && !persistHydrationError) {
          persistHydrationError = new Error('Persisted Renderer state could not be hydrated.')
        }
      })
      .finally(() => { persistHydrationPromise = null })
  }
  await persistHydrationPromise
  return persistHydrationError
}

function restoredMainSurface(candidate: unknown): MainSurface {
  return candidate === 'board' ? 'board' : 'workbench'
}

function restoredWorkspaceTool(candidate: unknown): WorkspaceTool {
  return typeof candidate === 'string' &&
    (WORKSPACE_TOOL_IDS as readonly string[]).includes(candidate)
    ? candidate as WorkspaceTool
    : 'files-branches'
}

function restoredBoolean(candidate: unknown, fallback: boolean): boolean {
  return typeof candidate === 'boolean' ? candidate : fallback
}

export const useAppStore = create<AppState>()(persist<AppState, [], [], PersistedAppState>((set, get) => ({
  restoredWorkbench: null,
  config: null,
  providerCatalog: [],
  sessions: [],
  recoveryCandidates: [],
  warmTerminal: null,
  unclaimedTerminalSessionIds: [],
  timelines: {},
  pendingAgentLaunches: {},
  activeWorkspaceId: null,
  scratchTopicOrder: [],
  documents: {},
  dirtyDocuments: {},
  documentGenerations: {},
  documentObservationGenerations: {},
  documentIssues: {},
  savingDocuments: {},
  documentRevealTargets: {},
  lastActiveFileByWorkspace: {},
  tabs: {},
  layouts: {},
  closingWorkbenchViews: {},
  closeTabRequest: null,
  closeRegionRequest: null,
  regionCaretFocus: null,
  workspaceFileRevisions: {},
  fileExplorerStates: {},
  viewModes: {},
  editorWordWrap: false,
  editorRegionModes: {},
  editorRegionDiffs: {},
  executorDetections: {},
  hostChecks: {},
  browserAnnotationsByBrowserId: {},
  agentComposerDrafts: {},
  agentSteerQueues: {},
  launcherNameDrafts: {},
  agentNames: {},
  mainSurface: 'workbench',
  projectRailOpen: true,
  collapsedProjectGroups: {},
  toolsOpen: true,
  tabMenuOpen: false,
  workspaceTool: 'files-branches',
  projectRailWidth: PROJECT_RAIL_DEFAULT_WIDTH,
  toolDockWidth: TOOL_DOCK_DEFAULT_WIDTH,
  loading: true,
  runtimeOwnershipWarnings: [],
  environmentWarning: null,
  displacedAgentSessionIds: [],
  error: null,
  lastError: null,
  errorDismissed: false,
  async initialize() {
    if (!api.control || typeof api.control.onRequest !== 'function') {
      throw new Error('AgentMux Control API is unavailable')
    }
    const pendingSessionEvents: RuntimeEvent[] = []
    let sessionEventBufferOverflowed = false
    const pendingBrowserEvents: BrowserEvent[] = []
    let booting = true
    const disposeSessions = api.sessions.onEvent((event) => {
      if (booting) {
        if (event.event.type !== 'terminal-output') {
          pendingSessionEvents.push(event)
          if (pendingSessionEvents.length > 256) {
            pendingSessionEvents.shift()
            sessionEventBufferOverflowed = true
          }
        }
        return
      }
      if (event.event.type !== 'terminal-output') get().applyEvent(event)
    })
    const disposeBrowsers = api.browser.onEvent((event) => {
      if (booting) {
        pendingBrowserEvents.push(event)
        if (pendingBrowserEvents.length > 256) pendingBrowserEvents.shift()
      }
      else get().applyBrowserEvent(event)
    })
    const disposeControl = api.control.onRequest((request, signal) => (
      get().executeControl(request, signal)
    ))
    const disposeFileInvalidations = api.files.onInvalidated((event) => {
      const key = documentKey(event.workspaceId, event.path)
      fileInvalidationSequences.set(key, (fileInvalidationSequences.get(key) ?? 0) + 1)
      void get().refreshDocument(event.workspaceId, event.path)
    })
    runtimeSubscriptionCount += 4
    const disposeRuntimeSubscriptions = (): void => {
      if (runtimeSubscriptionCount === 0) return
      runtimeSubscriptionCount -= 4
      disposeSessions()
      disposeBrowsers()
      disposeControl()
      disposeFileInvalidations()
      void stopWarmTerminal(get().warmTerminal).then((sessionId) => {
        if (!sessionId) return
        set((state) => ({
          unclaimedTerminalSessionIds: forgetUnclaimedTerminalSession(
            state.unclaimedTerminalSessionIds,
            sessionId
          )
        }))
      })
      set({ warmTerminal: null })
    }
    try {
      // Do not let the runtime snapshot race the Renderer persistence layer. The persisted Workbench
      // is the index that selects recovery candidates; observing it before hydration would turn a
      // restart into an empty first Workspace and make a healthy Agent appear unrecoverable. The
      // subscriptions above intentionally start first so events arriving during this storage read
      // stay in the existing boot buffer instead of being missed.
      const persistWarning = await ensurePersistHydrated()
      // Keep the write fence closed until the restored Workbench has been projected into the live
      // store below. Opening it immediately after hydration allows startup observers (and React's
      // first render) to serialize the pre-runtime empty shell over the durable Tab/Region record.
      // The fence is opened exactly once after the projection is installed.
      // Config is the boundary that tells us which Workspace a persisted Region belongs to, so a
      // config failure genuinely prevents a safe shell. Session membership and the Provider catalog
      // are narrower runtime observations: either can be temporarily unavailable while the saved
      // Workbench and an already-running Agent remain usable. Keep those failures scoped to a visible
      // startup notice instead of letting Promise.all turn them into a full-window connection error.
      const [configResult, initialSnapshotResult, providerCatalogResult] = await Promise.allSettled([
        api.config.get(),
        api.sessions.snapshot(),
        api.providers.list()
      ])
      if (configResult.status === 'rejected') throw configResult.reason
      const config = configResult.value
      set({ environmentWarning: initialSnapshotResult.status === 'fulfilled'
        ? initialSnapshotResult.value.environmentWarning ?? null : get().environmentWarning })
      const startupWarnings: string[] = []
      let snapshot = initialSnapshotResult.status === 'fulfilled'
        ? initialSnapshotResult.value
        : emptyRuntimeSnapshot()
      let snapshotVerified = initialSnapshotResult.status === 'fulfilled'
      let retainUnknownSessionViews = !snapshotVerified
      let recoveryWorkflowFailed = false
      if (initialSnapshotResult.status === 'rejected') {
        startupWarnings.push(startupWorkflowWarning(
          'Runtime Session snapshot',
          initialSnapshotResult.reason,
          'The saved Workbench remains visible; Session status will reconcile when the Runtime is available.'
        ))
      }
      const providerCatalog = providerCatalogResult.status === 'fulfilled'
        ? providerCatalogResult.value
        : []
      if (providerCatalogResult.status === 'rejected') {
        startupWarnings.push(startupWorkflowWarning(
          'Provider catalog lookup',
          providerCatalogResult.reason,
          'Existing Sessions remain usable; restart startup to restore Provider choices for new Agents.'
        ))
      }
      const readCanonicalSnapshot = async (step: string): Promise<RuntimeSnapshot | null> => {
        try {
          const next = await api.sessions.snapshot()
          snapshotVerified = true
          retainUnknownSessionViews = recoveryWorkflowFailed
          return next
        } catch (error) {
          snapshotVerified = false
          retainUnknownSessionViews = true
          startupWarnings.push(startupWorkflowWarning(
            step,
            error,
            'The saved Workbench remains visible; the Runtime will reconcile it on a later canonical snapshot.'
          ))
          return null
        }
      }
      const persistedAgentIds = persistedAgentSessionIds(get().restoredWorkbench)
      // An empty Runtime snapshot cannot distinguish "there are no Sessions" from a freshly
      // connected/incorrectly rooted store. If the persisted Workbench still names Agent Regions,
      // keep those Regions as pending projections until Core returns a candidate or an explicit
      // retirement. Treating this one response as authoritative is what made a restart erase the
      // user's layout when the GUI and Runtime addressed different userData roots.
      if (
        snapshotVerified &&
        persistedAgentIds.size > 0 &&
        snapshot.sessions.length === 0 &&
        snapshot.recoveryCandidates.length === 0
      ) {
        retainUnknownSessionViews = true
        startupWarnings.push(
          'Runtime Session snapshot returned no Session facts. The saved Agent Regions remain visible until a canonical snapshot confirms their identity.'
        )
      }
      const recoveryFailures: SessionSnapshot[] = []
      let recovered = false
      for (const candidate of snapshotVerified ? snapshot.recoveryCandidates : []) {
        if (!persistedAgentIds.has(candidate.agentSessionId)) continue
        try {
          const recovery = await api.sessions.recover({
            kind: 'agent',
            hostId: candidate.hostId,
            agentSessionId: candidate.agentSessionId,
            run: { ...candidate.run }
          }, candidate.workspacePath)
          if (recovery.kind === 'reattachable' || recovery.kind === 'resumed') {
            recovered = true
          } else if (recovery.kind === 'unavailable' || recovery.kind === 'conflict') {
            recoveryFailures.push(recoveryCandidateSession(candidate, recovery))
          } else if (recovery.kind === 'retired') {
            // Retired means an actor deliberately ended this Agent, so the Region must NOT be retained
            // — the same judgement the manual path makes (`recoverSession` removes the projection on
            // `retired`), and the reason the empty-snapshot guard above names "an explicit retirement"
            // as legitimate grounds to stop retaining. What was missing is the *telling*: unavailable
            // and conflict both leave a visible error skeleton, while a retirement removed the Region
            // in total silence, so a Region the user left behind was simply gone with `error` null.
            // Say it instead. Deleting this arm turns the startup notice assertion red, not a tab
            // count — the tab is correctly absent either way.
            startupWarnings.push(
              `The Agent in a saved Region was retired and could not be restored (${candidate.label}). Its Region was closed; start a new Agent to continue there.`
            )
          }
        } catch (error) {
          // A rejected recovery call is a failed workflow step, not proof that the Agent is dead. Do
          // not invent a continuity reason; retain its persisted Region through the unverified
          // projection path and leave the exact cause in the service-window notice.
          snapshotVerified = false
          retainUnknownSessionViews = true
          recoveryWorkflowFailed = true
          startupWarnings.push(startupWorkflowWarning(
            'Automatic Agent recovery',
            error,
            'The original Region remains visible; retry recovery after the Runtime is reachable.'
          ))
        }
      }
      if (recovered) {
        const refreshedSnapshot = await readCanonicalSnapshot('Runtime Session snapshot after recovery')
        if (refreshedSnapshot) snapshot = refreshedSnapshot
      }
      let failedCleanupIds = new Set<string>()
      while (true) {
        const unclaimedSessionIds = new Set(get().unclaimedTerminalSessionIds)
        failedCleanupIds = new Set<string>()
        await Promise.all(snapshot.sessions.flatMap((session) => {
          if (!unclaimedSessionIds.has(session.id)) return []
          return [api.sessions.stop(session.control).catch(() => {
            failedCleanupIds.add(session.id)
          })]
        }))
        if (!sessionEventBufferOverflowed) break
        pendingSessionEvents.length = 0
        sessionEventBufferOverflowed = false
        const refreshedSnapshot = await readCanonicalSnapshot('Runtime Session snapshot during startup reconciliation')
        if (!refreshedSnapshot) break
        snapshot = refreshedSnapshot
      }
      const unclaimedSessionIds = new Set(get().unclaimedTerminalSessionIds)
      const visibleSessions = [
        ...snapshot.sessions.filter((session) => !unclaimedSessionIds.has(session.id)),
        ...recoveryFailures
      ]
      const persistedState = get()
      const restoredUi = restorePersistedUiState(config, persistedState)
      const workbench = restorePersistedWorkbench({
        config,
        sessions: visibleSessions,
        persisted: persistedState.restoredWorkbench,
        createTabGroupId: newTabGroupId,
        preserveUnknownSessionViews: retainUnknownSessionViews
      })
      // 抢救过的持久化 Tab 必须响亮：静默修好等于用户下次发现某一格不见了却无从查证。
      const repairNotice = describePersistedTabRepairs(workbench.repairs)
      const startupError = [
        ...(persistWarning
          ? [`Saved workspace state could not be restored: ${presentError(persistWarning)}`]
          : []),
        ...(repairNotice ? [repairNotice] : []),
        ...startupWarnings
      ].join(' ')
      set({
        restoredWorkbench: null,
        config,
        providerCatalog,
        sessions: visibleSessions,
        recoveryCandidates: snapshot.recoveryCandidates,
        unclaimedTerminalSessionIds: [...failedCleanupIds],
        timelines: snapshot.timelines,
        runtimeOwnershipWarnings: snapshot.runtimeOwnershipWarnings ?? [],
        pendingAgentLaunches: {},
        ...restoredUi,
        tabs: workbench.tabs,
        layouts: workbench.layouts,
        loading: false,
        error: startupError || null,
        lastError: startupError || null,
        errorDismissed: false
      })
      // The Runtime and its Agents remain usable; only the optional persisted presentation projection
      // was unavailable. Open the fence after the fallback state is installed so that this warning
      // itself cannot serialize the empty fallback over the user's last good record.
      if (!persistWarning) openPersistWrites()
      // Restored dirty buffers keep their base revision and immediately resume observation.
      // Refresh marks disk conflicts through the existing reducer; it never overwrites a dirty draft.
      for (const key of Object.keys(get().documents)) {
        const separator = key.indexOf('\0')
        if (separator < 0) continue
        const workspaceId = key.slice(0, separator), path = key.slice(separator + 1)
        if (!config.workspaces.some((workspace) => workspace.id === workspaceId)) continue
        void api.files.observe(workspaceId, path).then(() => get().refreshDocument(workspaceId, path)).catch((error) => get().reportError(error))
      }
      booting = false
      for (const event of pendingSessionEvents) get().applyEvent(event)
      for (const event of pendingBrowserEvents) get().applyBrowserEvent(event)
      // A rejected initial snapshot used the saved Workbench as a temporary projection. Retry one
      // canonical membership read after the shell is visible so stale Terminal Regions get a real
      // cleanup boundary even when Runtime emits no event for a PTY that disappeared with the app.
      // Agent recovery candidates remain protected by the same reducer used for event-driven resync.
      if (!snapshotVerified) startSessionMembershipResync(undefined, { reportFailure: false })
      return () => {
        disposeRuntimeSubscriptions()
      }
    } catch (error) {
      booting = false
      disposeRuntimeSubscriptions()
      const persisted = get().restoredWorkbench
      // A failure after hydration (for example a malformed Runtime snapshot or a repair assertion)
      // must not turn the saved Workbench into the in-memory empty default. Keep the durable
      // topology visible while the service-window error explains which startup step failed.
      set({
        ...(persisted ? { tabs: persisted.tabs, layouts: persisted.layouts } : {}),
        loading: false,
        error: presentError(error),
        lastError: presentError(error),
        errorDismissed: false
      })
      // If hydration itself failed, keep the write fence closed: opening it here would let the
      // default empty state overwrite the only durable copy before the user can repair storage.
      // Other startup failures have a verified record and may accept intentional later edits.
      if (!persistHydrationError) openPersistWrites()
      return () => {}
    }
  },
  async selectWorkspace(id) {
    set({ activeWorkspaceId: id, mainSurface: 'workbench', error: null, errorDismissed: true })
    const state = get()
    if (!state.layouts[id]) {
      set((current) => ({
        layouts: { ...current.layouts, [id]: createWorkspaceLayout(newTabGroupId()) }
      }))
    }
  },
  activateWorkspaceSelection(result) {
    const workspace = result.workspace
    set((state) => {
      const existingLayout = state.layouts[workspace.id]
      return {
        config: result.config,
        activeWorkspaceId: workspace.id,
        mainSurface: 'workbench',
        error: null,
        errorDismissed: true,
        layouts: existingLayout
          ? state.layouts
          : { ...state.layouts, [workspace.id]: createWorkspaceLayout(newTabGroupId()) }
      }
    })
  },
  async runFanOut(input) {
    try {
      const result = await api.workspaces.runFanOut(input)
      if (result.kind === 'rejected') {
        get().reportError(new Error(result.reason))
        return result
      }
      if (result.kind === 'fanout') {
        // Config changed in main (each lane registered a worktree); pull the new truth rather than
        // reconstructing it here.
        //
        // 走 `adoptedConfig` 而不是裸 `set({ config })`，尽管扇出只**添加**记录、今天动不了活动位。
        // 「这次写入只加不减」是一条会过期的理由：下一个人在同一处加一句 filter 时不会回头读这行
        // 注释，而漏掉活动位的症状是一屏没有解释的空白欢迎页。统一走同一个出口，代价是一次无操作。
        const next = await api.config.get()
        // 同活动位：扇出今天只加不减，所以这句是无操作。但「只加不减」是会过期的理由——统一在
        // 这个出口撤掉被移除 workspace 的观察者，下一个人在此加 filter 时不会漏掉子进程（#559）。
        disposeObserversForRemovedWorkspaces(get().tabs, next)
        set((state) => adoptedConfig(state.activeWorkspaceId, next))
        // A partial failure is neither swallowed nor promoted to total failure: the lanes that did
        // launch stay launched, and the ones that did not are named through the existing error surface.
        const failed = result.lanes.filter((lane) => lane.status !== 'launched')
        // 一个建了 worktree 但没启动成功的 lane 有第二件事要说：**那个目录现在怎么样了**。此前这条真相
        // 走到 renderer 就断了——lane 上带着它，而没有任何消费者读，于是清理失败的 lane 与清理干净的
        // lane 在屏幕上完全一样。措辞与顺序共用 `retentionReport`，不在这里另写一套。
        //
        // 两句话拼进**同一次** reportError，而不是各报一次：错误面是一个槽（`reportError` 就是
        // `set({ error })`），第二次调用会把第一次擦掉。分两次报的后果是保留告知盖掉「哪几条没起来、
        // 为什么」——用户失去的正是他最需要的那半边。
        const retention = retentionReport(
          result.lanes.flatMap((lane) =>
            lane.status === 'launch-failed' && lane.cleanup
              ? [{ retention: lane.cleanup.retention, id: lane.branch, reason: lane.cleanup.reason }]
              : []
          )
        )
        if (failed.length > 0 || retention) {
          const launchFailures = failed.length > 0
            ? `${failed.length} of ${result.lanes.length} lanes did not start: ${failed
                .map((lane) => `${lane.branch} (${lane.error})`)
                .join('; ')}`
            : null
          get().reportError(new Error([launchFailures, retention].filter(Boolean).join(' — ')))
        }
      }
      return result
    } catch (error) {
      get().reportError(error)
      return { kind: 'rejected', reason: presentError(error) }
    }
  },
  async createPullRequest(input) {
    // The click's intent, captured before any await. Every later step checks it.
    const token = input.token
    try {
      const verdict = evaluateCreatePrIntent(token, input.current)
      if (verdict.kind === 'conflict') {
        // Aborting is the honest outcome: the payload no longer describes what the user asked for.
        // Switching to another worktree does NOT reach here — that returns proceed-detached.
        get().reportError(new Error(verdict.reason))
        return { kind: 'refused', reason: verdict.reason }
      }
      // The eligibility ladder runs first so the user gets the actionable reason ("push it first",
      // "run gh auth login") instead of whatever gh happens to say when it fails. It is a HINT, not
      // the authority: main re-checks the base against the remote and refuses on its own terms.
      if (input.eligibility) {
        const verdictLadder = evaluatePrEligibility(input.eligibility)
        if (!verdictLadder.eligible) {
          const reason = verdictLadder.blockers.map((key) => PR_BLOCKER_MESSAGES[key]).join(' ')
          get().reportError(new Error(reason))
          return { kind: 'refused', reason }
        }
      }
      // gh 桥从 ghBridge 取（与 git 同一层，但缺席理由是它自己那一句）。桥缺席是拒绝，绝不假装开了 PR。
      const lookup = ghBridge()
      if (!lookup.available) {
        get().reportError(new Error(lookup.reason))
        return { kind: 'refused', reason: lookup.reason }
      }
      // Main re-checks the base against the remote and is the final authority; an unavailable check
      // is a refusal there, not a pass.
      const result = await lookup.bridge.createPullRequest(input.workspaceId, {
        title: input.title,
        body: input.body,
        base: token.baseRef,
        ...(input.draft === undefined ? {} : { draft: input.draft })
      })
      // A refusal or failure is surfaced but NOT swallowed into a cleared composer: the caller keeps
      // the title and body so one bad network moment does not eat what the user wrote.
      if (result.kind !== 'created') {
        get().reportError(new Error(result.kind === 'refused' ? result.reason : result.message))
      }
      return result
    } catch (error) {
      get().reportError(error)
      return { kind: 'failed', message: presentError(error) }
    }
  },
  async keepOneOfFanOut(input) {
    try {
      const result = await api.workspaces.keepOneOfFanOut(input)
      // 输家的记录刚被撤掉，而活动位很可能正指着其中一个——用户就是在看那几条 lane 才按下 Keep 的。
      const next = await api.config.get()
      // 胜者写在候选第二位：活动位指着的还在（比如某条 lane 因为脏树被留下）就不动它，被删掉了才
      // 落到胜者身上。落到胜者而不是通用兜底，是因为「留下这一个」这句话本身就说明了该看哪儿。
      // 输家的记录连同它们的文件 Tab 一起被撤，那些 Tab 攥着的 Main 侧观察者也要在这里释放（#559）。
      disposeObserversForRemovedWorkspaces(get().tabs, next)
      set((state) => adoptedConfig(state.activeWorkspaceId, next, input.keepWorkspaceId))
      // A lane refused because it still holds uncommitted work is reported, never silently dropped —
      // losing a bake-off is not a reason to discard someone's work. 分档措辞在 `retentionReport`
      // 里，因为「哪一档说哪句话」是判断：这里曾经把三档折成一句硬编码的「because they still hold
      // changes」，对 git 失败与「已删但记录没撤下」两档都是假话。
      //
      // 折成一句而不是逐条 reportError：错误面是一个槽，逐条报的话三档同时出现时只剩最后一档，而
      // 被擦掉的第一档（脏树）恰好是唯一有真实下一步可做的那一档。
      const retention = retainedLaneReport(result.outcomes)
      if (retention) get().reportError(new Error(retention))
      return result
    } catch (error) {
      get().reportError(error)
      return null
    }
  },
  async removeWorktree(input) {
    const outcome = await api.workspaces.removeWorktree(input)
    // `removed` 带回来的 config 就是权威的那一份，不再另外 get() 一次：多一次往返就多一个能与这次
    // 移除结果不一致的窗口。`retained` 什么都没删，所以什么都不写——它是保护生效了，不是一次变更。
    if (outcome.status === 'removed') {
      // The removed worktree's file Tabs still hold Main-side observers; drop them at the same seam
      // that reseats the active Workspace (see disposeObserversForRemovedWorkspaces / #559).
      disposeObserversForRemovedWorkspaces(get().tabs, outcome.config)
      set((state) => adoptedConfig(state.activeWorkspaceId, outcome.config))
    }
    // 抛不抛由调用方决定：单条移除的 `retained` 要在对话框里重问，压成 null 会把 git 的理由吃掉。
    return outcome
  },
  focusTabGroup(workspaceId, tabGroupId) {
    const layout = get().layouts[workspaceId]
    if (!layout || !findGroup(layout, tabGroupId)) return
    set((state) => ({
      layouts: { ...state.layouts, [workspaceId]: focusGroup(layout, tabGroupId) }
    }))
  },
  activateTab(workspaceId, tabGroupId, tabId) {
    const layout = get().layouts[workspaceId]
    if (!layout) return
    const tab = get().tabs[tabId]
    const surface = tab ? titleWorkbenchSurface(tab) : null
    set((state) => ({
      layouts: {
        ...state.layouts,
        [workspaceId]: activateLayoutTab(layout, tabGroupId, tabId)
      },
      ...(surface?.kind === 'file'
        ? { lastActiveFileByWorkspace: { ...state.lastActiveFileByWorkspace, [workspaceId]: surface.path } }
        : {})
    }))
  },
  async executeControl(request, signal) {
    const input = () => {
      const state = get()
      return { sessions: state.sessions, tabs: state.tabs, layouts: state.layouts }
    }
    const requireActive = (): void => {
      if (signal?.aborted) throw controlCancellation(signal)
    }
    const resolveExecutorId = (requested: string): string => {
      const executors = get().config?.executors ?? {}
      if (executors[requested]) return requested
      const matches = Object.entries(executors)
        .filter(([, executor]) => executor.label.trim().toLocaleLowerCase() === requested.trim().toLocaleLowerCase())
        .map(([id]) => id)
      if (matches.length === 1) return matches[0]!
      if (matches.length > 1) throw controlFailure('INVALID_CONTROL_REQUEST', `Executor name is ambiguous: ${requested}`)
      return requested
    }
    const agentSession = (
      target: { kind: 'self' } | { kind: 'agent-session'; agentSessionId: string },
      caller?: { agentSessionId: string }
    ): Extract<SessionSnapshot, { kind: 'agent' }> => {
      const id = target.kind === 'self' ? caller?.agentSessionId : target.agentSessionId
      if (!id) throw controlFailure('INVALID_CONTROL_REQUEST', 'A self selector requires a managed caller.')
      const session = get().sessions.find((candidate) => candidate.id === id)
      if (!session || session.kind !== 'agent') {
        throw controlFailure('UNKNOWN_AGENT_SESSION', 'Agent Session is not available to the Desktop.')
      }
      if (!workbenchViewCloseAllowsSession(get().closingWorkbenchViews, id)) {
        throw controlFailure('SESSION_CLOSING', 'Agent Session is closing.')
      }
      return session
    }
    const focus = (tabId: string, region?: AgentMuxRegion) => {
      const state = get()
      const tab = state.tabs[tabId]
      const layout = tab && state.layouts[tab.workspaceId]
      const group = layout && findGroupForTab(layout, tabId)
      if (!tab || !layout || !group) throw controlFailure('TAB_NOT_OPEN', 'Tab target is not open.')
      set({
        activeWorkspaceId: tab.workspaceId,
        mainSurface: 'workbench',
        tabs: region ? { ...state.tabs, [tab.id]: focusWorkbenchTabRegion(tab, region.regionId) } : state.tabs,
        layouts: { ...state.layouts, [tab.workspaceId]: activateLayoutTab(layout, group.id, tab.id) }
      })
      return { tabId, ...(region ? { regionId: region.regionId } : {}) }
    }
    requireActive()
    if (request.operation === 'inspect.tab') {
      const tab = resolveWorkbenchControlTab(input(), request.target, request.caller)
      return { operation: request.operation, tab: inspectWorkbenchControlTab(input(), tab) }
    }
    if (request.operation === 'inspect.region') {
      const region = resolveWorkbenchControlRegion(input(), request.target, request.caller)
      return { operation: request.operation, region: inspectWorkbenchControlRegion(input(), region) }
    }
    if (request.operation === 'list.agents') {
      const state = get()
      // 一个 executor 可能配在多台 Host 上，而 list.agents 是一张扁平表：按「最可用」归并——
      // available > missing > check-failed > unknown。这是旧 `.some(=== 'ready')`（「有一台 ready 就算可用」）
      // 的诚实推广。逐台的四态区分仍完整活在 ExecutorDetection（按 (host,executor) 各带一态），
      // 这里只是给 CLI 的汇总视图。归并与线上的映射共用同一处 {@link executorAvailabilityFromCheckState}。
      const availabilityRank: Record<AgentMuxExecutorAvailability, number> = {
        available: 3, missing: 2, 'check-failed': 1, unknown: 0
      }
      return {
        operation: request.operation,
        agents: Object.entries(state.config?.executors ?? {}).map(([executorId, executor]) => ({
          executorId,
          label: executor.label,
          providerId: executor.providerId,
          availability: (state.config?.workspaces ?? [])
            .map((workspace) => executorAvailabilityFromCheckState(
              state.executorDetections[executorDetectionKey(workspace.hostId, executorId)]?.state
            ))
            .reduce<AgentMuxExecutorAvailability>(
              (best, current) => (availabilityRank[current] > availabilityRank[best] ? current : best),
              'unknown'
            )
        }))
      }
    }
    if (request.operation === 'focus') {
      if (request.target.kind === 'tab') {
        const tab = resolveWorkbenchControlTab(input(), request.target)
        return { operation: request.operation, ...focus(tab.id) }
      }
      const region = resolveWorkbenchControlRegion(input(), request.target)
      return { operation: request.operation, ...focus(region.tabId, region) }
    }
    if (request.operation === 'arrange') {
      const state = get()
      const tab = resolveWorkbenchControlTab(input(), request.target, request.caller)
      // 「预设要补几个 Region」由 arrangeWorkbenchControlTab 自己从 preset 推导——这里只交铸 id 的
      // 手段。那段推导曾住在这里，而 GUI 菜单（arrangeTabRegions，本文件下方）是它的第二个调用方：
      // 留在这里就必须被抄一份，两份必漂移。
      const arranged = arrangeWorkbenchControlTab(tab, request.mode, newRegionId)
      set({ tabs: { ...state.tabs, [tab.id]: arranged } })
      return { operation: request.operation, tab: inspectWorkbenchControlTab(input(), arranged) }
    }
    if (request.operation === 'promote.region') {
      // 促升一格成它自己的一张 Tab（#487）。树代数全在纯 reducer reducePromoteRegionToTab 里，这里
      // 不重实现——只做三件 Control 面的事：把 self/显式选择器解析成一格（复用 resolveWorkbenchControlRegion，
      // 顺带证明它真的开着）、把 reducer 的 'unchanged' 翻成 typed 失败（绝不把「什么都没做」报成一次成功
      // 的移动）、把新 Tab 坐标交回调用方。促升只搬布局投影，不碰 Runtime lifecycle：这里没有任何
      // api.sessions.* 调用，Session/Run 身份原样跟着 regionId 走。
      const region = resolveWorkbenchControlRegion(input(), request.target, request.caller)
      const result = reducePromoteRegionToTab({
        tabs: get().tabs,
        layouts: get().layouts,
        workspaceId: region.workspaceId,
        tabId: region.tabId,
        regionId: region.regionId,
        mint: { tabId: `view:${crypto.randomUUID()}` }
      })
      if (result.kind !== 'promoted') {
        // 'already-sole' 是调用方**能据以行动**的那种拒绝：这一格已经独占整张 Tab，没有可搬的东西。
        // 其余 'unchanged'（输入过期、目标不合格）是请求本身不成立。两者都拒绝、都不谎报一次没发生
        // 的移动，区别在于自主调用方可以据码分支，而不必去 match 文案。
        throw result.kind === 'already-sole'
          ? controlFailure('REGION_ALREADY_SOLE', 'Region is already the only Region of its Tab; it is already its own Tab.')
          : controlFailure('CONTROL_FAILED', 'Region cannot be promoted to a new Tab.')
      }
      set({
        activeWorkspaceId: result.target.workspaceId,
        mainSurface: 'workbench',
        tabs: result.tabs,
        layouts: result.layouts
      })
      return {
        operation: request.operation,
        tabId: result.target.tabId,
        regionId: result.target.regionId,
        workspaceId: result.target.workspaceId
      }
    }
    if (request.operation === 'send') {
      let session: Extract<SessionSnapshot, { kind: 'agent' }>
      if (request.target.kind === 'self' || request.target.kind === 'agent-session') {
        session = agentSession(request.target, request.caller)
      } else if (request.target.kind === 'region') {
        const region = resolveWorkbenchControlRegion(input(), request.target)
        if (region.kind !== 'agent') throw controlFailure('MESSAGE_TARGET_NOT_AGENT', 'Target Region is not an Agent.')
        session = agentSession({ kind: 'agent-session', agentSessionId: region.agentSessionId })
      } else {
        const tab = resolveWorkbenchControlTab(input(), { kind: 'tab', tabId: request.target.tabId })
        const candidates = messageTargetCandidates(input(), tab.id)
        if (candidates.length !== 1) {
          throw controlFailure('MESSAGE_TARGET_NOT_UNIQUE', 'Target Tab does not contain exactly one Agent Session.', { candidates })
        }
        session = agentSession({ kind: 'agent-session', agentSessionId: candidates[0]!.agentSessionId })
      }
      requireActive()
      // One-shot manual submit: the id is born and dies with this single call. There is no store-held
      // retry here (unlike the steer queue), so a fresh id per invocation is the correct lifetime.
      await api.sessions.submitPrompt(session.control, request.text, crypto.randomUUID())
      return { operation: request.operation, agentSessionId: session.id }
    }
    if (request.operation === 'interrupt' || request.operation === 'resume' || request.operation === 'stop') {
      const session = agentSession(request.target, request.caller)
      requireActive()
      if (request.operation === 'interrupt') {
        await api.sessions.interrupt(session.control)
        return { operation: request.operation, agentSessionId: session.id }
      }
      if (request.operation === 'stop') {
        await api.sessions.stop(session.control)
        return { operation: request.operation, agentSessionId: session.id }
      }
      const resumed = await api.sessions.resume(session.control, request.text, request.requestId)
      if (resumed.kind !== 'agent' || resumed.id !== session.id) {
        throw controlFailure('LAUNCH_RESULT_MISMATCH', 'Explicit resume returned another Agent Session.')
      }
      set((current) => projectRecoveredSession(current, session.id, resumed))
      if (signal?.aborted) throw controlCancellation(signal)
      return { operation: request.operation, agentSessionId: resumed.id, runId: resumed.control.run.runId }
    }

    // browser.run 必须在这里拦下，不能落进下面那段。
    //
    // 下面那整段是**开**东西的路：读 request.destination 找落点、铺一个 launcher，最后无条件落到开
    // 浏览器的尾巴上（那段没有自己的 if）。browser.run 不开任何东西——它作用在一个已经开着的
    // Browser 上，没有 destination。放它过去的话，它会一路走进那条尾巴被当成 open.browser 执行：
    // **多开一个空白浏览器，而 Agent 的程序一行都没跑**，回执里还带着一个它没请求过的 region。
    //
    // 这一处是 T-008 验收点名的「两处没有编译器保护」之一。今天不是了：browser.run 进联合之后，
    // 下面的 `request.destination` 与 `request.url` 各报一处 TS2339——漏掉这个分支编译不过。
    if (request.operation === 'browser.run') {
      // 授权闸不在这层，在 Main 的 browser:runScript handler 里：那是所有调用方的必经之路，
      // 而这里只是今天唯一的一个调用方。放在这层的话，每多一个入口就要记得再写一遍同样的检查。
      const report = await api.browser.runScript(request.browserId, request.code)
      requireActive()
      return {
        operation: request.operation,
        result: report.result,
        logs: report.logs,
        outcome: report.outcome
      }
    }

    const state = get()
    const plan = planControlOpen(
      input(),
      request.destination,
      request.caller,
      `view:${crypto.randomUUID()}`,
      newRegionId()
    )
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, plan.tabId)) {
      throw controlFailure('CONTROL_OWNER_LOST', 'Control target Tab is closing.')
    }
    const workspace = state.config?.workspaces.find((candidate) => candidate.id === plan.workspaceId)
    if (!workspace) throw controlFailure('UNKNOWN_WORKSPACE', 'Control target Workspace is not configured.')
    const rollback = (surface: WorkbenchSurface): void => {
      set((current) => {
        const restored = rollbackControlOpen({ tabs: current.tabs, layouts: current.layouts }, plan, surface)
        return restored ? { tabs: restored.tabs, layouts: restored.layouts } : current
      })
    }

    if (request.operation === 'open.agent' && request.content.kind === 'agent-session') {
      const session = agentSession({ kind: 'agent-session', agentSessionId: request.content.agentSessionId })
      if (!workspaceOwnsSessionPath(workspace, session)) {
        throw controlFailure('REGION_WORKSPACE_MISMATCH', 'Agent Session and destination belong to different Workspaces.')
      }
      const topicId = topicIdForSession(state.config, session)
      if (isScratchWorkspaceId(workspace.id)) {
        if (!topicId) throw controlFailure('REGION_TOPIC_MISMATCH', 'Agent Session has no matching Scratch Topic.')
        if (plan.kind === 'tab') plan.tabs[plan.tabId] = { ...plan.tabs[plan.tabId]!, topicId }
        else if (plan.tabs[plan.tabId]?.topicId !== topicId) {
          throw controlFailure('REGION_TOPIC_MISMATCH', 'Agent Session and destination belong to different Scratch Topics.')
        }
      }
      const surface: AgentWorkbenchSurface = {
        regionId: plan.regionId, kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: session.id
      }
      plan.tabs[plan.tabId] = replaceWorkbenchRegion(plan.tabs[plan.tabId]!, plan.regionId, surface)
      set({ activeWorkspaceId: workspace.id, mainSurface: 'workbench', tabs: plan.tabs, layouts: plan.layouts })
      return {
        operation: request.operation,
        region: {
          tabId: plan.tabId, regionId: plan.regionId, workspaceId: workspace.id, kind: 'agent',
          agentSessionId: session.id, providerId: session.providerId, executorId: session.executorId
        }
      }
    }

    if (request.operation === 'open.agent') {
      const content = request.content
      if (content.kind !== 'new-agent') {
        throw controlFailure('INVALID_CONTROL_REQUEST', 'Agent open content is invalid.')
      }
      const executorId = resolveExecutorId(content.executorId)
      if (!state.config?.executors[executorId]) {
        throw controlFailure('AGENT_EXECUTOR_NOT_CONFIGURED', 'Agent Executor is not configured.')
      }
      const agentSessionId = crypto.randomUUID()
      // The target Topic is carried explicitly by the destination View's binding. A brand-new
      // Tab has no binding and therefore no Topic — we never mint one from the Tab identity.
      const scratchTopicId = isScratchWorkspaceId(workspace.id)
        ? plan.tabs[plan.tabId]?.topicId
        : undefined
      if (scratchTopicId && !isScratchTopicId(scratchTopicId)) {
        throw controlFailure('REGION_TOPIC_MISMATCH', 'Control destination has an invalid Scratch Topic.')
      }
      const pending: AgentWorkbenchSurface = {
        regionId: plan.regionId, kind: 'agent', phase: 'launching', workspaceId: workspace.id, sessionId: agentSessionId
      }
      plan.tabs[plan.tabId] = replaceWorkbenchRegion(plan.tabs[plan.tabId]!, plan.regionId, pending)
      set((current) => ({
        activeWorkspaceId: workspace.id,
        mainSurface: 'workbench',
        tabs: plan.tabs,
        layouts: plan.layouts,
        pendingAgentLaunches: { ...current.pendingAgentLaunches, [agentSessionId]: { events: [], overflowed: false } }
      }))
      const cancel = (): void => rollback(pending)
      signal?.addEventListener('abort', cancel, { once: true })
      let launched: AgentLaunchResult | null = null
      const cleanup = async (primary: Error): Promise<never> => {
        if (launched) {
          try { await api.sessions.stop(launched.session.control) }
          catch (cleanupError) {
            set((current) => reduceDetachedAgentLaunch(current, launched!).state)
            throw controlFailure('LAUNCH_CLEANUP_FAILED', `${primary.message} Cleanup failed: ${presentError(cleanupError)}`, {
              cause: new AggregateError([primary, cleanupError])
            })
          }
        }
        throw primary
      }
      try {
        launched = await api.sessions.launchAgent({
          executorId,
          hostId: workspace.hostId,
          workspacePath: workspace.path,
          ...(scratchTopicId ? { scratchTopicId } : {}),
          agentSessionId,
          createOperationId: request.requestId,
          ...(content.prompt === undefined ? {} : { prompt: content.prompt })
        })
        if (launched.session.id !== agentSessionId || launched.timeline.agentSessionId !== agentSessionId) {
          await cleanup(controlFailure('LAUNCH_RESULT_MISMATCH', 'Agent launch returned another Session identity.'))
        }
        let canonical: AgentLaunchResult | null = null
        try {
          canonical = await get().canonicalizeAgentLaunch(launched)
        } catch (cause) {
          await cleanup(Object.assign(
            controlFailure('CONTROL_FAILED', 'Agent launch state could not be reconciled.'),
            { cause }
          ))
        }
        if (!canonical) return await cleanup(controlFailure('CONTROL_OWNER_LOST', 'Agent Session ended during launch.'))
        const committed: AgentLaunchResult = canonical
        launched = committed
        if (signal?.aborted) await cleanup(controlCancellation(signal))
        const owner = findWorkbenchRegion(get().tabs, plan.regionId)
        if (!ownsSessionLaunch(owner?.surface, 'agent', agentSessionId)) {
          // T-005: the Region vanished mid-launch — closed, or its id recycled by another launch —
          // but the Agent itself started healthy. Do NOT stop it (the old `cleanup` here killed a
          // perfectly good Run): keep it in the session list so it stays discoverable, and record the
          // displacement so a persistent, layout-anchored notice can offer to give it a place again.
          // The receipt still fails (there is no valid landing to hand back), but the Run keeps running.
          // `reduceDetachedAgentLaunch` adds the Session unconditionally (its Region is gone) and clears
          // the pending-launch bookkeeping; the outer catch's rollback/discard then no-op.
          let timelineGapSessionId: string | undefined
          set((current) => {
            const detached = reduceDetachedAgentLaunch(current, committed)
            timelineGapSessionId = detached.timelineGapSessionId
            return {
              ...detached.state,
              displacedAgentSessionIds: [...current.displacedAgentSessionIds, agentSessionId]
            }
          })
          if (timelineGapSessionId) void get().resyncTimeline(timelineGapSessionId)
          throw controlFailure('CONTROL_OWNER_LOST', 'Agent launched successfully but its Region disappeared during launch.')
        }
        if (!workspaceOwnsSessionPath(workspace, committed.session)) {
          await cleanup(controlFailure('LAUNCH_RESULT_MISMATCH', 'Agent launch returned another Workspace.'))
        }
        set((current) => reduceAgentSessionLaunchAttached(current, plan.regionId, committed).state)
        const landing = resolveSpatialCommit(get().tabs, plan.regionId, { kind: 'agent', sessionId: agentSessionId })
        if (landing.kind !== 'landed') {
          // The Agent is healthy; only the Desktop projection moved while launch was in flight.
          // Keep the Session available and report the layout race without stopping its Run.
          get().reportError(new Error('Agent launched successfully, but its Region moved before the layout receipt was read.'))
          throw controlFailure('CONTROL_OWNER_LOST', 'Agent launched successfully but its Region owner moved during launch.')
        }
        return {
          operation: request.operation,
          region: {
            tabId: landing.tabId, regionId: plan.regionId, workspaceId: workspace.id, kind: 'agent',
            agentSessionId, providerId: committed.session.providerId, executorId: committed.session.executorId
          }
        }
      } catch (error) {
        rollback(pending)
        set((current) => discardPendingAgentLaunch(current, agentSessionId))
        throw error
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
    }

    if (request.operation === 'open.terminal') {
      const pendingId = `terminal-launch:${crypto.randomUUID()}`
      const pending: TerminalWorkbenchSurface = {
        regionId: plan.regionId, kind: 'terminal', phase: 'launching', workspaceId: workspace.id, sessionId: pendingId
      }
      plan.tabs[plan.tabId] = replaceWorkbenchRegion(plan.tabs[plan.tabId]!, plan.regionId, pending)
      set({ activeWorkspaceId: workspace.id, mainSurface: 'workbench', tabs: plan.tabs, layouts: plan.layouts })
      const cancel = (): void => rollback(pending)
      signal?.addEventListener('abort', cancel, { once: true })
      let session: SessionSnapshot | null = null
      const cleanup = async (primary: Error): Promise<never> => {
        if (session) {
          try { await api.sessions.stop(session.control) }
          catch (cleanupError) {
            set((current) => ({ sessions: [...current.sessions.filter((item) => item.id !== session!.id), session!] }))
            throw controlFailure('LAUNCH_CLEANUP_FAILED', `${primary.message} Cleanup failed: ${presentError(cleanupError)}`, {
              cause: new AggregateError([primary, cleanupError])
            })
          }
        }
        throw primary
      }
      try {
        session = await api.sessions.launchTerminal({
          hostId: workspace.hostId,
          workspacePath: workspace.path,
          createOperationId: request.requestId,
          ...(request.shellCommand === undefined ? {} : { shellCommand: request.shellCommand })
        })
        if (session.kind !== 'terminal' || session.hostId !== workspace.hostId || session.workspacePath !== workspace.path) {
          await cleanup(controlFailure('LAUNCH_RESULT_MISMATCH', 'Terminal launch result does not match its request.'))
        }
        if (signal?.aborted) await cleanup(controlCancellation(signal))
        const owner = findWorkbenchRegion(get().tabs, plan.regionId)
        if (!ownsSessionLaunch(owner?.surface, 'terminal', pendingId)) {
          await cleanup(controlFailure('CONTROL_OWNER_LOST', 'Control Region owner disappeared during Terminal launch.'))
        }
        const committed = session
        set((current) => {
          const currentOwner = findWorkbenchRegion(current.tabs, plan.regionId)
          if (
            !currentOwner ||
            currentOwner.surface.kind !== 'terminal' ||
            !ownsSessionLaunch(currentOwner.surface, 'terminal', pendingId)
          ) return current
          const tabs = {
            ...current.tabs,
            [currentOwner.tab.id]: replaceWorkbenchRegion(currentOwner.tab, plan.regionId, { ...currentOwner.surface, sessionId: committed.id })
          }
          return reduceSessionLaunchAttached({ ...current, tabs }, plan.regionId, committed)
        })
        // 与 agent 那条路共用同一处落点解析。此前这里返回 `plan.tabId`——上面的两道 owner 闸都只认
        // surface 身份，没有一道比较过 Tab id，于是启动期间这一格被 promote 走时，回执交回的是旧 Tab。
        const landing = resolveSpatialCommit(get().tabs, plan.regionId, { kind: 'terminal', sessionId: committed.id })
        if (landing.kind !== 'landed') {
          throw controlFailure('CONTROL_OWNER_LOST', 'Terminal launched successfully but its Region owner moved during launch.')
        }
        return {
          operation: request.operation,
          region: {
            tabId: landing.tabId, regionId: plan.regionId, workspaceId: workspace.id, kind: 'terminal',
            runId: session.control.run.runId
          }
        }
      } catch (error) {
        rollback(pending)
        throw error
      } finally {
        signal?.removeEventListener('abort', cancel)
      }
    }

    const browserId = `browser:${crypto.randomUUID()}`
    set({ activeWorkspaceId: workspace.id, mainSurface: 'workbench', tabs: plan.tabs, layouts: plan.layouts })
    const cancel = (): void => rollback(plan.launcher)
    signal?.addEventListener('abort', cancel, { once: true })
    let createdBrowserId: string | null = null
    const cleanup = async (primary: Error): Promise<never> => {
      if (createdBrowserId) {
        try { await api.browser.close(createdBrowserId) }
        catch (cleanupError) {
          throw controlFailure('LAUNCH_CLEANUP_FAILED', `${primary.message} Cleanup failed: ${presentError(cleanupError)}`, {
            cause: new AggregateError([primary, cleanupError])
          })
        }
      }
      throw primary
    }
    try {
      const browser = await api.browser.create(browserId, request.url)
      createdBrowserId = browser.id
      if (browser.id !== browserId) await cleanup(controlFailure('LAUNCH_RESULT_MISMATCH', 'Browser owner returned another Browser identity.'))
      if (signal?.aborted) await cleanup(controlCancellation(signal))
      const surface: BrowserWorkbenchSurface = {
        ...browser, regionId: plan.regionId, kind: 'browser', workspaceId: workspace.id, browserId
      }
      let attached = false
      set((current) => {
        const owner = findWorkbenchRegion(current.tabs, plan.regionId)
        if (
          !owner ||
          owner.tab.id !== plan.tabId ||
          owner.surface !== plan.launcher ||
          !workbenchViewCloseAllowsView(current.closingWorkbenchViews, owner.tab.id)
        ) return current
        attached = true
        return { tabs: { ...current.tabs, [owner.tab.id]: replaceWorkbenchRegion(owner.tab, plan.regionId, surface) } }
      })
      if (!attached) await cleanup(controlFailure('CONTROL_OWNER_LOST', 'Control Region owner disappeared during Browser creation.'))
      return {
        operation: request.operation,
        region: { tabId: plan.tabId, regionId: plan.regionId, workspaceId: workspace.id, kind: 'browser', browserId }
      }
    } catch (error) {
      rollback(plan.launcher)
      throw error
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  },
  selectSession(id, preferredTabGroupId) {
    if (!workbenchViewCloseAllowsSession(get().closingWorkbenchViews, id)) return
    const session = get().sessions.find((candidate) => candidate.id === id)
    const workspace = session ? workspaceForSession(get().config, session) : null
    if (!session || !workspace) return
    const existing = Object.values(get().tabs).flatMap((tab) => (
      workbenchSurfaces(tab).flatMap((surface) => (
        isSessionSurface(surface) && surface.sessionId === id
          ? [{ tab, surface }]
          : []
      ))
    ))[0]
    const tabId = existing?.tab.id ?? sessionTabId(id)
    const layout = get().layouts[workspace.id] ?? createWorkspaceLayout(newTabGroupId())
    const existingTabGroupId = tabGroupForTab(layout, tabId)
    const targetTabGroupId = existingTabGroupId ?? preferredTabGroupId ?? layout.activeGroupId
    const regionId = existing?.surface.regionId ?? initialWorkbenchRegionId(tabId)
    const surface: AgentWorkbenchSurface | TerminalWorkbenchSurface = {
      regionId,
      kind: session.kind,
      phase: 'attached',
      workspaceId: workspace.id,
      sessionId: id
    }
    const createdTab = existing
      ? replaceWorkbenchRegion(existing.tab, regionId, surface)
      : createWorkbenchTab(tabId, surface)
    const sessionTopicId = scratchTopicIdFromWorkspacePath(workspace.path, session.workspacePath)
    const tab = sessionTopicId ? { ...createdTab, topicId: sessionTopicId } : createdTab
    // Tab 已在某个分组里就只需激活；新建时必须真的挂上。挂不上（`preferredTabGroupId` 指向一个
    // 已不存在的分组）原先静默回落成原 layout：Tab 记录进了 state.tabs 而不在任何 tabOrder 里。
    // 这里刻意不「退回 activeGroupId」——请求的分组不在场时换一个窗口安放，正是 #307 那个
    // 「浮层里开到背后主界面」的形态。selectSession 是同步 void 动作，抛出只会变成事件处理里的
    // 未捕获异常，所以走 reportError 把失败摆到界面上。
    const nextLayout = existingTabGroupId
      ? activateLayoutTab(layout, targetTabGroupId, tabId)
      : addTabPlacement(layout, targetTabGroupId, tabId)
    if (!nextLayout) {
      get().reportError(new Error('The Tab Group is no longer available'))
      return
    }
    set((state) => ({
      activeWorkspaceId: workspace.id,
      mainSurface: 'workbench',
      tabs: { ...state.tabs, [tab.id]: tab },
      layouts: { ...state.layouts, [workspace.id]: nextLayout }
    }))
    if (existing) get().focusRegion(workspace.id, tabId, regionId)
  },
  openLauncher(tabGroupId) {
    const state = get()
    const workspaceId = state.activeWorkspaceId
    const layout = workspaceId ? state.layouts[workspaceId] : undefined
    if (!workspaceId || !layout) return
    const targetTabGroupId = tabGroupId ?? layout.activeGroupId
    const topicId = inheritedTopicIdForNewTab(workspaceId, layout, state.tabs, targetTabGroupId)
    const tab = newLauncherTab(workspaceId, topicId)
    // 同 selectSession：挂不上就报错并放弃，不留一条永不显示的孤儿 Tab。这是同步 void 动作
    // （唯一调用方是 Tab Bar 上的「+」），所以不抛。
    const nextLayout = addTabPlacement(layout, targetTabGroupId, tab.id)
    if (!nextLayout) {
      get().reportError(new Error('The Tab Group is no longer available'))
      return
    }
    set((state) => ({
      mainSurface: 'workbench',
      tabs: { ...state.tabs, [tab.id]: tab },
      layouts: { ...state.layouts, [workspaceId]: nextLayout }
    }))
  },
  closeTab(workspaceId, tabGroupId, tabId, options) {
    const state = get()
    const errorBeforeClose = state.error
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, tabId)) {
      return Promise.resolve(false)
    }
    const plan = planWorkbenchViewClose({
      tabs: state.tabs,
      layouts: state.layouts,
      sessions: state.sessions,
      workspaceId,
      tabGroupId,
      tabId,
      keepAgentSessions: options?.keepAgentSessions === true,
      closingViewIds: new Set(Object.keys(state.closingWorkbenchViews))
    })
    if (!plan) return Promise.resolve(true)
    if (!plan.closesView) {
      set((current) => reconcileWorkbenchFileProjection(
        current,
        applyWorkbenchViewCloseTopology(current, plan, null)
      ))
      pruneEditorRegionState(get().tabs)
      return Promise.resolve(true)
    }
    if (plan.resources.length === 0) {
      const reconciliation = reconcileWorkbenchViewClose({
        plan,
        currentTab: state.tabs[tabId],
        currentSessions: state.sessions,
        receipts: []
      })
      const previousTabs = state.tabs
      set((current) => reconcileWorkbenchFileProjection(
        current,
        applyWorkbenchViewCloseTopology(current, plan, reconciliation.tab)
      ))
      pruneEditorRegionState(get().tabs)
      return disposeClosedFileOwners(previousTabs, get().tabs).then(
        () => true,
        (error) => {
          get().reportError(error)
          return false
        }
      )
    }
    set((current) => ({
      closingWorkbenchViews: {
        ...current.closingWorkbenchViews,
        [tabId]: plan
      }
    }))
    return (async () => {
      try {
        const [browserReceipts, sessionReceipts] = await Promise.all([
          settleWorkbenchViewCloseResources(
            plan.resources.filter((resource) => resource.kind === 'browser'),
            async (resource) => await api.browser.close(resource.browserId)
          ),
          settleWorkbenchViewCloseResources(
            plan.resources.filter((resource) => resource.kind === 'session'),
            async (resource) => {
              const current = get()
              if (!current.sessions.some((session) => (
                session.id === resource.sessionId && sessionOwnsControl(session, resource.control)
              ))) return
              if (hasAttachedSessionOutsideClosingViews({
                tabs: current.tabs,
                plans: current.closingWorkbenchViews,
                sessionId: resource.sessionId
              })) {
                throw new Error(`Session gained another View while closing: ${resource.sessionId}`)
              }
              await api.sessions.stop(resource.control)
            }
          )
        ])
        const reconciliation = reconcileWorkbenchViewClose({
          plan,
          currentTab: get().tabs[tabId],
          currentSessions: get().sessions,
          receipts: [...browserReceipts, ...sessionReceipts]
        })
        const previousTabs = get().tabs
        set((current) => reconcileWorkbenchFileProjection(
          current,
          applyWorkbenchViewCloseTopology(current, plan, reconciliation.tab)
        ))
        await disposeClosedFileOwners(previousTabs, get().tabs)
        pruneEditorRegionState(get().tabs)
        if (reconciliation.failures.length > 0) {
          get().reportError(workbenchViewCloseFailure(reconciliation.failures))
        } else if (reconciliation.changedWhileClosing) {
          if (get().error === errorBeforeClose) {
            get().reportError(new Error('The View changed while it was closing. Review it and close it again.'))
          }
        }
        return reconciliation.failures.length === 0 && !reconciliation.changedWhileClosing
      } catch (error) {
        get().reportError(error)
        return false
      } finally {
        set((current) => {
          if (current.closingWorkbenchViews[tabId] !== plan) return current
          const closingWorkbenchViews = { ...current.closingWorkbenchViews }
          delete closingWorkbenchViews[tabId]
          return { closingWorkbenchViews }
        })
      }
    })()
  },
  moveTab(workspaceId, tabId, sourcePaneId, targetPaneId, visibleTargetIndex) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    const layout = current.layouts[workspaceId]
    if (!layout) return
    set((state) => ({
      layouts: {
        ...state.layouts,
        // 落点下标来自渲染层看到的（已按 Topic 投影的）顺序，必须先翻回存储坐标再交给
        // reducer；直接透传就是 #556 的主缺陷。翻译只有一处，见 moveTabWithinActiveTopic。
        [workspaceId]: moveTabWithinActiveTopic(layout, current.tabs, {
          tabId,
          sourceGroupId: sourcePaneId,
          targetGroupId: targetPaneId,
          visibleTargetIndex
        })
      }
    }))
  },
  moveTabToNewGroup(workspaceId, tabId, sourcePaneId, targetPaneId, direction) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    const layout = current.layouts[workspaceId]
    if (!layout) return
    set((state) => ({
      layouts: {
        ...state.layouts,
        [workspaceId]: moveLayoutTabToNewGroup(
          layout,
          tabId,
          sourcePaneId,
          targetPaneId,
          direction,
          newTabGroupId()
        )
      }
    }))
  },
  focusRegion(workspaceId, tabId, regionId, cause = 'pointer') {
    const tab = get().tabs[tabId]
    const layout = get().layouts[workspaceId]
    const tabGroupId = layout ? tabGroupForTab(layout, tabId) : null
    if (!tab || tab.workspaceId !== workspaceId || !tabGroupId || !tab.regions[regionId]) return
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: focusWorkbenchTabRegion(tab, regionId) },
      layouts: {
        ...state.layouts,
        [workspaceId]: activateLayoutTab(layout!, tabGroupId, tabId)
      },
      // 只有键盘导航这一路才把 DOM caret 也搬过去（regionFocusClaimsCaret）。判据是这次落焦的**因**，不是
      // 「谁成了焦点」——指针点击那一路原生 mousedown 已把焦点放对，再夺一次会打断选择/原生行为。同一个
      // regionId 驱动绿环、原生视图让位、与这条 caret 意图，三者读同一次判定（region-focus.ts 顶部的纪律）。
      // nonce 递增让「连按方向键停在同一格」也能各触发一次，且 selector 不因对象相等忽略它。
      ...(regionFocusClaimsCaret(cause)
        ? { regionCaretFocus: { regionId, nonce: ++regionCaretFocusNonce } }
        : { regionCaretFocus: null })
    }))
  },
  clearRegionCaretFocus(nonce) {
    // 只清掉自己消费的那一条：若清的瞬间已被更晚一次导航覆盖成新 nonce，别把新意图也抹掉。
    set((state) => (state.regionCaretFocus?.nonce === nonce ? { regionCaretFocus: null } : state))
  },
  moveSessionViewToWorkspace(regionId, targetWorkspaceId) {
    const state = get()
    const owner = findWorkbenchRegion(state.tabs, regionId)
    if (!owner) return
    const surface = owner.surface
    // Only a Session projection can be moved; a file/launcher/browser Region has no cwd to protect
    // and no Session identity to relocate. `isSessionSurface` is that membership test's one home, so a
    // sixth session-bearing kind is declared there rather than being silently excluded here.
    if (!isSessionSurface(surface)) return
    // A closing source View must not be half-moved out from under its own teardown. Surface the
    // refusal on the existing error banner rather than mutating the layout.
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, owner.tab.id)) {
      get().reportError(new Error('The View is closing'))
      return
    }
    const result = reduceMoveSessionView({
      tabs: state.tabs,
      layouts: state.layouts,
      regionId,
      sessionId: surface.sessionId,
      targetWorkspaceId,
      workspaceIds: (state.config?.workspaces ?? []).map((workspace) => workspace.id),
      mint: { tabId: `view:${crypto.randomUUID()}`, tabGroupId: newTabGroupId(), regionId: newRegionId() }
    })
    if (result.kind !== 'moved') return
    // One atomic layout replacement, then navigate with the same focus path selectSession uses —
    // no second navigation route, no fabricated cwd.
    set({
      activeWorkspaceId: result.target.workspaceId,
      mainSurface: 'workbench',
      tabs: result.tabs,
      layouts: result.layouts
    })
    get().focusRegion(result.target.workspaceId, result.target.tabId, result.target.regionId)
  },
  splitRegion(workspaceId, tabId, regionId, direction) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    const tab = current.tabs[tabId]
    if (!tab || tab.workspaceId !== workspaceId || !tab.regions[regionId]) return
    const addedRegionId = newRegionId()
    const launcher: LauncherWorkbenchSurface = {
      regionId: addedRegionId,
      kind: 'launcher',
      workspaceId
    }
    const nextTab = addWorkbenchRegion(tab, regionId, direction, launcher)
    if (nextTab === tab) return
    set((state) => ({ tabs: { ...state.tabs, [tabId]: nextTab } }))
  },
  arrangeTabRegions(workspaceId, tabId, mode) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    const tab = current.tabs[tabId]
    if (!tab || tab.workspaceId !== workspaceId) return
    // 与控制协议的 `arrange` 分支共用同一个引擎，且**不重算**「要补几个格」——那次推导住在
    // arrangeWorkbenchControlTab 里，这里连数都数不着。两侧各算一遍必漂移，症状是同一个预设
    // 从菜单点没反应、从命令行却好用（见那个函数的注释）。三档重排（预设 / 均分 / 当前格优先）
    // 也是同一个理由走同一条路：本方法不认 mode 的档，原样转交。
    let arranged: WorkbenchTab
    try {
      arranged = arrangeWorkbenchControlTab(tab, mode, newRegionId)
    } catch (error) {
      // 引擎的拒绝是有话要说的（格数超了、id 撞了），不能咽掉——菜单里点了没反应就是最难查的那种。
      get().reportError(error)
      return
    }
    if (arranged === tab) return
    set((state) => ({ tabs: { ...state.tabs, [tabId]: arranged } }))
  },
  swapRegions(workspaceId, tabId, regionIdA, regionIdB) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    const tab = current.tabs[tabId]
    if (!tab || tab.workspaceId !== workspaceId) return
    // 换位的合法性（两个端点都在场、不与自己换）由 swapWorkbenchTabRegions → swapWorkbenchRegions
    // 自己守；挂不上时原样返回，这里据 `===` 判定不写回，避免无谓的重渲染。
    const nextTab = swapWorkbenchTabRegions(tab, regionIdA, regionIdB)
    if (nextTab === tab) return
    set((state) => ({ tabs: { ...state.tabs, [tabId]: nextTab } }))
  },
  promoteRegionToTab(workspaceId, tabId, regionId) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    // 合法性（Tab 归属、格在场、只剩一格是 no-op）全由 reducePromoteRegionToTab 自己守；促升不成立时
    // 交回 'unchanged'，这里据此不写回，避免无谓的重渲染。regionId 原样带去新 Tab（不新铸），故 browser
    // /editor/terminal 的按 regionId 索引的内容不用回收，不像 closeRegion 要 pruneEditorRegionState。
    const result = reducePromoteRegionToTab({
      tabs: current.tabs,
      layouts: current.layouts,
      workspaceId,
      tabId,
      regionId,
      mint: { tabId: `view:${crypto.randomUUID()}` }
    })
    if (result.kind !== 'promoted') return
    // One atomic state replacement. The reducer's layout already made the new Tab the active Tab of its
    // group and focused that group, and the new Tab's sole Region is its active Region by construction —
    // so there is no second focus/navigation route to run (that would be a place for the two to drift).
    // What the reducer cannot know is the app-shell framing: bring the promoted Region's workspace and the
    // workbench surface forward so the new Tab is actually on screen — the user asked for this Region to
    // become its own Tab, so they want to see it. (mainSurface/activeWorkspaceId are normally already
    // these values, since the Region was right-clicked in the visible workbench, but setting them makes
    // "show the new Tab" true regardless of how the action was reached — e.g. a future command palette.)
    set({
      activeWorkspaceId: result.target.workspaceId,
      mainSurface: 'workbench',
      tabs: result.tabs,
      layouts: result.layouts
    })
  },
  async closeRegion(workspaceId, tabId, regionId) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    const tab = current.tabs[tabId]
    const surface = tab?.regions[regionId]
    if (!tab || tab.workspaceId !== workspaceId || !surface) return
    if (!removeWorkbenchRegion(tab, regionId)) return
    // What this surface owns outside the tree is decided once, exhaustively (workbench-surface-kinds).
    // Asking `kind === 'browser'` / `kind === 'file'` here instead would let a sixth resource-bearing
    // kind answer "nothing to release" and leak with no compile error.
    const obligations = surfaceCloseObligations(surface)
    if (obligations.browserViewId !== null) {
      try {
        await api.browser.close(obligations.browserViewId)
      } catch (error) {
        get().reportError(error)
        return
      }
    }
    const previousTabs = get().tabs
    set((state) => {
      const liveTab = state.tabs[tabId]
      if (!liveTab || !sameWorkbenchSurfaceOwner(liveTab.regions[regionId], surface)) return state
      const nextTab = removeWorkbenchRegion(liveTab, regionId)
      if (!nextTab) return state
      const tabs = { ...state.tabs, [tabId]: nextTab }
      return obligations.releasesDocument
        ? reconcileWorkbenchFileProjection(state, { tabs, layouts: state.layouts })
        : { tabs }
    })
    pruneEditorRegionState(get().tabs)
    if (obligations.releasesDocument) await disposeClosedFileOwners(previousTabs, get().tabs)
  },
  requestCloseTab(workspaceId, tabGroupId, tabId) {
    // 只投意图，不在这里关：真正的关闭要经组件的 requestTabsClose（未保存/在跑 Agent 的确认对话框只活在
    // 组件里）。nonce 让「连按两次 Cmd+W 关同一张 Tab」也能各触发一次——同一 tabId 重复投递不会因对象
    // 相等而被 selector 忽略。
    set((state) => ({
      closeTabRequest: { workspaceId, tabGroupId, tabId, nonce: (state.closeTabRequest?.nonce ?? 0) + 1 }
    }))
  },
  clearCloseTabRequest(nonce) {
    // 只清掉自己消费的那一条：若清的瞬间已被更晚一次按键覆盖成新 nonce，别把新意图也抹掉。
    set((state) => (state.closeTabRequest?.nonce === nonce ? { closeTabRequest: null } : state))
  },
  requestCloseRegion(workspaceId, tabId, regionId) {
    // 只投意图，不在这里关：真正的关闭（含未保存确认）在承载该格的组件里，与鼠标点这一格的 X 同一条路。
    // nonce 让「连按两次 Cmd+W 关同一格」也能各触发一次——同一 regionId 重复投递不会因对象相等被 selector 忽略。
    set((state) => ({
      closeRegionRequest: {
        workspaceId,
        tabId,
        regionId,
        nonce: (state.closeRegionRequest?.nonce ?? 0) + 1
      }
    }))
  },
  clearCloseRegionRequest(nonce) {
    // 只清掉自己消费的那一条：若清的瞬间已被更晚一次按键覆盖成新 nonce，别把新意图也抹掉。
    set((state) => (state.closeRegionRequest?.nonce === nonce ? { closeRegionRequest: null } : state))
  },
  updateRegionSplitRatio(workspaceId, tabId, nodePath, ratio) {
    const tab = get().tabs[tabId]
    if (!tab || tab.workspaceId !== workspaceId) return
    set((state) => ({
      tabs: {
        ...state.tabs,
        [tabId]: {
          ...tab,
          layout: setWorkbenchRegionSplitRatio(tab.layout, nodePath, ratio)
        }
      }
    }))
  },
  updateSplitRatio(workspaceId, nodePath, ratio) {
    const layout = get().layouts[workspaceId]
    if (!layout) return
    set((state) => ({
      layouts: {
        ...state.layouts,
        [workspaceId]: setSplitRatio(layout, nodePath, ratio)
      }
    }))
  },
  setViewMode(sessionId, mode) {
    set((state) => ({ viewModes: { ...state.viewModes, [sessionId]: mode } }))
  },
  toggleEditorWordWrap() {
    set((state) => ({ editorWordWrap: !state.editorWordWrap }))
  },
  async setEditorRegionMode(regionId, workspaceId, path, mode) {
    set((state) => ({ editorRegionModes: { ...state.editorRegionModes, [regionId]: mode } }))
    // Only entering diff triggers a load, and only when this Region has no diff yet — switching back
    // and forth must not refetch. An explicit refresh goes through reloadRegionDiff.
    if (mode === 'diff' && !get().editorRegionDiffs[regionId]) {
      await loadRegionDiff(regionId, workspaceId, path)
    }
  },
  async reloadRegionDiff(regionId, workspaceId, path) {
    await loadRegionDiff(regionId, workspaceId, path)
  },
  async openFileDiff(path) {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) return
    // 同 createNote：把开头解析出来的那一个显式传下去。下面 regionId 是按这个 workspaceId 派生的，
    // 若 openFile 自己重读活动 Workspace，两者就会指向不同的 Workspace——文件在 A 打开、diff 模式
    // 却切到了 B 的 Region（或谁的都不是）。
    await get().openFile(path, undefined, undefined, workspaceId)
    // openFile places the file at its canonical Region, so the id is derived by the same rule rather
    // than read back — a wrong regionId here would flip a different Region into diff mode (or none).
    const regionId = initialWorkbenchRegionId(fileTabId(workspaceId, path))
    await get().setEditorRegionMode(regionId, workspaceId, path, 'diff')
  },
  renameAgent(sessionId, name) {
    const trimmed = name?.trim() ?? ''
    set((state) => {
      if (trimmed.length > 0) {
        return { agentNames: { ...state.agentNames, [sessionId]: trimmed } }
      }
      if (state.agentNames[sessionId] === undefined) return state
      const { [sessionId]: _cleared, ...rest } = state.agentNames
      return { agentNames: rest }
    })
  },
  renameTab(tabId, name) {
    set((state) => {
      const tab = state.tabs[tabId]
      if (!tab) return state
      const renamed = renameWorkbenchTab(tab, name)
      return renamed === tab ? state : { tabs: { ...state.tabs, [tabId]: renamed } }
    })
  },
  setMainSurface(mainSurface) {
    set({ mainSurface })
  },
  toggleProjectRail() {
    set((state) => ({ projectRailOpen: !state.projectRailOpen }))
  },
  toggleProjectGroup(key) {
    set((state) => {
      // 折叠集合里**删掉**而不是写 false：只存折叠的那些，展开就是不在集合里（见状态声明）。
      // 写 `{...state, [key]: false}` 会让这份记录随着用户开合越攒越多，且和"新分组默认展开"
      // 变成两条规则。
      const { [key]: collapsed, ...rest } = state.collapsedProjectGroups
      return { collapsedProjectGroups: collapsed ? rest : { ...rest, [key]: true } }
    })
  },
  setTabMenuOpen(tabMenuOpen) {
    set({ tabMenuOpen })
  },
  setWorkspaceTool(workspaceTool) {
    set({ workspaceTool, toolsOpen: true, mainSurface: 'workbench' })
  },
  toggleTools() {
    set((state) => ({ toolsOpen: !state.toolsOpen }))
  },
  setProjectRailWidth(projectRailWidth) {
    set({ projectRailWidth: clampProjectRailWidth(projectRailWidth) })
  },
  setToolDockWidth(toolDockWidth) {
    set({ toolDockWidth: clampToolDockWidth(toolDockWidth) })
  },
  updateFileExplorerState(workspaceId, update) {
    set((state) => ({
      fileExplorerStates: {
        ...state.fileExplorerStates,
        [workspaceId]: update(
          state.fileExplorerStates[workspaceId] ?? createEmptyFileExplorerViewState()
        )
      }
    }))
  },
  async detectExecutors(hostId) {
    const executorIds = Object.keys(get().config?.executors ?? {})
    if (executorIds.length === 0) return
    if (executorIds.some((executorId) => get().executorDetections[executorDetectionKey(hostId, executorId)]?.state === 'checking')) return
    const requestId = (detectionRequestIds.get(hostId) ?? 0) + 1
    detectionRequestIds.set(hostId, requestId)
    set((state) => ({
      executorDetections: {
        ...state.executorDetections,
        ...Object.fromEntries(
          executorIds.map((executorId) => [executorDetectionKey(hostId, executorId), { state: 'checking' } satisfies ExecutorDetectionState])
        )
      }
    }))
    await Promise.all(
      executorIds.map(async (executorId) => {
        try {
          const result = await api.executors.detect(executorId, hostId)
          if (detectionRequestIds.get(hostId) !== requestId) return
          // 三态探测结局 → store 的检查状态：available→ready, missing→missing, check-failed→error。
          // check-failed（环境退化，我们没查成）落到 error 而不是 missing——这正是那次误报要防的：
          // 「没查成」绝不能显示成「没装」。AgentSettingsPane 的 'error' 文案已是 "Check failed"。
          const state: AsyncCheckState = result.availability === 'available'
            ? 'ready'
            : result.availability === 'missing'
              ? 'missing'
              : 'error'
          set((current) => ({
            executorDetections: {
              ...current.executorDetections,
              [executorDetectionKey(hostId, executorId)]: {
                state,
                result,
                observedAt: Date.now()
              }
            }
          }))
        } catch (error) {
          if (detectionRequestIds.get(hostId) !== requestId) return
          set((state) => ({
            executorDetections: {
              ...state.executorDetections,
              [executorDetectionKey(hostId, executorId)]: {
                state: 'error',
                detail: presentError(error),
                observedAt: Date.now()
              }
            }
          }))
        }
      })
    )
  },
  async checkHost(host) {
    const requestId = (hostCheckRequestIds.get(host.id) ?? 0) + 1
    hostCheckRequestIds.set(host.id, requestId)
    set((state) => ({
      hostChecks: { ...state.hostChecks, [host.id]: { state: 'checking' } }
    }))
    try {
      const result = await api.hosts.check(host)
      if (hostCheckRequestIds.get(host.id) !== requestId) return
      set((state) => ({
        hostChecks: {
          ...state.hostChecks,
          [host.id]: {
            state: result.ok ? 'ready' : 'error',
            result,
            detail: result.detail,
            observedAt: Date.now()
          }
        }
      }))
    } catch (error) {
      if (hostCheckRequestIds.get(host.id) !== requestId) return
      set((state) => ({
        hostChecks: {
          ...state.hostChecks,
          [host.id]: { state: 'error', detail: presentError(error), observedAt: Date.now() }
        }
      }))
    }
  },
  async openFile(path, tabGroupId, location, requestedWorkspaceId) {
    // 显式 workspace 优先于活动 workspace。异步动作（建文件、切 diff）必须能把**自己开头那次**
    // 解析结果传进来：否则调用方解析一次、这里再解析一次，两次之间用户切了侧栏就漂移，
    // 而漂移的症状不是报错而是**开错文件**——名字撞上另一个项目里的同名文件时界面上一切正常。
    const workspaceId = requestedWorkspaceId ?? get().activeWorkspaceId
    const layout = workspaceId ? get().layouts[workspaceId] : undefined
    if (!workspaceId || !layout) return
    const key = documentKey(workspaceId, path)
    // Stash the reveal target before opening. EditorPane consumes it once on Monaco mount (new
    // document) or on the `line` prop it reads (already-open document), then clears it. Setting it
    // for both paths means re-clicking a `:line` link on an open file re-reveals that line.
    if (location) {
      set((state) => ({
        documentRevealTargets: { ...state.documentRevealTargets, [key]: location }
      }))
    }
    try {
      const existing = get().documents[key]
      if (existing) {
        const targetGroupId = tabGroupId ?? layout.activeGroupId
        const activeTabId = findGroup(layout, targetGroupId)?.activeTabId
        const topicId = activeTabId ? get().tabs[activeTabId]?.topicId : undefined
        set((state) => reduceFileOpened(state, workspaceId, path, existing, tabGroupId, topicId))
        return
      }
      while (!get().documents[key]) {
        let request = fileOpenRequests.get(key)
        const joinedRequest = Boolean(request)
        if (!request) {
          const openedLifetime = advanceDocumentLifetime(key)
          request = Promise.resolve().then(async () => {
            try {
              const invalidationSequence = fileInvalidationSequences.get(key) ?? 0
              await api.files.observe(workspaceId, path)
              const result = await api.files.read(workspaceId, path)
              if (result.status === 'directory') {
                // A clicked path can be a directory (detection is pure-string and cannot know), and
                // a directory is not a document. Reveal it in the file tree — the same behaviour the
                // explorer already gives a directory click — and surface the Files dock so the reveal
                // is visible even when the click came from a terminal or a chat message.
                await api.files.unobserve(workspaceId, path)
                get().updateFileExplorerState(workspaceId, (current) =>
                  revealFileExplorerPath(current, path))
                set({ workspaceTool: 'files-branches', toolsOpen: true, mainSurface: 'workbench' })
                return false
              }
              if (result.status !== 'read') {
                await api.files.unobserve(workspaceId, path)
                throw new Error(result.status === 'deleted'
                  ? `File was deleted: ${path}`
                  : result.message)
              }
              if (documentLifetime(key) !== openedLifetime) {
                await api.files.unobserve(workspaceId, path)
                return false
              }
              const currentLayout = get().layouts[workspaceId]
              if (!currentLayout) {
                await api.files.unobserve(workspaceId, path)
                return false
              }
              const targetGroupId = tabGroupId ?? currentLayout.activeGroupId
              const activeTabId = findGroup(currentLayout, targetGroupId)?.activeTabId
              const topicId = activeTabId ? get().tabs[activeTabId]?.topicId : undefined
              set((state) => reduceFileOpened(state, workspaceId, path, result.document, tabGroupId, topicId))
              if (fileOpenRequests.get(key) === request) fileOpenRequests.delete(key)
              if ((fileInvalidationSequences.get(key) ?? 0) !== invalidationSequence) {
                await refreshFileDocument(workspaceId, path, openedLifetime)
              }
              return true
            } catch (error) {
              get().reportError(error)
              return false
            } finally {
              if (fileOpenRequests.get(key) === request) fileOpenRequests.delete(key)
            }
          })
          fileOpenRequests.set(key, request)
        }
        const opened = await request
        if (!opened || get().documents[key]) return
        if (!joinedRequest) return
      }
    } catch (error) {
      get().reportError(error)
    } finally {
      // 「跳到第 N 行」是一次性的，而它的存放位置**会被复用**：key 是 `ws\0path`，确定性的。
      // 上面那次写入排在所有失败出口之前（必须如此——已开着的文件重点一次链接也要重新跳），
      // 而这个方法有四个失败出口（目录分支、读失败、lifetime 作废、layout 没了），任何一个
      // 走掉都会把 target 留在盘上。症状不是报错：用户之后从文件树打开同一个文件、没要求
      // 任何行号，EditorPane 挂载时把这条陈旧 target 消费掉，光标自己跳到上次那条失败链接
      // 里的行。
      //
      // 判据只有一处，而不是在四个出口各清一次：**没有文档落地在这个 key 上，target 就不该
      // 留着**。逐出口补清理必然漂移，而且新增第五个出口时没人会想起来
      //（记忆 two-write-sites-need-one-projection / guard-count-exits-not-conditions）。
      //
      // 「有文档就不动」这一条同时罩住了并发：两次点同一个文件（`foo.ts:42` 然后 `foo.ts:99`，
      // 第二次 join 第一次的在途请求）时，只要有一次成功，`documents[key]` 就在场，两个
      // finally 谁都不撤——后写的那个 target 赢。此处刻意**不**比 target 的同一性：
      // 实测加上 `!== location` 这层判断对任何时序都改变不了结果（两次都失败时撤掉是对的；
      // 有一次成功时上面那句已经挡住了），它是多余条件，而多余条件会让下一个人以为有场景
      // 依赖它（记忆 surviving-mutation-may-be-dead-condition）。
      //
      // 撤的动作走 `clearDocumentRevealTarget`——EditorPane 消费完之后调的也是它。就地再写一份
      // delete 会让「怎么撤一个 target」有两处取值层，必然漂移。
      if (location && !get().documents[key]) get().clearDocumentRevealTarget(key)
    }
  },
  async attachPersistedFileDocument(workspaceId, path) {
    await loadPersistedFileDocument(workspaceId, path)
  },
  clearDocumentRevealTarget(key) {
    set((state) => {
      if (!state.documentRevealTargets[key]) return state
      const next = { ...state.documentRevealTargets }
      delete next[key]
      return { documentRevealTargets: next }
    })
  },
  async createScratchTopic() {
    const state = get()
    const workspace = state.config?.workspaces.find((item) => item.id === state.activeWorkspaceId)
    if (!workspace || !isScratchWorkspaceId(workspace.id)) {
      throw new Error('Select the Scratch workspace first')
    }
    const layout = state.layouts[workspace.id]
    if (!layout) throw new Error('Scratch workspace layout is unavailable')
    const group = findGroup(layout, layout.activeGroupId)
    const activeTab = group?.activeTabId ? state.tabs[group.activeTabId] : undefined
    const activeSurface = activeTab ? titleWorkbenchSurface(activeTab) : undefined
    const canOwnTopic = activeTab &&
      !activeTab.topicId &&
      (activeSurface?.kind === 'launcher' || activeSurface?.kind === 'agent') &&
      isScratchTopicId(activeTab.id)
    const targetTab = canOwnTopic ? activeTab : newLauncherTab(workspace.id)
    const topicId = targetTab.topicId ?? targetTab.id
    const snapshot = await api.scratch.ensureTopic(workspace.id, topicId)
    let placementFailed = false
    set((current) => {
      const currentLayout = current.layouts[workspace.id]
      if (!currentLayout) return current
      const nextTab = { ...targetTab, topicId }
      const alreadyOpen = Boolean(current.tabs[targetTab.id])
      // 已在场只需激活；新建必须真的挂上，挂不上就整笔放弃（见 addTabPlacement）。
      // 不在 set 回调里抛：抛在 reducer 中间会让「有没有写进去」变得难读，故先记标记后抛。
      const nextLayout = alreadyOpen
        ? activateLayoutTab(currentLayout, layout.activeGroupId, nextTab.id)
        : addTabPlacement(currentLayout, layout.activeGroupId, nextTab.id)
      if (!nextLayout) {
        placementFailed = true
        return current
      }
      return {
        tabs: { ...current.tabs, [nextTab.id]: nextTab },
        layouts: { ...current.layouts, [workspace.id]: nextLayout },
        workspaceFileRevisions: bumpWorkspaceFileRevision(
          current.workspaceFileRevisions,
          workspace.id
        )
      }
    })
    if (placementFailed) throw new Error('The Tab Group is no longer available')
    return snapshot
  },
  setScratchTopicOrder(order) {
    set({ scratchTopicOrder: [...order] })
  },
  async openScratchTopic(topicId) {
    const state = get()
    const workspace = state.config?.workspaces.find((item) => item.id === state.activeWorkspaceId)
    if (!workspace || !isScratchWorkspaceId(workspace.id)) {
      throw new Error('Select the Scratch workspace first')
    }
    const snapshot = await api.scratch.readTopic(workspace.id, topicId)
    if (!snapshot) throw new Error('Scratch Topic no longer exists')
    let placementFailed = false
    set((current) => {
      const layout = current.layouts[workspace.id]
      if (!layout) return current
      const boundTab = Object.values(current.tabs).find((tab) =>
        tab.workspaceId === workspace.id &&
        tab.topicId === topicId &&
        tabGroupForTab(layout, tab.id) !== null
      )
      if (boundTab) {
        const groupId = tabGroupForTab(layout, boundTab.id)!
        return {
          // 切 Topic 就像切 Branch：换掉那一组 Tab。真相仍是这一份 layout——激活该 Topic 的
          // Tab 就够了，当前 Topic 由活动 Tab 派生（scratch-topic-layout.ts），不另存一份。
          layouts: {
            ...current.layouts,
            [workspace.id]: activateLayoutTab(layout, groupId, boundTab.id)
          }
        }
      }
      const tab = { ...newLauncherTab(workspace.id), topicId }
      const nextLayout = addTabPlacement(layout, layout.activeGroupId, tab.id)
      if (!nextLayout) {
        placementFailed = true
        return current
      }
      return {
        tabs: { ...current.tabs, [tab.id]: tab },
        layouts: { ...current.layouts, [workspace.id]: nextLayout }
      }
    })
    if (placementFailed) throw new Error('The Tab Group is no longer available')
  },
  async renameScratchTopic(topicId, title) {
    const state = get()
    const workspace = state.config?.workspaces.find((item) => item.id === state.activeWorkspaceId)
    if (!workspace || !isScratchWorkspaceId(workspace.id)) {
      throw new Error('Select the Scratch workspace first')
    }
    try {
      const snapshot = await api.scratch.renameTitle(workspace.id, topicId, title)
      set((current) => ({
        workspaceFileRevisions: bumpWorkspaceFileRevision(
          current.workspaceFileRevisions,
          workspace.id
        )
      }))
      return snapshot
    } catch (error) {
      get().reportError(error)
      throw error
    }
  },
  async createPath(input) {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) throw new Error('Select a workspace first')
    try {
      await api.files.create(workspaceId, input)
    } catch (error) {
      get().reportError(error)
      throw error
    }
    // FileExplorer refreshes its own tree after this resolves, but it is not the only reader: the
    // Topics panel and the Board invalidate on this counter alone. Bumping here rather than relying
    // on "FileExplorer is the sole caller" — that reason expires the moment something else calls it.
    set((current) => ({
      workspaceFileRevisions: bumpWorkspaceFileRevision(current.workspaceFileRevisions, workspaceId)
    }))
    return workspaceId
  },
  async createNote(tabGroupId, launcher) {
    const state = get()
    const launcherTab = launcher ? state.tabs[launcher.tabId] : undefined
    // 「落在哪个 Workspace」与其余四个启动动作走同一条判定。此前这里只读 activeWorkspaceId，
    // 于是 launcher 绑在 A 而活动 Workspace 是 B 时笔记建到 B——见 resolveLauncherWorkspaceId 的注释。
    const workspaceId = resolveLauncherWorkspaceId({
      launcherTabWorkspaceId: launcherTab?.workspaceId,
      activeWorkspaceId: state.activeWorkspaceId
    })
    if (!workspaceId) throw new Error('Select a workspace first')
    const name = await createNoteWithAvailableName(
      new Date(),
      // 刻意不走 createPath：那条路每次失败都 reportError，而撞名重试是这里的**正常**流程，
      // 会把一串「文件已存在」推到全局错误面上。只有走完全部候选后的那次真失败才该冒出去，
      // 由调用方（launcher 的 run()）显示。
      async (candidate) => { await api.files.create(workspaceId, { path: candidate, kind: 'file' }) }
    )
    // 让文件树看到新文件。createScratchTopic 等写入面用的是同一个计数器，不另起一套失效机制。
    set((current) => ({
      workspaceFileRevisions: bumpWorkspaceFileRevision(current.workspaceFileRevisions, workspaceId)
    }))
    // 显式把开头解析出来的 workspaceId 传下去。create walk 是异步的（远端可达 15s），这期间侧栏
    // 的 selectWorkspace 完全可点；若让 openFile 自己重读活动 Workspace，笔记建在 A 而打开的是
    // B 里的同名文件——名字只是当天日期，撞名概率很高，而用户看到的一切都正常。
    //
    // `tabGroupId` 同样必须传下去（而不是让 openFile 退到 `layout.activeGroupId`）：请求这条笔记的
    // 分组才是它该出现的地方。缺了它，从一个非活动分组（分屏的另一半、或将来浮层里的那个 launcher）
    // 建笔记，Tab 会挂到别的分组上——用户点了「Note」却看不见任何变化。
    await get().openFile(name, tabGroupId, undefined, workspaceId)
    return name
  },
  async renamePath(path, nextPath) {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) throw new Error('Select a workspace first')
    return await withWorkspaceFileMutation(workspaceId, path, async () => {
      const stateBeforeMove = get()
      const collision = findFileRenameProjectionCollision(stateBeforeMove, workspaceId, path, nextPath)
      if (collision) {
        const error = Object.assign(
          new Error(`The destination is already open in the workbench: ${collision.path}`),
          { code: 'WORKSPACE_MOVE_RENDERER_DESTINATION_OWNED' }
        )
        get().reportError(error)
        throw error
      }
      const observedPaths = Object.keys(stateBeforeMove.documents).flatMap((key) => {
        const prefix = `${workspaceId}\0`
        if (!key.startsWith(prefix)) return []
        const documentPath = key.slice(prefix.length)
        return isPathWithinSubtree(documentPath, path) ? [documentPath] : []
      })
      let result
      try {
        result = await api.files.move({
          source: { workspaceId, path },
          destination: { workspaceId, path: nextPath }
        })
      } catch (error) {
        get().reportError(error)
        throw error
      }
      if (result.status === 'error') {
        const error = Object.assign(new Error(result.message), {
          code: result.code,
          finalLocation: result.finalLocation
        })
        get().reportError(error)
        throw error
      }
      for (const observedPath of observedPaths) {
        advanceDocumentLifetime(documentKey(workspaceId, observedPath))
      }
      set((state) => ({
        ...reduceFileRename(state, workspaceId, path, nextPath),
        // Same reason as `createPath`: the Topics panel and the Board read this counter and nothing
        // else. Moving a Topic's `topic.md` out breaks the Topic's identity, and only the file tree
        // would notice. Folded into the projection's own `set` so it is one render, not two.
        workspaceFileRevisions: bumpWorkspaceFileRevision(state.workspaceFileRevisions, workspaceId)
      }))
      for (const observedPath of observedPaths) {
        const renamedPath = remapPathWithinSubtree(observedPath, path, nextPath)
        transferFileSaveTail(workspaceId, observedPath, renamedPath)
        try {
          await api.files.unobserve(workspaceId, observedPath)
        } catch (error) {
          get().reportError(error)
        }
        try {
          await api.files.observe(workspaceId, renamedPath)
        } catch (error) {
          get().reportError(error)
        }
        try {
          await get().refreshDocument(workspaceId, renamedPath)
        } catch (error) {
          get().reportError(error)
        }
      }
    })
  },
  async deletePath(path) {
    const workspaceId = get().activeWorkspaceId
    if (!workspaceId) throw new Error('Select a workspace first')
    return await withWorkspaceFileMutation(workspaceId, path, async () => {
      const observedPaths = Object.keys(get().documents).flatMap((key) => {
        const prefix = `${workspaceId}\0`
        if (!key.startsWith(prefix)) return []
        const documentPath = key.slice(prefix.length)
        return isPathWithinSubtree(documentPath, path) ? [documentPath] : []
      })
      try {
        await api.files.delete(workspaceId, path)
        for (const observedPath of observedPaths) {
          advanceDocumentLifetime(documentKey(workspaceId, observedPath))
        }
        set((state) => ({
          ...reduceFileDelete(state, workspaceId, path),
          // Deleting a Topic's directory is the only way to delete a Topic (there is no
          // `scratch.deleteTopic`, and the delete affordance is deliberately ungated for Topic
          // directories where rename and move are not). Without this the tree row vanishes —
          // `confirmDelete` refreshes it directly — while the Topics panel and the Board keep
          // showing the deleted Topic until an unrelated write happens to bump.
          workspaceFileRevisions: bumpWorkspaceFileRevision(state.workspaceFileRevisions, workspaceId)
        }))
        await Promise.all(observedPaths.map(async (observedPath) => {
          await api.files.unobserve(workspaceId, observedPath)
        }))
      } catch (error) {
        get().reportError(error)
        throw error
      }
    })
  },
  updateDocument(tabId, content, regionId) {
    set((state) => reduceDocumentContent(state, tabId, content, regionId))
  },
  async saveDocument(tabId, regionId) {
    await enqueueFileSave(tabId, false, regionId)
  },
  async overwriteDocument(tabId, regionId) {
    await enqueueFileSave(tabId, true, regionId)
  },
  async reloadDocument(tabId, regionId) {
    const surface = fileSurface(get().tabs[tabId], regionId)
    if (!surface) return
    const key = documentKey(surface.workspaceId, surface.path)
    const issue = get().documentIssues[key]
    if (issue?.kind === 'changed') {
      set((state) => reduceDocumentReloaded(state, surface.workspaceId, surface.path, issue.observed))
      return
    }
    if (issue?.kind === 'deleted') {
      advanceDocumentLifetime(key)
      set((state) => reduceFileDelete(state, surface.workspaceId, surface.path))
      await api.files.unobserve(surface.workspaceId, surface.path)
      return
    }
    await get().refreshDocument(surface.workspaceId, surface.path)
  },
  async refreshDocument(workspaceId, path) {
    await refreshFileDocument(workspaceId, path)
  },
  async launchBoardAgent(workspaceId, executorId, prompt, topicId) {
    await get().selectWorkspace(workspaceId)
    set({ mainSurface: 'board' })
    // Topic 行的 Inbox 带 Topic 上下文起 Agent。绑定不在这里重造：`openScratchTopic` 已经是
    // 「找到或新建一个绑到该 Topic 的 View」的唯一路径，走它一遍，新 Agent 的 workspacePath 与
    // scratchTopicId 就与从 Topic 面板起的完全一致——Board 不是第二条 Topic 绑定路径。
    if (topicId) await get().openScratchTopic(topicId)
    const layout = get().layouts[workspaceId]
    if (!layout) throw new Error('Workspace layout is unavailable')
    const group = findGroup(layout, layout.activeGroupId)
    const boundTab = topicId && group?.activeTabId ? get().tabs[group.activeTabId] : undefined
    if (topicId && boundTab?.topicId !== topicId) {
      throw new Error('Scratch Topic View is unavailable')
    }
    const launcher = boundTab &&
      boundTab.regions[boundTab.layout.activeRegionId]?.kind === 'launcher'
      ? { tabId: boundTab.id, regionId: boundTab.layout.activeRegionId }
      : undefined
    await get().launchAgent(executorId, prompt, layout.activeGroupId, launcher)
  },
  async launchAgent(executorId, prompt, tabGroupId, launcher, launchOptions, names) {
    const state = get()
    const launcherTab = launcher ? state.tabs[launcher.tabId] : undefined
    const launcherSurface = launcherTab && launcher
      ? launcherTab.regions[launcher.regionId]
      : undefined
    if (launcher && launcherSurface?.kind !== 'launcher') {
      throw new Error('Launcher Region is no longer available')
    }
    const workspaceId = resolveLauncherWorkspaceId({
      launcherTabWorkspaceId: launcherTab?.workspaceId,
      activeWorkspaceId: state.activeWorkspaceId
    })
    const workspace = state.config?.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new Error('Select a workspace first')
    const layout = state.layouts[workspace.id]
    if (!layout) throw new Error('Workspace layout is unavailable')
    const inheritedTopicId = launcherTab
      ? undefined
      : inheritedTopicIdForNewTab(workspace.id, layout, state.tabs, tabGroupId)
    const targetTab = launcherTab ?? newLauncherTab(workspace.id, inheritedTopicId)
    const tabId = targetTab.id
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, tabId)) throw new Error('The View is closing')
    // The target Topic is the View's explicit binding. An unbound View launches with no Topic;
    // we never fabricate one from the Tab identity (a Tab id is not a Topic).
    const scratchTopicId = isScratchWorkspaceId(workspace.id)
      ? targetTab.topicId
      : undefined
    if (scratchTopicId && !isScratchTopicId(scratchTopicId)) {
      throw new Error('Scratch Agent View has an invalid Topic identity')
    }
    const regionId = launcher?.regionId ?? targetTab.layout.activeRegionId
    const sessionId = crypto.randomUUID()
    const pendingSurface: AgentWorkbenchSurface = {
      regionId,
      kind: 'agent',
      phase: 'launching',
      workspaceId: workspace.id,
      sessionId
    }
    const replacedTab = replaceWorkbenchRegion(targetTab, regionId, pendingSurface)
    const pendingTab = scratchTopicId ? { ...replacedTab, topicId: scratchTopicId } : replacedTab
    // 没有 launcher 归属时这条 Tab 是新建的，必须真的挂进某个分组。挂不上就抛：原先用 addTab
    // 的静默回落，Tab 记录进了 state.tabs 而不在任何 tabOrder 里——永不显示、永不可关，且用户
    // 点了「启动」看不到任何反馈（实测抛出的是 null，多出一条孤儿记录）。
    const nextLayout = launcher ? layout : addTabOrThrow(layout, tabGroupId, tabId)
    set((current) => ({
      tabs: { ...current.tabs, [tabId]: pendingTab },
      layouts: {
        ...current.layouts,
        [workspace.id]: nextLayout
      },
      pendingAgentLaunches: {
        ...current.pendingAgentLaunches,
        [sessionId]: { events: [], overflowed: false }
      }
    }))
    try {
      const launched = await api.sessions.launchAgent({
        executorId,
        hostId: workspace.hostId,
        workspacePath: workspace.path,
        ...(scratchTopicId ? { scratchTopicId } : {}),
        ...(launchOptions && Object.keys(launchOptions).length > 0 ? { launchOptions } : {}),
        prompt,
        agentSessionId: sessionId,
        createOperationId: crypto.randomUUID()
      })
      if (
        launched.session.id !== sessionId ||
        launched.timeline.agentSessionId !== sessionId
      ) {
        try {
          await api.sessions.stop(launched.session.control)
          set((current) => discardPendingAgentLaunch(current, sessionId))
        } catch (cleanupError) {
          let timelineGapSessionId: string | undefined
          set((current) => {
            const reduced = reduceDetachedAgentLaunch(current, launched)
            timelineGapSessionId = reduced.timelineGapSessionId
            return reduced.state
          })
          if (timelineGapSessionId) void get().resyncTimeline(timelineGapSessionId)
          throw Object.assign(
            new Error(`Agent launch result mismatched its requested Session and cleanup failed: ${presentError(cleanupError)}`),
            { code: 'AGENT_LAUNCH_CLEANUP_FAILED', cause: cleanupError }
          )
        }
        throw new Error('Agent launch result does not match its requested Session identity')
      }
      let result: AgentLaunchResult | null
      try {
        result = await get().canonicalizeAgentLaunch(launched)
      } catch (reconcileError) {
        try {
          await api.sessions.stop(launched.session.control)
          set((current) => discardPendingAgentLaunch(current, sessionId))
        } catch (cleanupError) {
          let timelineGapSessionId: string | undefined
          set((current) => {
            const reduced = reduceDetachedAgentLaunch(current, launched)
            timelineGapSessionId = reduced.timelineGapSessionId
            return reduced.state
          })
          if (timelineGapSessionId) void get().resyncTimeline(timelineGapSessionId)
          throw Object.assign(
            new Error(`Agent launch state could not be reconciled and cleanup failed: ${presentError(cleanupError)}`),
            {
              code: 'AGENT_LAUNCH_CLEANUP_FAILED',
              cause: new AggregateError([reconcileError, cleanupError])
            }
          )
        }
        throw reconcileError
      }
      if (!result) {
        // 这个 Session 在启动过程中就没了（在途事件溢出后重取快照，它已经不在快照里）。
        // 抛出去而不是就地 `set(...) + return`：下面那个 catch 已经是这个方法唯一的失败出口，
        // 它会翻回 launcher、reportError、再抛给调用方。就地静默回滚的话，用户看到的是初始页
        // 自己闪回来而没有任何一个字解释，与「我刚才是不是没点上」完全同形；批量扇出的调用方
        // 也会把这次当成成功继续往下走。同一个条件在 Control 那条路上判的是 CONTROL_OWNER_LOST
        // （见 runControlRequest 里 `if (!canonical)`），两条路对同一个事实必须判得一样。
        throw Object.assign(new Error('Agent Session ended during launch.'), {
          code: 'CONTROL_OWNER_LOST'
        })
      }
      const session = result.session
      const launchOwner = findWorkbenchRegion(get().tabs, regionId)
      if (
        !ownsSessionLaunch(launchOwner?.surface, 'agent', sessionId) ||
        (launchOwner && !workbenchViewCloseAllowsView(get().closingWorkbenchViews, launchOwner.tab.id))
      ) {
        try {
          await api.sessions.stop(session.control)
          set((current) => discardPendingAgentLaunch(current, sessionId))
        } catch (cleanupError) {
          let timelineGapSessionId: string | undefined
          set((current) => {
            const reduced = reduceDetachedAgentLaunch(current, result)
            timelineGapSessionId = reduced.timelineGapSessionId
            return reduced.state
          })
          if (timelineGapSessionId) void get().resyncTimeline(timelineGapSessionId)
          throw Object.assign(
            new Error(`Agent launch owner disappeared and cleanup failed: ${presentError(cleanupError)}`),
            { code: 'AGENT_LAUNCH_CLEANUP_FAILED', cause: cleanupError }
          )
        }
        return
      }
      let timelineGapSessionId: string | undefined
      set((current) => {
        const reduced = reduceAgentSessionLaunchAttached(current, regionId, result)
        timelineGapSessionId = reduced.timelineGapSessionId
        return scratchTopicId
          ? {
              ...reduced.state,
              workspaceFileRevisions: bumpWorkspaceFileRevision(
                current.workspaceFileRevisions,
                workspace.id
              )
            }
          : reduced.state
      })
      // 只有启动成功、region 从 launcher 变成 agent 之后，才清掉这条 launcher 草稿——此刻它已失去归属。
      // 失败路径（下方 catch → reduceSessionLaunchFailed）绝不清：region 会翻回 launcher 且沿用同一个
      // regionId，草稿留在原地供用户直接重试。这正是用户报告"报错退回初始页、之前输入没缓存"要修的行为。
      get().clearAgentComposerDraftIfUnchanged(regionId, prompt)
      // 名字草稿与 prompt 草稿同一时机、同一理由清掉：这个 region 已经从 launcher 变成 agent，
      // 那两格输入失去归属，留着会串到下一个新标签页。失败路径不清（region 翻回 launcher 且沿用
      // 同一 regionId），用户填的名字原地留着供直接重试。
      set((current) => {
        if (current.launcherNameDrafts[regionId] === undefined) return current
        const { [regionId]: _consumed, ...rest } = current.launcherNameDrafts
        return { launcherNameDrafts: rest }
      })
      // 名字与草稿同一时机落地：Agent 已经挂上，两个 id 才真正指向一个存在的东西。失败路径不写，
      // 否则会留下一个指向已消失 session 的孤儿名字。留空即不写，显示名交还派生链。
      if (names?.agentName) get().renameAgent(sessionId, names.agentName)
      if (names?.tabName) get().renameTab(tabId, names.tabName)
      if (timelineGapSessionId) void get().resyncTimeline(timelineGapSessionId)
    } catch (error) {
      if (!ownsSessionLaunch(findWorkbenchRegion(get().tabs, regionId)?.surface, 'agent', sessionId)) {
        set((current) => discardPendingAgentLaunch(current, sessionId))
        if ((error as { code?: unknown } | null)?.code === 'AGENT_LAUNCH_CLEANUP_FAILED') {
          get().reportError(error)
          throw error
        }
        return
      }
      set((current) => reduceSessionLaunchFailed(current, regionId, 'agent', sessionId))
      get().reportError(error)
      throw error
    }
  },
  async launchTerminal(tabGroupId, launcher, workspacePath) {
    const state = get()
    const launcherTab = launcher ? state.tabs[launcher.tabId] : undefined
    const launcherSurface = launcherTab && launcher
      ? launcherTab.regions[launcher.regionId]
      : undefined
    if (launcher && launcherSurface?.kind !== 'launcher') {
      throw new Error('Launcher Region is no longer available')
    }
    const workspaceId = resolveLauncherWorkspaceId({
      launcherTabWorkspaceId: launcherTab?.workspaceId,
      activeWorkspaceId: state.activeWorkspaceId
    })
    const workspace = state.config?.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new Error('Select a workspace first')
    const layout = state.layouts[workspace.id]
    if (!layout) throw new Error('Workspace layout is unavailable')
    const inheritedTopicId = launcherTab
      ? undefined
      : inheritedTopicIdForNewTab(workspace.id, layout, state.tabs, tabGroupId)
    const targetTab = launcherTab ?? newLauncherTab(workspace.id, inheritedTopicId)
    const tabId = targetTab.id
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, tabId)) throw new Error('The View is closing')
    const regionId = launcher?.regionId ?? targetTab.layout.activeRegionId
    const sessionId = crypto.randomUUID()
    const pendingSurface: TerminalWorkbenchSurface = {
      regionId,
      kind: 'terminal',
      phase: 'launching',
      workspaceId: workspace.id,
      sessionId
    }
    const pendingTab = replaceWorkbenchRegion(targetTab, regionId, pendingSurface)
    // 与 launchAgent 同一条判定：新建 Tab 必须真的挂进某个分组，挂不上就抛。
    const nextLayout = launcher ? layout : addTabOrThrow(layout, tabGroupId, tabId)
    set((current) => ({
      tabs: { ...current.tabs, [tabId]: pendingTab },
      layouts: {
        ...current.layouts,
        [workspace.id]: nextLayout
      }
    }))
    try {
      const session = await api.sessions.launchTerminal({
        hostId: workspace.hostId,
        workspacePath: workspacePath ?? workspace.path,
        createOperationId: crypto.randomUUID()
      })
      const launchOwner = findWorkbenchRegion(get().tabs, regionId)
      if (
        !ownsSessionLaunch(launchOwner?.surface, 'terminal', sessionId) ||
        (launchOwner && !workbenchViewCloseAllowsView(get().closingWorkbenchViews, launchOwner.tab.id))
      ) {
        await api.sessions.stop(session.control).catch((cleanupError) => {
          if (get().sessions.some((item) => item.id === session.id)) get().reportError(cleanupError)
        })
        return
      }
      set((current) => {
        const owner = findWorkbenchRegion(current.tabs, regionId)
        if (
          !owner ||
          owner.surface.kind !== 'terminal' ||
          !ownsSessionLaunch(owner.surface, 'terminal', sessionId)
        ) return current
        return reduceSessionLaunchAttached({
          ...current,
          tabs: {
            ...current.tabs,
            [owner.tab.id]: replaceWorkbenchRegion(owner.tab, regionId, {
              ...owner.surface,
              sessionId: session.id
            })
          }
        }, regionId, session)
      })
    } catch (error) {
      if (!ownsSessionLaunch(findWorkbenchRegion(get().tabs, regionId)?.surface, 'terminal', sessionId)) return
      set((current) => reduceSessionLaunchFailed(current, regionId, 'terminal', sessionId))
      get().reportError(error)
      throw error
    }
  },
  prewarmTerminal(workspaceId, ownerLauncherId) {
    const workspace = get().config?.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) return
    const key = warmTerminalKey(workspace.hostId, workspace.path)
    const existing = get().warmTerminal
    if (existing?.key === key) {
      // 同 host 同 cwd 的 shell 可以复用，不必再起一个——但**归属要转过来**。分屏里两个 launcher
      // 的 key 完全一样，若这里直接 return，槽的 owner 就永远停在第一个挂载的那个 launcher 上，而
      // 后挂载的那个（用户刚点出来、正在看的那个）只能显示冷卡片。转移归属让「最后一个请求预热的
      // launcher 拥有预览」，同时仍然只有一个 PTY、仍然只有一个 view 挂在上面。
      if (existing.ownerLauncherId !== ownerLauncherId) {
        set((state) => (
          state.warmTerminal === existing
            ? { warmTerminal: { ...existing, ownerLauncherId } }
            : {}
        ))
      }
      return
    }
    if (existing) {
      // A different host/cwd cannot reuse this shell. Keep its durable id recorded
      // until Core confirms the stop.
      void stopWarmTerminal(existing).then((sessionId) => {
        if (!sessionId) return
        set((state) => ({
          unclaimedTerminalSessionIds: forgetUnclaimedTerminalSession(
            state.unclaimedTerminalSessionIds,
            sessionId
          )
        }))
      })
    }
    const ready = api.sessions
      .launchTerminal({
        hostId: workspace.hostId,
        workspacePath: workspace.path,
        createOperationId: crypto.randomUUID()
      })
      .catch(() => null)
    void ready.then((session) => {
      if (!session) {
        if (get().warmTerminal?.ready === ready) set({ warmTerminal: null })
        return
      }
      set((state) => ({
        // Track every successful prewarm even if another workspace replaced the slot
        // while Core was launching it. The matching stop path removes the id later.
        warmTerminal: state.warmTerminal?.ready === ready
          ? { ...state.warmTerminal, session }
          : state.warmTerminal,
        unclaimedTerminalSessionIds: trackUnclaimedTerminalSession(
          state.unclaimedTerminalSessionIds,
          session.id
        )
      }))
    })
    set({ warmTerminal: { key, ownerLauncherId, ready, session: null } })
  },
  async promoteWarmTerminal(tabGroupId, launcher) {
    const state = get()
    const launcherTab = launcher ? state.tabs[launcher.tabId] : undefined
    const launcherSurface = launcherTab && launcher
      ? launcherTab.regions[launcher.regionId]
      : undefined
    if (launcher && launcherSurface?.kind !== 'launcher') {
      throw new Error('Launcher Region is no longer available')
    }
    if (launcherTab && !workbenchViewCloseAllowsView(state.closingWorkbenchViews, launcherTab.id)) {
      throw new Error('The View is closing')
    }
    const workspaceId = resolveLauncherWorkspaceId({
      launcherTabWorkspaceId: launcherTab?.workspaceId,
      activeWorkspaceId: state.activeWorkspaceId
    })
    const workspace = state.config?.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new Error('Select a workspace first')
    const key = warmTerminalKey(workspace.hostId, workspace.path)
    if (state.warmTerminal?.key !== key) {
      await get().launchTerminal(tabGroupId, launcher)
      return
    }
    const held = state.warmTerminal
    // Consume the slot before awaiting so concurrent clicks cannot claim it twice.
    set({ warmTerminal: null })
    const session = await held.ready
    if (!session) {
      await get().launchTerminal(tabGroupId, launcher)
      return
    }
    if (!get().layouts[workspace.id]) {
      if (await stopTerminalSession(session)) {
        set((current) => ({
          unclaimedTerminalSessionIds: forgetUnclaimedTerminalSession(
            current.unclaimedTerminalSessionIds,
            session.id
          )
        }))
      }
      throw new Error('Workspace layout is unavailable')
    }
    const inheritedTopicId = launcherTab
      ? undefined
      : inheritedTopicIdForNewTab(workspace.id, get().layouts[workspace.id], state.tabs, tabGroupId)
    const targetTab = launcherTab ?? newLauncherTab(workspace.id, inheritedTopicId)
    const tabId = targetTab.id
    const regionId = launcher?.regionId ?? targetTab.layout.activeRegionId
    const surface: TerminalWorkbenchSurface = {
      regionId,
      kind: 'terminal',
      phase: 'attached',
      workspaceId: workspace.id,
      sessionId: session.id
    }
    let bound = false
    let sessionOwnedByClose = false
    let placementFailed = false
    set((current) => {
      if (!workbenchViewCloseAllowsSession(current.closingWorkbenchViews, session.id)) {
        sessionOwnedByClose = true
        return current
      }
      if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return current
      let baseTab = targetTab
      if (launcher) {
        const live = current.tabs[tabId]
        if (!live || live.regions[regionId]?.kind !== 'launcher') return current
        baseTab = live
      }
      const nextTabs = { ...current.tabs, [tabId]: replaceWorkbenchRegion(baseTab, regionId, surface) }
      const nextSessions = [...current.sessions.filter((item) => item.id !== session.id), session]
      const nextUnclaimedIds = forgetUnclaimedTerminalSession(
        current.unclaimedTerminalSessionIds,
        session.id
      )
      if (launcher) {
        bound = true
        return {
          tabs: nextTabs,
          sessions: nextSessions,
          unclaimedTerminalSessionIds: nextUnclaimedIds
        }
      }
      const layout = current.layouts[workspace.id]
      if (!layout) return current
      // 挂不上就不 bound：下面的 `!bound` 路径会把已从槽里取出的 PTY 停掉，不泄漏进程。
      // 但要与「Tab 正在关闭」那种静默放弃分开——落点不在场是用户点了按钮却什么都没发生，
      // 必须响亮（原先用 addTab 的静默回落会留下一条永不显示的孤儿 Tab）。
      const nextLayout = addTabPlacement(layout, tabGroupId, tabId)
      if (!nextLayout) {
        placementFailed = true
        return current
      }
      bound = true
      return {
        tabs: nextTabs,
        layouts: { ...current.layouts, [workspace.id]: nextLayout },
        sessions: nextSessions,
        unclaimedTerminalSessionIds: nextUnclaimedIds
      }
    })
    if (!bound) {
      if (sessionOwnedByClose) return
      if (await stopTerminalSession(session)) {
        set((current) => ({
          unclaimedTerminalSessionIds: forgetUnclaimedTerminalSession(
            current.unclaimedTerminalSessionIds,
            session.id
          )
        }))
      }
      if (placementFailed) throw new Error('The Tab Group is no longer available')
      return
    }
    void get().refreshSession(session.id)
  },
  async createBrowser(tabGroupId, launcher, url = 'about:blank') {
    const state = get()
    const launcherTab = launcher ? state.tabs[launcher.tabId] : undefined
    const launcherSurface = launcherTab && launcher
      ? launcherTab.regions[launcher.regionId]
      : undefined
    if (launcher && launcherSurface?.kind !== 'launcher') {
      throw new Error('Launcher Region is no longer available')
    }
    const workspaceId = resolveLauncherWorkspaceId({
      launcherTabWorkspaceId: launcherTab?.workspaceId,
      activeWorkspaceId: state.activeWorkspaceId
    })
    if (!workspaceId) throw new Error('Select a workspace first')
    const layout = state.layouts[workspaceId]
    if (!layout) throw new Error('Workspace layout is unavailable')
    const inheritedTopicId = launcherTab
      ? undefined
      : inheritedTopicIdForNewTab(workspaceId, layout, state.tabs, tabGroupId)
    const targetTab = launcherTab ?? newLauncherTab(workspaceId, inheritedTopicId)
    const tabId = targetTab.id
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, tabId)) throw new Error('The View is closing')
    const regionId = launcher?.regionId ?? targetTab.layout.activeRegionId
    const pendingLauncher = targetTab.regions[regionId]
    if (pendingLauncher?.kind !== 'launcher') throw new Error('Launcher Region is no longer available')
    if (!launcher) {
      // 挂不上就抛，绝不留孤儿 Tab（见 addTabPlacement 的说明）。这里排在 api.browser.create
      // 之前：落点不在场时连 BrowserView 都不该建，省掉一次紧接着的销毁。
      const nextLayout = addTabOrThrow(layout, tabGroupId, tabId)
      set((current) => ({
        tabs: { ...current.tabs, [tabId]: targetTab },
        layouts: { ...current.layouts, [workspaceId]: nextLayout }
      }))
    }
    try {
      const browser = await api.browser.create(regionId, url)
      const surface: BrowserWorkbenchSurface = {
        ...browser,
        regionId,
        kind: 'browser',
        workspaceId,
        browserId: regionId
      }
      let attached = false
      set((current) => {
        const currentOwner = findWorkbenchRegion(current.tabs, regionId)
        if (
          currentOwner?.tab.id !== tabId ||
          currentOwner.surface !== pendingLauncher ||
          !workbenchViewCloseAllowsView(current.closingWorkbenchViews, currentOwner.tab.id)
        ) return current
        attached = true
        return {
          tabs: {
            ...current.tabs,
            [currentOwner.tab.id]: replaceWorkbenchRegion(currentOwner.tab, regionId, surface)
          }
        }
      })
      if (!attached) {
        const primary = new Error('Browser launch owner disappeared before it could attach.')
        try {
          await api.browser.close(browser.id)
        } catch (cleanupError) {
          throw new AggregateError(
            [primary, cleanupError],
            `${primary.message} Cleanup also failed: ${presentError(cleanupError)}`
          )
        }
        return
      }
    } catch (error) {
      get().reportError(error)
      throw error
    }
  },
  async openHttpLink(origin, rawUrl, destination) {
    const url = normalizeHttpLinkUrl(rawUrl)
    if (destination === 'system') {
      await api.ui.openExternal(url)
      return
    }
    if (destination !== 'tab' && (!origin.tabId || !origin.regionId)) {
      throw new Error('Directional link destinations require a Tab and Region origin')
    }

    const tabId = destination === 'tab' ? `launcher:${crypto.randomUUID()}` : origin.tabId!
    const regionId = destination === 'tab' ? initialWorkbenchRegionId(tabId) : newRegionId()
    const pendingLauncher: LauncherWorkbenchSurface = {
      regionId,
      kind: 'launcher',
      workspaceId: origin.workspaceId
    }
    let planned = false
    let placementError: Error | null = null
    set((current) => {
      const layout = current.layouts[origin.workspaceId]
      if (!layout) {
        placementError = new Error('Workspace layout is unavailable')
        return current
      }
      if (!findGroup(layout, origin.tabGroupId)) {
        placementError = new Error('Link origin Tab Group is no longer available')
        return current
      }
      if (destination === 'tab') {
        const topicId = inheritedTopicIdForNewTab(
          origin.workspaceId,
          layout,
          current.tabs,
          origin.tabGroupId
        )
        const createdTab = createWorkbenchTab(tabId, pendingLauncher)
        const tab = topicId ? { ...createdTab, topicId } : createdTab
        // 落点判定收在 addTabPlacement 里（同一族缺陷的唯一判据）。原先这里写的是
        // `nextLayout === layout` 的身份比较——对这条路径恰好等价，但那个判据认不出
        // 「Tab 已在别处、activateTab 返回同一对象」，换到别的调用点就会把正常路径判成失败。
        const nextLayout = addTabPlacement(layout, origin.tabGroupId, tabId)
        if (!nextLayout) {
          placementError = new Error('Link destination Tab could not be created')
          return current
        }
        planned = true
        return {
          tabs: { ...current.tabs, [tabId]: tab },
          layouts: { ...current.layouts, [origin.workspaceId]: nextLayout }
        }
      }

      const originTab = current.tabs[origin.tabId!]
      if (
        !originTab ||
        originTab.workspaceId !== origin.workspaceId ||
        !originTab.regions[origin.regionId!] ||
        tabGroupForTab(layout, originTab.id) !== origin.tabGroupId
      ) {
        placementError = new Error('Link origin Region is no longer available')
        return current
      }
      if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, originTab.id)) {
        placementError = new Error('The View is closing')
        return current
      }
      const nextTab = addWorkbenchRegion(
        originTab,
        origin.regionId!,
        destination,
        pendingLauncher
      )
      if (nextTab === originTab) {
        placementError = new Error('Link destination Region could not be created')
        return current
      }
      planned = true
      return { tabs: { ...current.tabs, [originTab.id]: nextTab } }
    })
    if (!planned) throw placementError ?? new Error('Link destination could not be created')

    try {
      await get().createBrowser(origin.tabGroupId, { tabId, regionId }, url)
    } catch (error) {
      set((current) => {
        const liveTab = current.tabs[tabId]
        if (!liveTab || liveTab.regions[regionId] !== pendingLauncher) return current
        if (destination !== 'tab') {
          const nextTab = removeWorkbenchRegion(liveTab, regionId)
          return nextTab
            ? { tabs: { ...current.tabs, [tabId]: nextTab } }
            : current
        }
        const layout = current.layouts[origin.workspaceId]
        const currentTabGroupId = tabGroupForTab(layout, tabId)
        if (!layout || !currentTabGroupId) return current
        const tabs = { ...current.tabs }
        delete tabs[tabId]
        return {
          tabs,
          layouts: {
            ...current.layouts,
            [origin.workspaceId]: removeLayoutTab(layout, currentTabGroupId, tabId)
          }
        }
      })
      throw error
    }
  },
  applyBrowserEvent(event) {
    set((state) => ({
      ...reduceBrowserEvent(state, event),
      ...(event.type === 'closed'
        ? {
            browserAnnotationsByBrowserId: Object.fromEntries(
              Object.entries(state.browserAnnotationsByBrowserId)
                .filter(([browserId]) => browserId !== event.id)
            )
          }
        : {})
    }))
  },
  addBrowserAnnotation(annotation) {
    if (
      annotation.browserId !== annotation.selection.browserId ||
      annotation.navigationId !== annotation.selection.navigationId
    ) {
      throw new Error('Browser annotation identity does not match its selected element')
    }
    set((state) => {
      const current = state.browserAnnotationsByBrowserId[annotation.browserId] ?? []
      if (current.some(({ id }) => id === annotation.id)) return state
      return {
        browserAnnotationsByBrowserId: {
          ...state.browserAnnotationsByBrowserId,
          [annotation.browserId]: [...current, annotation]
        }
      }
    })
  },
  deleteBrowserAnnotation(browserId, annotationId) {
    set((state) => {
      const current = state.browserAnnotationsByBrowserId[browserId] ?? []
      const next = current.filter(({ id }) => id !== annotationId)
      if (next.length === current.length) return state
      const browserAnnotationsByBrowserId = { ...state.browserAnnotationsByBrowserId }
      if (next.length > 0) browserAnnotationsByBrowserId[browserId] = next
      else delete browserAnnotationsByBrowserId[browserId]
      return { browserAnnotationsByBrowserId }
    })
  },
  clearBrowserAnnotations(browserId) {
    set((state) => {
      if (!state.browserAnnotationsByBrowserId[browserId]) return state
      const browserAnnotationsByBrowserId = { ...state.browserAnnotationsByBrowserId }
      delete browserAnnotationsByBrowserId[browserId]
      return { browserAnnotationsByBrowserId }
    })
  },
  setAgentComposerDraft(sessionId, text) {
    set((state) => ({
      agentComposerDrafts: { ...state.agentComposerDrafts, [sessionId]: text }
    }))
  },
  setLauncherNameDraft(regionId, field, value) {
    set((state) => {
      const current = state.launcherNameDrafts[regionId] ?? EMPTY_LAUNCHER_NAMES
      return {
        launcherNameDrafts: { ...state.launcherNameDrafts, [regionId]: { ...current, [field]: value } }
      }
    })
  },
  appendAgentComposerDraft(sessionId, text) {
    if (!text.trim()) return
    set((state) => {
      const current = state.agentComposerDrafts[sessionId] ?? ''
      return {
        agentComposerDrafts: {
          ...state.agentComposerDrafts,
          [sessionId]: `${current}${current.trim() ? '\n\n' : ''}${text}`
        }
      }
    })
  },
  clearAgentComposerDraftIfUnchanged(sessionId, expectedText) {
    set((state) => {
      if ((state.agentComposerDrafts[sessionId] ?? '') !== expectedText) return state
      const agentComposerDrafts = { ...state.agentComposerDrafts }
      delete agentComposerDrafts[sessionId]
      return { agentComposerDrafts }
    })
  },
  enqueueAgentSteer(sessionId, text) {
    if (!text.trim()) return false
    const session = get().sessions.find((item) => item.id === sessionId)
    if (!session || session.kind !== 'agent') return false
    // Refuse an oversized prompt HERE, at the only door into the queue, rather than letting Core
    // reject it at submit time. `INVALID_AGENT_PROMPT` is a permanent verdict for identical content,
    // but `flushAgentSteerQueue` treats every throw as retryable: it keeps the entry and returns. So
    // one oversized entry is retried on every runtime event, forever, and head-of-line-blocks every
    // valid steer behind it. Checking at the consumer cannot fix that — by then the user's words are
    // already in the queue with the draft cleared.
    //
    // Trim first, because Core measures the TRIMMED content (client.ts:2285). Measuring the raw text
    // would refuse prompts Core would have accepted, and the two sides must agree on one boundary.
    if (agentPromptExceedsBudget(text.trim())) {
      get().reportError(new Error(
        `This message is too large to send (limit ${Math.floor(MAX_AGENT_PROMPT_BYTES / 1024)}KB). Shorten it, or put the content in a file and reference the path.`
      ))
      return false
    }
    // Mint the operationId here, at the entry's birth — one id per queued prompt. It rides the entry
    // through every retry so a re-flushed entry replays with the same id; a second call for a genuinely
    // different prompt makes a second entry with its own id.
    //
    // The runId is stamped here for the same reason and at the same moment: this is the only point where
    // "which run was the user talking to" is knowable without guessing. By flush time the session may
    // already be on a different run under the same agentSessionId.
    const entry: AgentSteerQueueEntry = {
      operationId: crypto.randomUUID(),
      runId: session.control.run.runId,
      text
    }
    set((state) => ({ agentSteerQueues: { ...state.agentSteerQueues, [sessionId]: [...(state.agentSteerQueues[sessionId] ?? []), entry] } }))
    return true
  },
  async flushAgentSteerQueue(sessionId) {
    const session = get().sessions.find((item) => item.id === sessionId)
    if (!session || session.kind !== 'agent') return
    const queued = get().agentSteerQueues[sessionId] ?? []
    if (queued.length === 0 || !steerQueueCanDrainNow(session)) return
    const runId = session.control.run.runId
    for (const entry of queued) {
      // A steer typed at a run that is gone is NOT sent to whatever run inherited the agentSessionId.
      // Skipping rather than deleting: the badge still shows the user their words (the composer labels
      // them undeliverable), and deciding to discard user-authored text is not this loop's call.
      if (!steerEntryTargetsRun(entry, runId)) continue
      try {
        await api.sessions.submitPrompt(session.control, entry.text, entry.operationId)
        set((state) => {
          const current = state.agentSteerQueues[sessionId] ?? []
          const next = current[0] === entry ? current.slice(1) : current.filter((item) => item !== entry)
          const agentSteerQueues = { ...state.agentSteerQueues }
          if (next.length) agentSteerQueues[sessionId] = next
          else delete agentSteerQueues[sessionId]
          return { agentSteerQueues }
        })
      } catch (error) {
        // Every failure here is treated as retryable: the entry stays and the loop stops, so a
        // transient refusal neither loses the user's words nor reorders what follows.
        //
        // That is only safe because nothing permanently-rejectable can reach this queue. A permanent
        // verdict (INVALID_AGENT_PROMPT) would be retried on every runtime event forever and would
        // head-of-line-block every entry behind it — which is why the size check lives at
        // `enqueueAgentSteer`, the single door in, rather than here. If a second permanent rejection
        // class ever appears, this catch is where it would wedge; classify it at the door too.
        get().reportError(error)
        return
      }
    }
  },
  async send(sessionId, text) {
    if (!text.trim()) return
    const session = get().sessions.find((item) => item.id === sessionId)
    if (!session || session.kind !== 'agent') return
    // Compare occurrence counts rather than `includes(text)`: an identical prompt may already be
    // queued. A successful send removes one occurrence while the pre-existing duplicate remains; only
    // an increase proves this invocation was retained for retry.
    const queuedBefore = get().agentSteerQueues?.[sessionId] ?? []
    const sameBefore = queuedBefore.filter((entry) => entry.text === text).length
    // A refused enqueue never reaches the queue, so the occurrence-count check below cannot see it —
    // it would read "nothing was retained" and report success for a prompt that was never sent.
    // enqueueAgentSteer has already told the user why; this throw only signals the Composer to keep
    // the draft, via the same path a failed submit takes.
    if (!get().enqueueAgentSteer(sessionId, text)) {
      throw new Error('Prompt was not queued.')
    }
    await get().flushAgentSteerQueue(sessionId)
    // `flushAgentSteerQueue` intentionally retains failed entries for retry. Surface that outcome to the
    // Composer so it must keep the user's draft instead of treating a retained queue item as success.
    const sameAfter = (get().agentSteerQueues?.[sessionId] ?? []).filter((entry) => entry.text === text).length
    if (sameAfter > sameBefore) {
      throw new Error('Prompt was retained for retry because the Agent did not accept it yet.')
    }
  },
  async respondInteraction(sessionId, response) {
    const session = get().sessions.find((item) => item.id === sessionId)
    if (!session || session.kind !== 'agent') return
    try {
      await api.sessions.respondInteraction(session.control, response)
      await get().flushAgentSteerQueue(sessionId)
    } catch (error) {
      get().reportError(error)
      throw error
    }
  },
  async setPosture(sessionId, modeId) {
    // A fire-and-forget SET: Core resolves the Provider's declared keystroke and writes it in-band. We
    // never record a "current mode" — the live posture lives in the CLI's own TUI, which AgentMux cannot
    // read, so claiming to know it would be a lie. The picker sends the intent and the CLI owns the state.
    const session = get().sessions.find((item) => item.id === sessionId)
    if (!session || session.kind !== 'agent') return
    try {
      await api.sessions.setPosture(session.control, modeId)
    } catch (error) {
      get().reportError(error)
      throw error
    }
  },
  async interrupt(sessionId) {
    const session = get().sessions.find((item) => item.id === sessionId)
    if (session) await api.sessions.interrupt(session.control).catch((error) => get().reportError(error))
  },
  async refreshSession(sessionId) {
    const before = get()
    if (!workbenchViewCloseAllowsSession(before.closingWorkbenchViews, sessionId)) return
    const current = before.sessions.find((item) => item.id === sessionId)
    if (!current) return
    try {
      const session = await api.sessions.refresh(current.control)
      set((state) => {
        if (!workbenchViewCloseAllowsSession(state.closingWorkbenchViews, sessionId)) return state
        const live = state.sessions.find((item) => item.id === sessionId)
        if (!live || !sessionOwnsControl(live, current.control)) return state
        if (!hasAttachedSessionView(state.tabs, sessionId)) return state
        return { sessions: [...state.sessions.filter((item) => item.id !== session.id), session] }
      })
    } catch (error) {
      get().reportError(error)
    }
  },
  async recoverSession(sessionId) {
    const before = get()
    if (!workbenchViewCloseAllowsSession(before.closingWorkbenchViews, sessionId)) return
    const current = before.sessions.find((item) => item.id === sessionId)
    if (!current) return
    try {
      const recovery = await api.sessions.recover(current.control, current.workspacePath)
      if (recovery.kind === 'retired') {
        set((state) => removeSessionProjection(state, sessionId))
        return
      }
      if (
        recovery.kind === 'unavailable' ||
        recovery.kind === 'conflict'
      ) {
        set((state) => ({
          sessions: state.sessions.map((session) => (
            session.id === sessionId && sessionOwnsControl(session, current.control)
              ? {
                  ...session,
                  status: {
                    ...session.status,
                    state: 'error' as const,
                    // 与 recoveryCandidateSession 同一处产出。这条路是**用户自己点「恢复」**走的，
                    // 各写一遍时它正是被漏掉的那一处。
                    ...continuityStatusFields(recovery)
                  }
                }
              : session
          ))
        }))
        return
      }
      const session = recovery.session
      const after = get()
      const live = after.sessions.find((item) => item.id === sessionId)
      const ownerStillCurrent = live !== undefined &&
        (sessionOwnsControl(live, current.control) || sessionOwnsControl(live, session.control)) &&
        hasAttachedSessionView(after.tabs, sessionId)
      if (
        workbenchViewCloseAllowsSession(after.closingWorkbenchViews, sessionId) &&
        ownerStillCurrent
      ) {
        set((state) => projectRecoveredSession(state, sessionId, session))
        return
      }
      if (session.control.run.runId === current.control.run.runId) return
      try {
        await api.sessions.stop(session.control)
      } catch (cleanupError) {
        set((state) => projectRecoveredSession(state, sessionId, session))
        get().selectSession(session.id)
        throw new AggregateError(
          [new Error('Recovered Session owner disappeared before commit.'), cleanupError],
          'Recovered Session owner disappeared and cleanup failed.'
        )
      }
    } catch (error) {
      get().reportError(error)
    }
  },
  async stopSession(sessionId) {
    const state = get()
    if (!workbenchViewCloseAllowsSession(state.closingWorkbenchViews, sessionId)) return
    const session = state.sessions.find((item) => item.id === sessionId)
    if (session) await api.sessions.stop(session.control).catch((error) => get().reportError(error))
  },
  async canonicalizeAgentLaunch(result) {
    while (get().pendingAgentLaunches[result.session.id]?.overflowed) {
      set((state) => {
        const pending = state.pendingAgentLaunches[result.session.id]
        if (!pending) return state
        return {
          pendingAgentLaunches: {
            ...state.pendingAgentLaunches,
            [result.session.id]: { ...pending, events: [], overflowed: false }
          }
        }
      })
      const snapshot = await api.sessions.snapshot()
      const pending = get().pendingAgentLaunches[result.session.id]
      if (!pending) return null
      if (pending.overflowed) continue
      const session = snapshot.sessions.find((candidate) => candidate.id === result.session.id)
      if (!session) return null
      if (session.kind !== 'agent') throw new Error('Agent launch resync projected a non-Agent Session')
      const timeline = snapshot.timelines[result.session.id]
      if (!timeline || timeline.agentSessionId !== result.session.id) {
        throw new Error('Agent launch resync did not return its matching Timeline baseline')
      }
      result = { session, timeline }
    }
    return result
  },
  async resyncTimeline(sessionId) {
    const existing = timelineResyncs.get(sessionId)
    if (existing) {
      existing.requested = true
      await existing.promise
      return
    }
    const entry = { requested: false, promise: Promise.resolve() }
    entry.promise = (async () => {
      try {
        do {
          entry.requested = false
          const session = get().sessions.find((candidate) => (
            candidate.kind === 'agent' && candidate.id === sessionId
          ))
          if (!session || session.kind !== 'agent') return
          const snapshot = await api.sessions.timeline(session.control)
          set((state) => reduceTimelineSnapshot(state, snapshot))
        } while (entry.requested)
      } catch (error) {
        get().reportError(error)
      } finally {
        timelineResyncs.delete(sessionId)
      }
    })()
    timelineResyncs.set(sessionId, entry)
    await entry.promise
  },
  applyEvent(event) {
    if (sessionMembershipResync) {
      const pendingLaunchAgentSessionId = pendingAgentLaunchEventId(get(), event)
      if (pendingLaunchAgentSessionId) {
        set((state) => projectRuntimeEvent(state, event).state)
        enqueueSessionMembershipEvent(sessionMembershipResync, event, pendingLaunchAgentSessionId)
        return
      }
      enqueueSessionMembershipEvent(sessionMembershipResync, event)
      return
    }
    let timelineGapSessionId: string | undefined
    let sessionMembershipGap = false
    set((state) => {
      const reduced = projectRuntimeEvent(state, event)
      timelineGapSessionId = reduced.timelineGapSessionId
      sessionMembershipGap = reduced.sessionMembershipGap === true
      return reduced.state
    })
    if (sessionMembershipGap) startSessionMembershipResync(event)
    if (timelineGapSessionId) void get().resyncTimeline(timelineGapSessionId)
    // Runtime events can clear an interaction gate or mark a process ready. Retry
    // queued steers after projection; the flush guard keeps pending/running states safe.
    for (const sessionId of Object.keys(get().agentSteerQueues)) {
      void get().flushAgentSteerQueue(sessionId)
    }
  },
  decayStaleAgentStatuses(now) {
    set((state) => {
      const decayed = computeDecayedAgentStatuses(state.sessions, now)
      // computeDecayedAgentStatuses 无变化时返回原引用——原样返回，Zustand 不做无谓写入。
      return decayed === state.sessions ? state : { sessions: decayed }
    })
  },
  setConfig(config) {
    detectionRequestIds.clear()
    hostCheckRequestIds.clear()
    // 活动位跟着一起算。此前这里只清 host 键的两张缓存却不管 `activeWorkspaceId`，而那正是**唯一**
    // 会被「配置里少了一条 workspace」打坏的引用：删 host 会连带删掉它上面的全部 workspace（见
    // HostSettingsPane 的 filter），删项目会删掉一整组，而两处都经过这里。缺了这一行，每个删除现场
    // 都得自己记得挪活动位，而漏掉的那些就是空白欢迎页。
    //
    // 活动位不是唯一指进 config 的东西：被删 workspace 的文件 Tab 还在 `state.tabs` 里，每个都攥着
    // 一个 Main 侧观察者子进程。撤活动位让它们不可达却不释放那些子进程，于是它们一直活到 app 退出
    // （#559 的子进程泄漏）。在同一处把它们撤掉——与「谁负责在记录消失时收尾」是同一个决定。
    disposeObserversForRemovedWorkspaces(get().tabs, config)
    set((state) => ({
      ...adoptedConfig(state.activeWorkspaceId, config),
      executorDetections: {},
      hostChecks: {}
    }))
  },
  reportError(error) {
    const message = presentError(error)
    // Replayed runtime events and polling can report the same transient failure
    // repeatedly. Once the user dismissed that exact message, do not resurrect it
    // until a different error arrives or they explicitly reopen it.
    const current = get()
    if (current.errorDismissed && current.lastError === message) return
    set({ error: message, lastError: message, errorDismissed: false })
  },
  dismissError() {
    if (!get().error) return
    set({ errorDismissed: true })
  },
  reopenError() {
    const message = get().lastError
    if (!message) return
    set({ error: message, errorDismissed: false })
  }
}), {
  name: 'agentmux-workbench-v1',
  version: 1,
  storage: createJSONStorage(() => persistentWorkbenchStorage.storage),
  /**
   * 版本前进时把上一版的记录原样带过来，一个字段都不重置。
   *
   * 没有这个函数时，zustand 遇到版本不等只会 `console.error` 然后把这份记录当成**不存在**：
   * 实测 zustand 5.0.14 的 hydrate 分支 `return [false, undefined]`，
   * `merge(undefined, get())` 把整份状态换成内存默认值，`hasHydrated()` 照旧变 true，
   * 而 `onRehydrateStorage` 的 error 参数是 `undefined`。三件坏事同时发生：
   *   - 用户的 Tab / 布局 / 侧栏宽度 / 换行开关 / 自己起的 Agent 名字全部消失；
   *   - 上面那道写闸（`workbenchWriteFence`）因为 hydration「成功」了而照旧打开；
   *   - 于是下一次写入覆盖掉唯一的副本。
   * 换句话说 bump 一下版本号就是一次静默数据销毁，而两个检测点（:4073 的 error 分支、
   * `ensurePersistHydrated` 里那条 `!hasHydrated()` 合成检查）都看不见它。
   *
   * 为什么可以整份带过来、不需要挑：判据是**这条记录的缺席是否含糊**（与主进程侧
   * `authoredConfigCarryOver` 同一条判据）。这里持久化的每一项都是「在场就是用户的选择，
   * 不在场就是没设过」，没有任何一项存在「配置写在这个字段出现之前」与「用户主动关掉了它」
   * 分不清的情况——那种含糊只发生在**按内置 id 建键**的集合上，主进程侧的内置 Executor 表是
   * 本仓唯一那个例子。所以这里没有该重置的半边。
   *
   * 这不是兼容层：它不认识任何具体的旧版本号，没有 `if (from === 1)` 分支，也不会随版本增长。
   * 形状变了由下游各自的逐条校验（`projectPersistedWorkbench`、`orderTopics`、
   * `restorePersistedUiState` 里那些 enum 与 Workspace 存在性校验）把认不出的条目丢掉——
   * 那些校验本来就在。这里只负责不要整份丢。
   *
   * 那次 cast 断言的**不是**「这份记录合法」——它不合法也照样交出去。断言的是「版本前进这条路
   * 对记录的信任程度与版本相等那条路**完全相同**」：版本相等时 zustand 直接把反序列化出来的
   * `state` 交给 merge，同样不校验任何字段。两条路都把校验留给真正的取值点
   * （`projectPersistedWorkbench`、`orderTopics`、`restorePersistedUiState`）。所以这个函数
   * 一旦开始挑字段或修形状，它就变成了兼容层；它的正确实现只能是恒等。
   */
  migrate: (persisted) => persisted as PersistedAppState,
  // Startup owns the hydration boundary explicitly. `initialize()` must not ask Core for recovery
  // candidates until the persisted Workbench and UI projection have been merged.
  skipHydration: true,
  onRehydrateStorage: () => (_state, error) => {
    if (error) persistHydrationError = error
  },
  partialize: (state) => ({
    agentComposerDrafts: state.agentComposerDrafts,
    documents: Object.fromEntries(Object.entries(state.documents).filter(([key]) => state.dirtyDocuments[key])),
    dirtyDocuments: Object.fromEntries(Object.entries(state.dirtyDocuments).filter(([, dirty]) => dirty)),
    restoredWorkbench: projectPersistedWorkbench({ tabs: state.tabs, layouts: state.layouts }),
    unclaimedTerminalSessionIds: state.unclaimedTerminalSessionIds,
    // 拖出来的顺序是用户意图，重开应该还在。它只是偏好：恢复时对不上磁盘的条目会被 orderTopics 丢掉。
    scratchTopicOrder: state.scratchTopicOrder,
    // Agent 手改名是用户意图，重开要还在。key 是 session id；已消失的 session 留一条死名字无害——
    // 它不投影到任何界面（没有对应 session），下次同 id 复现的概率是 uuid 级零。
    agentNames: state.agentNames,
    // These are Renderer presentation facts. They are deliberately persisted beside Workbench
    // topology, while PTY/Run/scrollback/Provider transcript state remains Core-owned.
    activeWorkspaceId: state.activeWorkspaceId,
    mainSurface: state.mainSurface,
    projectRailOpen: state.projectRailOpen,
    // 折叠了哪几组是用户意图，重开要还在。key 里带的是父目录路径——与同一份记录里已经逐字
    // 持久化的 file Region path 同一档事实，没有引入新的敏感面。
    collapsedProjectGroups: state.collapsedProjectGroups,
    toolsOpen: state.toolsOpen,
    workspaceTool: state.workspaceTool,
    projectRailWidth: state.projectRailWidth,
    toolDockWidth: state.toolDockWidth,
    // 换行开关是一种查看偏好（像主题），重开要还在——与上面这些表面偏好同一档。
    editorWordWrap: state.editorWordWrap
  })
}))

/** A controlled UI update flushes draft and layout state before unloading. */
export function prepareRendererUpdate(): void {
  if (useAppStore.getState().loading) throw new Error('The interface is still loading; retry the update when ready.')
  if (Object.values(useAppStore.getState().savingDocuments).some(Boolean)) throw new Error('A file save is in progress; retry the update after it completes.')
  persistentWorkbenchStorage.flush()
}
