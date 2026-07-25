import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'
import {
  AGENTMUX_CONTROL_ERROR_CODES,
  type AgentMuxControlErrorCode,
  type AgentMuxControlRequest,
  type AgentMuxControlResult,
  type AgentMuxRegion
} from '@agentmux/core/control'
import type { AgentCatalogEntry } from '@agentmux/core'
import type {
  AgentLaunchResult,
  AgentSessionRecoveryCandidate,
  AgentTimelineSnapshot,
  AppConfig,
  BrowserEvent,
  CreateWorkspacePathInput,
  FileDocument,
  HostConfig,
  HostCheckResult,
  ExecutorDetection,
  RuntimeEvent,
  ScratchTopicSnapshot,
  SessionControl,
  SessionRecoveryResult,
  SessionSnapshot,
  WorkspaceSelectionResult
} from '../../shared/contracts'
import {
  isScratchTopicId,
  scratchTopicIdFromDirectoryName,
  scratchTopicIdFromWorkspacePath,
  workspaceOwnsSessionPath
} from '../../shared/scratch-topics'
import { isScratchWorkspaceId } from '../../shared/contracts'
import { api } from './lib/api'
import type { BrowserAnnotation } from './lib/browser-annotations'
import type { OpenDestination, OpenHttpLinkOrigin } from './lib/open-destination'
import { rendererResourceOwnerCounts } from './lib/resource-owner-counts'
import { terminalResourceOwnerCounts } from './lib/terminal-resource-owners'
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
  addTab,
  createWorkspaceLayout,
  findGroup,
  findGroupForTab,
  focusGroup,
  moveTab as moveLayoutTab,
  removeTab as removeLayoutTab,
  setSplitRatio,
  moveTabToNewGroup as moveLayoutTabToNewGroup,
  type SplitDirection,
  type WorkspaceLayout
} from './lib/workbench-layout'
import {
  setWorkbenchRegionSplitRatio,
  workbenchRegionBounds,
  workbenchRegionPresetSize
} from './lib/workbench-view-layout'
import {
  projectPersistedWorkbench,
  persistedAgentSessionIds,
  restorePersistedWorkbench,
  type PersistedWorkbench
} from './lib/workbench-persistence'
import { reduceBrowserEvent } from './lib/browser-state'
import {
  reduceDocumentContent,
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
  ownsSessionLaunch,
  pendingAgentLaunchEventId,
  discardPendingAgentLaunch,
  projectRuntimeEvent,
  removeSessionProjection,
  reduceAgentMembershipSnapshot,
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
  clampToolDockWidth,
  type WorkspaceTool
} from './lib/surface-tool-dock'
import {
  activeWorkbenchSurface,
  addWorkbenchRegion,
  createWorkbenchTab,
  documentKey,
  findWorkbenchRegion,
  focusWorkbenchTabRegion,
  initialWorkbenchRegionId,
  tabGroupForTab,
  removeWorkbenchRegion,
  replaceWorkbenchRegion,
  sessionTabId,
  tabStillOpen,
  titleWorkbenchSurface,
  topicIdForSession,
  workbenchSurfaces,
  workspaceForSession,
  type AgentWorkbenchSurface,
  type BrowserWorkbenchSurface,
  type FileWorkbenchSurface,
  type LauncherWorkbenchSurface,
  type TerminalWorkbenchSurface,
  type WorkbenchSurface,
  type WorkbenchTab
} from './lib/workbench-tabs'
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
import { isPathWithinSubtree, remapPathWithinSubtree } from './lib/workspace-paths'
import {
  createEmptyFileExplorerViewState,
  type FileExplorerViewState
} from './lib/file-explorer-selection'

type ViewMode = SessionViewMode
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

type AppState = {
  restoredWorkbench: PersistedWorkbench | null
  config: AppConfig | null
  providerCatalog: AgentCatalogEntry[]
  sessions: SessionSnapshot[]
  // The create page can render this shell directly, but it stays outside the ordinary
  // Session projection until the user claims it.
  warmTerminal: WarmTerminal | null
  unclaimedTerminalSessionIds: string[]
  timelines: Record<string, AgentTimelineSnapshot>
  pendingAgentLaunches: Record<string, PendingAgentLaunch>
  activeWorkspaceId: string | null
  documents: Record<string, FileDocument>
  dirtyDocuments: Record<string, boolean>
  documentGenerations: Record<string, number>
  documentObservationGenerations: Record<string, number>
  documentIssues: Record<string, FileDocumentIssue | undefined>
  savingDocuments: Record<string, boolean>
  lastActiveFileByWorkspace: Record<string, string | undefined>
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
  closingWorkbenchViews: Record<string, WorkbenchViewClosePlan>
  workspaceFileRevisions: Record<string, number>
  fileExplorerStates: Record<string, FileExplorerViewState | undefined>
  viewModes: Record<string, ViewMode>
  executorDetections: Record<string, ExecutorDetectionState>
  hostChecks: Record<string, HostCheckState>
  browserAnnotationsByBrowserId: Record<string, BrowserAnnotation[]>
  agentComposerDrafts: Record<string, string>
  mainSurface: MainSurface
  projectRailOpen: boolean
  toolsOpen: boolean
  tabMenuOpen: boolean
  workspaceTool: WorkspaceTool
  toolDockWidth: number
  loading: boolean
  error: string | null
  initialize(): Promise<() => void>
  selectWorkspace(id: string): Promise<void>
  activateWorkspaceSelection(result: WorkspaceSelectionResult): void
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
  focusRegion(workspaceId: string, tabId: string, regionId: string): void
  splitRegion(
    workspaceId: string,
    tabId: string,
    regionId: string,
    direction: SplitDirection
  ): void
  closeRegion(workspaceId: string, tabId: string, regionId: string): Promise<void>
  updateRegionSplitRatio(workspaceId: string, tabId: string, nodePath: string, ratio: number): void
  updateSplitRatio(workspaceId: string, nodePath: string, ratio: number): void
  setViewMode(sessionId: string, mode: ViewMode): void
  setMainSurface(surface: MainSurface): void
  toggleProjectRail(): void
  setTabMenuOpen(open: boolean): void
  setWorkspaceTool(tool: WorkspaceTool): void
  toggleTools(): void
  setToolDockWidth(width: number): void
  updateFileExplorerState(
    workspaceId: string,
    update: (current: FileExplorerViewState) => FileExplorerViewState
  ): void
  detectExecutors(hostId: string): Promise<void>
  checkHost(host: HostConfig): Promise<void>
  openFile(path: string, tabGroupId?: string): Promise<void>
  createScratchTopic(): Promise<ScratchTopicSnapshot>
  openScratchTopic(topicId: string): Promise<void>
  renameScratchTopic(topicId: string, title: string): Promise<ScratchTopicSnapshot>
  createPath(input: CreateWorkspacePathInput): Promise<void>
  renamePath(path: string, nextPath: string): Promise<void>
  deletePath(path: string): Promise<void>
  updateDocument(tabId: string, content: string, regionId?: string): void
  saveDocument(tabId: string, regionId?: string): Promise<void>
  overwriteDocument(tabId: string, regionId?: string): Promise<void>
  reloadDocument(tabId: string, regionId?: string): Promise<void>
  refreshDocument(workspaceId: string, path: string): Promise<void>
  launchBoardAgent(workspaceId: string, executorId: string, prompt: string): Promise<void>
  launchAgent(
    executorId: string,
    prompt: string,
    tabGroupId: string,
    launcher?: { tabId: string; regionId: string }
  ): Promise<void>
  launchTerminal(
    tabGroupId: string,
    launcher?: { tabId: string; regionId: string },
    workspacePath?: string
  ): Promise<void>
  // Idempotent for one host + cwd. Failures stay local to the create page.
  prewarmTerminal(workspaceId: string): void
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
  appendAgentComposerDraft(sessionId: string, text: string): void
  clearAgentComposerDraftIfUnchanged(sessionId: string, expectedText: string): void
  send(sessionId: string, text: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  refreshSession(sessionId: string): Promise<void>
  recoverSession(sessionId: string): Promise<void>
  stopSession(sessionId: string): Promise<void>
  canonicalizeAgentLaunch(result: AgentLaunchResult): Promise<AgentLaunchResult | null>
  resyncTimeline(sessionId: string): Promise<void>
  applyEvent(event: RuntimeEvent): void
  setConfig(config: AppConfig): void
  reportError(error: unknown): void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
    (surface.kind === 'agent' || surface.kind === 'terminal') &&
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
          (surface.kind === 'terminal' || surface.kind === 'agent') &&
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
    return result.currentRun
      ? `This Agent Session now belongs to Run ${result.currentRun.runId}; the stale Run was not resumed.`
      : 'Another lifecycle operation owns this Agent Session; no new Run was started.'
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

function recoveryCandidateSession(
  candidate: AgentSessionRecoveryCandidate,
  recovery: Extract<SessionRecoveryResult, { kind: 'unavailable' | 'conflict' }>
): SessionSnapshot {
  return {
    id: candidate.agentSessionId,
    kind: 'agent',
    providerId: candidate.providerId,
    executorId: candidate.executorId,
    capabilities: candidate.capabilities,
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
      continuity: recovery.kind,
      detail: continuityFailureDetail(recovery)
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

const detectionRequestIds = new Map<string, number>()
const hostCheckRequestIds = new Map<string, number>()
const timelineResyncs = new Map<string, { requested: boolean; promise: Promise<void> }>()
const fileDocumentLifetimes = new Map<string, number>()
const fileReadRequestIds = new Map<string, number>()
const fileReadInFlightCounts = new Map<string, number>()
const fileInvalidationSequences = new Map<string, number>()
const fileSaveTails = new Map<string, Promise<void>>()
const workspaceFileMutationTails = new Map<string, Promise<void>>()
const fileOpenRequests = new Map<string, Promise<boolean>>()

function fileSurface(tab: WorkbenchTab | undefined, regionId?: string): FileWorkbenchSurface | null {
  if (!tab) return null
  const surface = regionId ? tab.regions[regionId] : titleWorkbenchSurface(tab)
  return surface?.kind === 'file' ? surface : null
}

function isScratchTopicDocument(surface: FileWorkbenchSurface): boolean {
  const segments = surface.path.split('/').filter(Boolean)
  const directoryName = segments.at(-2)
  const fileName = segments.at(-1)
  return isScratchWorkspaceId(surface.workspaceId) &&
    fileName === 'topic.md' &&
    scratchTopicIdFromDirectoryName(directoryName ?? '') !== null
}

function openFileRefs(tabs: Readonly<Record<string, WorkbenchTab>>): Map<string, FileWorkbenchSurface> {
  return new Map(Object.values(tabs).flatMap((tab) => workbenchSurfaces(tab).flatMap((surface) => (
    surface.kind === 'file' ? [[documentKey(surface.workspaceId, surface.path), surface] as const] : []
  ))))
}

async function disposeClosedFileOwners(
  previousTabs: Readonly<Record<string, WorkbenchTab>>,
  nextTabs: Readonly<Record<string, WorkbenchTab>>
): Promise<void> {
  const previous = openFileRefs(previousTabs)
  const next = openFileRefs(nextTabs)
  await Promise.all([...previous].flatMap(([key, surface]) => {
    if (next.has(key)) return []
    advanceDocumentLifetime(key)
    return [api.files.unobserve(surface.workspaceId, surface.path)]
  }))
}

async function withWorkspaceFileMutation<T>(
  workspaceId: string,
  path: string,
  operation: () => Promise<T>
): Promise<T> {
  const previousMutation = workspaceFileMutationTails.get(workspaceId) ?? Promise.resolve()
  let releaseMutation!: () => void
  const mutation = new Promise<void>((resolve) => { releaseMutation = resolve })
  const tail = previousMutation.catch(() => {}).then(async () => await mutation)
  workspaceFileMutationTails.set(workspaceId, tail)
  const prefix = `${workspaceId}\0`
  const saves = [...fileSaveTails.entries()].flatMap(([key, save]) => (
    key.startsWith(prefix) && isPathWithinSubtree(key.slice(prefix.length), path) ? [save] : []
  ))
  try {
    await previousMutation.catch(() => {})
    await Promise.all(saves.map(async (save) => await save.catch(() => {})))
    return await operation()
  } finally {
    releaseMutation()
    await tail
    if (workspaceFileMutationTails.get(workspaceId) === tail) {
      workspaceFileMutationTails.delete(workspaceId)
    }
  }
}

function transferFileSaveTail(workspaceId: string, path: string, nextPath: string): void {
  const key = documentKey(workspaceId, path)
  const tail = fileSaveTails.get(key)
  if (!tail) return
  const nextKey = documentKey(workspaceId, nextPath)
  const previous = fileSaveTails.get(nextKey) ?? Promise.resolve()
  const transferred = Promise.all([previous.catch(() => {}), tail.catch(() => {})]).then(() => {})
  if (fileSaveTails.get(key) === tail) fileSaveTails.delete(key)
  fileSaveTails.set(nextKey, transferred)
  void transferred.finally(() => {
    if (fileSaveTails.get(nextKey) === transferred) fileSaveTails.delete(nextKey)
  })
}

function documentLifetime(key: string): number {
  return fileDocumentLifetimes.get(key) ?? 0
}

function advanceDocumentLifetime(key: string): number {
  const lifetime = documentLifetime(key) + 1
  fileDocumentLifetimes.set(key, lifetime)
  fileReadRequestIds.set(key, (fileReadRequestIds.get(key) ?? 0) + 1)
  return lifetime
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
        message: message(error)
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
        message: message(error)
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
              workspaceFileRevisions: {
                ...current.workspaceFileRevisions,
                [surface.workspaceId]: (current.workspaceFileRevisions[surface.workspaceId] ?? 0) + 1
              }
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

function startSessionMembershipResync(event: RuntimeEvent): void {
  if (sessionMembershipResync) {
    enqueueSessionMembershipEvent(sessionMembershipResync, event)
    return
  }
  const entry: SessionMembershipResync = {
    events: [{ event, pendingLaunchAgentSessionId: null }],
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
          return projected
        })
        for (const sessionId of timelineGaps) void useAppStore.getState().resyncTimeline(sessionId)
        if (!membershipGap) return
      }
    } catch (error) {
      useAppStore.getState().reportError(error)
    } finally {
      if (sessionMembershipResync === entry) sessionMembershipResync = null
    }
  })()
}

type WarmTerminal = {
  // Prevents a shell from being reused for the wrong host or working directory.
  key: string
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

function newLauncherTab(workspaceId: string): WorkbenchTab {
  const tabId = `launcher:${crypto.randomUUID()}`
  const surface: LauncherWorkbenchSurface = {
    regionId: initialWorkbenchRegionId(tabId),
    kind: 'launcher',
    workspaceId
  }
  return createWorkbenchTab(tabId, surface)
}

type PersistedAppState = {
  restoredWorkbench: PersistedWorkbench
  unclaimedTerminalSessionIds: string[]
}

const nonBrowserWorkbenchStorage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined
}

export const useAppStore = create<AppState>()(persist<AppState, [], [], PersistedAppState>((set, get) => ({
  restoredWorkbench: null,
  config: null,
  providerCatalog: [],
  sessions: [],
  warmTerminal: null,
  unclaimedTerminalSessionIds: [],
  timelines: {},
  pendingAgentLaunches: {},
  activeWorkspaceId: null,
  documents: {},
  dirtyDocuments: {},
  documentGenerations: {},
  documentObservationGenerations: {},
  documentIssues: {},
  savingDocuments: {},
  lastActiveFileByWorkspace: {},
  tabs: {},
  layouts: {},
  closingWorkbenchViews: {},
  workspaceFileRevisions: {},
  fileExplorerStates: {},
  viewModes: {},
  executorDetections: {},
  hostChecks: {},
  browserAnnotationsByBrowserId: {},
  agentComposerDrafts: {},
  mainSurface: 'workbench',
  projectRailOpen: true,
  toolsOpen: true,
  tabMenuOpen: false,
  workspaceTool: 'files-branches',
  toolDockWidth: TOOL_DOCK_DEFAULT_WIDTH,
  loading: true,
  error: null,
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
      const [config, initialSnapshot, providerCatalog] = await Promise.all([
        api.config.get(),
        api.sessions.snapshot(),
        api.providers.list()
      ])
      let snapshot = initialSnapshot
      const persistedAgentIds = persistedAgentSessionIds(get().restoredWorkbench)
      const recoveryFailures: SessionSnapshot[] = []
      let recovered = false
      for (const candidate of snapshot.recoveryCandidates) {
        if (!persistedAgentIds.has(candidate.agentSessionId)) continue
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
        }
      }
      if (recovered) snapshot = await api.sessions.snapshot()
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
        snapshot = await api.sessions.snapshot()
      }
      const unclaimedSessionIds = new Set(get().unclaimedTerminalSessionIds)
      const visibleSessions = [
        ...snapshot.sessions.filter((session) => !unclaimedSessionIds.has(session.id)),
        ...recoveryFailures
      ]
      const firstWorkspace = config.workspaces[0]?.id ?? null
      const workbench = restorePersistedWorkbench({
        config,
        sessions: visibleSessions,
        persisted: get().restoredWorkbench,
        createTabGroupId: newTabGroupId
      })
      set({
        restoredWorkbench: null,
        config,
        providerCatalog,
        sessions: visibleSessions,
        unclaimedTerminalSessionIds: [...failedCleanupIds],
        timelines: snapshot.timelines,
        pendingAgentLaunches: {},
        activeWorkspaceId: firstWorkspace,
        tabs: workbench.tabs,
        layouts: workbench.layouts,
        loading: false
      })
      if (firstWorkspace) void get().selectWorkspace(firstWorkspace)
      booting = false
      for (const event of pendingSessionEvents) get().applyEvent(event)
      for (const event of pendingBrowserEvents) get().applyBrowserEvent(event)
      return () => {
        disposeRuntimeSubscriptions()
      }
    } catch (error) {
      booting = false
      disposeRuntimeSubscriptions()
      set({ loading: false, error: message(error) })
      return () => {}
    }
  },
  async selectWorkspace(id) {
    set({ activeWorkspaceId: id, mainSurface: 'workbench', error: null })
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
        layouts: existingLayout
          ? state.layouts
          : { ...state.layouts, [workspace.id]: createWorkspaceLayout(newTabGroupId()) }
      }
    })
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
      return {
        operation: request.operation,
        agents: Object.entries(state.config?.executors ?? {}).map(([executorId, executor]) => ({
          executorId,
          label: executor.label,
          providerId: executor.providerId,
          available: state.config?.workspaces.some((workspace) => (
            state.executorDetections[executorDetectionKey(workspace.hostId, executorId)]?.state === 'ready'
          )) ?? false
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
      const current = workbenchRegionBounds(tab.layout.root).length
      const additions = request.mode.kind === 'preset'
        ? Array.from({ length: Math.max(0, workbenchRegionPresetSize(request.mode.preset) - current) }, newRegionId)
        : []
      const arranged = arrangeWorkbenchControlTab(tab, request.mode, additions)
      set({ tabs: { ...state.tabs, [tab.id]: arranged } })
      return { operation: request.operation, tab: inspectWorkbenchControlTab(input(), arranged) }
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
      await api.sessions.submitPrompt(session.control, request.text)
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
      if (!state.config?.executors[content.executorId]) {
        throw controlFailure('AGENT_EXECUTOR_NOT_CONFIGURED', 'Agent Executor is not configured.')
      }
      const agentSessionId = crypto.randomUUID()
      const scratchTopicId = isScratchWorkspaceId(workspace.id)
        ? (plan.kind === 'tab' ? plan.tabId : plan.tabs[plan.tabId]?.topicId)
        : undefined
      if (scratchTopicId && !isScratchTopicId(scratchTopicId)) {
        throw controlFailure('REGION_TOPIC_MISMATCH', 'Control destination has an invalid Scratch Topic.')
      }
      if (scratchTopicId && plan.kind === 'tab') plan.tabs[plan.tabId] = { ...plan.tabs[plan.tabId]!, topicId: scratchTopicId }
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
            throw controlFailure('LAUNCH_CLEANUP_FAILED', `${primary.message} Cleanup failed: ${message(cleanupError)}`, {
              cause: new AggregateError([primary, cleanupError])
            })
          }
        }
        throw primary
      }
      try {
        launched = await api.sessions.launchAgent({
          executorId: content.executorId,
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
          await cleanup(controlFailure('CONTROL_OWNER_LOST', 'Control Region owner disappeared during Agent launch.'))
        }
        if (!workspaceOwnsSessionPath(workspace, committed.session)) {
          await cleanup(controlFailure('LAUNCH_RESULT_MISMATCH', 'Agent launch returned another Workspace.'))
        }
        set((current) => reduceAgentSessionLaunchAttached(current, plan.regionId, committed).state)
        return {
          operation: request.operation,
          region: {
            tabId: plan.tabId, regionId: plan.regionId, workspaceId: workspace.id, kind: 'agent',
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
            throw controlFailure('LAUNCH_CLEANUP_FAILED', `${primary.message} Cleanup failed: ${message(cleanupError)}`, {
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
        return {
          operation: request.operation,
          region: {
            tabId: plan.tabId, regionId: plan.regionId, workspaceId: workspace.id, kind: 'terminal',
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
          throw controlFailure('LAUNCH_CLEANUP_FAILED', `${primary.message} Cleanup failed: ${message(cleanupError)}`, {
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
        (surface.kind === 'agent' || surface.kind === 'terminal') && surface.sessionId === id
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
    set((state) => ({
      activeWorkspaceId: workspace.id,
      mainSurface: 'workbench',
      tabs: { ...state.tabs, [tab.id]: tab },
      layouts: {
        ...state.layouts,
        [workspace.id]: existingTabGroupId
          ? activateLayoutTab(layout, targetTabGroupId, tabId)
          : addTab(layout, targetTabGroupId, tabId)
      }
    }))
    if (existing) get().focusRegion(workspace.id, tabId, regionId)
  },
  openLauncher(tabGroupId) {
    const workspaceId = get().activeWorkspaceId
    const layout = workspaceId ? get().layouts[workspaceId] : undefined
    if (!workspaceId || !layout) return
    const targetTabGroupId = tabGroupId ?? layout.activeGroupId
    const tab = newLauncherTab(workspaceId)
    set((state) => ({
      mainSurface: 'workbench',
      tabs: { ...state.tabs, [tab.id]: tab },
      layouts: { ...state.layouts, [workspaceId]: addTab(layout, targetTabGroupId, tab.id) }
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
  moveTab(workspaceId, tabId, sourcePaneId, targetPaneId, targetIndex) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    const layout = current.layouts[workspaceId]
    if (!layout) return
    set((state) => ({
      layouts: {
        ...state.layouts,
        [workspaceId]: moveLayoutTab(layout, tabId, sourcePaneId, targetPaneId, targetIndex)
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
  focusRegion(workspaceId, tabId, regionId) {
    const tab = get().tabs[tabId]
    const layout = get().layouts[workspaceId]
    const tabGroupId = layout ? tabGroupForTab(layout, tabId) : null
    if (!tab || tab.workspaceId !== workspaceId || !tabGroupId || !tab.regions[regionId]) return
    set((state) => ({
      tabs: { ...state.tabs, [tabId]: focusWorkbenchTabRegion(tab, regionId) },
      layouts: {
        ...state.layouts,
        [workspaceId]: activateLayoutTab(layout!, tabGroupId, tabId)
      }
    }))
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
  async closeRegion(workspaceId, tabId, regionId) {
    const current = get()
    if (!workbenchViewCloseAllowsView(current.closingWorkbenchViews, tabId)) return
    const tab = current.tabs[tabId]
    const surface = tab?.regions[regionId]
    if (!tab || tab.workspaceId !== workspaceId || !surface) return
    if (!removeWorkbenchRegion(tab, regionId)) return
    if (surface.kind === 'browser') {
      try {
        await api.browser.close(surface.browserId)
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
      return surface.kind === 'file'
        ? reconcileWorkbenchFileProjection(state, { tabs, layouts: state.layouts })
        : { tabs }
    })
    if (surface.kind === 'file') await disposeClosedFileOwners(previousTabs, get().tabs)
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
  setMainSurface(mainSurface) {
    set({ mainSurface })
  },
  toggleProjectRail() {
    set((state) => ({ projectRailOpen: !state.projectRailOpen }))
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
          set((state) => ({
            executorDetections: {
              ...state.executorDetections,
              [executorDetectionKey(hostId, executorId)]: {
                state: result.installed ? 'ready' : 'missing',
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
                detail: message(error),
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
          [host.id]: { state: 'error', detail: message(error), observedAt: Date.now() }
        }
      }))
    }
  },
  async openFile(path, tabGroupId) {
    const workspaceId = get().activeWorkspaceId
    const layout = workspaceId ? get().layouts[workspaceId] : undefined
    if (!workspaceId || !layout) return
    const key = documentKey(workspaceId, path)
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
    }
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
    set((current) => {
      const currentLayout = current.layouts[workspace.id]
      if (!currentLayout) return current
      const nextTab = { ...targetTab, topicId }
      const alreadyOpen = Boolean(current.tabs[targetTab.id])
      return {
        tabs: { ...current.tabs, [nextTab.id]: nextTab },
        layouts: {
          ...current.layouts,
          [workspace.id]: alreadyOpen
            ? activateLayoutTab(currentLayout, layout.activeGroupId, nextTab.id)
            : addTab(currentLayout, layout.activeGroupId, nextTab.id)
        },
        workspaceFileRevisions: {
          ...current.workspaceFileRevisions,
          [workspace.id]: (current.workspaceFileRevisions[workspace.id] ?? 0) + 1
        }
      }
    })
    return snapshot
  },
  async openScratchTopic(topicId) {
    const state = get()
    const workspace = state.config?.workspaces.find((item) => item.id === state.activeWorkspaceId)
    if (!workspace || !isScratchWorkspaceId(workspace.id)) {
      throw new Error('Select the Scratch workspace first')
    }
    const snapshot = await api.scratch.readTopic(workspace.id, topicId)
    if (!snapshot) throw new Error('Scratch Topic no longer exists')
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
          layouts: {
            ...current.layouts,
            [workspace.id]: activateLayoutTab(layout, groupId, boundTab.id)
          }
        }
      }
      const tab = { ...newLauncherTab(workspace.id), topicId }
      return {
        tabs: { ...current.tabs, [tab.id]: tab },
        layouts: {
          ...current.layouts,
          [workspace.id]: addTab(layout, layout.activeGroupId, tab.id)
        }
      }
    })
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
        workspaceFileRevisions: {
          ...current.workspaceFileRevisions,
          [workspace.id]: (current.workspaceFileRevisions[workspace.id] ?? 0) + 1
        }
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
      set((state) => reduceFileRename(state, workspaceId, path, nextPath))
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
        set((state) => reduceFileDelete(state, workspaceId, path))
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
  async launchBoardAgent(workspaceId, executorId, prompt) {
    await get().selectWorkspace(workspaceId)
    set({ mainSurface: 'board' })
    const layout = get().layouts[workspaceId]
    if (!layout) throw new Error('Workspace layout is unavailable')
    await get().launchAgent(executorId, prompt, layout.activeGroupId)
  },
  async launchAgent(executorId, prompt, tabGroupId, launcher) {
    const state = get()
    const launcherTab = launcher ? state.tabs[launcher.tabId] : undefined
    const launcherSurface = launcherTab && launcher
      ? launcherTab.regions[launcher.regionId]
      : undefined
    if (launcher && launcherSurface?.kind !== 'launcher') {
      throw new Error('Launcher Region is no longer available')
    }
    const workspaceId = launcherTab?.workspaceId ?? state.activeWorkspaceId
    const workspace = state.config?.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new Error('Select a workspace first')
    const layout = state.layouts[workspace.id]
    if (!layout) throw new Error('Workspace layout is unavailable')
    const targetTab = launcherTab ?? newLauncherTab(workspace.id)
    const tabId = targetTab.id
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, tabId)) throw new Error('The View is closing')
    const scratchTopicId = isScratchWorkspaceId(workspace.id)
      ? (targetTab.topicId ?? tabId)
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
    set((current) => ({
      tabs: { ...current.tabs, [tabId]: pendingTab },
      layouts: {
        ...current.layouts,
        [workspace.id]: launcher ? layout : addTab(layout, tabGroupId, tabId)
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
            new Error(`Agent launch result mismatched its requested Session and cleanup failed: ${message(cleanupError)}`),
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
            new Error(`Agent launch state could not be reconciled and cleanup failed: ${message(cleanupError)}`),
            {
              code: 'AGENT_LAUNCH_CLEANUP_FAILED',
              cause: new AggregateError([reconcileError, cleanupError])
            }
          )
        }
        throw reconcileError
      }
      if (!result) {
        set((current) => reduceSessionLaunchFailed(current, regionId, 'agent', sessionId))
        return
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
            new Error(`Agent launch owner disappeared and cleanup failed: ${message(cleanupError)}`),
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
              workspaceFileRevisions: {
                ...current.workspaceFileRevisions,
                [workspace.id]: (current.workspaceFileRevisions[workspace.id] ?? 0) + 1
              }
            }
          : reduced.state
      })
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
    const workspaceId = launcherTab?.workspaceId ?? state.activeWorkspaceId
    const workspace = state.config?.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) throw new Error('Select a workspace first')
    const layout = state.layouts[workspace.id]
    if (!layout) throw new Error('Workspace layout is unavailable')
    const targetTab = launcherTab ?? newLauncherTab(workspace.id)
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
    set((current) => ({
      tabs: { ...current.tabs, [tabId]: pendingTab },
      layouts: {
        ...current.layouts,
        [workspace.id]: launcher ? layout : addTab(layout, tabGroupId, tabId)
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
  prewarmTerminal(workspaceId) {
    const workspace = get().config?.workspaces.find((item) => item.id === workspaceId)
    if (!workspace) return
    const key = warmTerminalKey(workspace.hostId, workspace.path)
    const existing = get().warmTerminal
    if (existing?.key === key) return
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
    set({ warmTerminal: { key, ready, session: null } })
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
    const workspaceId = launcherTab?.workspaceId ?? state.activeWorkspaceId
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
    const targetTab = launcherTab ?? newLauncherTab(workspace.id)
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
      bound = true
      return {
        tabs: nextTabs,
        layouts: { ...current.layouts, [workspace.id]: addTab(layout, tabGroupId, tabId) },
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
    const workspaceId = launcherTab?.workspaceId ?? state.activeWorkspaceId
    if (!workspaceId) throw new Error('Select a workspace first')
    const layout = state.layouts[workspaceId]
    if (!layout) throw new Error('Workspace layout is unavailable')
    const targetTab = launcherTab ?? newLauncherTab(workspaceId)
    const tabId = targetTab.id
    if (!workbenchViewCloseAllowsView(state.closingWorkbenchViews, tabId)) throw new Error('The View is closing')
    const regionId = launcher?.regionId ?? targetTab.layout.activeRegionId
    const pendingLauncher = targetTab.regions[regionId]
    if (pendingLauncher?.kind !== 'launcher') throw new Error('Launcher Region is no longer available')
    if (!launcher) {
      set((current) => ({
        tabs: { ...current.tabs, [tabId]: targetTab },
        layouts: { ...current.layouts, [workspaceId]: addTab(layout, tabGroupId, tabId) }
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
            `${primary.message} Cleanup also failed: ${message(cleanupError)}`
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
        const tab = createWorkbenchTab(tabId, pendingLauncher)
        const nextLayout = addTab(layout, origin.tabGroupId, tabId)
        if (nextLayout === layout) {
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
  async send(sessionId, text) {
    if (!text.trim()) return
    const session = get().sessions.find((item) => item.id === sessionId)
    if (!session || session.kind !== 'agent') return
    try {
      await api.sessions.submitPrompt(session.control, text)
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
                    continuity: recovery.kind,
                    detail: continuityFailureDetail(recovery)
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
  },
  setConfig(config) {
    detectionRequestIds.clear()
    hostCheckRequestIds.clear()
    set({ config, executorDetections: {}, hostChecks: {} })
  },
  reportError(error) {
    set({ error: message(error) })
  }
}), {
  name: 'agentmux-workbench-v1',
  version: 1,
  storage: createJSONStorage(() => (
    typeof window === 'undefined' ? nonBrowserWorkbenchStorage : window.localStorage
  )),
  partialize: (state) => ({
    restoredWorkbench: projectPersistedWorkbench({ tabs: state.tabs, layouts: state.layouts }),
    unclaimedTerminalSessionIds: state.unclaimedTerminalSessionIds
  })
}))
