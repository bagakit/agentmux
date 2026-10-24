import { mintObjectId, mintCapabilityToken, isObjectId } from '@agentmux/core/object-id'
import type { CapsuleInspection, CapsuleRecord } from '@agentmux/core/capsule'
import type { WorkbenchWindowDocument } from '../shared/workbench-windows.js'
import type { BrowserInputFrameCapture } from '../shared/browser-input-context-capture.js'
import { BROWSER_FAVICON_TIMEOUT_MS, readBrowserFavicon } from './browser-favicon.js'
import type { BrowserColdDescriptor } from './browser-cold-descriptor.js'
import { parseBrowserControlHandoff, type BrowserAgentAuthority } from './browser-agent-authority.js'
import type { BrowserRecoveryPreviewStore } from './browser-recovery-preview.js'
import { installNativeBrowserWindows } from './browser-native-windows.js'
import { BROWSER_RECOVERY_PREVIEW_JPEG_PREFIX, BROWSER_RECOVERY_PREVIEW_MAX_WIDTH, BROWSER_RECOVERY_PREVIEW_MAX_HEIGHT,
  BROWSER_RECOVERY_PREVIEW_MAX_IMAGE_BYTES, type BrowserRecoveryPreviewScope } from '../shared/browser-recovery-preview.js'
import { readScreenshotViewport, screenshotSource, SCREENSHOT_VIEWPORT_SCRIPT } from './browser-screenshot-source.js'
import { evaluateBrowserOutcomeCriteria } from './browser-outcome-criteria.js'
import { parseBrowserStructuredOutputRequest } from './browser-structured-output.js'
import { resolveBrowserStructuredTarget } from './browser-structured-target.js'
import { parseBrowserOutcomeCriteriaRequest, type BrowserOutcomeEvaluation, type BrowserOutcomeFieldRunInput, type BrowserOutcomeRegistration } from '../shared/browser-outcome-criteria.js'

import { BaseWindow, dialog, session, WebContentsView, type BrowserWindow, type BrowserWindowConstructorOptions, type WebContents, type WebFrameMain, type Session } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BROWSER_PAGE_CAPABILITY_NAMES, BROWSER_PAGE_MUTATING_CAPABILITY_NAMES, browserPageCapabilityNames, type AgentMuxBrowserMode, type AgentMuxBrowserTarget, type AgentMuxBrowserRetention, type AgentMuxBrowserRetentionReason, type AgentMuxBrowserControl, type AgentMuxBrowserReleaseReceipt } from '@agentmux/core'
import {
  BROWSER_EVENT_CHANNEL,
  BROWSER_PRESENTATION_EVENT_CHANNEL,
  BROWSER_PNG_MAX_BASE64_CHARS,
  type BrowserAnnotationMarker,
  type BrowserBounds,
  type BrowserElementRect,
  type BrowserElementSelection,
  type BrowserEvent,
  type BrowserScreenshotCapture,
  type BrowserScriptRunReport,
  type BrowserSnapshot,
  type BrowserViewport,
  type BrowserOperator,
  type BrowserActivityState
} from '../shared/contracts.js'
import type { BrowserControlHandoff } from '../shared/contracts.js'
import type {
  BrowserPresentationOccurrence, BrowserPresentationGeometry, BrowserPresentationLease,
  BrowserPresentationCapture, BrowserPresentationCaptureAck, BrowserPresentationEvent,
  BrowserPresentationRevocationReason, BrowserPresentationActivation, BrowserPresentationActivationReceipt,
  BrowserPresentationViewportPoint, BrowserPresentationMouseModifier
} from '../shared/contracts.js'
import type { AgentMuxControlErrorCode } from '@agentmux/core/control'
import type { BrowserOperation, BrowserOperationStep, BrowserReplayPlan, BrowserReplayStep } from '../shared/browser-operation.js'
import { normalizeBrowserBounds } from '../shared/browser-bounds.js'
import { browserViewportSize, cloneBrowserViewport, isBrowserViewport } from '../shared/browser-viewport.js'
import { resolveBrowserAddress } from '../shared/browser-address.js'
import type { BrowserInputHistoryScope } from '../shared/browser-input-history.js'
import { showBrowserOperationFeedback, type BrowserOperationFeedback } from './browser-operation-feedback.js'
import { BrowserControlFeedback } from './browser-control-feedback.js'
import { validateBrowserOperatorAvatarPng } from './browser-operator-avatar.js'
import { DEFAULT_BROWSER_AGENT_CONTROL, type BrowserAgentControlPreferences } from '../shared/browser-agent-control.js'
import { installTextEditContextMenu } from './text-edit-context-menu.js'
import { BrowserCdpSession } from './browser-cdp-session.js'
import { BrowserNativeInputShield } from './browser-native-input-shield.js'
import { cancelBrowserWebAuthnAccounts, registerBrowserWebAuthnAccounts, type BrowserWebAuthnOwner } from './browser-webauthn-accounts.js'
import { cancelBrowserWebAuthnAccess, registerBrowserWebAuthnAccess } from './browser-webauthn-access.js'
import { capturePageImage } from '@agentmux/native-desktop/image'
import { browserPagePixels } from './browser-image.js'
import { createBrowserPageDispatch } from './browser-page-dispatch.js'
import { browserOperationPhaseFromOutcome, browserRunOutcomeFromFailure } from './browser-run-outcome.js'
import { safeBrowserUrl, startBrowserOperationStep, summarizeBrowserValue } from './browser-operation-step.js'
import { BrowserRefLedgerStore } from './browser-ref-ledger-store.js'
import {
  appLinkOutcome,
  appLinkRefusedMessage,
  classifyBrowserTarget,
  type AppLinkSchemeChoice
} from './browser-app-link.js'
import { runBrowserScript } from './browser-script-runner.js'
import { buildReplayScript } from './browser-replay-compiler.js'
import { captureBrowserPageSnapshot, type BrowserCdpSender } from './browser-page-snapshot.js'
import { verifyBrowserSemanticTarget } from './browser-semantic-target.js'
import type { BrowserOperationJournal } from './browser-operation-journal.js'
import { BrowserStepEvidenceStore, pageStepEvidence, recordBrowserStepEvidence, screenshotStepEvidence } from './browser-step-evidence.js'
import type { BrowserStepEvidenceContent, BrowserStepEvidenceRead } from '../shared/browser-step-evidence.js'
import type { BrowserPageSnapshot } from '../shared/contracts.js'
import { BrowserResultArtifactStore } from './browser-result-artifact.js'
import type { BrowserResultContext, BrowserResultReadOptions, BrowserResultArtifactChunk } from '../shared/browser-result-artifact.js'
import type { BrowserStructuredOutputReceipt } from '../shared/browser-structured-output.js'
import type { BrowserScopedSnapshot } from '../shared/browser-snapshot-query.js'
import { BrowserDemonstrationCapture } from './browser-demonstration-capture.js'
import { BrowserDemonstrationInterpreter } from './browser-demonstration-interpretation.js'
import type { BrowserDemonstrationRecorder } from './browser-demonstration-recorder.js'
import type { BrowserDemonstrationDraft, BrowserDemonstrationState } from '../shared/browser-demonstration.js'
import type { BrowserUploads } from './browser-uploads.js'
import type { BrowserDownloads } from './browser-downloads.js'
import { BrowserTaskAssets, runBrowserTaskAsset } from './browser-task-assets.js'
import { runBrowserTaskBatch, type BrowserTaskRunBudget } from './browser-task-batch.js'
import type { BrowserTaskAsset, BrowserTaskAssetRun, BrowserTaskAssetRunInput, BrowserTaskAssetState, BrowserTaskContent, BrowserTaskStepExecution, BrowserTaskStep, BrowserTaskBatchInput, BrowserTaskBatchRun } from '../shared/browser-task-assets.js'
import { recoverBrowserTaskStep, runBrowserTaskNavigation } from './browser-local-recovery.js'
import { sanitizeBrowserElementSelection } from './browser-selection.js'
import {
  BROWSER_SELECTION_WORLD_ID,
  buildBrowserAnnotationMarkerScript,
  buildCancelBrowserAnnotationMarkerScript,
  buildBrowserElementSelectionScript,
  buildSelectedBrowserElementExpression,
  buildCancelBrowserElementSelectionScript
} from './browser-selection-script.js'

type BrowserStorage =
  | { mode: 'normal'; profileId: string; partition: string }
  | { mode: 'normal'; profileId: null; partition: string; capsule: CapsuleInspection; capsuleOrigin: string; capsuleOpenOperationIds: string[] }
  | { mode: 'private'; profileId: null; partition: string; session: Session }

type NativeChildCloseObserver = { resolve(closed: boolean): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> | null }
type NativeChildClose = {
  id: string
  view: WebContentsView
  navigationId: string
  processId: number
  frameToken: string
  prompted: boolean
  observers: Set<NativeChildCloseObserver>
  settle(closed: boolean): void
}

type BrowserEntry = {
  id: string
  source?: import('@agentmux/core').AgentMuxBrowserSource
  nativeChild?: {
    window: { width: number; height: number }
    closing?: NativeChildClose
    closeWarning?: string
  }
  readonly workspaceId: string | null
  view: WebContentsView
  storage: BrowserStorage
  requestedUrl: string
  navigationId: string
  /** A native main-frame commit, distinct from a requested navigation or a displayed URL. */
  committedNavigationId: string | null
  capsuleRequest: { id: number; navigationId: string; frame: WebFrameMain } | null
  capsuleResponse: { instanceId: string; navigationId: string; frame: WebFrameMain } | null
  initialDocument: {
    view: WebContentsView; completion: AbortController; superseded: AbortController
    failure: { error: unknown } | null
    resolve(): void; reject(error: unknown): void
    navigationId: string | null; loadNavigationId: string | null; committedNavigationId: string | null
  } | null
  faviconDataUrl?: string | undefined
  faviconUrl?: string | undefined
  faviconRequest?: AbortController | undefined
  recoveryPreviewJob?: AbortController | undefined
  recoveryPreviewNavigation?: string | undefined
  recoveryPreviewRetired?: true
  selectionRevision: number
  selectionOperation: number | symbol | null
  annotationRevision: number
  switchRevision: number
  pendingSwitch: PendingProfileSwitch | null
  bounds: BrowserBounds | null
  visible: boolean
  viewport: BrowserViewport
  error: string | null
  /**
   * 这一刻有没有一段 Agent 程序在驱动它。`snapshot()` 读取它——渲染进程据此
   * 在标签上认出是哪一格（见 `BrowserSnapshot.driving` 的说明）。
   *
   * 一个布尔够用，不必是计数：两次 run 不可能在同一个页面上重叠——`BrowserCdpSession.attach` 对
   * 已 attach 的 page 第二次会抛，`runScript` 第一件事就是它。
   */
  driving: boolean
  /** 这一页上待答的那个应用链接提问。回答掉或换页就清。 */
  appLinkPrompt: { url: string; scheme: string } | null
  appLinkRequest: symbol | null
  activity: BrowserActivityState
  humanControl: boolean
  activeRun: { operationId: string; signal: AbortSignal; stop: () => void } | undefined
  runInFlight: boolean
  controlRevision: number
  /** Main-owned relationship; absent legacy metadata is unknown, never inferred from the Journal. */
  agent: AgentMuxBrowserControl['agent']
  agentWarning: string | undefined
  inputShield?: BrowserNativeInputShield | undefined
  inputShieldCleanupNotice?: {
    shield: BrowserNativeInputShield; originalOperation: BrowserOperation | null
  }
  /** One exact native owner's current notice; its original operation keeps the incident history. */
  inputIsolationNotice?: {
    view: WebContentsView; operation: BrowserOperation | null; resolved: boolean
  }
  inputIsolation: AgentMuxBrowserControl['inputIsolation']
  feedbackRevision: number
  feedback?: BrowserOperationFeedback
  controlFeedback?: BrowserControlFeedback
  demonstration?: BrowserDemonstrationState
  demonstrationInterpreter?: BrowserDemonstrationInterpreter
  taskAssets?: BrowserTaskAssetState
  /** Transient resources for this entity; never a second durable binding catalogue. */
  presentationLeaseIds: Set<string>
  captureId: string | null
  inputLeaseId: string | null
  firstPress: PresentationFirstPress | null
  // A quiet document is observed from native creation. Usage is sticky for this WC: navigation
  // IDs and even commits cannot distinguish a new document from a BFCache return.
  resourceRisk: Set<AgentMuxBrowserRetentionReason>
  resourceDocumentConfirmed: boolean
  resourceReads: number
  publishedRetention: string | null
  releaseAttempt: {
    navigationId: string
    view: WebContentsView
    pending: boolean
    receipt: AgentMuxBrowserReleaseReceipt | null
    promise: Promise<AgentMuxBrowserReleaseReceipt>
    settle(status: AgentMuxBrowserReleaseReceipt['status'], reasons: readonly AgentMuxBrowserRetentionReason[]): void
  } | null
}

type PresentationFirstPress = {
  id: string
  lease: PresentationLease
  source: WebContentsView
  capture: PresentationCapture
  navigationId: string
  controlRevision: number
  sourceBounds: BrowserBounds
  sourceInputLeaseId: string | null
  geometry: BrowserPresentationGeometry
  zoom: number
  viewport: BrowserViewport
  down: BrowserPresentationViewportPoint
  button: 'left' | 'middle' | 'right'
  clickCount: 1 | 2
  modifiers: readonly BrowserPresentationMouseModifier[]
  state: 'prepared' | 'dispatching' | 'dispatched' | 'cancelled'
  result: BrowserPresentationActivationReceipt | null
}

type PresentationFrameIdentity = Pick<WebFrameMain, 'processId' | 'frameToken'>
type PresentationDocument = PresentationFrameIdentity & { frame: WebFrameMain; session: Session; url: string }
type PresentationLease = {
  id: string
  entry: BrowserEntry
  document: PresentationDocument
  window: BrowserWindow
  windowDocument: WorkbenchWindowDocument | undefined
  occurrence: BrowserPresentationOccurrence
  geometry: BrowserPresentationGeometry
}
type PresentationCapture = {
  id: string
  entry: BrowserEntry
  document: PresentationDocument
  source: WebContentsView
  profileId: string | null
  granted: boolean
  preparingSource: boolean
  preparationWindow: BaseWindow | null
  revoked: boolean
  trackIds: readonly string[] | null
}

type BrowserTaskPageExecution = { cursor: BrowserTaskStepExecution; step?: BrowserTaskStep }

const BROWSER_WAIT_PAGE_CALLS = new Set(browserPageCapabilityNames('wait'))
const BROWSER_DOCUMENT_PAGE_CALLS = new Set(BROWSER_PAGE_CAPABILITY_NAMES.filter(name =>
  !['gotoUrl', 'cdp', 'readResult', 'readDownload', 'wait'].includes(name)))


// Pure hover and motion do not establish active document use; other native input is retained.
const BROWSER_PASSIVE_INPUT_TYPES = new Set<Electron.InputEvent['type']>([
  'mouseMove', 'mouseEnter', 'mouseLeave', 'pointerMove', 'pointerRawUpdate'
])

// Native input clears visual feedback only; control changes require an explicit action.
const BROWSER_FEEDBACK_CLEAR_INPUT_TYPES = new Set([
  'mouseDown',
  'mouseUp',
  'mouseWheel',
  'keyDown',
  'rawKeyDown',
  'char',
  'touchStart',
  'pointerDown'
])

const BROWSER_ACTION_PAGE_CALLS = BROWSER_PAGE_MUTATING_CAPABILITY_NAMES

const INPUT_SHIELD_CLEANUP_WARNING = 'The original Browser input surface could not be fully released. The page and operation are retained; use Return to Agent to retry release, then inspect the page before starting a fresh program.'
const INPUT_ISOLATION_WARNING = 'Native Browser input isolation is unconfirmed. The original page and Agent remain available. Use Take control before editing manually, or submit a fresh Agent program to retry isolation.'
const INPUT_ISOLATION_HISTORY = 'Native input isolation was unconfirmed during this operation.'
function appendWarning(current: string | undefined, warning: string): string {
  return current && (`\n${current}\n`).includes(`\n${warning}\n`) ? current : [current, warning].filter(Boolean).join('\n')
}
function removeWarning(current: string | undefined, warning: string): string | undefined {
  return current?.split('\n').filter(line => line !== warning).join('\n') || undefined
}

/** Metadata retained while a hidden Browser native owner is released. */
type ReleasedBrowser = {
  id: string
  workspaceId: string | null
  storage: BrowserStorage
  requestedUrl: string
  viewport: BrowserViewport
  agent?: AgentMuxBrowserControl['agent']
  agentWarning?: string | undefined
  pendingSwitch?: PendingProfileSwitch
  detachedView?: WebContentsView
  inputShield?: BrowserNativeInputShield
  /** An explicit person-facing Close retires the page; only native cleanup remains. */
  cleanupOnly?: true
}

type ClosingBrowserView = Pick<ReleasedBrowser, 'id' | 'workspaceId' | 'storage' | 'requestedUrl' | 'viewport'> & { view: WebContentsView }
const NATIVE_CLOSE_WARNING = 'Native page cleanup is unconfirmed. Its resource ownership is retained.'

type BrowserRestoreInput = {
  workspaceId: string | null
  profileId: string | null
  mode?: AgentMuxBrowserMode
  viewport: BrowserViewport
}

type PendingProfileSwitch = {
  token: number
  profileId: string
  view: WebContentsView
  rejectCancellation(error: Error): void
  attached: boolean
  released: boolean
  cleanupWarning?: string
}

export interface BrowserProfileResolver {
  defaultProfileId(): string
  resolvePartition(profileId: string): string
}

/**
 * 应用链接移交要用到的两样外部能力。做成一个注入的接口而不是让 manager 自己 import electron +
 * ConfigStore：这个类必须能在没有 Electron 的单测里被直接质询（既有的 `profiles` / `refLedgers`
 * 就是同一个理由）。
 */
export interface AppLinkHost {
  /** 读这一刻记住的答案。每次现读而不是构造时快照一份——设置面改完不该等重启才生效。 */
  rememberedSchemes(): Promise<Record<string, AppLinkSchemeChoice>>
  /** 记住一个答案。只有用户勾了「记住」才会被调到。 */
  rememberScheme(scheme: string, choice: AppLinkSchemeChoice): Promise<void>
  openExternal(target: string): void | Promise<void>
}

export const DEFAULT_BROWSER_ZOOM_FACTOR = 0.9
export interface NativeBrowserOwner { browserId: string; bounds: BrowserBounds; view: WebContentsView; inputShield?: WebContentsView }
export interface NativeBrowserInputBarrier { ready: Promise<void>; release(): Promise<void> }
type NativeBrowserInputSurface = {
  entry: BrowserEntry
  page: WebContentsView
  shield: BrowserNativeInputShield
  ready?: Promise<void>
  presentations: Map<object, () => void>
}

export type NativeBrowserPageInput = { type: 'pointer'; event: Electron.MouseInputEvent } | { type: 'escape' }
const BROWSER_SELECTION_TIMEOUT_MS = 120_000
// Standalone observations have no script worker deadline. End only this first-document
// wait after its request budget; the loading page and its navigation remain available.
const BROWSER_INITIAL_DOCUMENT_OBSERVATION_MS = 30_000
const BROWSER_MARKER_MAX_COUNT = 50
const BROWSER_MARKER_MAX_COORDINATE = 10_000_000

export function assertAllowedBrowserUrl(value: string): string {
  if (value === 'about:blank') return value
  const url = new URL(value)
  if (url.protocol === 'file:') {
    if (!url.pathname || url.hostname) throw new Error('Unsupported browser file URL')
    return pathToFileURL(fileURLToPath(url)).toString()
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported browser URL protocol: ${url.protocol}`)
  }
  return url.toString()
}

export function normalizeBrowserUrl(value: string): string {
  const input = value.trim()
  if (!input || input === 'about:blank') return 'about:blank'
  if (input.startsWith('/') || input.startsWith('./') || input.startsWith('../') || input.startsWith('file://')) {
    const fileUrl = input.startsWith('file://') ? input : pathToFileURL(input).toString()
    return assertAllowedBrowserUrl(fileUrl)
  }
  return assertAllowedBrowserUrl(resolveBrowserAddress(input))
}

export class BrowserViewManager {
  /** Window Chrome listens to the current native owner without a second Browser/input registry. */
  onNativeVisibilityChange: ((visibility: import('../shared/native-overlay.js').NativeBrowserVisibility, window?: BrowserWindow) => void) | undefined
  private nativeVisibilityRevision = 0
  onNativeInput: ((owner: NativeBrowserOwner, input: NativeBrowserPageInput) => boolean) | undefined
  /** Optional App appearance projection; the receiver rechecks the original native document. */
  capsuleDocumentReady: ((browserId: string) => void) | undefined
  /** Facts from real embedded page owners; external tabs never enter this registry. */
  targets(): AgentMuxBrowserTarget[] {
    return [...this.entries.values()].map(entry => this.projectTarget(entry))
  }

  /** Read one existing native owner without discovering or acquiring other pages. */
  target(id: string): AgentMuxBrowserTarget | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    const view = entry.view
    const target = this.projectTarget(entry)
    return this.entries.get(id) === entry && entry.view === view ? target : null
  }

  /** Historical appearance can be read for an existing or released owner without acquiring it. */
  recoveryPreviewScope(id: string): BrowserRecoveryPreviewScope | null {
    const entry = this.entries.get(id) ?? this.releasedEntries.get(id)
    if (!entry || ('cleanupOnly' in entry && entry.cleanupOnly)) return null
    // Capsule storage has no user Profile. Historical thumbnails are optional; do not borrow a
    // Profile identity to address this independent container. Its original Close still proceeds.
    if ('capsule' in entry.storage) return null
    return entry.storage.mode === 'private'
      ? { browserId: id, workspaceId: entry.workspaceId, mode: 'private', profileId: null }
      : { browserId: id, workspaceId: entry.workspaceId, mode: 'normal', profileId: entry.storage.profileId }
  }

  /** Freeze one existing Main-owned page observation without navigating, restoring or focusing it. */
  inputContext(id: string, hostId: string): import('@agentmux/core/browser-input-context').BrowserInputContext | null {
    const entry = this.entries.get(id)
    if (!entry || entry.view.webContents.isDestroyed()) return null
    const view = entry.view, contents = view.webContents, observedAt = Date.now()
    const operation = entry.activity.operation
    const running = operation?.steps.filter(step => step.status === 'running') ?? []
    const context: import('@agentmux/core/browser-input-context').BrowserInputContext = {
      kind: 'browser', version: 1, capturedAt: observedAt,
      browser: { hostId, browserId: id, navigationId: entry.navigationId },
      page: { url: contents.getURL() || entry.requestedUrl, title: contents.getTitle() },
      ...(operation ? { activity: { operationId: operation.id, stepSequence: running.length === 1 ? running[0]!.sequence : null,
        phase: operation.phase, observedAt } } : {})
    }
    return this.entries.get(id) === entry && entry.view === view ? context : null
  }

  private projectTarget(entry: BrowserEntry): AgentMuxBrowserTarget {
    const contents = entry.view.webContents
    const available = !contents.isDestroyed()
    const workspaceId = entry.workspaceId
    return { id: entry.id, workspaceId, source: 'embedded', mode: entry.storage.mode, status: available ? 'ready' : 'unavailable',
      ...(entry.source ? { openedFrom: entry.source } : {}),
      control: this.controlState(entry),
      url: available ? contents.getURL() : '', title: available ? contents.getTitle().slice(0, 512) : '',
      navigationId: entry.navigationId,
      capabilities: workspaceId ? [...BROWSER_PAGE_CAPABILITY_NAMES] : BROWSER_PAGE_CAPABILITY_NAMES.filter(name =>
        !['uploadFiles', 'download', 'readDownload', 'extractStructured', 'readResult'].includes(name)),
      ...(!available || !workspaceId || entry.agentWarning ? { warning: [entry.agentWarning, !available
        ? 'The embedded page surface is unavailable. Its original Region remains.' : !workspaceId
          ? 'This embedded page has no verified Workspace binding. Workspace file and durable result capabilities are unavailable.' : ''].filter(Boolean).join(' ') } : {}) }
  }
  /** One read of the existing owners; no page acquisition or persistent resource index. */
  resourceTargets(processes: ReadonlyMap<number, number> | null): AgentMuxBrowserTarget[] {
    const identities = (native: WebContents[]): { pid: number; creationTime: number }[] | null => {
      if (!native.length) return []
      if (!processes) return null
      try {
        const pids = new Set(native.flatMap(contents => contents.mainFrame.framesInSubtree.filter(frame => !frame.detached).map(frame => frame.osProcessId)))
        return pids.size && [...pids].every(pid => pid > 0 && Number.isFinite(processes.get(pid)) && processes.get(pid)! > 0)
          ? [...pids].map(pid => ({ pid, creationTime: processes.get(pid)! })) : null
      } catch { return null }
    }
    const live = this.targets().map(target => {
      const entry = this.entries.get(target.id)!
      let observed: { pid: number; creationTime: number }[] | null = null
      let retention: AgentMuxBrowserRetention = { status: 'unknown', reasons: ['owner-unavailable'] }
      try {
        retention = this.retention(entry)
        const shield = this.inputSurfaces.get(entry.view)?.shield ?? entry.inputShield
        if (!entry.view.webContents.isDestroyed()) observed = identities([entry.view.webContents,
          ...(shield && !shield.contents.isDestroyed() ? [shield.contents] : []),
          ...[...(this.inputSurfaceCleanup.get(entry.id) ?? [])].filter(surface => !surface.shield.contents.isDestroyed()).map(surface => surface.shield.contents),
          ...this.closingOwners(entry.id).filter(owner => !owner.view.webContents.isDestroyed()).map(owner => owner.view.webContents)])
      } catch { /* Keep this original target; incomplete native observation is unknown. */ }
      const warning = this.closingWarning(entry.id, target.warning)
      return { ...target, ...(warning !== undefined ? { warning } : {}), resource: { state: target.status === 'ready' ? 'live' as const : 'unknown' as const,
        locations: [], processes: observed, retention } }
    })
    const released = [...this.releasedEntries.values(), ...[...this.closingViews.keys()].filter(id => !this.entries.has(id) && !this.releasedEntries.has(id))
      .map<ReleasedBrowser>(id => ({ ...this.closingOwners(id)[0]!, cleanupOnly: true }))]
      .map(entry => ({ ...entry, inputShield: entry.inputShield ?? [...(this.inputSurfaceCleanup.get(entry.id) ?? [])][0]?.shield }))
      .map<AgentMuxBrowserTarget>(entry => ({
      id: entry.id, workspaceId: entry.workspaceId, source: 'embedded', mode: entry.storage.mode,
      status: 'unavailable', url: entry.cleanupOnly ? '' : entry.requestedUrl, title: '', capabilities: [],
      ...(this.closingViews.has(entry.id) ? { warning: NATIVE_CLOSE_WARNING } : entry.inputShield ? { warning: entry.cleanupOnly
        ? 'This Browser was closed explicitly. Its original native input surface cleanup is unconfirmed; use Close to retry cleanup. Open a new Browser for a fresh page.'
        : 'The page was released, but its native input surface cleanup is unconfirmed. Reopen or close this original Browser to retry its retained cleanup.' } : {}),
      resource: { state: entry.inputShield || this.closingViews.has(entry.id) ? 'unknown' : 'released', locations: [],
        processes: identities([...(entry.inputShield && !entry.inputShield.contents.isDestroyed() ? [entry.inputShield.contents] : []),
          ...this.closingOwners(entry.id).filter(owner => !owner.view.webContents.isDestroyed()).map(owner => owner.view.webContents)]),
        ...(entry.inputShield || this.closingViews.has(entry.id) ? { retention: { status: 'unknown', reasons: ['close-unconfirmed'] } } : {}) }
    }))
    return [...live, ...released]
  }
  private readonly entries = new Map<string, BrowserEntry>()
  private readonly inputSurfaces = new Map<WebContentsView, NativeBrowserInputSurface>()
  private readonly inputSurfaceCleanup = new Map<string, Set<NativeBrowserInputSurface>>()
  /** Native-handle index only; entries and its exact current view remain the sole owner facts. */
  private readonly entriesByContents = new WeakMap<WebContents, BrowserEntry>()
  /** Actual native handles awaiting destruction, grouped by their original Browser identity. */
  private readonly closingViews = new Map<string, Map<WebContentsView, ClosingBrowserView>>()

  private closingOwners(id?: string): ClosingBrowserView[] {
    return id === undefined ? [...this.closingViews.values()].flatMap(views => [...views.values()])
      : [...this.closingViews.get(id)?.values() ?? []]
  }

  private forgetClosingView(id: string, view: WebContentsView): void {
    const retained = this.closingViews.get(id)
    if (!retained?.delete(view)) return
    if (!retained.size) this.closingViews.delete(id)
    const current = this.entries.get(id)
    if (current && current.view !== view && !current.view.webContents.isDestroyed()) {
      try { this.emit(current) } catch (error) { console.warn('Browser cleanup update was not delivered:', error) }
    }
  }

  private closeNativeView(owner: Pick<ReleasedBrowser, 'id' | 'workspaceId' | 'storage' | 'requestedUrl' | 'viewport'>, view: WebContentsView): void {
    const contents = view.webContents
    if (contents.isDestroyed()) { this.forgetClosingView(owner.id, view); return }
    let views = this.closingViews.get(owner.id)
    if (!views) { views = new Map(); this.closingViews.set(owner.id, views) }
    if (!views.has(view)) {
      views.set(view, { id: owner.id, workspaceId: owner.workspaceId, storage: owner.storage, requestedUrl: owner.requestedUrl, viewport: cloneBrowserViewport(owner.viewport), view })
      contents.once('destroyed', () => this.forgetClosingView(owner.id, view))
    }
    // Explicit Close owns this attempt. Reads and late events never repeat it.
    try { contents.close() } finally { if (contents.isDestroyed()) this.forgetClosingView(owner.id, view) }
  }

  private retryClosingViews(owners: readonly ClosingBrowserView[]): void {
    const errors: unknown[] = []
    for (const owner of owners) {
      try { this.closeNativeView(owner, owner.view) } catch (error) { errors.push(error) }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Browser native cleanup remains unconfirmed.')
  }

  private closingWarning(id: string, warning?: string): string | undefined {
    return this.closingViews.has(id) ? [warning, NATIVE_CLOSE_WARNING].filter(Boolean).join('\n') : warning
  }
  /** Lookup index only; nativeOwner still verifies the current authoritative entry and attachment. */
  private readonly browserIdsByView = new WeakMap<WebContentsView, string>()
  private readonly viewWindows = new WeakMap<WebContentsView, BrowserWindow>()
  private presentationWindow: ((document: WorkbenchWindowDocument | undefined, occurrence: BrowserPresentationOccurrence['location']) => BrowserWindow) | undefined
  setPresentationWindowOwner(resolve: (document: WorkbenchWindowDocument | undefined, occurrence: BrowserPresentationOccurrence['location']) => BrowserWindow): void { this.presentationWindow = resolve }
  windowForView(view: WebContentsView): BrowserWindow { return this.viewWindows.get(view) ?? this.window }
  private placeView(view: WebContentsView, window: BrowserWindow, index = 1): void {
    const previous = this.viewWindows.get(view)
    if (previous && previous !== window && !previous.isDestroyed()) previous.contentView.removeChildView(view)
    try { window.contentView.addChildView(view, index); this.viewWindows.set(view, window) }
    catch (error) { if (previous && previous !== window && !previous.isDestroyed()) { previous.contentView.addChildView(view, 1); this.viewWindows.set(view, previous) } throw error }
    const id = this.browserIdsByView.get(view), entry = id ? this.entries.get(id) : undefined
    if (entry?.view === view) this.synchronizeInputShield(entry)
  }
  private detachView(view: WebContentsView): void {
    const host = this.windowForView(view)
    if (!host.isDestroyed()) host.contentView.removeChildView(view)
    this.viewWindows.delete(view)
  }
  /** Exact presentation resources return before destroying a borrowed shell. */
  async returnWindow(window: BrowserWindow): Promise<void> {
    for (const entry of this.entries.values()) {
      for (const id of [...entry.presentationLeaseIds]) { const lease = this.presentationLeases.get(id); if (lease?.window === window) this.removePresentationLease(lease) }
      if (this.windowForView(entry.view) === window) { this.cancelRecoveryPreview(entry); this.placeView(entry.view, this.window); entry.view.setVisible(false); entry.visible = false }
      this.synchronizeInputShield(entry)
      this.publishNativeCoverage(entry)
      const candidate = entry.pendingSwitch?.view
      if (candidate && this.windowForView(candidate) === window) this.placeView(candidate, this.window)
    }
    this.notifyNativeVisibility(window)
    if (window !== this.window) this.notifyNativeVisibility(this.window)
  }
  private readonly faviconUrls = new WeakMap<WebContentsView, { documentUrl: string; navigationId: string | undefined; urls: string[] }>()
  private readonly releasedEntries = new Map<string, ReleasedBrowser>()
  private readonly webAuthnSessions = new Map<Session, () => void>()
  private readonly capsuleResponseSessions = new Set<Session>()
  private readonly presentationLeases = new Map<string, PresentationLease>()
  private readonly presentationCaptures = new Map<string, PresentationCapture>()
  private presentationDocument: PresentationDocument | null = null
  private pendingPresentationCapture: PresentationCapture | null = null
  private disposePresentationRequester: (() => void) | null = null
  private presentationDisposed = false
  private demonstrationCapture: { entry: BrowserEntry; view: WebContentsView; contents: WebContents; capture: BrowserDemonstrationCapture } | null = null

  private readonly taskExecutions = new Map<string, { entry: BrowserEntry; runId: string | undefined; operationId: string | undefined; stopRequested: boolean }>()
  private readonly unsubscribeTaskAssets: (() => void) | undefined

  constructor(
    private readonly window: BrowserWindow,
    private readonly profiles: BrowserProfileResolver,
    /**
     * ref 的跨轮/跨重启账本。和 `profiles` 一样从外面传进来，不给默认值：默认值要调
     * `app.getPath('userData')`，那会让这个类在**构造时**就绑死 Electron，而它此前只在真正开页面时才需要。
     */
    private readonly refLedgers: BrowserRefLedgerStore,
    /**
     * 应用链接的移交能力。和 `refLedgers` 同理从外面传进来：`shell.openExternal` 与读写 config 都会
     * 让这个类绑死 Electron/磁盘，而它此前只在真正开页面时才需要 Electron。
     *
     * `openExternal` 必须由调用方以箭头包一层或 `.bind(shell)` 传入——直接摘方法会丢掉原生 receiver
     * （本仓吃过这个亏）。
     */
    private readonly appLinks: AppLinkHost,
    private readonly operationJournal?: BrowserOperationJournal,
    private readonly stepEvidence?: BrowserStepEvidenceStore,
    private readonly resultArtifacts?: BrowserResultArtifactStore,
    private readonly demonstrations?: BrowserDemonstrationRecorder,
    private readonly taskAssets?: BrowserTaskAssets,
    private readonly downloads?: BrowserDownloads,
    private readonly uploads?: BrowserUploads,
    private readonly feedbackPreferences: () => BrowserAgentControlPreferences = () => DEFAULT_BROWSER_AGENT_CONTROL,
    private readonly recoveryPreviews?: BrowserRecoveryPreviewStore,
    private readonly nativeWindows: { confirmLeave?(window: BrowserWindow): Promise<boolean> } = {},
    private readonly agents?: BrowserAgentAuthority
  ) {
    this.unsubscribeTaskAssets = taskAssets?.subscribe(browserId => {
      if (!this.entries.has(browserId)) return
      void this.getTaskAssets(browserId).catch(() => {})
    })
  }

  resourceOwnerCounts(): { browserViews: number; releasedBrowserViews: number } {
    return {
      browserViews: new Set([...this.entries.values()].map(entry => entry.view).concat(this.closingOwners().map(owner => owner.view))
        .filter(view => !view.webContents.isDestroyed())).size,
      releasedBrowserViews: this.releasedEntries.size
    }
  }

  inputHistoryScope(id: string, profileId: string | null): BrowserInputHistoryScope {
    const entry = this.require(id)
    if (entry.storage.profileId !== profileId) throw new Error('The Browser Profile changed before input history was requested.')
    if (entry.workspaceId === null) throw new Error('This Browser has no verified Workspace for input history.')
    return { workspaceId: entry.workspaceId, profileId: entry.storage.profileId }
  }

  /** Page SDK admission is an observation of this exact native document, never a URL capability. */
  capsuleDocument(sender: WebContents, frame: WebFrameMain | null): { record: CapsuleRecord; browserId: string; navigationId: string; instanceId: string } | null {
    const entry = this.entriesByContents.get(sender)
    if (!entry || entry.view.webContents !== sender || !('capsule' in entry.storage) || entry.storage.capsule.record.mode !== 'injected' ||
      !this.isCapsuleDocument(entry, frame)) return null
    return { record: entry.storage.capsule.record, browserId: entry.id, navigationId: entry.navigationId, instanceId: entry.capsuleResponse!.instanceId }
  }

  capsuleId(browserId: string): string | null {
    const entry = this.entries.get(browserId) ?? this.releasedEntries.get(browserId)
    return entry && 'capsule' in entry.storage ? entry.storage.capsule.record.capsuleId : null
  }

  /** The original admitted page transport for optional App theme projection; never acquires a page. */
  capsuleDocumentContents(browserId: string): WebContents | null {
    const entry = this.entries.get(browserId)
    if (!entry || !('capsule' in entry.storage) || entry.storage.capsule.record.mode !== 'injected' ||
      !this.isCapsuleDocument(entry, entry.view.webContents.mainFrame)) return null
    return entry.view.webContents
  }

  /** Low-frequency App appearance changes enumerate the original owners, without another catalogue. */
  capsuleDocumentIds(): string[] {
    return [...this.entries.values()].flatMap(entry => 'capsule' in entry.storage &&
      entry.storage.capsule.record.mode === 'injected' && this.capsuleDocumentContents(entry.id) ? [entry.id] : [])
  }

  /** Bind an original open request to its actual container without navigating or granting page input. */
  recordCapsuleOpen(browserId: string, capsuleId: string, operationId: string): BrowserSnapshot {
    const entry = this.require(browserId)
    if (!('capsule' in entry.storage) || entry.storage.capsule.record.capsuleId !== capsuleId) {
      throw new Error('The original Capsule does not match this Browser container. Its page is retained.')
    }
    if (typeof operationId !== 'string' || !operationId.trim()) throw new Error('The original Capsule open operation identity is required.')
    if (!entry.storage.capsuleOpenOperationIds.includes(operationId)) {
      entry.storage.capsuleOpenOperationIds.push(operationId)
      this.emit(entry)
    }
    return this.snapshot(entry)
  }

  private isCapsuleDocument(entry: BrowserEntry, frame: WebFrameMain | null): boolean {
    if (!('capsule' in entry.storage) || entry.storage.capsule.endpoint.status !== 'available' || !frame ||
      !this.owns(entry, entry.view) || entry.view.webContents.isDestroyed() || frame.detached || frame.isDestroyed() ||
      frame !== entry.view.webContents.mainFrame || entry.committedNavigationId !== entry.navigationId ||
      !entry.capsuleResponse || entry.capsuleResponse.navigationId !== entry.navigationId || entry.capsuleResponse.frame !== frame ||
      entry.view.webContents.isLoadingMainFrame()) return false
    try {
      return new URL(entry.view.webContents.getURL()).origin === entry.storage.capsuleOrigin &&
        new URL(frame.url).origin === entry.storage.capsuleOrigin
    } catch { return false }
  }

  registerPresentation(sender: WebContents, frame: WebFrameMain | null, input: {
    browserId: string; occurrence: BrowserPresentationOccurrence; geometry: BrowserPresentationGeometry; window?: WorkbenchWindowDocument
  }, originalDocument: PresentationFrameIdentity | null): BrowserPresentationLease {
    const document = this.requirePresentationDocument(sender, frame, originalDocument)
    const entry = this.require(input.browserId)
    const occurrence = input.occurrence
    const location = occurrence?.location
    const inline = location && 'kind' in location && location.kind === 'inline' && Object.keys(location).length === 1
    const spatial = location && !('kind' in location) && ['displayWorkspaceId', 'groupId', 'tabId', 'regionId'].every(key =>
      typeof (location as Record<string, unknown>)[key] === 'string' && ((location as Record<string, string>)[key]?.trim()))
    if (!occurrence?.presentationId?.trim() || !inline && !spatial) {
      throw new Error('Browser presentation requires an exact occurrence')
    }
    const nativeWindow = this.presentationWindow?.(input.window, occurrence.location) ?? this.window
    const geometry = this.presentationGeometry(input.geometry)
    for (const id of entry.presentationLeaseIds) {
      const existing = this.presentationLeases.get(id)!
      if (existing.document === document && existing.occurrence.presentationId === occurrence.presentationId) {
        throw new Error('This Browser presentation is already registered')
      }
    }
    const id = mintObjectId()
    this.presentationLeases.set(id, { id, entry, document, window: nativeWindow, windowDocument: input.window,
      occurrence: { presentationId: occurrence.presentationId, location: { ...occurrence.location } }, geometry })
    entry.presentationLeaseIds.add(id)
    if (geometry.visible) void entry.controlFeedback?.synchronize()
    return { leaseId: id }
  }

  presentationWindowForLease(sender: WebContents, frame: WebFrameMain | null, leaseId: string): BrowserWindow {
    return this.requirePresentationLease(sender, frame, leaseId).window
  }

  updatePresentation(sender: WebContents, frame: WebFrameMain | null,
    leaseId: string, value: BrowserPresentationGeometry): void {
    const lease = this.requirePresentationLease(sender, frame, leaseId)
    const wasVisible = lease.geometry.visible
    lease.geometry = this.presentationGeometry(value)
    if (lease.entry.inputLeaseId === leaseId) {
      if (lease.geometry.visible && lease.geometry.inputVisible !== false) this.setBounds(lease.entry.id, lease.geometry.bounds)
      else this.clearPresentationInput(lease.entry)
    }
    if (!this.hasVisiblePresentation(lease.entry)) this.revokePresentationCapture(lease.entry, 'no-visible-presentations')
    if (wasVisible !== lease.geometry.visible) void lease.entry.controlFeedback?.synchronize()
  }

  removePresentation(sender: WebContents, frame: WebFrameMain | null, leaseId: string): void {
    const lease = this.requirePresentationLease(sender, frame, leaseId, false)
    this.removePresentationLease(lease)
  }

  armPresentationCapture(sender: WebContents, frame: WebFrameMain | null,
    leaseId: string): BrowserPresentationCapture {
    const lease = this.requirePresentationLease(sender, frame, leaseId)
    if (!lease.geometry.visible) throw new Error('Browser presentation is hidden')
    const existing = lease.entry.captureId ? this.presentationCaptures.get(lease.entry.captureId) : undefined
    if (existing && !existing.revoked) {
      if (!existing.trackIds) throw new Error('Browser presentation capture is still pending')
      return { captureId: existing.id, browserId: lease.entry.id }
    }
    // At most one capture record per entity. Old cleanup reports remain unknown after a new arm;
    // they cannot retain released Native owners or revive a newer capture.
    if (existing) this.presentationCaptures.delete(existing.id)
    if (this.pendingPresentationCapture) throw new Error('Another Browser presentation capture is still pending')
    if (lease.entry.view.webContents.isDestroyed()) throw new Error('Browser native page is unavailable')
    const capture: PresentationCapture = {
      id: mintObjectId(), entry: lease.entry, document: lease.document,
      source: lease.entry.view, profileId: lease.entry.storage.profileId,
      granted: false, preparingSource: false, preparationWindow: null, revoked: false, trackIds: null
    }
    // BrowserWindow's Renderer is outside contentView: even child index 0 paints above it.
    // Give a never-shown source an unclipped native viewport in a hidden shell instead.
    // BaseWindow creates no WebContents; the original page and logical host stay unchanged.
    if (!lease.entry.visible) {
      lease.entry.bounds ??= { ...lease.geometry.bounds }
      capture.preparingSource = true
      try {
        const { width, height } = lease.entry.bounds
        capture.preparationWindow = new BaseWindow({ show: false, focusable: false, frame: false,
          skipTaskbar: true, useContentSize: true, width, height })
        this.windowForView(capture.source).contentView.removeChildView(capture.source)
        capture.preparationWindow.contentView.addChildView(capture.source)
        capture.source.setBounds({ x: 0, y: 0, width, height })
        capture.source.setVisible(true)
      } catch (error) {
        try { this.finishPresentationCapturePreparation(capture) }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Browser preview preparation and cleanup failed') }
        throw error
      }
    }
    this.presentationCaptures.set(capture.id, capture)
    lease.entry.captureId = capture.id
    this.pendingPresentationCapture = capture
    return { captureId: capture.id, browserId: lease.entry.id }
  }

  ackPresentationCapture(sender: WebContents, frame: WebFrameMain | null,
    captureId: string, ack: BrowserPresentationCaptureAck): void {
    const document = this.requirePresentationDocument(sender, frame)
    const capture = this.presentationCaptures.get(captureId)
    if (!capture || capture.document !== document) throw new Error('Unknown Browser presentation capture')
    if (ack.outcome === 'failed') {
      if (typeof ack.message !== 'string' || !ack.message.trim()) throw new Error('Capture failure requires a message')
      // This holder reports that no stream was obtained; no invented source/visibility reason.
      capture.revoked = true
      if (capture.entry.captureId === capture.id) capture.entry.captureId = null
      if (this.pendingPresentationCapture === capture) this.pendingPresentationCapture = null
      this.presentationCaptures.delete(capture.id)
      try { this.finishPresentationCapturePreparation(capture) }
      finally { this.publishNativeCoverage(capture.entry) }
      return
    }
    if (!['ready', 'stopped'].includes(ack.outcome) || !Array.isArray(ack.trackIds) ||
      ack.trackIds.length === 0 || ack.trackIds.some(id => typeof id !== 'string' || !id.trim()) ||
      new Set(ack.trackIds).size !== ack.trackIds.length) throw new Error('Capture acknowledgement requires actual track ids')
    if (capture.trackIds && (capture.trackIds.length !== ack.trackIds.length ||
      !capture.trackIds.every(id => ack.trackIds.includes(id)))) throw new Error('Capture track ids changed')
    if (ack.outcome === 'ready') {
      if (capture.revoked || !capture.granted || !this.isPresentationCaptureCurrent(capture)) {
        throw new Error('Browser presentation capture is no longer authorized')
      }
      capture.trackIds = [...ack.trackIds]
    } else {
      capture.revoked = true
      if (capture.entry.captureId === capture.id) capture.entry.captureId = null
      this.presentationCaptures.delete(capture.id)
    }
    if (this.pendingPresentationCapture === capture) this.pendingPresentationCapture = null
    try { this.finishPresentationCapturePreparation(capture) }
    finally { this.publishNativeCoverage(capture.entry) }
  }

  async activatePresentation(sender: WebContents, frame: WebFrameMain | null,
    leaseId: string, activation: BrowserPresentationActivation): Promise<BrowserPresentationActivationReceipt> {
    const lease = this.requirePresentationLease(sender, frame, leaseId)
    const entry = lease.entry
    const unconfirmed = (reason: Extract<BrowserPresentationActivationReceipt, { outcome: 'input-unconfirmed' }>['reason'],
      message: string): Extract<BrowserPresentationActivationReceipt, { outcome: 'input-unconfirmed' }> => ({ outcome: 'input-unconfirmed', reason, message })
    if (activation?.kind === 'select') {
      if (activation.focus !== undefined && activation.focus !== 'preserve') throw new Error('Unknown Browser presentation focus policy')
      if (!lease.geometry.visible || lease.geometry.inputVisible === false) return unconfirmed('hidden', 'The page is clipped by its reading window. Scroll it fully into view or open its original Browser to interact; the page remains readable.')
      if (this.agentOwnsInput(entry)) return unconfirmed('agent-control-active', 'An Agent program owns the original Browser viewport. This live preview remains readable; take control explicitly before moving its native input owner.')
      entry.firstPress = null
      this.selectPresentation(lease, activation.focus !== 'preserve')
      return { outcome: 'selected' }
    }
    if (activation?.kind === 'prepare-first-press') {
      if (this.agentOwnsInput(entry)) return unconfirmed('agent-control-active', 'An Agent program owns this Browser. Use explicit Take control before interacting with the page.')
      this.validatePresentationPoint(activation.down)
      this.validatePresentationModifiers(activation.modifiers)
      if (!['left', 'middle', 'right'].includes(activation.button) || ![1, 2].includes(activation.clickCount)) {
        throw new Error('Browser first press requires a known mouse button and click count')
      }
      if (!lease.geometry.visible || lease.geometry.inputVisible === false || !entry.bounds) return unconfirmed('hidden', 'The original Browser viewport is hidden or clipped. Scroll the page fully into view or open its original Browser; its content remains available.')
      if (!lease.window.isFocused()) return unconfirmed('window-not-focused', 'Focus this window before taking control of the Browser.')
      if (entry.navigationId !== activation.navigationId || entry.view.webContents.isLoadingMainFrame()) {
        return unconfirmed('navigation-changed', 'The displayed Browser navigation changed. Wait for its current frame and try again.')
      }
      const capture = entry.captureId ? this.presentationCaptures.get(entry.captureId) : undefined
      if (!capture || capture.id !== activation.captureId || capture.document !== lease.document || !capture.trackIds ||
        !this.isPresentationCaptureCurrent(capture)) return unconfirmed('capture-changed', 'The displayed Browser frame is no longer authorized. The original page remains available.')
      const press: PresentationFirstPress = {
        id: mintObjectId(), lease, source: entry.view, capture, navigationId: entry.navigationId, controlRevision: entry.controlRevision,
        sourceBounds: entry.bounds, sourceInputLeaseId: entry.inputLeaseId,
        geometry: lease.geometry, zoom: entry.view.webContents.getZoomFactor(), viewport: entry.viewport,
        down: { ...activation.down }, button: activation.button, clickCount: activation.clickCount,
        modifiers: [...activation.modifiers], state: 'prepared', result: null
      }
      entry.firstPress = press
      return { outcome: 'prepared', inputScopeId: press.id,
        sourceViewport: { width: press.sourceBounds.width, height: press.sourceBounds.height, zoomFactor: press.zoom } }
    }
    if (!activation || !['commit-first-press', 'cancel-first-press'].includes(activation.kind)) throw new Error('Unknown Browser presentation activation')
    const press = entry.firstPress
    if (!press || press.id !== activation.inputScopeId || press.lease !== lease) return unconfirmed('unknown-input-scope', 'This Browser input intent has expired. No input was replayed.')
    if (activation.kind === 'cancel-first-press') {
      if (press.state !== 'prepared') return press.result ?? unconfirmed('input-dispatch-failed', 'Input dispatch has already begun; its page effect is unconfirmed.')
      press.state = 'cancelled'
      return press.result = { outcome: 'cancelled', inputScopeId: press.id }
    }
    this.validatePresentationPoint(activation.up)
    this.validatePresentationModifiers(activation.modifiers)
    if (press.state === 'cancelled') return press.result!
    if (press.state === 'dispatching') return unconfirmed('input-dispatch-failed', 'This input is already being dispatched; it will not be replayed.')
    if (press.state === 'dispatched') return press.result?.outcome === 'input-dispatched'
      ? { outcome: 'already-dispatched', inputScopeId: press.id } : press.result!
    const invalid = this.presentationFirstPressInvalid(press)
    if (invalid) { press.state = 'cancelled'; return press.result = { ...invalid, inputDispatch: 'not-started' } }
    // Consume BEFORE transport. A duplicate IPC cannot dispatch this gesture twice.
    press.state = 'dispatching'
    const contents = press.source.webContents
    let finishUp: (value: boolean) => void = () => {}
    const observedUp = new Promise<boolean>(resolve => { finishUp = resolve })
    const onInput = (_event: unknown, input: Electron.InputEvent): void => {
      if (input.type === 'mouseUp') {
        const mouse = input as Electron.MouseInputEvent
        if (mouse.button === press.button && mouse.x === Math.floor(activation.up.x * press.sourceBounds.width) &&
          mouse.y === Math.floor(activation.up.y * press.sourceBounds.height)) finishUp(true)
      }
    }
    contents.on('input-event', onInput)
    const timeout = setTimeout(() => finishUp(false), 250)
    try {
      // The ORIGINAL captured viewport stays authoritative for both events, including its zoom.
      // Chromium performs the DIP→page conversion; capture video pixel dimensions are irrelevant.
      contents.sendInputEvent({ type: 'mouseDown', x: Math.floor(press.down.x * press.sourceBounds.width),
        y: Math.floor(press.down.y * press.sourceBounds.height), button: press.button,
        clickCount: press.clickCount, modifiers: [...press.modifiers] })
      const afterDown = this.presentationFirstPressInvalid(press)
      if (afterDown) return press.result = { ...afterDown, inputDispatch: 'press-sent' }
      contents.sendInputEvent({ type: 'mouseUp', x: Math.floor(activation.up.x * press.sourceBounds.width),
        y: Math.floor(activation.up.y * press.sourceBounds.height), button: press.button,
        clickCount: press.clickCount, modifiers: [...activation.modifiers] })
      if (!await observedUp) return press.result = { ...unconfirmed('input-dispatch-failed', 'Browser input delivery could not be confirmed. The healthy original page remains in place; do not replay automatically.'), inputDispatch: 'gesture-sent' }
      // A transport observation is not a page-effect acknowledgement. Give the ordered Native
      // input queue its turn before moving/resizing; the actual first-click counter verifies effects.
      await new Promise<void>(resolve => setImmediate(resolve))
      const changed = this.presentationFirstPressInvalid(press)
      if (changed) return press.result = { ...changed, inputDispatch: 'gesture-sent' }
      this.selectPresentation(lease)
      return press.result = { outcome: 'input-dispatched', inputScopeId: press.id }
    } catch {
      return press.result = unconfirmed('input-dispatch-failed', 'Browser input dispatch is unconfirmed. The original page remains available; no automatic replay was attempted.')
    } finally {
      clearTimeout(timeout)
      contents.removeListener('input-event', onInput)
      press.state = 'dispatched'
    }
  }

  private selectPresentation(lease: PresentationLease, claimFocus = true): void {
    if (!lease.geometry.visible || lease.geometry.inputVisible === false) return
    const previousLeaseId = lease.entry.inputLeaseId
    lease.entry.inputLeaseId = lease.id
    try { this.setBounds(lease.entry.id, lease.geometry.bounds) }
    catch (error) { lease.entry.inputLeaseId = previousLeaseId; this.publishNativeCoverage(lease.entry); throw error }
    if (claimFocus) lease.entry.view.webContents.focus()
    this.sendPresentation({ type: 'input-owner-changed', browserId: lease.entry.id, leaseId: lease.id })
  }

  private presentationFirstPressInvalid(press: PresentationFirstPress): Extract<BrowserPresentationActivationReceipt, { outcome: 'input-unconfirmed' }> | null {
    const entry = press.lease.entry
    const fail = (reason: Extract<BrowserPresentationActivationReceipt, { outcome: 'input-unconfirmed' }>['reason'], message: string): Extract<BrowserPresentationActivationReceipt, { outcome: 'input-unconfirmed' }> => ({ outcome: 'input-unconfirmed', reason, message })
    if (entry.controlRevision !== press.controlRevision || this.agentOwnsInput(entry)) return fail('control-changed', 'Browser control changed after this gesture was prepared. No further input was dispatched; do not replay it.')
    if (entry.firstPress !== press || this.entries.get(entry.id) !== entry || entry.view !== press.source ||
      press.source.webContents.isDestroyed() || !this.isPresentationDocumentCurrent(press.lease.document)) return fail('source-changed', 'This Browser input source changed; no further input or transfer was attempted.')
    if (this.presentationLeases.get(press.lease.id) !== press.lease || !press.lease.geometry.visible || press.lease.geometry.inputVisible === false) return fail('hidden', 'This Browser presentation is no longer fully visible for input. Its page remains readable.')
    if (entry.navigationId !== press.navigationId || press.source.webContents.isLoadingMainFrame()) return fail('navigation-changed', 'The original Browser navigation changed.')
    if (entry.captureId !== press.capture.id || !this.isPresentationCaptureCurrent(press.capture)) return fail('capture-changed', 'The Browser capture changed.')
    if (entry.bounds !== press.sourceBounds || entry.inputLeaseId !== press.sourceInputLeaseId ||
      press.lease.geometry !== press.geometry || entry.viewport !== press.viewport ||
      press.source.webContents.getZoomFactor() !== press.zoom) return fail('geometry-changed', 'The captured Browser viewport or presentation geometry changed.')
    if (!press.lease.window.isFocused()) return fail('window-not-focused', 'This Browser window is no longer focused.')
    return null
  }

  private validatePresentationPoint(point: BrowserPresentationViewportPoint): void {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x >= 1 || point.y < 0 || point.y >= 1) throw new Error('Browser first press requires a point within the actual captured frame')
  }

  private validatePresentationModifiers(modifiers: readonly BrowserPresentationMouseModifier[]): void {
    if (!Array.isArray(modifiers) || modifiers.some(value => !['shift', 'control', 'alt', 'meta'].includes(value)) || new Set(modifiers).size !== modifiers.length) throw new Error('Browser first press has invalid mouse modifiers')
  }

  private requirePresentationDocument(sender: WebContents, frame: WebFrameMain | null, originalDocument?: PresentationFrameIdentity | null): PresentationDocument {
    // Keep native validation order; explain the first rejected fact without disclosing page data.
    const reason = this.presentationDisposed ? 'manager-disposed'
      : this.window.isDestroyed() ? 'window-destroyed'
      : sender !== this.window.webContents ? 'sender-mismatch'
      : sender.isDestroyed() ? 'sender-destroyed'
      : !frame ? 'frame-missing'
      : frame.isDestroyed() ? 'frame-destroyed'
      : frame !== sender.mainFrame ? 'frame-mismatch'
      : frame.parent !== null ? 'frame-not-top-level'
      : originalDocument !== undefined && (!originalDocument || originalDocument.processId !== frame.processId || originalDocument.frameToken !== frame.frameToken) ? 'document-changed'
      : !sender.getURL() ? 'document-url-missing'
      : frame.url !== sender.getURL() ? 'document-url-mismatch'
      : null
    if (reason || !frame) {
      throw new Error(`Untrusted Browser presentation document (${reason})`)
    }
    if (!this.disposePresentationRequester) this.attachPresentationRequester(sender)
    const current = this.presentationDocument
    if (current && !this.isPresentationDocumentCurrent(current)) this.invalidatePresentationRequester()
    return this.presentationDocument ??= { frame, processId: frame.processId, frameToken: frame.frameToken, session: sender.session, url: sender.getURL() }
  }

  private isPresentationDocumentCurrent(document: PresentationDocument): boolean {
    if (this.presentationDisposed || this.window.isDestroyed()) return false
    const sender = this.window.webContents
    return !sender.isDestroyed() &&
      document === this.presentationDocument && sender.session === document.session &&
      !document.frame.isDestroyed() && sender.mainFrame === document.frame &&
      document.frame.processId === document.processId && document.frame.frameToken === document.frameToken &&
      document.frame.url === document.url && sender.getURL() === document.url
  }

  private attachPresentationRequester(sender: WebContents): void {
    const requesterSession = sender.session
    const onNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
      if (details.isMainFrame && !details.isSameDocument) this.invalidatePresentationRequester()
    }
    const onSameDocument = (_event: unknown, url: string, isMainFrame: boolean): void => {
      if (isMainFrame && this.presentationDocument) this.presentationDocument.url = url
    }
    const invalidate = (): void => this.invalidatePresentationRequester()
    const onCommit = (): void => {
      const document = this.presentationDocument, frame = sender.mainFrame
      if (document && (document.processId !== frame.processId || document.frameToken !== frame.frameToken)) invalidate()
    }
    sender.on('did-start-navigation', onNavigation)
    sender.on('did-navigate', onCommit)
    sender.on('did-navigate-in-page', onSameDocument)
    sender.on('render-process-gone', invalidate)
    sender.on('destroyed', invalidate)
    requesterSession.setDisplayMediaRequestHandler((request, callback) => {
      const capture = this.pendingPresentationCapture
      let originMatches = false
      try { originMatches = new URL(request.securityOrigin).origin === new URL(capture?.document.url ?? '').origin } catch { /* reject opaque/invalid origins */ }
      if (!capture || capture.granted || !this.isPresentationCaptureCurrent(capture) ||
        request.frame !== capture.document.frame || request.frame.url !== capture.document.url ||
        !originMatches || !request.videoRequested || request.audioRequested) {
        callback(null as never)
        return
      }
      // Main explicitly authorizes this exact App document, not all frames sharing its Session.
      // Native source navigation changes its live frame; it never ends the Browser entity's capture.
      capture.granted = true
      callback({ video: capture.source.webContents.mainFrame })
    }, { useSystemPicker: false })
    this.disposePresentationRequester = () => {
      sender.removeListener('did-start-navigation', onNavigation)
      sender.removeListener('did-navigate', onCommit)
      sender.removeListener('did-navigate-in-page', onSameDocument)
      sender.removeListener('render-process-gone', invalidate)
      sender.removeListener('destroyed', invalidate)
      requesterSession.setDisplayMediaRequestHandler(null)
    }
  }

  private requirePresentationLease(sender: WebContents, frame: WebFrameMain | null, id: string, validateWindow = true): PresentationLease {
    const document = this.requirePresentationDocument(sender, frame)
    const lease = this.presentationLeases.get(id)
    if (!lease || lease.document !== document || this.entries.get(lease.entry.id) !== lease.entry) {
      throw new Error('Unknown Browser presentation lease')
    }
    if (validateWindow && this.presentationWindow && this.presentationWindow(lease.windowDocument, lease.occurrence.location) !== lease.window) throw new Error('The exact native Browser presentation document has changed. The original page remains.')
    return lease
  }

  private presentationGeometry(value: BrowserPresentationGeometry): BrowserPresentationGeometry {
    if (value?.visible === false) return { visible: false }
    const bounds = value?.visible === true ? normalizeBrowserBounds(value.bounds) : null
    if (!bounds) throw new Error('Browser presentation bounds must be finite with a positive size')
    if (value.inputVisible !== undefined && typeof value.inputVisible !== 'boolean') throw new Error('Browser presentation input visibility must describe its actual clipping geometry')
    return { visible: true, bounds, ...(value.inputVisible === false ? { inputVisible: false } : {}) }
  }

  private hasVisiblePresentation(entry: BrowserEntry): boolean {
    for (const id of entry.presentationLeaseIds) if (this.presentationLeases.get(id)?.geometry.visible) return true
    return false
  }

  private isPresentationCaptureCurrent(capture: PresentationCapture): boolean {
    return !capture.revoked && this.isPresentationDocumentCurrent(capture.document) &&
      this.owns(capture.entry, capture.source) && !capture.source.webContents.isDestroyed() &&
      capture.entry.storage.profileId === capture.profileId && this.hasVisiblePresentation(capture.entry)
  }

  private clearPresentationInput(entry: BrowserEntry): void {
    if (!entry.inputLeaseId) return
    entry.inputLeaseId = null
    this.setBounds(entry.id, null)
    this.sendPresentation({ type: 'input-owner-changed', browserId: entry.id, leaseId: null })
  }

  private removePresentationLease(lease: PresentationLease): void {
    this.presentationLeases.delete(lease.id)
    lease.entry.presentationLeaseIds.delete(lease.id)
    if (lease.entry.inputLeaseId === lease.id) this.clearPresentationInput(lease.entry)
    if (!this.hasVisiblePresentation(lease.entry)) this.revokePresentationCapture(lease.entry, 'no-visible-presentations')
    void lease.entry.controlFeedback?.synchronize()
    this.publishNativeCoverage(lease.entry)
  }

  private revokePresentationCapture(entry: BrowserEntry, reason: BrowserPresentationRevocationReason): void {
    const capture = entry.captureId ? this.presentationCaptures.get(entry.captureId) : undefined
    if (!capture || capture.revoked) { this.publishNativeCoverage(entry); return }
    capture.revoked = true
    this.publishNativeCoverage(entry)
    try { this.finishPresentationCapturePreparation(capture) }
    catch (error) { console.warn('Browser preview preparation cleanup failed:', error) }
    if (this.pendingPresentationCapture === capture) this.pendingPresentationCapture = null
    this.sendPresentation({ type: 'capture-revoked', browserId: entry.id, captureId: capture.id, reason })
  }

  private finishPresentationCapturePreparation(capture: PresentationCapture): void {
    if (!capture.preparingSource) return
    capture.preparingSource = false
    const staging = capture.preparationWindow
    capture.preparationWindow = null
    const errors: unknown[] = []
    try {
      // A real selection may already have moved this same source into its chosen host.
      if (this.owns(capture.entry, capture.source) && !capture.source.webContents.isDestroyed() && !capture.entry.visible) {
        let hidden = false
        try { capture.source.setVisible(false); hidden = true } catch (error) { errors.push(error) }
        if (staging?.contentView.children.includes(capture.source)) staging.contentView.removeChildView(capture.source)
        // A failed hide leaves the original page detached and recoverable by explicit selection,
        // never exposed over the workface. Keep the original logical host for that recovery.
        const host = this.windowForView(capture.source)
        if (hidden && !host.isDestroyed()) {
          try { this.placeView(capture.source, host) } catch (error) { errors.push(error) }
        }
      }
    } finally {
      if (this.owns(capture.entry, capture.source)) this.synchronizeInputShield(capture.entry)
      if (staging && !staging.isDestroyed()) {
        try { if (staging.contentView.children.includes(capture.source)) staging.contentView.removeChildView(capture.source) }
        catch (error) { errors.push(error) }
        // BaseWindow does not own WebContents lifetime. Even a failed detach must not leave
        // a hidden native shell alive after this capture ends; the Browser owner retains the page.
        try { staging.destroy() } catch (error) { errors.push(error) }
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Browser preview preparation cleanup failed')
  }

  private invalidatePresentationRequester(): void {
    const document = this.presentationDocument
    if (!document) return
    // Invalidate before notifying; a late promise/ACK cannot revive this App document's leases.
    this.presentationDocument = null
    for (const lease of this.presentationLeases.values()) {
      if (lease.document !== document) continue
      this.revokePresentationCapture(lease.entry, 'requester-ended')
      this.removePresentationLease(lease)
    }
    for (const [id, capture] of this.presentationCaptures) {
      if (capture.document !== document) continue
      this.presentationCaptures.delete(id)
      if (capture.entry.captureId === id) capture.entry.captureId = null
      this.publishNativeCoverage(capture.entry)
    }
  }

  private sendPresentation(event: BrowserPresentationEvent): void {
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send(BROWSER_PRESENTATION_EVENT_CHANNEL, event)
    }
  }

  /** A rendering fact derived from the existing owners, never a selection or restore intent. */
  private publishNativeCoverage(entry: BrowserEntry): void {
    let coverage: Extract<BrowserPresentationEvent, { type: 'native-coverage-changed' }>['coverage'] = null
    try {
      const lease = entry.inputLeaseId ? this.presentationLeases.get(entry.inputLeaseId) : undefined
      const capture = entry.captureId ? this.presentationCaptures.get(entry.captureId) : undefined
      if (lease?.entry === entry && lease.geometry.visible && capture?.document === lease.document &&
        !capture.preparingSource && capture.granted && capture.trackIds?.length && this.isPresentationCaptureCurrent(capture) &&
        capture.source === entry.view && !lease.window.isDestroyed() &&
        (!this.presentationWindow || this.presentationWindow(lease.windowDocument, lease.occurrence.location) === lease.window) &&
        this.windowForView(entry.view) === lease.window && lease.window.contentView.children.includes(entry.view)) {
        const actual = this.nativeOwner(entry.id, lease.window)?.bounds, expected = lease.geometry.bounds
        if (actual && actual.x === expected.x && actual.y === expected.y &&
          actual.width === expected.width && actual.height === expected.height) {
          coverage = { leaseId: lease.id, captureId: capture.id }
        }
      }
    } catch (error) {
      // An observation failure cannot turn a healthy original page into a failed operation.
      console.warn('Browser native coverage observation failed:', error)
    }
    try { this.sendPresentation({ type: 'native-coverage-changed', browserId: entry.id, coverage }) }
    catch (error) { console.warn('Browser native coverage update failed:', error) }
    this.emitRetentionChange(entry)
  }

  /** Native Chrome considers only physically visible Browser frames, never Session/Run projections. */
  visibleNativeBounds(window?: BrowserWindow): BrowserBounds[] {
    return [...this.entries.values()].flatMap(entry =>
      entry.visible && entry.bounds && (!window || this.windowForView(entry.view) === window) && !entry.view.webContents.isDestroyed() ? [{ ...entry.bounds }] : [])
  }

  nativeBrowserVisibility(window?: BrowserWindow): import('../shared/native-overlay.js').NativeBrowserVisibility {
    return { revision: this.nativeVisibilityRevision, bounds: this.visibleNativeBounds(window) }
  }
  private notifyNativeVisibility(window?: BrowserWindow): void {
    this.nativeVisibilityRevision++
    this.onNativeVisibilityChange?.(this.nativeBrowserVisibility(window), window)
  }

  /** O(1) lookup of the current physically attached owner; no second native Browser registry. */
  nativeOwner(browserId: string, window?: BrowserWindow): NativeBrowserOwner | undefined {
    const entry = this.entries.get(browserId)
    if (!entry || window && this.windowForView(entry.view) !== window || !entry.visible || !entry.bounds || !this.owns(entry, entry.view) || entry.view.webContents.isDestroyed() || !entry.view.getVisible()) return
    const shield = this.inputSurfaces.get(entry.view)?.shield ?? entry.inputShield
    return { browserId, bounds: entry.view.getBounds(), view: entry.view,
      ...(shield?.isCurrentFor(entry.view) ? { inputShield: shield.view } : {}) }
  }

  /** Presentation blocks human hit-testing on the exact native page, never page protocol input. */
  acquireNativeInputBarrier(owner: NativeBrowserOwner, failed: () => void): NativeBrowserInputBarrier {
    const entry = this.entries.get(owner.browserId)
    if (!entry || this.nativeOwner(owner.browserId)?.view !== owner.view) throw new Error('The original native Browser input target is unavailable. Original page remains.')
    const surface = this.inputSurface(entry, owner.view), token = {}
    surface.presentations.set(token, failed)
    const ready = this.prepareInputSurface(surface).then(() => {
      if (surface.presentations.has(token) && !surface.shield.isolated) throw new Error('The original native Browser input barrier is unconfirmed. Original page remains.')
    })
    return { ready, release: async () => {
      if (!surface.presentations.delete(token)) return
      await this.releasePresentationInputSurface(surface)
    } }
  }

  /** Resolve an actual attachment without interpreting its geometry, title or page DOM. */
  nativeOwnerForView(view: WebContentsView, window?: BrowserWindow): NativeBrowserOwner | undefined {
    const browserId = this.browserIdsByView.get(view)
    const owner = browserId === undefined ? undefined : this.nativeOwner(browserId, window)
    return owner?.view === view ? owner : undefined
  }

  /** Actual OS owners, including out-of-process frames; a shared PID is reported only once. */
  resourceProcessIds(): number[] {
    const pids = new Set<number>()
    const live = [...this.entries.values()].flatMap(entry => [entry.view.webContents, ...(entry.inputShield ? [entry.inputShield.contents] : [])])
    live.push(...[...this.inputSurfaces.values(), ...[...this.inputSurfaceCleanup.values()].flatMap(surfaces => [...surfaces])].map(surface => surface.shield.contents))
    const retired = [...this.releasedEntries.values()].flatMap(entry => entry.inputShield ? [entry.inputShield.contents] : [])
    for (const contents of [...live, ...retired, ...this.closingOwners().map(owner => owner.view.webContents)]) {
      if (!contents || contents.isDestroyed()) continue
      for (const frame of contents.mainFrame.framesInSubtree) {
        if (!frame.detached && frame.osProcessId > 0) pids.add(frame.osProcessId)
      }
    }
    return [...pids]
  }

  /** Existing native ownership wins over a cold resource read, including a failed read. */
  async ensure(id: string, resolveCold: () => Promise<BrowserColdDescriptor>, input?: Partial<BrowserRestoreInput>): Promise<BrowserSnapshot> {
    const binding = { ...(input?.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      ...(input?.mode !== undefined ? { mode: input.mode } : {}) }
    if (this.entries.has(id) || this.releasedEntries.has(id)) return await this.restore(id, binding)
    let saved: BrowserColdDescriptor
    try { saved = await resolveCold() }
    catch (error) {
      // Another consumer can acquire the real page while this observation is waiting.
      if (this.entries.get(id) || this.releasedEntries.get(id)) return await this.restore(id, binding)
      throw error
    }
    if (this.entries.get(id) || this.releasedEntries.get(id)) return await this.restore(id, binding)
    if (saved.id !== id) throw new Error('Browser recovery returned another identity. The original Region is kept.')
    if (saved.capsuleId && (!saved.capsule || saved.capsule.record.capsuleId !== saved.capsuleId)) {
      throw new Error('The original Capsule container has not been resolved. Its Browser Region is retained; reconnect its original Host.')
    }
    this.assertWorkspaceBinding(saved.workspaceId, input?.workspaceId ?? null)
    if (input?.mode !== undefined && input.mode !== saved.mode) throw new Error('The saved Browser mode does not match this Region.')
    // create rechecks the original maps and registers synchronously before loadURL. Concurrent
    // visible and public consumers therefore share one owner without a pending registry.
    return await this.create(id, saved.url, saved.workspaceId, saved.profileId, saved.mode, saved.viewport, saved)
  }

  async create(id: string, rawUrl: string, workspaceId: string | null = null, rememberedProfileId?: string, mode?: AgentMuxBrowserMode, viewport: BrowserViewport = 'responsive', saved?: Pick<BrowserColdDescriptor, 'agent' | 'warning' | 'source' | 'capsule' | 'capsuleOrigin' | 'capsuleOpenOperationIds'>): Promise<BrowserSnapshot> {
    if (!id.trim()) throw new Error('Browser id is required')
    if (!isBrowserViewport(viewport)) throw new Error('Unknown browser viewport or invalid dimensions')
    if (mode !== undefined && mode !== 'normal' && mode !== 'private') throw new Error('Browser mode must be normal or private')
    if (mode === 'private' && rememberedProfileId !== undefined) throw new Error('A private Browser cannot use a saved Profile. Open a normal Browser to use that Profile.')
    if (saved?.capsule && (mode === 'private' || rememberedProfileId !== undefined)) throw new Error('A Capsule uses its own persistent container and cannot use a Browser Profile or private mode.')
    if (saved?.capsuleOpenOperationIds && (!saved.capsule || saved.capsuleOpenOperationIds.some(operationId => typeof operationId !== 'string' || !operationId.trim()))) {
      throw new Error('Capsule open requests require their original container and operation identities.')
    }
    // A repeated recovery handshake addresses this owner, not a new navigation/profile choice.
    const existing = this.entries.get(id)
    if (existing) {
      this.assertWorkspaceBinding(existing.workspaceId, workspaceId)
      if (saved?.capsule && (!('capsule' in existing.storage) || existing.storage.capsule.record.capsuleId !== saved.capsule.record.capsuleId)) {
        throw new Error('This Browser belongs to another container. Its original page is retained; open the Capsule in a separate Browser.')
      }
      if (existing.releaseAttempt?.pending) await this.prepareForConsumption(id)
      if (this.entries.get(id) !== existing) return await this.create(id, rawUrl, workspaceId, rememberedProfileId, mode, viewport, saved)
      if (mode !== undefined && existing.storage.mode !== mode) throw new Error('An existing Browser cannot change mode. Open a new Browser instead.')
      for (const operationId of saved?.capsuleOpenOperationIds ?? []) this.recordCapsuleOpen(id, saved!.capsule!.record.capsuleId, operationId)
      return this.snapshot(existing)
    }
    const released = this.releasedEntries.get(id)
    if (released) {
      if (saved?.capsule && (!('capsule' in released.storage) || released.storage.capsule.record.capsuleId !== saved.capsule.record.capsuleId)) {
        throw new Error('This Browser belongs to another container. Its original page is retained; open the Capsule in a separate Browser.')
      }
      await this.restore(id, { workspaceId, ...(mode === undefined ? {} : { mode }) })
      for (const operationId of saved?.capsuleOpenOperationIds ?? []) this.recordCapsuleOpen(id, saved!.capsule!.record.capsuleId, operationId)
      return this.snapshot(this.require(id))
    }
    const url = normalizeBrowserUrl(rawUrl)
    let storage: BrowserStorage
    if (mode === 'private') {
      const partition = `agentmux-browser-private:${mintObjectId()}`
      storage = { mode: 'private', profileId: null, partition, session: session.fromPartition(partition) }
    } else if (saved?.capsule) {
      const endpoint = saved.capsule.endpoint
      const origin = endpoint.status === 'available' ? new URL(endpoint.url).origin : saved.capsuleOrigin
      if (!origin || origin !== new URL(`http://127.0.0.1:${saved.capsule.record.port}`).origin ||
        (saved.capsuleOrigin !== undefined && saved.capsuleOrigin !== origin)) {
        throw new Error('The original Capsule origin is unconfirmed. Its Browser identity is retained; retry the original Host.')
      }
      storage = { mode: 'normal', profileId: null, partition: `persist:agentmux-capsule:${saved.capsule.record.capsuleId}`,
        capsule: saved.capsule, capsuleOrigin: origin, capsuleOpenOperationIds: [...new Set(saved.capsuleOpenOperationIds ?? [])] }
    } else {
      const profileId = rememberedProfileId ?? this.profiles.defaultProfileId()
      storage = { mode: 'normal', profileId, partition: this.resolvePartition(profileId) }
    }
    try { return await this.createEntry(id, url, storage, viewport, workspaceId, undefined, saved) }
    catch (error) {
      if (storage.mode === 'private') await this.clearPrivateStorage(storage).catch(cleanup => {
        throw new AggregateError([error, cleanup], 'Private Browser creation and website-data cleanup failed')
      })
      throw error
    }
  }

  /** Request safe native release. A budget request never commits owner destruction. */
  async release(id: string, navigationId: string): Promise<AgentMuxBrowserReleaseReceipt> {
    return this.releaseNative(id, navigationId)
  }

  private async releaseNative(id: string, navigationId: string, explicitReload = false): Promise<AgentMuxBrowserReleaseReceipt> {
    const result = (status: AgentMuxBrowserReleaseReceipt['status'], reasons: readonly AgentMuxBrowserRetentionReason[]): AgentMuxBrowserReleaseReceipt =>
      ({ browserId: id, navigationId, status, reasons })
    const entry = this.entries.get(id)
    if (!entry) return result('unknown', ['owner-unavailable'])
    if (!navigationId || entry.navigationId !== navigationId) return result('retained', ['source-changed'])
    // Re-observing an unknown close is safe; issuing another close is not.
    const previous = entry.releaseAttempt
    if (previous?.view === entry.view) {
      const receipt = previous.receipt ?? await previous.promise
      return receipt.navigationId === navigationId ? receipt : result(receipt.status, receipt.reasons)
    }
    const retention = this.retention(entry)
    // An explicit Reload already requests a new document. Visibility and previous ordinary page
    // use are budget protections, not active operations; native beforeunload still owns refusal.
    const reasons = explicitReload ? retention.reasons.filter(reason => !['visible', 'presentation', 'document-used'].includes(reason)) : retention.reasons
    if (reasons.length) return result(retention.status === 'unknown' ? 'unknown' : 'retained', reasons)
    const view = entry.view, contents = view.webContents
    let resolve!: (receipt: AgentMuxBrowserReleaseReceipt) => void
    const promise = new Promise<AgentMuxBrowserReleaseReceipt>(yes => { resolve = yes })
    let settled = false
    const veto = () => {
      attempt.settle('retained', ['beforeunload'])
      this.markResourceRisk(entry, view, 'beforeunload')
    }
    // Only the observation ends at this boundary. The physical close remains owned by Main;
    // late destruction still publishes its exact source and no caller automatically resends it.
    const timer = setTimeout(() => {
      attempt.settle('unknown', ['close-unconfirmed'])
      if (this.owns(entry, view)) this.emit(entry)
    }, 1_000)
    const attempt: NonNullable<BrowserEntry['releaseAttempt']> = {
      navigationId, view, pending: true, receipt: null, promise,
      settle: (status, reasons) => {
        if (attempt.receipt?.status === 'released' || (status === 'unknown' && attempt.receipt?.status === 'retained')) return
        const receipt = result(status, reasons)
        attempt.receipt = receipt
        if (status !== 'unknown') attempt.pending = false
        if (status !== 'unknown') contents.removeListener('will-prevent-unload', veto)
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(receipt)
      }
    }
    entry.releaseAttempt = attempt
    contents.once('will-prevent-unload', veto)
    this.emit(entry)
    try { contents.close({ waitForBeforeUnload: true }) }
    catch {
      attempt.settle('unknown', ['close-unconfirmed'])
      if (this.owns(entry, view)) this.emit(entry)
    }
    return promise
  }

  /** Observe the original close once; confirmed destruction alone requires a same-ID handoff. */
  async prepareForConsumption(id: string): Promise<void> {
    const entry = this.entries.get(id), attempt = entry?.releaseAttempt
    if (!entry || !attempt?.pending || attempt.view !== entry.view) return
    const receipt = await attempt.promise
    if (receipt.status === 'retained' && !attempt.pending) return
    if (this.entries.get(id) !== entry && !this.entries.has(id) && this.releasedEntries.has(id)) {
      await this.restore(id)
    }
  }

  private markResourceRisk(entry: BrowserEntry, view: WebContentsView, reason: AgentMuxBrowserRetentionReason): void {
    if (!this.owns(entry, view) || entry.resourceRisk.has(reason)) return
    entry.resourceRisk.add(reason)
    this.emit(entry)
  }

  private retention(entry: BrowserEntry): AgentMuxBrowserRetention {
    const contents = entry.view.webContents
    const reasons = new Set<AgentMuxBrowserRetentionReason>(entry.resourceRisk)
    if (entry.visible) reasons.add('visible')
    if ([...entry.presentationLeaseIds].some(id => this.presentationLeases.get(id)?.geometry.visible)) reasons.add('presentation')
    if (entry.captureId || contents.isBeingCaptured?.()) reasons.add('presentation')
    if (entry.runInFlight || entry.activeRun || entry.driving || entry.resourceReads || entry.humanControl || this.agentOwnsInput(entry) ||
      this.taskExecutions.get(entry.id)?.entry === entry || this.taskAssets?.isBrowserExecuting?.(entry.id) ||
      this.demonstrationCapture?.entry === entry) reasons.add('operation')
    if (entry.pendingSwitch) reasons.add('profile-switch')
    if (entry.selectionOperation !== null || entry.firstPress) reasons.add('selection')
    if (contents.isLoading()) reasons.add('loading')
    if (contents.isCurrentlyAudible?.()) reasons.add('media')
    if (this.uploads?.hasRetained(entry.id)) reasons.add('upload')
    if (contents.debugger?.isAttached?.() || contents.isDevToolsOpened?.()) reasons.add('debugger')
    if (!entry.resourceDocumentConfirmed || typeof contents.isBeingCaptured !== 'function' || typeof contents.isCurrentlyAudible !== 'function') reasons.add('document-unconfirmed')
    if (entry.releaseAttempt?.pending && entry.releaseAttempt.view === entry.view) reasons.add('close-unconfirmed')
    if (entry.inputShield && (entry.inputIsolation === 'unconfirmed' || !this.agentOwnsInput(entry))) reasons.add('close-unconfirmed')
    if (this.inputSurfaceCleanup.has(entry.id)) reasons.add('close-unconfirmed')
    return { status: reasons.has('document-unconfirmed') || reasons.has('close-unconfirmed') ? 'unknown' : reasons.size ? 'retained' : 'eligible', reasons: [...reasons] }
  }

  /** Rebuild a previously released Browser native owner from its retained projection metadata. */
  async restore(id: string, input?: Partial<BrowserRestoreInput>): Promise<BrowserSnapshot> {
    if (input?.viewport !== undefined && !isBrowserViewport(input.viewport)) throw new Error('Unknown browser viewport or invalid dimensions')
    const existing = this.entries.get(id)
    if (existing) {
      this.assertWorkspaceBinding(existing.workspaceId, input?.workspaceId ?? null)
      if (existing.releaseAttempt?.pending) await this.prepareForConsumption(id)
      if (this.entries.get(id) !== existing) return await this.restore(id, input)
      if (input?.mode !== undefined && input.mode !== existing.storage.mode) throw new Error('An existing Browser cannot change mode. Open a new Browser instead.')
      return this.snapshot(existing)
    }
    const released = this.releasedEntries.get(id)
    if (!released) throw new Error(`Unknown released browser: ${id}`)
    this.assertWorkspaceBinding(released.workspaceId, input?.workspaceId ?? null)
    if (released.cleanupOnly) {
      this.cleanupReleasedOwner(released)
      if (!released.inputShield && !released.pendingSwitch && !released.detachedView) this.releasedEntries.delete(id)
      throw new Error('This Browser was closed explicitly. Use Close to retry its remaining native cleanup, or open a new Browser for a fresh page.')
    }
    if (input?.mode !== undefined && input.mode !== released.storage.mode) throw new Error('An existing Browser cannot change mode. Open a new Browser instead.')
    const profileId = input?.profileId ?? released.storage.profileId
    if (released.storage.mode === 'private' && profileId !== null) throw new Error('A private Browser cannot use a saved Profile.')
    if ('capsule' in released.storage && profileId !== null) throw new Error('A Capsule cannot restore into a Browser Profile. Its original container is retained.')
    // The retained Main descriptor is the only authoritative URL while the native owner is gone.
    // Renderer tab.url can lag did-start-navigation, so accepting it here could restore an older
    // committed page and silently change the Region's identity.
    const url = released.requestedUrl
    const viewport = cloneBrowserViewport(input?.viewport ?? released.viewport)
    // Validate the profile before removing the retained descriptor. A failed restore must leave the
    // original profile ownership intact so deleting/repairing a profile cannot orphan this Region.
    const storage: BrowserStorage = released.storage.mode === 'private' || 'capsule' in released.storage ? released.storage
      : { mode: 'normal', profileId: profileId!, partition: this.resolvePartition(profileId!) }
    this.cleanupReleasedOwner(released)
    this.releasedEntries.delete(id)
    try {
      const snapshot = await this.createEntry(id, url, storage, viewport, released.workspaceId, released.inputShield, { agent: released.agent,
        ...(released.agentWarning === undefined ? {} : { warning: released.agentWarning }) })
      return snapshot
    } catch (error) {
      this.releasedEntries.set(id, { ...released, storage, requestedUrl: url, viewport })
      throw error
    }
  }

  private async createEntry(
    id: string,
    url: string,
    storage: BrowserStorage,
    viewport: BrowserViewport = 'responsive',
    workspaceId: string | null = null,
    retiredInputShield?: BrowserNativeInputShield,
    saved?: Pick<BrowserColdDescriptor, 'agent' | 'warning' | 'source' | 'capsule' | 'capsuleOrigin' | 'capsuleOpenOperationIds'>
  ): Promise<BrowserSnapshot> {
    const view = this.createView(storage.partition, 'capsule' in storage ? storage.capsule.record : undefined)
    const entry = this.registerEntry(id, url, storage, view, viewport, workspaceId, retiredInputShield, saved)
    try {
      void this.startNavigation(entry, url, true).catch(() => {})
      return this.snapshot(entry)
    } catch (error) {
      // The ordinary creation transaction has not delivered its resource yet.
      // Native child adoption does not use this URL-navigation transaction.
      try { this.destroyOwner(id) }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Browser creation and owner rollback failed') }
      throw error
    }
  }

  private createNativeChild(parent: BrowserEntry, sourceView: WebContentsView, options: BrowserWindowConstructorOptions): WebContents {
    // Only the original page may contribute this request. This rejects a stale
    // source incarnation, without closing its independent healthy replacement.
    if (!this.owns(parent, sourceView)) throw new Error('The original native Browser page is no longer current; its child was not created.')
    const lease = parent.inputLeaseId ? this.presentationLeases.get(parent.inputLeaseId) : undefined
    let location: import('@agentmux/core').AgentMuxBrowserSource['location']
    if (lease?.entry === parent && 'displayWorkspaceId' in lease.occurrence.location && this.isPresentationDocumentCurrent(lease.document)) {
      try {
        if (!this.presentationWindow || this.presentationWindow(lease.windowDocument, lease.occurrence.location) === lease.window) location = { ...lease.occurrence.location }
      } catch { /* Source Browser identity is still known; an unconfirmed placement is omitted. */ }
    }
    const source = { browserId: parent.id, navigationId: parent.navigationId, ...(location ? { location } : {}) }
    const { webContents: guest, webPreferences } = options as BrowserWindowConstructorOptions & { webContents?: WebContents }
    const view = new WebContentsView({ ...(webPreferences ? { webPreferences } : {}), ...(guest ? { webContents: guest } : {}) })
    const window = { width: options.width ?? 1024, height: options.height ?? 768 }
    const child = this.registerEntry(mintObjectId(), view.webContents.getURL() || 'about:blank', parent.storage, view,
      'responsive', parent.workspaceId, undefined, { agent: parent.agent, ...(parent.agentWarning ? { warning: parent.agentWarning } : {}) }, { source, window })
    this.markResourceRisk(parent, sourceView, 'document-used')
    this.send({ type: 'native-opened', browser: this.snapshot(child), workspaceId: child.workspaceId, window })
    // Chromium, not startNavigation/loadURL, continues the original guest request.
    return view.webContents
  }

  /** Native shell Close closes its original child page; explicit Return only moves it. */
  requestNativeWindowClose(window: BrowserWindow): boolean {
    const candidates = [...this.entries.values()].filter(entry => entry.nativeChild && this.windowForView(entry.view) === window)
    // A multi-Region shell returns its workface. Never guess which child to close.
    const entry = candidates.length === 1 ? candidates[0] : undefined
    if (!entry) return false
    void this.closeNativeChild(entry).catch(error => {
      if (!this.owns(entry, entry.view)) return
      entry.activity = { ...entry.activity, warning: error instanceof Error ? error.message : String(error) }
      this.emit(entry)
    })
    return true
  }

  nativeWindowSize(browserId: string): { width: number; height: number } | null {
    const size = this.entries.get(browserId)?.nativeChild?.window
    return size ? { ...size } : null
  }

  private closeNativeChild(entry: BrowserEntry): Promise<boolean> {
    const child = entry.nativeChild!, page = entry.view.webContents
    if (page.isDestroyed()) return Promise.resolve(true)
    const existing = child.closing
    const frame = page.mainFrame
    const closing: NativeChildClose = existing ?? { id: mintObjectId(), view: entry.view, navigationId: entry.navigationId,
      processId: frame.processId, frameToken: frame.frameToken, prompted: false, observers: new Set(), settle: (closed: boolean) => {
        if (child.closing !== closing) return
        delete child.closing
        let publish = false
        if (child.closeWarning) {
          const warning = removeWarning(entry.activity.warning, child.closeWarning)
          const { warning: _warning, ...activity } = entry.activity
          entry.activity = { ...activity, ...(warning ? { warning } : {}) }
          delete child.closeWarning
          publish = this.owns(entry, entry.view) && !page.isDestroyed()
        }
        for (const observer of closing.observers) { if (observer.timer) clearTimeout(observer.timer); observer.resolve(closed) }
        closing.observers.clear()
        if (publish) { try { this.emit(entry) } catch (error) { console.warn('The original native Close settled, but its presentation could not be updated:', error) } }
      } }
    child.closing = closing
    const observed = new Promise<boolean>((resolve, reject) => {
      const observer: NativeChildCloseObserver = { resolve, reject, timer: null }
      closing.observers.add(observer)
      // This bounds one observation, not the original native request or page lifetime.
      // The same request is retained and a later explicit Close observes it without replay.
      if (!closing.prompted) observer.timer = setTimeout(() => {
        closing.observers.delete(observer)
        const error = new Error(`Native close ${closing.id} is unconfirmed. The original page remains available; inspect it and use Close to observe this same request again.`)
        if (this.owns(entry, entry.view)) {
          child.closeWarning = error.message
          entry.activity = { ...entry.activity, warning: appendWarning(entry.activity.warning, error.message) }
          try { this.emit(entry) } catch (projectionError) { console.warn('The original native Close remains unconfirmed; its presentation is unavailable:', projectionError) }
        }
        reject(error)
      }, 1_000)
    })
    if (!existing) {
      try { page.close({ waitForBeforeUnload: true }) }
      catch (error) {
        for (const observer of closing.observers) { if (observer.timer) clearTimeout(observer.timer); observer.reject(error instanceof Error ? error : new Error(String(error))) }
        closing.observers.clear()
      }
    }
    return observed
  }

  private async confirmNativeChildClose(entry: BrowserEntry, view: WebContentsView): Promise<void> {
    const closing = entry.nativeChild?.closing
    if (!closing || closing.view !== view || closing.prompted || !this.owns(entry, view)) return
    const page = view.webContents, frame = page.mainFrame
    if (closing.navigationId !== entry.navigationId || closing.processId !== frame.processId || closing.frameToken !== frame.frameToken) return
    closing.prompted = true
    for (const observer of closing.observers) { if (observer.timer) clearTimeout(observer.timer); observer.timer = null }
    const processId = frame.processId, frameToken = frame.frameToken
    const current = () => this.owns(entry, view) && entry.nativeChild?.closing === closing && !page.isDestroyed() &&
      !frame.isDestroyed() && !frame.detached && page.mainFrame === frame && frame.processId === processId && frame.frameToken === frameToken
    try {
      const window = this.windowForView(view)
      const leave = this.nativeWindows.confirmLeave ? await this.nativeWindows.confirmLeave(window) :
        (await dialog.showMessageBox(window, { type: 'warning', title: 'Leave this page?', message: 'This page is asking to stay open.',
          detail: 'Changes you made may not be saved.', buttons: ['Leave', 'Stay'], defaultId: 1, cancelId: 1, noLink: true })).response === 0
      if (!current()) { closing.settle(false); return }
      if (leave) page.close()
      else closing.settle(false)
    } catch (error) {
      closing.settle(false)
      if (!this.owns(entry, view)) return
      entry.activity = { ...entry.activity, warning: `Page close could not be confirmed: ${error instanceof Error ? error.message : String(error)}. The original page remains open.` }
      this.emit(entry)
    }
  }

  /** Ordinary and Chromium-created pages use the same owner and all of its consumers. */
  private registerEntry(
    id: string, url: string, storage: BrowserStorage, view: WebContentsView,
    viewport: BrowserViewport = 'responsive', workspaceId: string | null = null,
    retiredInputShield?: BrowserNativeInputShield,
    saved?: Pick<BrowserColdDescriptor, 'agent' | 'warning' | 'source' | 'capsule' | 'capsuleOrigin' | 'capsuleOpenOperationIds'>,
    native?: { source: import('@agentmux/core').AgentMuxBrowserSource; window: { width: number; height: number } }
  ): BrowserEntry {
    if (!isBrowserViewport(viewport)) throw new Error('Unknown browser viewport or invalid dimensions')
    if (this.entries.has(id)) throw new Error(`Browser already exists: ${id}`)
    const entry: BrowserEntry = {
      id,
      ...(native ? { source: native.source, nativeChild: { window: native.window } } : saved?.source ? { source: saved.source } : {}),
      workspaceId,
      view,
      storage,
      requestedUrl: url,
      navigationId: mintObjectId(),
      committedNavigationId: null,
      capsuleRequest: null, capsuleResponse: null,
      initialDocument: null,
      selectionRevision: 0,
      selectionOperation: null,
      annotationRevision: 0,
      switchRevision: 0,
      pendingSwitch: null,
      bounds: null,
      visible: false,
      viewport: cloneBrowserViewport(viewport),
      error: null,
      driving: false,
      appLinkPrompt: null,
      appLinkRequest: null,
      activity: { operation: null, control: 'human', ...(retiredInputShield ? { warning: 'An earlier native Browser input surface could not be fully released. The original Browser has reopened; explicitly hand it to its Agent to retry cleanup before starting a fresh isolated program.' } : {}) },
      humanControl: false,
      activeRun: undefined,
      runInFlight: false,
      controlRevision: 0,
      agent: saved ? saved.agent : null,
      agentWarning: saved?.warning,
      inputIsolation: retiredInputShield ? 'unconfirmed' : 'inactive',
      inputShield: retiredInputShield,
      feedbackRevision: 0,
      presentationLeaseIds: new Set(), captureId: null, inputLeaseId: null, firstPress: null,
      resourceRisk: new Set(native ? ['document-used'] : []), resourceDocumentConfirmed: false, resourceReads: 0, publishedRetention: null, releaseAttempt: null
    }
    this.entries.set(id, entry)
    let childRegistrationAttempted = false
    try {
      // An unattached view forwards its size to WebContents. Once hidden in a
      // Widget, native layout hides the child without forwarding new bounds.
      view.setVisible(false)
      const drawingSize = browserViewportSize(viewport) ?? this.window.getContentBounds()
      if (Number.isFinite(drawingSize.width) && drawingSize.width > 0 && Number.isFinite(drawingSize.height) && drawingSize.height > 0) {
        view.setBounds({ x: 0, y: 0, width: drawingSize.width, height: drawingSize.height })
      }
      childRegistrationAttempted = true
      // BrowserWindow's original Renderer is below contentView. Native Chrome sits above Browsers.
      this.placeView(view, this.window)
      this.attach(entry, view)
      this.emit(entry)
      if (this.demonstrations) void this.getDemonstration(id).catch(() => {
        if (!this.owns(entry, view) || this.demonstrationCapture?.entry === entry) return
        entry.demonstration = { draft: null, warning: 'The saved demonstration could not be read. The Browser remains usable; reopen its activity details to retry.' }
        this.emit(entry)
      })
      if (this.taskAssets) void this.getTaskAssets(id).catch(() => {})
      return entry
    } catch (error) {
      this.entries.delete(id)
      this.notifyNativeVisibility(this.windowForView(view))
      const cleanupErrors: unknown[] = []
      if (childRegistrationAttempted && !this.window.isDestroyed()) {
        try {
          this.detachView(view)
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }
      if (!view.webContents.isDestroyed()) {
        try {
          view.webContents.close()
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'Browser creation and owner rollback failed')
      }
      throw error
    }
  }

  async navigate(id: string, rawUrl: string): Promise<BrowserSnapshot> {
    if (this.entries.get(id)?.releaseAttempt?.pending) await this.prepareForConsumption(id)
    const entry = this.require(id)
    this.requireHumanInput(entry)
    void this.startNavigation(entry, rawUrl).catch(() => {})
    return this.snapshot(entry)
  }

  /** Keep full navigation completion separate from first-document consumption. */
  private startNavigation(entry: BrowserEntry, rawUrl: string, initial = false): Promise<void> {
    const url = normalizeBrowserUrl(rawUrl)
    entry.nativeChild?.closing?.settle(false)
    this.cancelPendingSwitchForNavigation(entry, new Error('Browser profile switch was superseded by navigation'))
    const view = entry.view
    entry.requestedUrl = url
    entry.error = null
    this.emit(entry)
    let document: BrowserEntry['initialDocument'] = null
    if (initial || entry.initialDocument) {
      entry.initialDocument?.superseded.abort()
      document = { view, completion: new AbortController(), superseded: new AbortController(), failure: null,
        resolve: () => settled(null), reject: error => settled({ error }),
        navigationId: null, loadNavigationId: null, committedNavigationId: null }
      const attempt = document
      const settled = (failure: { error: unknown } | null) => {
        if (attempt.completion.signal.aborted) return
        attempt.failure = failure
        if (entry.initialDocument === attempt) entry.initialDocument = null
        attempt.completion.abort()
      }
      entry.initialDocument = attempt
    }
    const promise = view.webContents.loadURL(url).catch((error) => {
      if (this.owns(entry, view) && !document?.superseded.signal.aborted &&
        (!document || document.navigationId === document.loadNavigationId)) {
        entry.error = error instanceof Error ? error.message : String(error)
        this.emit(entry)
      }
      throw error
    })
    void promise.then(() => {
      if (document && (!this.owns(entry, view) ||
        (document.navigationId && document.navigationId === document.loadNavigationId &&
          document.committedNavigationId === document.navigationId))) document.resolve()
    }, error => {
      if (document && document.navigationId === document.loadNavigationId) document.reject(error)
    })
    return promise
  }

  private async waitForInitialDocument(entry: BrowserEntry, view: WebContentsView,
    signal?: AbortSignal, deadlineMillis = performance.now() + BROWSER_INITIAL_DOCUMENT_OBSERVATION_MS): Promise<void> {
    const current = () => {
      if (!this.owns(entry, view) || view.webContents.isDestroyed()) throw new Error('The original Browser owner changed before its document was ready.')
      signal?.throwIfAborted()
      if (performance.now() >= deadlineMillis) throw new Error('The initial Browser document did not become ready within this request budget. Navigation and existing Browser work remain available.')
    }
    current()
    while (entry.initialDocument) {
      const document = entry.initialDocument
      if (document.view !== view) throw new Error('The original Browser view changed before its document was ready.')
      try {
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: unknown, failed = error !== undefined) => {
            clearTimeout(timeout)
            signal?.removeEventListener('abort', aborted)
            document.superseded.signal.removeEventListener('abort', replaced)
            document.completion.signal.removeEventListener('abort', completed)
            failed ? reject(error) : resolve()
          }
          const replaced = () => finish()
          const aborted = () => finish(signal?.reason ?? new Error('The Browser operation stopped before its document was ready.'))
          const completed = () => finish(document.failure?.error, document.failure !== null)
          const timeout = setTimeout(() => finish(new Error('The initial Browser document exceeded this request budget. Navigation and existing Browser work remain available.')), Math.max(1, deadlineMillis - performance.now()))
          timeout.unref?.()
          signal?.addEventListener('abort', aborted, { once: true })
          document.superseded.signal.addEventListener('abort', replaced, { once: true })
          document.completion.signal.addEventListener('abort', completed, { once: true })
          if (document.completion.signal.aborted) completed()
          else if (document.superseded.signal.aborted) replaced()
          else if (signal?.aborted) aborted()
        })
      } catch (error) {
        current()
        if (!document.superseded.signal.aborted) throw error
      }
      current()
    }
  }

  async back(id: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    this.requireHumanInput(entry)
    this.cancelPendingSwitchForNavigation(entry, new Error('Browser profile switch was superseded by navigation'))
    if (entry.view.webContents.navigationHistory.canGoBack()) {
      entry.nativeChild?.closing?.settle(false)
      entry.view.webContents.navigationHistory.goBack()
    }
    return this.snapshot(entry)
  }

  async forward(id: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    this.requireHumanInput(entry)
    this.cancelPendingSwitchForNavigation(entry, new Error('Browser profile switch was superseded by navigation'))
    if (entry.view.webContents.navigationHistory.canGoForward()) {
      entry.nativeChild?.closing?.settle(false)
      entry.view.webContents.navigationHistory.goForward()
    }
    return this.snapshot(entry)
  }

  async reload(id: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    this.requireHumanInput(entry)
    this.cancelPendingSwitchForNavigation(entry, new Error('Browser profile switch was superseded by reload'))
    entry.nativeChild?.closing?.settle(false)
    entry.error = null
    entry.view.webContents.reload()
    return this.snapshot(entry)
  }

  /** Refresh the policy of this exact container without changing its Browser, route or partition. */
  async reloadCapsule(id: string, inspection: CapsuleInspection): Promise<BrowserSnapshot> {
    const entry = this.require(id), storage = entry.storage
    this.requireHumanInput(entry)
    if (!('capsule' in storage) || storage.capsule.record.capsuleId !== inspection.record.capsuleId ||
      new URL(`http://127.0.0.1:${inspection.record.port}`).origin !== storage.capsuleOrigin) {
      throw new Error('The original Capsule container could not be confirmed. Its page and address are retained.')
    }
    if (storage.capsule.record.mode === inspection.record.mode) {
      entry.storage = { ...storage, capsule: inspection }
      entry.capsuleRequest = null; entry.capsuleResponse = null; entry.committedNavigationId = null
      return this.reload(id)
    }
    const receipt = await this.releaseNative(id, entry.navigationId, true)
    if (receipt.status !== 'released') {
      if (this.owns(entry, entry.view)) {
        entry.activity = { ...entry.activity, warning: `Capsule mode reload is ${receipt.status}. The original page is retained (${receipt.reasons.join(', ')}). Complete its current Browser activity or inspect its original close before reloading.` }
        this.emit(entry)
        return this.snapshot(entry)
      }
      throw new Error('The original Capsule native close is unconfirmed. Its Browser Region is retained; inspect the same owner before retrying.')
    }
    const released = this.releasedEntries.get(id)
    if (!released || !('capsule' in released.storage) || released.storage.capsule.record.capsuleId !== inspection.record.capsuleId) {
      throw new Error('The original Capsule restore owner is unconfirmed. Its Region and operation are retained.')
    }
    released.storage = { ...released.storage, capsule: inspection }
    return this.restore(id)
  }

  async switchProfile(id: string, profileId: string): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    this.requireHumanInput(entry)
    if (entry.storage.mode === 'private') throw new Error('A private Browser cannot switch to a saved Profile. Open a new normal Browser instead.')
    if ('capsule' in entry.storage) throw new Error('A Capsule uses its own persistent container. Open a separate Browser to use a Profile.')
    const partition = this.resolvePartition(profileId)
    this.cancelPendingSwitch(entry, new Error('Browser profile switch was superseded'))
    if (entry.storage.profileId === profileId) return this.snapshot(entry)

    const authoritativeView = entry.view
    // Keep profile switching consistent with release: the committed URL may lag the latest
    // navigation request while Chromium is loading.
    const url = assertAllowedBrowserUrl(entry.requestedUrl)
    const candidate = this.createView(partition)
    candidate.setVisible(false)
    let rejectCancellation!: (error: Error) => void
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
    const pending: PendingProfileSwitch = {
      token: ++entry.switchRevision,
      profileId,
      view: candidate,
      rejectCancellation,
      attached: false,
      released: false
    }

    let committed = false
    try {
      entry.pendingSwitch = pending
      this.placeView(candidate, this.windowForView(authoritativeView))
      pending.attached = true
      const candidateControlFeedback = this.attach(entry, candidate)
      await Promise.race([candidate.webContents.loadURL(url), cancellation])
      if (
        this.entries.get(id) !== entry ||
        entry.view !== authoritativeView ||
        entry.pendingSwitch !== pending ||
        entry.switchRevision !== pending.token ||
        authoritativeView.webContents.isDestroyed() ||
        candidate.webContents.isDestroyed()
      ) {
        throw new Error('Browser profile switch was superseded')
      }
      this.requireHumanInput(entry)

      const zoomFactor = authoritativeView.webContents.getZoomFactor()
      candidate.webContents.setZoomFactor(zoomFactor)
      this.applyViewport(entry, candidate)
      if (entry.bounds) candidate.setBounds(entry.bounds)
      candidate.setVisible(entry.visible)
      const inputSurface = this.inputSurfaces.get(authoritativeView)
      if (inputSurface) this.inputSurfaceFailed(inputSurface)
      this.detachView(authoritativeView)

      this.releaseUploadFiles(entry)
      void this.releaseDemonstrationCapture(entry)
      entry.pendingSwitch = null
      void entry.feedback?.hide()
      void entry.controlFeedback?.hide()
      this.revokePresentationCapture(entry, 'source-replaced')
      this.clearFavicon(entry)
      const previousStorage = entry.storage
      const previousPreviewScope = this.recoveryPreviewScope(id)
      this.cancelRecoveryPreview(entry)
      // This explicit Profile commit replaces the old native source. A pending
      // Close of that source cannot become authority to remove the new page.
      entry.nativeChild?.closing?.settle(false)
      entry.view = candidate
      entry.controlFeedback = candidateControlFeedback
      // Candidate preparation predates current-owner input/media observation. Do not inherit
      // another WC's quiet proof; this page remains usable, but is not an automatic discard target.
      entry.resourceRisk.add('document-unconfirmed')
      if (entry.initialDocument) entry.initialDocument.superseded.abort()
      entry.initialDocument = null
      entry.storage = { mode: 'normal', profileId, partition }
      entry.requestedUrl = candidate.webContents.getURL() || url
      entry.navigationId = mintObjectId()
      entry.committedNavigationId = null
      entry.selectionOperation = null
      entry.selectionRevision += 1
      entry.annotationRevision += 1
      entry.error = null
      committed = true
      try { this.closeNativeView({ id: entry.id, workspaceId: entry.workspaceId, storage: previousStorage, requestedUrl: url, viewport: entry.viewport }, authoritativeView) }
      catch (error) {
        // The new Profile already owns this Browser. Publish that fact even if old cleanup failed.
        try { this.emit(entry) } catch (noticeError) { console.warn('Browser ownership update was not delivered:', noticeError) }
        throw error
      }
      this.synchronizeVisiblePage(entry, candidate)
      this.updateFavicon(entry, candidate)
      if (previousPreviewScope) void this.recoveryPreviews?.remove(previousPreviewScope)
      this.sampleRecoveryPreview(entry, candidate)
      this.emit(entry)
      return this.snapshot(entry)
    } finally {
      // Cancellation already attempted cleanup at its original entry point. Keep its failed
      // candidate reference instead of silently retrying or losing it in this late continuation.
      if (!committed && entry.switchRevision === pending.token) {
        if (entry.pendingSwitch === pending) {
          entry.pendingSwitch = null
          entry.switchRevision += 1
        }
        try { this.releasePendingSwitch(pending) } catch (error) {
          if (this.entries.get(id) === entry && !entry.pendingSwitch) entry.pendingSwitch = pending
          throw error
        }
      }
    }
  }

  openDevTools(id: string): void {
    const entry = this.require(id)
    // Opening this engine debugger detaches the active Agent CDP session and
    // exposes a page-writing Console. Reading retained inspect data stays free.
    this.requireHumanInput(entry)
    entry.view.webContents.openDevTools({ mode: 'detach', activate: true })
  }

  usesProfile(profileId: string): boolean {
    return [...this.entries.values()].some((entry) => (
      entry.storage.profileId === profileId || entry.pendingSwitch?.profileId === profileId
    )) || [...this.releasedEntries.values()].some((entry) => (
      entry.storage.profileId === profileId || entry.pendingSwitch?.profileId === profileId
    )) || this.closingOwners().some(owner => !owner.view.webContents.isDestroyed() && owner.storage.profileId === profileId)
  }

  setViewport(id: string, viewport: BrowserViewport): BrowserSnapshot {
    const entry = this.require(id)
    this.requireHumanInput(entry)
    if (!isBrowserViewport(viewport)) throw new Error('Unknown browser viewport or invalid dimensions')
    const ownedViewport = cloneBrowserViewport(viewport)
    this.applyViewport(entry, entry.view, ownedViewport)
    entry.viewport = ownedViewport
    // Emulation is already applied. Keep its dimensions observable even if native
    // drawing synchronization fails; the original failure still reaches the caller.
    try { this.synchronizeVisiblePage(entry, entry.view) }
    catch (error) {
      try { this.emit(entry) }
      catch (publicationError) { throw new AggregateError([error, publicationError], 'Viewport applied; drawing synchronization and publication failed') }
      throw error
    }
    this.emit(entry)
    return this.snapshot(entry)
  }

  async captureScreenshot(id: string, transport?: { view: WebContentsView; sendCommand: BrowserCdpSender }): Promise<BrowserScreenshotCapture> {
    return (await this.captureObservedScreenshot(id, transport)).capture
  }

  /** The original capture owner observes activity around these exact pixels. */
  async captureInputFrame(id: string, hostId: string): Promise<BrowserInputFrameCapture> {
    const result = await this.captureObservedScreenshot(id, undefined, hostId)
    if (!result.before || !result.after) throw new Error('The original Browser frame observation is unavailable. Keep the draft; text input remains available.')
    return { capture: result.capture, before: result.before, after: result.after }
  }

  private async captureObservedScreenshot(id: string, transport?: { view: WebContentsView; sendCommand: BrowserCdpSender }, hostId?: string) {
    if (this.entries.get(id)?.releaseAttempt?.pending) await this.prepareForConsumption(id)
    const entry = this.require(id)
    const view = entry.view
    if (transport && transport.view !== view) throw new Error('Browser page changed before the screenshot was captured')
    entry.resourceReads += 1
    try {
    await this.waitForInitialDocument(entry, view)
    const navigationId = entry.navigationId
    const requireCurrent = () => {
      if (!this.owns(entry, view) || view.webContents.isDestroyed() || entry.navigationId !== navigationId) {
        throw new Error('Browser page changed while the screenshot was being captured')
      }
    }
    requireCurrent()
    const url = view.webContents.getURL(), title = view.webContents.getTitle()
    const readViewport = () => readScreenshotViewport(() => view.webContents.executeJavaScriptInIsolatedWorld(BROWSER_SELECTION_WORLD_ID, [{ code: SCREENSHOT_VIEWPORT_SCRIPT }]))
    const before = await readViewport()
    requireCurrent()
    const inputBefore = hostId === undefined ? undefined : this.inputContext(id, hostId)
    let image: BrowserScreenshotCapture['image']
    if (transport) {
      // Reuse this operation's original session. CDP waits for a presented frame;
      // the GUI's Native capture remains available without attaching a debugger.
      const captured = await transport.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
      requireCurrent()
      const data = (captured as { data?: unknown } | null)?.data
      if (typeof data !== 'string' || data.length === 0 || data.length > BROWSER_PNG_MAX_BASE64_CHARS) throw new Error('Browser screenshot must contain bounded base64 PNG data')
      const bytes = Buffer.from(data, 'base64')
      if (bytes.toString('base64') !== data) throw new Error('Browser screenshot must contain canonical base64 PNG data')
      image = await capturePageImage({ capture: async () => ({ png: bytes }) })
    } else {
      image = await capturePageImage({ capture: async () => {
        const captured = await view.webContents.capturePage()
        requireCurrent()
        return browserPagePixels(captured)
      } })
    }
    const after = await readViewport()
    requireCurrent()
    const inputAfter = hostId === undefined ? undefined : this.inputContext(id, hostId)
    return {
      before: inputBefore,
      after: inputAfter,
      capture: {
        browserId: id,
        navigationId,
        source: screenshotSource(url, title, before, after),
        image
      }
    }
    } finally { entry.resourceReads -= 1; this.emit(entry) }
  }

  /**
   * 在这个 Browser 上跑一段 Agent 写的程序。
   *
   * 这里只做**四件事**：确认 Browser 还在、接上 CDP 会话、把页面函数的调用派发出去、把结局翻译成
   * 契约形状。程序本身在独立子进程里跑（`runBrowserScript`），页面能力由 `createBrowserPageDispatch`
   * 派发——那一层持有快照缓存与 ref 解析。
   *
   * **CDP 会话按次开关**，不常驻：Electron 的 debugger 与 DevTools 互斥，常驻等于永久占着用户的
   * DevTools（见 browser-cdp-session.ts 的说明）。`detach` 放在 finally 里，因为漏掉它的后果是
   * 静默的——用户此后再也打不开这个页面的 DevTools，而且没有任何提示。
   *
   * 翻译成四类结局是承重的：执行器的失败联合有四支，任何两支折成一支都会让 Agent 走错方向。
   * 特别是 `crashed` → `indeterminate`——进程死了意味着**做到哪一步不知道**，页面上可能已经点过
   * 一次了。把它报成普通失败，调用方就会重试，而那正是"下单被点两次"的来源。
   */
  /**
   * @param operationId 这次操作的 identity，由调用方给（协议的 `browser.run` 可选字段）。
   *   给了才可能「在飞期间凭 id 查询/取消」：Control 是一问一答，主进程铸的 id 只随终局回执露出，
   *   那时已无可取消。缺席时由 journal 铸——**铸造点仍只有一处**（journal 的 `makeId`），
   *   这里绝不再补一个 `mintObjectId()` 兜底：两个铸造点会让查询用的 id 与记录里的 id 分岔，
   *   而分岔时两边各自看起来都正常（MEMORY：读的 key 与写的 key 必须只判一次）。
   */
  async runScript(id: string, code: string, operator?: BrowserOperator, replayOf?: string, operationId?: string, onOperationStarted?: (operation: BrowserOperation) => void | Promise<void>, privateTaskParameters = false, taskPage?: BrowserTaskPageExecution,
    caller?: Pick<import('@agentmux/core').AgentMuxControlCaller, 'agentSessionId'>): Promise<BrowserScriptRunReport> {
    const originalView = this.entries.get(id)?.view
    if (this.entries.get(id)?.releaseAttempt?.pending) await this.prepareForConsumption(id)
    if (originalView && this.entries.get(id)?.view !== originalView) throw new Error('Browser native page changed during release. Refresh this original Browser snapshot before running the program; it has not been dispatched.')
    const entry = this.require(id)
    // Capture releases its native/CDP owner before its first await. Durable draft writes do not gate a healthy run.
    void this.releaseDemonstrationCapture(entry)
    if (entry.humanControl) {
      // 带类型化的码，不是一句散文：调用方要能把「人在用这一页」与「出故障了」分开，并且知道恢复
      // 动作是**人明确交还控制**，不是重试。裸 Error 会让两者在机读侧长得一模一样。
      throw Object.assign(
        new Error('Human control is still active for this Browser. Explicitly return control before running another Agent program.'),
        { code: 'BROWSER_HUMAN_CONTROL_ACTIVE' satisfies AgentMuxControlErrorCode }
      )
    }
    if (entry.runInFlight || entry.activeRun) {
      throw new Error('Another Browser operation is already running. Wait for it to finish or stop it before starting another program.')
    }
    entry.runInFlight = true
    const admittedControlRevision = entry.controlRevision
    // attach 抛是**常规路径**，不是意外：用户开着 DevTools 就必然抛（见 browser-cdp-session.ts）。
    // 所以这个 flag 的复位不能只挂在成功之后——attach 在 try 外面抛一次，flag 就永久卡住，
    // 此后每次 run 都报"另一个操作正在运行"，而 `activeRun` 是空的、连能停的东西都没有，
    // 只有销毁重建这个 view 才能恢复。失败自己是可恢复的，别把它变成不可恢复的。
    const runView = entry.view
    let session: BrowserCdpSession
    try {
      session = BrowserCdpSession.attach(runView.webContents)
      this.markResourceRisk(entry, runView, 'document-used')
    } catch (error) {
      entry.runInFlight = false
      throw error
    }
    // 本轮自愈过的 ref 都记在这里。自愈按外观匹配，可能落在一个长得一样的**另一个**元素上，
    // 所以它不能只活在主进程的日志里——必须跟着结局回到 Agent 手上。
    const notes: string[] = []
    const stopController = new AbortController()
    let stopRequested = false
    const localOperation: BrowserOperation = {
      // 非空白 id 保留原值；缺席或全空白才由 journal 的 `start` 唯一铸造。
      // 这里不写 `?? mintObjectId()`：那会是第二个铸造点，而它造出来的 id 与 journal 记下的那个可能
      // 不是同一个——查询按一个、记录按另一个，两边各自看起来都正常。
      //
      // 没有 journal 时（只在测试里）这个分支要给一个值才能构成 BrowserOperation，所以用空串占位，
      // 由下面 `operation = ... : localOperation` 那条路承担。空串不会被当成合法 id：journal 的
      // `start` 对空串判为空白，正是靠这个落回铸造点。
      id: operationId ?? '',
      browserId: id,
      operator: operator ?? { id: 'agent:unknown', name: 'Agent' },
      startedAt: Date.now(),
      phase: 'preparing',
      summary: 'Preparing browser program',
      url: entry.requestedUrl,
      steps: [],
      ...(replayOf ? { replayOf } : {})
    }
    let operation: BrowserOperation
    try {
      operation = this.operationJournal
        ? await this.operationJournal.start({
            ...(localOperation.id ? { id: localOperation.id } : {}),
            browserId: id,
            operator: localOperation.operator,
            summary: localOperation.summary,
            url: localOperation.url,
            ...(localOperation.replayOf ? { replayOf: localOperation.replayOf } : {})
          })
        : localOperation
    } catch (error) {
      entry.runInFlight = false
      const cleanupWarning = session.detach()
      if (cleanupWarning) {
        entry.activity = { ...entry.activity, warning: [entry.activity.warning, cleanupWarning].filter(Boolean).join(' ') }
        const failure = error instanceof Error ? error : new Error(String(error))
        failure.message += ` ${cleanupWarning}`
        // A failed warning projection must not replace the original typed refusal.
        try { this.emit(entry) } catch { /* The refusal still carries the actual cleanup warning. */ }
        throw failure
      }
      throw error
    }
    // A human handoff can arrive while the original journal start is awaiting IO,
    // before activeRun exists. Return cannot revive that already-fenced request.
    if (!this.owns(entry, runView) || entry.controlRevision !== admittedControlRevision) {
      operation.phase = 'stopped'
      operation.summary = 'Browser control changed before program dispatch'
      operation.finishedAt = Date.now()
      operation.warning = 'The original program was stopped before dispatch. Returning control does not resume it; inspect the page before submitting a fresh program.'
      const cleanupWarning = session.detach()
      if (cleanupWarning) operation.warning += ` ${cleanupWarning}`
      entry.runInFlight = false
      operation.control = this.owns(entry, runView) ? this.controlState(entry) : {
        owner: 'unknown', activeOperationId: null, revision: entry.controlRevision, inputIsolation: 'unconfirmed'
      }
      await this.operationJournal?.finish(operation.id, 'stopped', { summary: operation.summary, warning: operation.warning })
      return { result: undefined, logs: [], outcome: { kind: 'stopped', message: operation.warning }, runOperation: operation }
    }
    if (caller) {
      let agent: AgentMuxBrowserControl['agent']
      try { agent = this.agents?.resolve(caller.agentSessionId) } catch { /* Optional actor observation cannot stop the accepted program. */ }
      if (agent) { entry.agent = agent; entry.agentWarning = undefined }
      else {
        // A Core observation gap cannot revoke an existing confirmed relationship. For a fresh
        // page this actor is unknown, rather than proof that no Agent is associated.
        if (!entry.agent) entry.agent = undefined
        entry.agentWarning = 'This Browser program’s Agent identity could not be confirmed from its original Core owner. The page and any confirmed Browser Agent association are retained; reconnect that owner to confirm the actor.'
      }
    }
    entry.activity = { operation, control: 'agent', ...(operation.warning ? { warning: operation.warning } : {}) }
    const previousFeedback = entry.feedback
    const feedbackView = entry.view
    const feedback: BrowserOperationFeedback = showBrowserOperationFeedback({ contents: feedbackView.webContents, operationId: operation.id,
      navigationId: () => entry.navigationId, operatorName: operation.operator.name,
      preferences: this.feedbackPreferences,
      nextRevision: () => ++entry.feedbackRevision,
      isCurrent: () => this.entries.get(entry.id) === entry && entry.view === feedbackView && entry.visible &&
        entry.feedback === feedback && this.agentOwnsInput(entry) && !feedbackView.webContents.isDestroyed(),
      warn: () => {
        if (this.entries.get(entry.id) !== entry || entry.view !== feedbackView || entry.activity.operation?.id !== operation.id) return
        const warning = 'Browser action feedback could not be displayed. The page and Agent remain usable; inspect the activity and run another action to retry the visual feedback.'
        operation.warning ??= warning
        entry.activity = { ...entry.activity, warning: entry.activity.warning ?? warning }
        this.emit(entry)
      } })
    entry.feedback = feedback
    entry.driving = true
    ++entry.controlRevision
    entry.inputIsolation = 'preparing'
    entry.activeRun = {
      operationId: operation.id,
      signal: stopController.signal,
      stop: () => {
        if (stopRequested) return
        stopRequested = true
        ++entry.controlRevision
        entry.driving = false
        operation.phase = 'stopped'
        operation.summary = 'Browser operation stopped explicitly'
        operation.finishedAt = Date.now()
        operation.warning = 'The Browser operation was stopped explicitly. Earlier actions may have completed. Agent control remains; review the page before starting a fresh program, or use Take control to interact manually.'
        entry.activity = { operation, control: entry.activity.control, warning: [entry.activity.warning, operation.warning].filter(Boolean).join('\n') }
        stopController.abort()
        void this.operationJournal?.setPhase(operation.id, 'stopped', { summary: operation.summary, warning: operation.warning })
        this.emit(entry)
      }
    }
    try {
      this.emit(entry)
      await this.prepareInputShield(entry, runView)
      await previousFeedback?.hide('replace')
      await onOperationStarted?.(operation)
      if (!stopRequested) {
        operation.phase = 'running'
        operation.summary = 'Agent is operating the Browser'
        void this.operationJournal?.setPhase(operation.id, 'running', { summary: operation.summary })
        // 翻转必须各带一次 emit，否则这一位只有主进程自己知道，标签上的标记永远不动。开始与结束
        // 两处都要——只推开始的话，标记会一直停在"正在驱动"上，那比不画更糟。
        this.emit(entry)
      }
      if (stopRequested) return {
        result: undefined, logs: [], outcome: { kind: 'stopped', message: operation.warning! }, runOperation: operation
      }
      const deadlineMillis = Math.min(performance.now() + 30_000, taskPage?.cursor.deadlineMillis ?? Infinity)
      const remainingMillis = Math.floor(deadlineMillis - performance.now())
      if (!Number.isFinite(remainingMillis) || remainingMillis <= 0) throw new Error('Task execution budget reached before script dispatch. Existing progress remains; the step was not replayed.')
      const run = await runBrowserScript({ code, signal: stopController.signal,
        timeoutMs: remainingMillis,
        onPageCall: this.pageCallHandler(entry, runView, session, notes, operation, privateTaskParameters, stopController.signal, taskPage, deadlineMillis),
        ...(this.resultArtifacts ? { captureResultArtifact: async (sourcePath: string) => {
          if (!this.owns(entry, feedbackView) || entry.activeRun?.operationId !== operation.id || stopController.signal.aborted) throw new Error('The original Browser operation changed before retaining its result.')
          const context: BrowserResultContext = { workspaceId: entry.workspaceId, browserId: entry.id, operationId: operation.id, navigationId: entry.navigationId }
          return await this.resultArtifacts!.import(context, sourcePath)
        } } : {})
      })
      // 会话中途没了，**压过程序自己的结局**。这一条是承重的：Agent 的程序里一个
      // `try { await click(ref) } catch {}` 完全是正常写法，而那个 catch 会把"会话没了"
      // 吞掉，程序照常 return——于是一次不知道点没点成的运行被报成 completed，
      // 而 `completed` 连个放警告的字段都没有。判在这一层，程序catch 不catch 都盖不住。
      const ended = session.endedReason
      if (stopRequested) {
        operation.phase = 'stopped'
        operation.summary = 'Browser operation stopped explicitly'
        operation.finishedAt = operation.finishedAt ?? Date.now()
        operation.warning = operation.warning ?? 'The Browser operation was stopped explicitly. Earlier actions may have completed. Review the current page before starting a fresh program.'
        entry.activity = { operation, control: entry.humanControl ? 'human' : 'agent', warning: entry.activity.warning ?? operation.warning }
        return {
          result: undefined,
          logs: run.logs,
          outcome: { kind: 'stopped', message: operation.warning },
          runOperation: operation
        }
      }
      if (ended !== null) {
        operation.phase = 'indeterminate'
        operation.summary = 'Browser session ended before the result was known'
        operation.finishedAt = Date.now()
        operation.warning = String(ended)
        entry.activity = { operation, control: 'agent', warning: operation.warning }
        return {
          result: undefined,
          logs: run.logs,
          outcome: {
            kind: 'indeterminate',
            message:
              `The debugging session ended mid-run (${ended}) — opening DevTools on the page does that. ` +
              'An action may have half-completed. Look at the page before running anything again.'
          },
          runOperation: operation
        }
      }
      // 回放命中的目标是**按外观**认回来的，和 ref 自愈是同一件事，所以走同一个出口。
      //
      // 计划里存下来的身份只有 role+name+ordinal+count——快照本身就不含更稳的东西
      // （backendNodeId 随 CDP 会话消亡，见 browser-ref-ledger.ts）。
      //
      // **只有同名元素多于一个时才降级**，这条边界是承重的：`count === 1` 时那个总数判据恰恰
      // 证明了不存在第二个同名元素可以认错，此时它和按身份命中一样确定，报 `completed` 是诚实的。
      // 而 `count > 1` 时闸门挡不住一类很常见的页面变化：列表里多一行、少一行，总数仍是 3、
      // 序号仍是 2，闸门放行，点下去的却是**另一个** Delete。browser-ref-resolve.ts 刻意不做
      // role/name 回退，理由正是"它会静默改打一个同名元素，还照常报成功"——回放不能自己破那条规矩。
      //
      // 挡不住就不许装作挡住了：降级成 `indeterminate`（先看一眼页面，别盲目重试），返回值照带。
      // 反过来，把 `count === 1` 也一律降级，等于每一次回放都喊一声狼来了——那种警告会被学会忽略，
      // 于是真正该看的那一次也没人看（AGENTS.md:32-52 要的是可分辨，不是一律保守）。
      //
      // **判在 `run.completed` 分叉之前**，与上面接管那一支同理（见那段注释「两条路必须汇到同一个
      // 结局」）。写在 completed 臂里只能盖住「一路顺到底」的那次；而「按外观点下去了、后面某步
      // 才抛」的那次 `completed` 为 false，整份 notes 会被静默丢掉，收据报 `script-failed`——
      // 那句话对 Agent 的意思是"你代码写错了，改完重跑"，可此刻真实状态是**一个可能打在另一个
      // 同名元素上的破坏性动作已经执行了**。照着 script-failed 整段重跑，那个动作就再来一次，
      // 正是本文件反复点名的「下单点两次」。做没做成不确定，就得说不确定。
      if (replayOf && operation.steps.some((step) => step.target && step.target.count > 1)) {
        notes.push(
          'This run replayed recorded steps onto elements that share their role and name with ' +
            'others on the page. Replay re-finds those targets by name and position in a fresh ' +
            'snapshot — a match by appearance, not identity — so a page whose contents shifted can ' +
            'put the action on a different element of the same name. Look at the page before ' +
            'treating this as done.'
        )
      }
      if (run.completed) {
        // 自愈过就不是 `completed`。程序确实跑完了，但**它作用在什么上不确定**——role+name+nth
        // 能匹配到一个长得一样的邻居。这正是 `indeterminate` 的含义（先看一眼页面，别盲目重试），
        // 也是 `completed` 这一支承载不了的：它连一个放警告的字段都没有。返回值照常带回去——
        // 那是程序真算出来的东西，丢掉它只会逼 Agent 再跑一遍。
        if (notes.length > 0) {
          operation.phase = 'indeterminate'
          operation.summary = replayOf ? 'Replay completed by appearance match' : 'Completed with semantic ref healing'
          operation.finishedAt = Date.now()
          operation.warning = notes.join('\n')
          entry.activity = { operation, control: 'agent', warning: operation.warning }
          return {
            result: run.value,
            logs: run.logs,
            outcome: { kind: 'indeterminate', message: notes.join('\n') },
            runOperation: operation
          }
        }
        operation.phase = 'completed'
        operation.summary = 'Browser program completed'
        operation.finishedAt = Date.now()
        entry.activity = { operation, control: 'agent', ...(operation.warning ? { warning: operation.warning } : {}) }
        return { result: run.value, logs: run.logs, outcome: { kind: 'completed' }, runOperation: operation }
      }
      const failureOutcome = browserRunOutcomeFromFailure(run.failure)
      const outcome = privateTaskParameters && 'message' in failureOutcome
        ? { ...failureOutcome, message: `Browser task ${run.failure.kind} did not report completion. Raw error text is withheld because this invocation contains private parameters. Inspect the page before retrying.` }
        : failureOutcome
      // 结局四支 → phase 四支，**逐支对上**。原来写的是 `stopped ? stopped : failed`，于是
      // `indeterminate` 被折进 `failed`：同一次崩溃，Agent 收到的收据说"做到哪一步不知道，先看
      // 一眼页面别重试"，而人在历史里看到的是"失败了，改完重跑"——两个相反的结论。phase 枚举里
      // 本来就有 `indeterminate`，这不是缺词，是映射错了。崩溃恰恰意味着页面动作可能做了一半。
      //
      // 但**这一支自己算出来的结局还不够**：程序抛之前可能已经按外观点下去了（自愈、或回放打在
      // 同名元素上），那些告示就在 `notes` 里。一个"已经可能打错了对象"的运行报 `script-failed`
      // 等于叫 Agent 改代码整段重跑，而重跑会把那个动作再做一次。有告示就以 `indeterminate`
      // 收口，并且**把程序自己的失败原因一起带上**——那是排障的入口，不能被告示挤掉。
      if (notes.length > 0) {
        const failureReason = 'message' in outcome ? outcome.message : 'The Browser program failed.'
        operation.phase = 'indeterminate'
        operation.summary = replayOf ? 'Replay stopped after an appearance match' : 'Stopped after semantic ref healing'
        operation.finishedAt = Date.now()
        operation.warning = [...notes, failureReason].join('\n')
        entry.activity = { operation, control: 'agent', warning: operation.warning }
        return {
          result: undefined,
          logs: run.logs,
          outcome: { kind: 'indeterminate', message: operation.warning },
          runOperation: operation
        }
      }
      operation.phase = browserOperationPhaseFromOutcome(outcome.kind)
      operation.summary = 'message' in outcome ? outcome.message : 'Browser program failed'
      operation.finishedAt = Date.now()
      if ('message' in outcome) operation.warning = outcome.message
      entry.activity = { operation, control: 'agent', ...('message' in outcome ? { warning: outcome.message } : {}) }
      return { result: undefined, logs: run.logs, outcome, runOperation: operation }
    } finally {
      stopController.abort()
      // Execution ends independently of Browser ownership. Only an explicit human
      // handoff releases the page's input shield and ownership decoration.
      entry.driving = false
      if (entry.activeRun?.operationId === operation.id) { entry.activeRun = undefined; ++entry.controlRevision }
      // The original source can end before the live target is projected again.
      // Its returned operation still reports the final dispatch/control facts.
      operation.control = this.controlState(entry)
      await feedback.end(operation.phase === 'completed')
      const cleanupWarning = session.detach()
      if (cleanupWarning) {
        operation.warning ??= cleanupWarning
        entry.activity = { ...entry.activity, warning: entry.activity.warning ?? cleanupWarning }
      }
      entry.runInFlight = false
      if (this.operationJournal) {
        this.projectInputIsolationNotice(entry)
        const finalPhase = operation.phase === 'completed' || operation.phase === 'failed' || operation.phase === 'indeterminate' || operation.phase === 'stopped'
          ? operation.phase
          : 'indeterminate'
        await this.operationJournal.finish(operation.id, finalPhase, {
          summary: operation.summary,
          ...(operation.warning ? { warning: operation.warning } : {})
        })
        const persistenceWarning = this.operationJournal.getPersistenceWarning()
        if (persistenceWarning) {
          operation.warning ??= persistenceWarning
          entry.activity = { ...entry.activity, warning: entry.activity.warning ?? persistenceWarning }
        }
      }
      this.emit(entry)
    }
  }

  async startDemonstration(id: string): Promise<BrowserDemonstrationState> {
    const entry = this.require(id)
    if (!this.demonstrations) throw new Error('Demonstration storage is unavailable. The Browser remains usable.')
    if (entry.runInFlight || entry.activeRun) throw new Error('Stop the active Browser operation before recording a human demonstration.')
    void this.releaseDemonstrationCapture()
    const view = entry.view
    const contents = view.webContents
    const current = {
      entry, view, contents,
      capture: new BrowserDemonstrationCapture({
        contents, browserId: id, recorder: this.demonstrations,
        getIdentity: () => ({ navigationId: entry.navigationId, url: contents.getURL() || entry.requestedUrl, title: contents.getTitle() }),
        onDraft: (draft, warning) => {
          if (this.demonstrationCapture !== current || !this.owns(entry, view) || contents.isDestroyed()) return
          this.publishDemonstration(entry, draft, warning)
          if (draft && draft.status !== 'recording') this.demonstrationCapture = null
        }
      })
    }
    this.demonstrationCapture = current
    try {
      await this.waitForInitialDocument(entry, view)
      if (this.demonstrationCapture !== current || entry.runInFlight || entry.activeRun) throw new Error('Recording no longer owns this Browser. The current Browser operation remains available.')
      const draft = await current.capture.start()
      if (this.demonstrationCapture !== current || !this.owns(entry, view) || contents.isDestroyed()) {
        throw new Error('Recording no longer owns this Browser. The current Browser operation remains available.')
      }
      if (entry.demonstration?.draft?.id !== draft.id) this.publishDemonstration(entry, draft)
      return structuredClone(entry.demonstration!)
    } catch (error) {
      if (this.demonstrationCapture === current) void this.releaseDemonstrationCapture(entry)
      throw error
    }
  }

  async stopDemonstration(id: string): Promise<BrowserDemonstrationState> {
    const entry = this.require(id)
    const view = entry.view
    if (!this.demonstrations) throw new Error('Demonstration storage is unavailable. The Browser remains usable.')
    const stopped = this.releaseDemonstrationCapture(entry)
    const draft = stopped ? await stopped : await this.demonstrations.stop(id)
    if (this.owns(entry, view) && this.demonstrationCapture?.entry !== entry) this.publishDemonstration(entry, draft)
    return structuredClone(entry.demonstration ?? { draft })
  }

  async getDemonstration(id: string): Promise<BrowserDemonstrationState> {
    const entry = this.require(id)
    const view = entry.view
    if (!this.demonstrations) return { draft: null, warning: 'Demonstration storage is unavailable. The Browser remains usable.' }
    const draft = await this.demonstrations.get(id)
    if (this.owns(entry, view) && this.demonstrationCapture?.entry !== entry) this.publishDemonstration(entry, draft)
    return structuredClone(entry.demonstration ?? { draft })
  }

  private publishDemonstration(entry: BrowserEntry, draft: BrowserDemonstrationDraft | null, warning?: string): void {
    if (draft && entry.demonstration?.draft?.id === draft.id && entry.demonstration.draft.revision > draft.revision) return
    const notice = warning ?? this.demonstrations?.getPersistenceWarning() ?? draft?.warning
    entry.demonstrationInterpreter ??= new BrowserDemonstrationInterpreter(suggestions => {
      if (this.entries.get(entry.id) !== entry || !entry.demonstration) return
      entry.demonstration = { ...entry.demonstration, suggestions }
      this.emit(entry)
    })
    const suggestions = entry.demonstrationInterpreter.update(draft)
    entry.demonstration = { draft, suggestions, ...(notice ? { warning: notice } : {}) }
    this.emit(entry)
  }

  /** The native owner is released synchronously; saving the stopped draft completes in the background. */
  private releaseDemonstrationCapture(entry?: BrowserEntry): Promise<BrowserDemonstrationDraft | null> | null {
    const current = this.demonstrationCapture
    if (!current || (entry && current.entry !== entry)) return null
    this.demonstrationCapture = null
    if (!current.contents.isDestroyed() && current.entry.demonstration?.draft?.status === 'recording') {
      this.publishDemonstration(current.entry, { ...current.entry.demonstration.draft, status: 'stopped' })
    }
    return current.capture.stop().then(draft => {
      if (this.owns(current.entry, current.view) && !current.contents.isDestroyed() && this.demonstrationCapture?.entry !== current.entry) {
        this.publishDemonstration(current.entry, draft)
      }
      return draft
    }).catch(() => {
      if (this.owns(current.entry, current.view) && !current.contents.isDestroyed() && this.demonstrationCapture?.entry !== current.entry) {
        this.publishDemonstration(current.entry, current.entry.demonstration?.draft ?? null,
          'The demonstration stopped, but saving the draft could not be confirmed. The Browser remains usable; check local storage before recording again.')
      }
      return null
    })
  }

  async listOperationHistory(): Promise<BrowserOperation[]> {
    return this.operationJournal ? await this.operationJournal.list() : []
  }

  async runReplay(id: string, plan: BrowserReplayPlan, operator?: BrowserOperator, caller?: Pick<import('@agentmux/core').AgentMuxControlCaller, 'agentSessionId'>): Promise<BrowserScriptRunReport> {
    if (plan.schema !== 'agentmux.browser-replay.v1' || !plan.operationId || !Array.isArray(plan.steps)) {
      throw new Error('Invalid Browser replay plan')
    }
    if (this.operationJournal) {
      // The caller may select a single step, but cannot hide missing original facts or an unknown outcome.
      const original = await this.operationJournal.get(plan.operationId)
      if (!original) throw new Error('The original Browser operation is unavailable. No replay was started; inspect its history before planning another action.')
      const recordedPlan = await this.operationJournal.replayPlan(plan.operationId)
      if (['preparing', 'running', 'waiting', 'human', 'indeterminate', 'stopped'].includes(original.phase)) {
        throw new Error('The original Browser operation is stopped or its result is unconfirmed. No replay was started; inspect the original page before planning another action.')
      }
      // A selected or edited contribution cannot erase a barrier in its original operation.
      const originalBlocked = recordedPlan?.steps.find(step => step.blockedReason)
      if (originalBlocked?.blockedReason) {
        throw new Error(`The original Browser operation requires review before any replay: ${originalBlocked.blockedReason}`)
      }
    }
    const blocked = plan.steps.find((step) => step.blockedReason)
    if (blocked?.blockedReason) {
      throw new Error(`Replay requires review before any action: ${blocked.blockedReason}`)
    }
    const script = buildReplayScript(plan)
    return await this.runScript(id, script, operator, plan.operationId, undefined, undefined, false, undefined, caller)
  }

  /**
   * 按 operationId 停一个操作，**与它跑在哪个 Browser 上无关**。这是取消的唯一入口。
   *
   * 这里曾经还有一条 `stopOperation(id)`（按 browserId 停「这一页上正在跑的那个」），服务 UI 上的
   * 停止按钮。T-008 把那颗按钮收口到协议之后它没有调用方了，于是删掉——两条寻址落在同一个
   * `activeRun.stop` 上，留着第二条只是给「哪一条才是真的」留一个将来会漂移的问题。
   *
   * 三种答案都是成功，一个都不抛：
   *   - 还在飞 → 停下它，答出刚被改成 `stopped` 的那份事实。
   *   - 已经结束 → 幂等成功，答出它的既有终局。正常时序下取消总会撞上刚结束的操作（人按下停止的
   *     同一刻程序自己跑完了），把这个竞态报成失败等于让调用方分不出「我停晚了」和「出错了」。
   *   - 查不到 → `null`。RED-LINES 第 2 类：我们查不到 ≠ 这个 Browser 坏了。所以这条路**不碰任何
   *     entry 的状态**——尤其不清 activeRun，那会让一次查询失败变成一次真实的能力损失。
   */
  async stopOperationById(operationId: string): Promise<BrowserOperation | null> {
    for (const entry of this.entries.values()) {
      if (entry.activeRun?.operationId !== operationId) continue
      entry.activeRun.stop()
      // `stop()` 刚改的就是 `entry.activity.operation` 指的那个对象（runScript 里同一个引用），
      // 所以这里读到的是最新的一份，不必等 stop 里那条 fire-and-forget 的 journal 写落盘。
      const stopped = entry.activity.operation
      if (stopped?.id === operationId) return { ...stopped, control: this.controlState(entry) }
      break
    }
    // 不在飞：已结束或本就不认识。两者的答案都从 journal 来——不在这里维护第二份账。
    return await this.getOperation(operationId)
  }

  /**
   * 按 operationId 查一条操作。答案覆盖在跑、completed、stopped 与重启后被判为 indeterminate 四档，
   * 因为它读的就是 journal 本身（`ready()` 在重载时把活着的操作转成 indeterminate），不是第二份投影。
   *
   * journal 缺席或读坏了都属于流程状态，不是 Browser 坏了：答「查不到」，这个 Browser 照样能接新操作。
   * journal 本来就是 advisory 的。
   */
  async getOperation(operationId: string): Promise<BrowserOperation | null> {
    const operation = this.operationJournal ? await this.operationJournal.get(operationId) : null
    if (!operation) return null
    const entry = this.entries.get(operation.browserId)
    return entry?.activity.operation?.id === operation.id ? { ...operation,
      ...(entry.activity.operation.warning ? { warning: entry.activity.operation.warning } : {}),
      control: this.controlState(entry) } : operation
  }

  async getStepEvidence(operationId: string, sequence: number): Promise<BrowserStepEvidenceRead> {
    const operation = await this.getOperation(operationId)
    const step = operation?.steps.find(item => item.sequence === sequence)
    const result: BrowserStepEvidenceRead = { operationId, sequence, status: 'not-recorded', items: [] }
    if (!step) return { ...result, status: 'unavailable', warning: 'This operation step is no longer retained. Its page was not recaptured.' }
    if (step.evidenceWarning) result.warning = step.evidenceWarning
    if (!step.evidence?.length) return { ...result, ...(step.evidenceWarning ? { status: 'unavailable' as const } : {}) }
    for (const reference of step.evidence) {
      try {
        if (!this.stepEvidence || reference.operationId !== operationId || reference.sequence !== sequence ||
            reference.browserId !== operation?.browserId) throw new Error('Evidence identity is unavailable.')
        result.items.push(await this.stepEvidence.read(reference))
      } catch {
        result.warning = 'Some recorded evidence is unavailable or no longer retained. The step record remains; inspect the page before retrying an action.'
      }
    }
    result.status = result.items.length ? 'available' : 'unavailable'
    return result
  }

  /** Read only the result actually joined to this Main-recorded extraction step. No page is rerun. */
  async readStepResult(operationId: string, sequence: number, options?: BrowserResultReadOptions): Promise<BrowserResultArtifactChunk> {
    const operation = await this.getOperation(operationId)
    const step = operation?.steps.find(item => item.sequence === sequence)
    if (!operation || step?.method !== 'extractStructured' || !this.resultArtifacts) {
      throw new Error('This step has no retained structured result.')
    }
    const evidence = await this.getStepEvidence(operationId, sequence)
    const item = evidence.items.find(value => value.content.kind === 'structured-output')
    if (!item || item.content.kind !== 'structured-output') throw new Error('The recorded structured result is unavailable.')
    const { source, artifact, artifactStatus } = item.content.receipt
    const entry = this.require(operation.browserId)
    if (artifactStatus !== 'available' || !artifact || source.operationId !== operationId ||
        source.browserId !== operation.browserId || source.workspaceId !== entry.workspaceId ||
        source.navigationId !== item.reference.navigationId || artifact.operationId !== source.operationId ||
        artifact.browserId !== source.browserId || artifact.workspaceId !== source.workspaceId ||
        artifact.navigationId !== source.navigationId) throw new Error('The result does not belong to this recorded extraction.')
    return await this.resultArtifacts.read(artifact, { workspaceId: entry.workspaceId, browserId: entry.id }, options)
  }

  /** Main registers a finite condition before its sole, read-only extraction producer. */
  async checkOutcomeFields(id: string, input: BrowserOutcomeFieldRunInput, intent: 'human' | 'control' = 'control'): Promise<BrowserOutcomeEvaluation> {
    const entry = this.require(id)
    const view = entry.view
    const controlRevision = entry.controlRevision
    await this.waitForInitialDocument(entry, view)
    const navigationId = entry.navigationId
    const request = parseBrowserStructuredOutputRequest(input.request)
    const criteria = parseBrowserOutcomeCriteriaRequest({ criteria: input.criteria }).criteria
    if (criteria.some(c => c.kind !== 'field-equals' || !request.fields.some(f => f.key === c.key && f.type === typeof c.expected))) {
      throw new Error('Declare field conditions with the exact requested type.')
    }
    let registration: BrowserOutcomeRegistration | undefined
    let registrationSaved = false
    if (intent === 'human') {
      if (!this.owns(entry, view) || entry.controlRevision !== controlRevision) throw Object.assign(new Error('Browser control changed while the field check was preparing. The original page is kept; start a fresh check explicitly.'), { code: 'CONTROL_REQUEST_CONFLICT' })
      this.applyAgentControl(entry)
    }
    const report = await this.runScript(id, `return await extractStructured(${JSON.stringify(request)})`,
      { id: 'user:outcome-check', name: 'Field verification' }, undefined, undefined, async operation => {
        registration = { context: { workspaceId: entry.workspaceId, browserId: id, operationId: operation.id, navigationId },
          criteria: criteria.map(c => ({ ...c as Extract<typeof c, { kind: 'field-equals' }>,
            producer: { operationId: operation.id, navigationId, sequence: 1, request } })) }
        const registered = await this.operationJournal?.registerOutcome(operation.id, registration)
        if (!registered) throw new Error('The completion declaration was not accepted within the registration budget. No observation was performed; the Browser remains usable.')
        if (registered?.operation.outcome) { operation.outcome = registered.operation.outcome; registrationSaved = registered.saved }
      })
    if (!registration) throw new Error('The verification producer was not registered. The Browser remains usable.')
    return await this.evaluateOutcome(entry, view, registration, report.runOperation.id, registrationSaved)
  }

  /** Reads retained facts; verification never reruns extraction, clicks or file triggers. */
  async verifyOutcome(id: string, operationId: string): Promise<BrowserOutcomeEvaluation> {
    const entry = this.require(id)
    const operation = await this.getOperation(operationId)
    if (operation?.browserId !== id || !operation.outcome) throw new Error('This Browser operation has no registered completion conditions.')
    return await this.evaluateOutcome(entry, entry.view, operation.outcome.registration, operationId, true)
  }

  private async evaluateOutcome(entry: BrowserEntry, view: WebContentsView,
    registration: BrowserOutcomeRegistration, operationId: string, registrationSaved: boolean): Promise<BrowserOutcomeEvaluation> {
    const current = async () => {
      if (!this.owns(entry, view) || view.webContents.isDestroyed()) {
        throw new Error('The registered execution no longer owns this Browser.')
      }
      if (registration.assetRun) {
        const run = await this.taskAssets?.currentRun(entry.id)
        if (!this.owns(entry, view) || view.webContents.isDestroyed()) throw new Error('The original Browser owner changed while reading its asset facts.')
        if (!run || run.completionWarning || run.id !== registration.assetRun.runId || run.assetId !== registration.assetRun.assetId ||
            run.version !== registration.assetRun.version || !run.operationIds.includes(operationId) ||
            (entry.activity.operation && !run.operationIds.includes(entry.activity.operation.id))) throw new Error('The actual asset execution changed.')
        return { workspaceId: entry.workspaceId, browserId: entry.id, navigationId: entry.navigationId,
          assetRun: { runId: run.id, assetId: run.assetId, version: run.version, operationIds: run.operationIds } }
      }
      if (entry.activity.operation?.id !== operationId) throw new Error('The registered execution no longer owns this Browser.')
      return { workspaceId: entry.workspaceId, browserId: entry.id, navigationId: entry.navigationId, assetRun: null }
    }
    const unavailable = (): BrowserOutcomeEvaluation => ({ context: registration.context, ...(registration.assetRun ? { assetRun: registration.assetRun } : {}), status: 'unavailable',
      conditions: registration.criteria.map(c => ({ criterion: c.kind === 'field-equals'
        ? { kind: c.kind, key: c.key, expected: c.expected } : c.kind === 'download-readable'
          ? { kind: c.kind, path: c.path } : { kind: c.kind, checkpointId: c.checkpointId },
        status: 'unavailable', reason: 'The original registration could not be saved. Existing work remains; restore local storage before verifying again.' })) })
    const evaluation = !this.operationJournal || !registrationSaved ? unavailable()
      : await evaluateBrowserOutcomeCriteria(registration, {
        current, getOperation: id => this.getOperation(id),
        getStepEvidence: (id, sequence) => this.getStepEvidence(id, sequence),
        readStepResult: (id, sequence, options) => this.readStepResult(id, sequence, options),
        getDownloads: async () => {
          if (!this.downloads) throw new Error('Download facts are unavailable.')
          return await this.downloads.list({ workspaceId: entry.workspaceId, browserId: entry.id })
        },
        readDownload: async (reference, options) => {
          if (!this.downloads) throw new Error('Download files are unavailable.')
          return await this.downloads.read(reference, { workspaceId: entry.workspaceId, browserId: entry.id }, options)
        },
        getHumanCheckpoint: async (tuple, checkpointId) => {
          if (!this.taskAssets) throw new Error('Task facts are unavailable.')
          const read = await this.taskAssets.readExactFact({ ...tuple, browserId: entry.id }, checkpointId)
          if (read.status === 'unavailable') throw new Error(read.warning)
          return read.status === 'available' ? read.fact : null
        },
        isStructuredSourceCurrent: async source => {
          await current()
          if (source.navigationId !== entry.navigationId || source.scope.withinRef) return false
          const session = BrowserCdpSession.attach(view.webContents)
          try {
            const target = await resolveBrowserStructuredTarget(session.sendCommand, source.scope.within ? { within: source.scope.within } : {})
            try { const valid = target.document === source.document && await target.isCurrent(); await current(); return valid }
            finally { await target.release() }
          } finally { session.detach() }
        }
      })
    const recorded = await this.operationJournal?.recordOutcome(operationId, evaluation)
    const projected = recorded?.operation.outcome?.evaluation ?? evaluation
    if (recorded?.operation.outcome && this.owns(entry, view) && entry.activity.operation?.id === operationId) {
      entry.activity.operation.outcome = recorded.operation.outcome
      if (projected.warning) this.addCurrentOperationWarning(entry, view, entry.activity.operation, projected.warning)
      this.emit(entry)
    }
    return projected
  }

  async getTaskAssets(id: string): Promise<BrowserTaskAssetState> {
    const entry = this.require(id)
    const view = entry.view
    if (!this.taskAssets) return { assets: [], runs: [], warning: 'Task asset storage is unavailable. The Browser remains usable.' }
    try {
      const state = await this.taskAssets.state(id)
      if (this.owns(entry, view) && !view.webContents.isDestroyed()) { entry.taskAssets = state; this.emit(entry) }
      return state
    } catch {
      const state: BrowserTaskAssetState = { assets: entry.taskAssets?.assets ?? [], runs: entry.taskAssets?.runs ?? [], batches: entry.taskAssets?.batches ?? [],
        selectedRunId: entry.taskAssets?.selectedRunId ?? null,
        warning: 'Saved task assets could not be read. Existing Browser work remains; reopen the details to retry.' }
      if (this.owns(entry, view) && !view.webContents.isDestroyed()) { entry.taskAssets = state; this.emit(entry) }
      return state
    }
  }

  private async requireTaskAsset(id: string, assetId: string): Promise<BrowserTaskAsset> {
    this.require(id)
    if (!this.taskAssets) throw new Error('Task asset storage is unavailable. The Browser remains usable.')
    const asset = await this.taskAssets.get(assetId)
    if (!asset || asset.browserId !== id) throw new Error('This task asset does not belong to the Browser.')
    return asset
  }

  async importTaskAsset(id: string, name?: string): Promise<BrowserTaskAsset> {
    this.require(id)
    if (!this.taskAssets || !this.demonstrations) throw new Error('Saved demonstrations and task asset storage are required.')
    const draft = await this.demonstrations.get(id)
    if (!draft || draft.browserId !== id || draft.status === 'recording') throw new Error('Stop a real demonstration before importing it.')
    return await this.taskAssets.importRecording(draft, name)
  }

  async saveTaskAssetDraft(id: string, assetId: string, expectedRevision: number, content: BrowserTaskContent): Promise<BrowserTaskAsset> {
    await this.requireTaskAsset(id, assetId)
    return await this.taskAssets!.edit(assetId, expectedRevision, content)
  }

  async saveTaskAssetVersion(id: string, assetId: string, expectedRevision: number, content: BrowserTaskContent): Promise<BrowserTaskAsset> {
    const updated = await this.saveTaskAssetDraft(id, assetId, expectedRevision, content)
    return await this.taskAssets!.saveVersion(assetId, updated.revision)
  }

  async locateTaskAssetStep(id: string, assetId: string, expectedRevision: number, stepId: string): Promise<BrowserTaskAsset> {
    const asset = await this.requireTaskAsset(id, assetId)
    const entry = this.require(id)
    if (entry.runInFlight || entry.activeRun) throw new Error('Wait for the active Browser operation before locating a task target.')
    const step = asset.draft.steps.find(step => step.id === stepId)
    if (!step || step.kind === 'checkpoint' || (step.kind === 'branch' && step.branch?.condition.kind !== 'element-present')) throw new Error('This task step has no page target.')
    const view = entry.view
    await this.waitForInitialDocument(entry, view)
    if (entry.runInFlight || entry.activeRun) throw new Error('Wait for the active Browser operation before locating a task target.')
    const contents = view.webContents
    const navigationId = entry.navigationId
    const live = () => this.owns(entry, view) && !contents.isDestroyed() && entry.navigationId === navigationId
    const url = safeBrowserUrl(contents.getURL() || entry.requestedUrl)
    let target: BrowserReplayStep['target']
    if (step.kind !== 'navigate') {
      void this.releaseDemonstrationCapture(entry)
      const session = BrowserCdpSession.attach(contents)
      const contexts = new Set<number>()
      let mainFrameId: string | undefined
      const unsubscribe = session.observe((method, params) => {
        const context = (params as { context?: { id?: number; auxData?: { isDefault?: boolean; type?: string; frameId?: string } } }).context
        if (method === 'Runtime.executionContextCreated' && typeof context?.id === 'number' && contexts.size < 64 && mainFrameId !== undefined &&
            context.auxData?.isDefault === false && context.auxData.type === 'isolated' && context.auxData.frameId === mainFrameId) contexts.add(context.id)
        if (method === 'Runtime.executionContextsCleared') contexts.clear()
        if (method === 'Runtime.executionContextDestroyed') contexts.delete((params as { executionContextId: number }).executionContextId)
      })
      try {
        const tree = await session.sendCommand('Page.getFrameTree') as { frameTree?: { frame?: { id?: string } } }
        mainFrameId = tree.frameTree?.frame?.id
        if (!mainFrameId) throw new Error('The main Browser document could not be verified. The task draft was retained.')
        await session.sendCommand('Runtime.enable')
        const selected = await this.selectElement(id, async (revision, inspectionToken) => {
          for (const contextId of contexts) {
            if (!live() || entry.selectionOperation !== revision) throw new Error('The selected Browser target changed.')
            let result: { result?: { objectId?: string }; exceptionDetails?: unknown }
            try {
              result = await session.sendCommand('Runtime.evaluate', { contextId, expression: buildSelectedBrowserElementExpression(revision, inspectionToken), returnByValue: false }) as typeof result
            } catch { continue }
            if (result.exceptionDetails || !result.result?.objectId) continue
            target = await verifyBrowserSemanticTarget({ sendCommand: session.sendCommand, objectId: result.result.objectId,
              isCurrent: () => live() && entry.selectionOperation === revision,
              getSnapshot: () => captureBrowserPageSnapshot({ send: session.sendCommand, frames: session.frames,
                navigationId, url, title: contents.getTitle() }) })
            break
          }
          if (!target) throw new Error('The actual selected target is unknown or ambiguous. The task draft was retained; select a uniquely named interactive element.')
        })
        if (!selected) throw new Error('Target location was cancelled; the task draft was retained.')
      } finally {
        unsubscribe()
        const warning = session.detach()
        if (warning && live()) { entry.activity = { ...entry.activity, warning }; this.emit(entry) }
      }
    }
    if (!live()) throw new Error('The Browser page changed before the task target could be saved.')
    return await this.taskAssets!.edit(assetId, expectedRevision, { ...asset.draft,
      steps: asset.draft.steps.map(item => item.id === stepId ? { ...item, url, ...(target ? item.kind === 'branch' && item.branch ? { branch: { ...item.branch, condition: { kind: 'element-present' as const, target: { role: target.role, name: target.name } } } } : { target } : {}), reviewed: false,
        warning: 'Actual page target located. Review this draft step before saving a runnable version.' } : item) })
  }

  /** Trusted Client action. Existing Browser control is the only checkpoint authority. */
  async runTaskAsset(input: BrowserTaskAssetRunInput): Promise<BrowserTaskAssetRun> {
    return await this.executeTaskAsset(input, 'human')
  }

  /** CLI/control is never evidence of the person's checkpoint approval. */
  async runControlledTaskAsset(input: BrowserTaskAssetRunInput): Promise<BrowserTaskAssetRun> {
    return await this.executeTaskAsset(input, 'control')
  }

  private async executeTaskAsset(input: BrowserTaskAssetRunInput, intent: 'human' | 'control', budget?: BrowserTaskRunBudget): Promise<BrowserTaskAssetRun> {
    const entry = this.require(input.browserId)
    const view = entry.view
    const controlRevision = entry.controlRevision
    const asset = await this.requireTaskAsset(input.browserId, input.assetId)
    const privateTaskParameters = Boolean(asset.versions.find(version => version.version === input.version)?.parameters.length)
    if (this.taskExecutions.has(entry.id) || this.taskAssets!.isBrowserExecuting(entry.id, budget?.batchId) || entry.runInFlight || entry.activeRun) throw new Error('Another operation is using this Browser.')
    const execution = { entry, runId: input.runId, operationId: undefined as string | undefined, stopRequested: false }
    this.taskExecutions.set(entry.id, execution)
    try {
      // This existing trusted Client action is the checkpoint authority. Capture the actual
      // pending cursor and control before returning control or the asset owner advances it.
      if (input.runId) {
        const state = await this.taskAssets!.state(entry.id)
        const previous = state.runs.find(run => run.id === input.runId)
        if (!previous || previous.assetId !== asset.id || previous.version !== input.version || previous.browserId !== entry.id) {
          throw new Error('The original task continuation identity is unavailable; it was not restarted.')
        }
        if (state.batches?.some(batch => batch.items.some(item => item.runId === previous.id) && batch.id !== budget?.batchId)) {
          throw new Error('Continue this item through its original batch to preserve its bounds and progress.')
        }
        if (previous.status !== 'ready' && previous.status !== 'waiting-human') {
          throw new Error('This task cannot continue from its current cursor. Inspect the retained progress.')
        }
        if (intent === 'control' && previous.status === 'waiting-human') {
          throw new Error('This task is waiting for the person. Agent control cannot approve or continue its checkpoint.')
        }
        if (intent === 'human' && previous.status === 'waiting-human' && previous.pendingCheckpointId) {
          await this.taskAssets!.recordHumanCheckpoint({ runId: previous.id, browserId: previous.browserId,
            assetId: previous.assetId, version: previous.version }, previous.pendingCheckpointId,
          { pendingCheckpointId: previous.pendingCheckpointId, nextStep: previous.nextStep,
            controlBefore: entry.humanControl ? 'human' : entry.activity.control })
        }
      }
      if (!this.owns(entry, view) || view.webContents.isDestroyed()) {
        throw new Error('The original Browser owner is unavailable; the task was not replayed.')
      }
      if (execution.stopRequested) throw new Error('This task was stopped before control returned. Its progress remains.')
      if (intent === 'human') {
        if (entry.controlRevision !== controlRevision) throw Object.assign(new Error('Browser control changed while the task was preparing. The original page and task are kept; continue explicitly from their current facts.'), { code: 'CONTROL_REQUEST_CONFLICT' })
        this.applyAgentControl(entry)
      }
      return await runBrowserTaskAsset(this.taskAssets!, input, {
        onRunPrepared: runId => { execution.runId = runId },
        control: id => { const owner = this.require(id); return owner.humanControl ? 'human' : owner.activity.control },
        yieldControl: id => this.yieldControl(id),
        navigationId: id => id === entry.id && this.owns(entry, view) && !view.webContents.isDestroyed() ? entry.navigationId : null,
        runScript: async (id, code, cursor) => {
          if (this.entries.get(id) !== entry) throw new Error('The original Browser owner is unavailable; the task was not replayed.')
          if (!execution.runId) throw new Error('The task cursor is unavailable; the action was not restarted.')
          const taskPage: BrowserTaskPageExecution = { cursor: { ...cursor } }
          try {
            return await this.runScript(id, code, undefined, undefined, undefined, async operation => {
              execution.operationId = operation.id
              const version = await this.taskAssets!.executionVersion(cursor)
              const immutableStep = version?.steps.find(step => step.id === cursor.stepId)
              if (immutableStep) taskPage.step = structuredClone(immutableStep)
              const bound = await this.taskAssets!.bindOperation(cursor, operation.id)
              const declaration = version?.completion
              const download = declaration?.criteria.find(item => item.kind === 'download-readable')
              const producer = download?.stepId ?? version?.steps.find(step => step.kind !== 'checkpoint' && step.kind !== 'branch')?.id
              if (declaration && producer === cursor.stepId && this.operationJournal) {
                const registration: BrowserOutcomeRegistration = {
                  context: { workspaceId: entry.workspaceId, browserId: entry.id, operationId: operation.id, navigationId: entry.navigationId },
                  assetRun: { runId: cursor.runId, assetId: cursor.assetId, version: cursor.version },
                  criteria: declaration.criteria.map(item => item.kind === 'download-readable'
                    ? { kind: item.kind, path: item.path, producer: { operationId: operation.id, navigationId: entry.navigationId } }
                    : { kind: item.kind, checkpointId: item.checkpointId })
                }
                const saved = await this.operationJournal.registerOutcome(operation.id, registration)
                if (saved?.operation.outcome) operation.outcome = saved.operation.outcome
                if (!bound || !saved?.saved) {
                  await this.taskAssets!.markCompletionUnavailable(cursor)
                  const warning = 'Completion recording is unavailable. Existing Browser and Agent work remains; restore local storage before verifying again.'
                  operation.warning = appendWarning(operation.warning, warning)
                  this.addCurrentOperationWarning(entry, view, operation, warning)
                }
              }
              // Preparation can finish after the person stopped this exact cursor.
              // Hand that intent to the existing operation cancellation owner before any page work.
              if (execution.stopRequested) void this.stopOperationById(operation.id)
            }, privateTaskParameters, taskPage)
          } finally { execution.operationId = undefined }
        }
      }, budget)
    } finally {
      if (this.taskExecutions.get(entry.id) === execution) this.taskExecutions.delete(entry.id)
    }
  }

  async runTaskBatch(input: BrowserTaskBatchInput): Promise<BrowserTaskBatchRun> { return await this.executeTaskBatch(input, 'human') }
  async runControlledTaskBatch(input: BrowserTaskBatchInput): Promise<BrowserTaskBatchRun> { return await this.executeTaskBatch(input, 'control') }
  private async executeTaskBatch(input: BrowserTaskBatchInput, intent: 'human' | 'control'): Promise<BrowserTaskBatchRun> {
    const entry = this.require(input.browserId)
    await this.requireTaskAsset(input.browserId, input.assetId)
    if (intent === 'control' && (entry.humanControl || entry.activity.control === 'human')) throw new Error('The person has Browser control. Return control explicitly before running the batch.')
    if (intent === 'control' && input.batchId) {
      const state = await this.taskAssets!.state(input.browserId)
      const batch = state.batches?.find(batch => batch.id === input.batchId)
      const runId = batch?.items[batch.nextItem]?.runId
      if (batch?.status === 'waiting-human' || state.runs.some(run => run.id === runId && run.status === 'waiting-human')) throw new Error('This batch is waiting for the person. Agent control cannot approve its checkpoint.')
    }
    // The actual button gesture authorizes only this invocation's first continuation.
    // Later items share the original control owner; a new human takeover is never returned away.
    let firstItem = true
    return await runBrowserTaskBatch(this.taskAssets!, input, { runTask: (item, budget) => {
      const itemIntent = firstItem ? intent : 'control'
      firstItem = false
      return this.executeTaskAsset(item, itemIntent, budget)
    } })
  }
  async stopTaskBatch(browserId: string, batchId: string): Promise<BrowserTaskBatchRun | null> {
    this.require(browserId)
    if (!this.taskAssets) throw new Error('Task asset storage is unavailable.')
    const batch = await this.taskAssets.stopBatch(browserId, batchId)
    const runId = batch?.items[batch.nextItem]?.runId
    if (runId) await this.stopTaskAsset(browserId, runId)
    return batch
  }

  async stopTaskAsset(id: string, runId: string): Promise<BrowserTaskAssetRun | null> {
    const entry = this.require(id)
    if (!this.taskAssets) throw new Error('Task asset storage is unavailable.')
    const state = await this.taskAssets.state(id)
    const run = state.runs.find(run => run.id === runId)
    if (!run) throw new Error('This task run does not belong to the Browser.')
    const execution = this.taskExecutions.get(id)
    if (execution?.entry === entry && execution.runId === runId) {
      execution.stopRequested = true
      if (execution.operationId && entry.activeRun?.operationId === execution.operationId) void this.stopOperationById(execution.operationId)
    }
    return await this.taskAssets.stop(runId)
  }

  private yieldControl(id: string): void {
    const entry = this.require(id)
    entry.humanControl = true
    ++entry.controlRevision
    this.releaseInputShield(entry)
    entry.driving = false
    entry.activity = { ...entry.activity, control: 'human' }
    this.emit(entry)
  }

  /** Trusted human handoff, including the idle gap after an operation finishes. */
  takeControl(id: string): BrowserSnapshot {
    const entry = this.require(id)
    entry.activeRun?.stop()
    this.yieldControl(id)
    return this.snapshot(entry)
  }

  returnControl(id: string): BrowserSnapshot
  returnControl(id: string, input: BrowserControlHandoff): Promise<BrowserSnapshot>
  returnControl(id: string, input?: BrowserControlHandoff): BrowserSnapshot | Promise<BrowserSnapshot> {
    const entry = this.require(id)
    if (input !== undefined) return this.transferControl(entry, input)
    if (this.agentOwnsInput(entry)) return this.snapshot(entry)
    if (!entry.agent) throw Object.assign(new Error(entry.agent === null
      ? 'This Browser has no associated Agent. Create an Agent on its right to hand it over.'
      : 'The original Browser Agent association is unconfirmed. Keep the page and restore its original association before returning control.'), { code: 'CONTROL_UNAVAILABLE' })
    return this.applyAgentControl(entry)
  }

  /** A trusted click may establish one new relationship only after Core confirms its exact Run. */
  private async transferControl(entry: BrowserEntry, input: BrowserControlHandoff): Promise<BrowserSnapshot> {
    input = parseBrowserControlHandoff(input)
    const { agent } = input
    const matches = () => this.entries.get(entry.id) === entry && entry.navigationId === input.navigationId &&
      entry.controlRevision === input.expectedRevision && !entry.view.webContents.isDestroyed()
    if (!matches()) throw Object.assign(new Error('This Browser changed before the handoff. The original page and created Agent are kept; inspect the current page before continuing.'), { code: 'CONTROL_REQUEST_CONFLICT' })
    if (entry.agent === undefined || entry.agent && (entry.agent.hostId !== agent.hostId || entry.agent.agentSessionId !== agent.agentSessionId)) {
      throw Object.assign(new Error('This handoff cannot replace an unknown or different Browser Agent. The original association and created Agent are kept.'), { code: 'CONTROL_REQUEST_CONFLICT' })
    }
    if (!this.agents) throw Object.assign(new Error('The original Core Agent authority is unavailable. The page and created Agent are kept; retry this exact handoff after reconnecting.'), { code: 'CONTROL_UNAVAILABLE' })
    const original = await this.agents.inspect(agent)
    if (original.kind !== 'agent' || original.hostId !== agent.hostId || original.agentSessionId !== agent.agentSessionId || original.run.runId !== agent.run.runId) {
      throw Object.assign(new Error('Core has not confirmed this exact Agent Session/Run. The original page and created Agent are kept; inspect the original creation without repeating it.'), { code: 'STALE_AGENT_SESSION_BINDING' })
    }
    if (!matches()) throw Object.assign(new Error('This Browser changed while Core confirmed the Agent. The original page and created Agent are kept; inspect the current page before continuing.'), { code: 'CONTROL_REQUEST_CONFLICT' })
    entry.agent = { hostId: agent.hostId, agentSessionId: agent.agentSessionId }
    entry.agentWarning = undefined
    return this.applyAgentControl(entry)
  }

  private applyAgentControl(entry: BrowserEntry): BrowserSnapshot {
    if (this.agentOwnsInput(entry)) return this.snapshot(entry)
    entry.humanControl = false
    ++entry.controlRevision
    entry.activity = { ...entry.activity, control: 'agent' }
    entry.inputIsolation = 'preparing'
    this.emit(entry)
    void this.prepareInputShield(entry, entry.view)
    return this.snapshot(entry)
  }

  async replayPlan(operationId: string) {
    return this.operationJournal ? await this.operationJournal.replayPlan(operationId) : null
  }

  /**
   * 页面函数真正干活的那一头。
   *
   * 这个方法是 `captureBrowserPageSnapshot` 与 `resolveBrowserRef` 的**唯一生产调用路径**——
   * 它们此前只有测试在 import，而"看起来完整、生产走别的路"正是本任务点名要防的陷阱。
   *
   * 这里只做**归属校验**（这个 entry 还是不是当前那个、view 还在不在），页面语义一概交给
   * `createBrowserPageDispatch`。归属留在这一层是因为只有 manager 知道 entry 有没有被换掉：
   * 换掉之后继续在旧 view 上派发，Agent 会在一个已经不属于这个 Browser 的页面上动手。
   */
  private pageCallHandler(
    entry: BrowserEntry,
    observingView: WebContentsView,
    session: BrowserCdpSession,
    notes: string[],
    operation: BrowserOperation,
    privateTaskParameters = false,
    signal?: AbortSignal,
    taskPage?: BrowserTaskPageExecution,
    deadlineMillis = taskPage?.cursor.deadlineMillis ?? Infinity
  ): (name: string, args: unknown[]) => Promise<unknown> {
    const controlRevision = entry.controlRevision
    let activeStep: BrowserOperationStep | null = null
    const waitingSteps = new Set<number>()
    let beforeWaiting: { phase: BrowserOperation['phase']; summary: string } | null = null
    const requireCurrentDocumentOperation = () => {
      if (!this.owns(entry, observingView) || observingView.webContents.isDestroyed() || entry.activeRun?.operationId !== operation.id) throw new Error('The original Browser operation changed before document dispatch.')
      signal?.throwIfAborted()
      if (performance.now() >= deadlineMillis) throw new Error('The Browser program budget ended before document dispatch.')
    }
    let activeRecoveryMayDispatch: (() => boolean) | undefined
    const requireLive = (): WebContentsView => {
      const view = entry.view
      if (this.entries.get(entry.id) !== entry || view.webContents.isDestroyed()) {
        throw new Error(`Browser ${entry.id} went away while the script was running`)
      }
      return view
    }
    const beforeAction = (step = activeStep): void => {
      if (requireLive() !== observingView || entry.activeRun?.operationId !== operation.id) throw new Error('The original Browser operation changed before dispatch.')
      // Only the Main control owner or this operation's cancellation can revoke dispatch.
      if (!step || !BROWSER_ACTION_PAGE_CALLS.has(step.method)) return
      if (signal?.aborted) throw new Error('This Browser operation stopped before dispatch.')
      if (entry.humanControl || entry.controlRevision !== controlRevision) throw new Error('Browser control changed. Return control explicitly before running a fresh program; the old program cannot resume.')
      if (activeRecoveryMayDispatch && !activeRecoveryMayDispatch()) throw new Error('This recovery attempt no longer has dispatch authority.')
      if (taskPage?.cursor.expectedNavigationId && entry.navigationId !== taskPage.cursor.expectedNavigationId) throw new Error('The selected condition document changed before dispatch.')
      if (taskPage?.cursor.deadlineMillis !== undefined && performance.now() >= taskPage.cursor.deadlineMillis) throw new Error('Task execution budget reached before page dispatch.')
      if (taskPage && !this.taskAssets?.isExecutionCurrent(taskPage.cursor, operation.id)) throw new Error('The original task cursor changed before dispatch.')
    }
    const dispatch = createBrowserPageDispatch({
      session,
      beforeAction,
      ...(this.downloads && signal ? { downloads: { store: this.downloads, signal, context: () => {
        const view = requireLive()
        if (view !== observingView) throw new Error('The Browser view changed before download.')
        return { workspaceId: entry.workspaceId, browserId: entry.id, operationId: operation.id,
          navigationId: entry.navigationId, url: view.webContents.getURL(), contents: view.webContents }
      } } } : {}),
      ...(this.uploads ? { uploads: { store: this.uploads, context: () => {
        const view = requireLive()
        if (view !== observingView) throw new Error('The Browser view changed before upload.')
        return { workspaceId: entry.workspaceId, browserId: entry.id, operationId: operation.id,
          navigationId: entry.navigationId, documentSurvivesClient: false, currentNavigationId: () => {
            const currentView = requireLive()
            if (currentView !== observingView) throw new Error('The Browser view changed during upload.')
            if (signal?.aborted) throw new Error('This Browser operation stopped before file assignment could be confirmed.')
            return entry.navigationId
          } }
      } } } : {}),
      structuredOutput: {
        source: () => { requireLive(); if (entry.view !== observingView) throw new Error('The Browser view changed before structured observation.'); return { workspaceId: entry.workspaceId, browserId: entry.id,
          operationId: operation.id, navigationId: entry.navigationId } },
        isCurrent: navigationId => this.entries.get(entry.id) === entry && entry.view === observingView && !observingView.webContents.isDestroyed() &&
          entry.navigationId === navigationId
      },
      ...(this.resultArtifacts ? { resultArtifacts: {
        store: this.resultArtifacts, owner: { workspaceId: entry.workspaceId, browserId: entry.id }
      } } : {}),
      pageInfo: () => {
        const view = requireLive()
        return {
          url: view.webContents.getURL(),
          title: view.webContents.getTitle(),
          navigationId: entry.navigationId,
          ...(entry.faviconDataUrl ? { faviconDataUrl: entry.faviconDataUrl } : {})
        }
      },
      gotoUrl: async (url) => {
        beforeAction()
        await runBrowserTaskNavigation(() => this.startNavigation(entry, url))
      },
      captureScreenshot: async () => await this.captureScreenshot(entry.id, { view: observingView, sendCommand: session.sendCommand }),
      readLedger: async () => await this.refLedgers.read(entry.id),
      writeLedger: async (ledger) => {
        // Controlled parameterized task scripts return no refs. Do not retain page-derived echoes of their private values.
        if (privateTaskParameters) return
        await this.refLedgers.write(entry.id, ledger)
      },
      note: (text) => {
        notes.push(text)
        operation.warning = appendWarning(operation.warning, text)
        this.addCurrentOperationWarning(entry, observingView, operation, text)
        void this.operationJournal?.setPhase(operation.id, operation.phase, { summary: operation.summary, warning: operation.warning })
        this.emit(entry)
      },
      recordTarget: (target) => {
        if (!activeStep) return
        activeStep.target = target
        if (activeStep.replay) {
          activeStep.replay.target = target
          if (activeStep.method === 'fillInput' || activeStep.method === 'typeText') {
            activeStep.replay.args = []
            activeStep.replay.inputKey = 'value'
            activeStep.replay.blockedReason = 'Sensitive input is requested again at replay time.'
          } else if (activeStep.method === 'js' || activeStep.method === 'cdp') {
            activeStep.replay.args = []
            activeStep.replay.blockedReason = 'Opaque page code or protocol input requires explicit review.'
          }
        }
      }
    })
    return async (name, args) => {
      requireLive()
      const step = startBrowserOperationStep(operation, name, args)
      activeStep = step
      this.emit(entry)
      if (this.operationJournal) {
        await this.operationJournal.startStep(operation.id, {
          method: step.method,
          label: step.label,
          ...(step.ref ? { ref: step.ref } : {}),
          ...(step.replay ? { replay: step.replay } : {})
        })
      }
      if (BROWSER_WAIT_PAGE_CALLS.has(name) && (operation.phase === 'running' || operation.phase === 'waiting')) {
        if (waitingSteps.size === 0) beforeWaiting = { phase: operation.phase, summary: operation.summary }
        waitingSteps.add(step.sequence)
        operation.phase = 'waiting'
        operation.summary = `Waiting: ${step.label}`
        void this.operationJournal?.setPhase(operation.id, 'waiting', { summary: operation.summary })
        this.emit(entry)
      }
      const saveEvidence = async (content: BrowserStepEvidenceContent, navigationId: string, first = false): Promise<boolean> => {
        if (!this.stepEvidence) return false
        if ((content.kind === 'page' || content.kind === 'structured-output') && privateTaskParameters) {
          step.evidenceWarning = 'Automatic page observations were not retained because this task uses private invocation parameters. Inspect the live page for its current state.'
          return false
        }
        try {
          const reference = await recordBrowserStepEvidence(this.stepEvidence, {
            operationId: operation.id, sequence: step.sequence, browserId: entry.id, navigationId
          }, content)
          step.evidence = first ? [reference, ...(step.evidence ?? [])] : [...(step.evidence ?? []), reference]
          return true
        } catch {
          step.evidenceWarning = 'Step evidence could not be saved. The action result is retained; inspect the page and check local storage before recording again.'
          operation.warning = appendWarning(operation.warning, step.evidenceWarning)
          this.addCurrentOperationWarning(entry, observingView, operation, step.evidenceWarning)
          return false
        }
      }
      try {
        if (BROWSER_DOCUMENT_PAGE_CALLS.has(name)) {
          requireCurrentDocumentOperation()
          await this.waitForInitialDocument(entry, observingView, signal, deadlineMillis)
          requireCurrentDocumentOperation()
        }
        let value: unknown
        try {
          const feedback = entry.feedback
          let action: number | undefined
          if (BROWSER_ACTION_PAGE_CALLS.has(name)) {
            beforeAction(step)
            action = await feedback?.begin(name, name === 'pressKey' ? args[1] : undefined)
            beforeAction(step)
          } else if (BROWSER_WAIT_PAGE_CALLS.has(name)) await feedback?.clear()
          else await feedback?.observe()
          if (BROWSER_DOCUMENT_PAGE_CALLS.has(name)) requireCurrentDocumentOperation()
          value = await dispatch(name, args, { beforeAction: () => beforeAction(step),
            ...(feedback && action !== undefined && (name === 'click' || name === 'download') ? {
              dispatched: () => feedback.clickConfirmed(action)
            } : {}),
            ...(feedback && action !== undefined && entry.visible ? { feedback: async (node: BrowserPageSnapshot['nodes'][number], send: typeof session.sendCommand) => {
              beforeAction(step)
              await feedback.showTarget(node, send, action)
              beforeAction(step)
            } } : {}) })
          if (action !== undefined) await feedback?.completeAction(action)
        }
        catch (error) {
          if (!taskPage?.step || !operation.outcome || !signal) throw error
          const recovered = await recoverBrowserTaskStep({ identity: { ...taskPage.cursor, operationId: operation.id, sequence: step.sequence },
            step: taskPage.step, method: name, args, failure: error }, {
            signal,
            isCurrent: () => this.entries.get(entry.id) === entry && entry.view === observingView && !observingView.webContents.isDestroyed() &&
              entry.activeRun?.operationId === operation.id && (!taskPage.cursor.expectedNavigationId || entry.navigationId === taskPage.cursor.expectedNavigationId) &&
              this.taskAssets?.isExecutionCurrent(taskPage.cursor, operation.id) === true,
            control: () => entry.humanControl ? 'human' : 'agent',
            observe: async () => {
              if (entry.error) throw new Error('The original page reports a navigation or renderer error.')
              return await dispatch('snapshot', [{ maxNodes: 1000 }]) as BrowserScopedSnapshot
            },
            dispatch: async (method, callArgs, mayDispatch) => {
              activeRecoveryMayDispatch = mayDispatch
              try { return await dispatch(method, callArgs) } finally { activeRecoveryMayDispatch = undefined }
            },
            verify: () => this.verifyOutcome(entry.id, operation.id),
            record: report => saveEvidence({ kind: 'diagnostic', code: 'page-call-failed',
              message: `Local recovery for ${report.goal.kind} in saved version ${report.identity.version}: ${report.status}. Goal: ${report.goal.target ? `${report.goal.target.role} "${report.goal.target.name.slice(0, 256)}" (${report.goal.target.ordinal}/${report.goal.target.count})` : 'navigation'}; page: ${report.goal.page?.slice(0, 512) ?? 'unknown'}. Failure: ${report.failure.kind}; effects: ${report.failure.effects}. ${report.attempts.length}/${report.budget.attempts} attempts, ${report.elapsedMs}/${report.budget.timeMs} ms, ${report.outputBytes}/${report.budget.outputBytes} bytes. ${report.attempts.map(attempt => `Attempt ${attempt.number}: ${attempt.mode}, ${attempt.status}.`).join(' ')} Outcome evidence: ${report.outcome?.status ?? 'unavailable'}.`,
              nextAction: report.notice }, entry.navigationId, true)
          })
          // A proven pre-dispatch recovery keeps its explicit notice without relabeling
          // it as appearance-based historical ref healing in the script outcome owner.
          operation.warning = appendWarning(operation.warning, recovered.report.notice)
          this.addCurrentOperationWarning(entry, observingView, operation, recovered.report.notice)
          if (recovered.status !== 'action-completed' && recovered.status !== 'observed') throw error
          value = recovered.value
        }
        step.status = 'completed'
        step.finishedAt = Date.now()
        step.summary = summarizeBrowserValue(value)
        if (this.stepEvidence && name === 'snapshot') {
          const snapshot = value as BrowserPageSnapshot
          await saveEvidence(pageStepEvidence(snapshot), snapshot.navigationId)
        } else if (this.stepEvidence && name === 'captureScreenshot') {
          const capture = value as BrowserScreenshotCapture
          await saveEvidence(screenshotStepEvidence(capture), capture.navigationId)
        } else if (this.stepEvidence && name === 'extractStructured') {
          const receipt = value as BrowserStructuredOutputReceipt
          await saveEvidence({ kind: 'structured-output', receipt }, receipt.source.navigationId)
        }
        if (this.operationJournal) await this.operationJournal.finishStep(operation.id, step.sequence, {
          status: 'completed',
          summary: step.summary,
          ...(step.evidence ? { evidence: step.evidence } : {}),
          ...(step.evidenceWarning ? { evidenceWarning: step.evidenceWarning } : {}),
          ...(step.target ? { target: step.target } : {}),
          ...(step.replay ? { replay: step.replay } : {})
        })
        this.emit(entry)
        return value
      } catch (error) {
        step.status = signal?.aborted ? 'stopped' : 'failed'
        step.finishedAt = Date.now()
        step.summary = privateTaskParameters
          ? 'Browser task page call did not report completion. Raw error text is withheld because this invocation contains private parameters; inspect the page before retrying.'
          : (error instanceof Error ? error.message : String(error)).slice(0, 240)
        await saveEvidence({
          kind: 'diagnostic', code: 'page-call-failed',
          message: `Step ${step.sequence} (${name}) did not report completion. Side effects may already have occurred.`,
          nextAction: entry.humanControl
            ? 'Human control is active. Wait for the user to return control before continuing.'
            : 'Inspect the page and take a fresh snapshot before deciding whether this action can be retried.'
        }, entry.navigationId)
        if (this.operationJournal) await this.operationJournal.finishStep(operation.id, step.sequence, {
          status: step.status,
          summary: step.summary,
          ...(step.evidence ? { evidence: step.evidence } : {}),
          ...(step.evidenceWarning ? { evidenceWarning: step.evidenceWarning } : {}),
          ...(step.target ? { target: step.target } : {}),
          ...(step.replay ? { replay: step.replay } : {})
        })
        this.emit(entry)
        throw error
      } finally {
        activeStep = null
        if (waitingSteps.delete(step.sequence) && waitingSteps.size === 0) {
          // Explicit Stop owns the newer phase; finishing a wait must never overwrite it.
          if (operation.phase === 'waiting' && beforeWaiting) {
            operation.phase = beforeWaiting.phase
            operation.summary = beforeWaiting.summary
            void this.operationJournal?.setPhase(operation.id, operation.phase, { summary: operation.summary })
            this.emit(entry)
          }
          beforeWaiting = null
        }
      }
    }
  }

  /**
   * 一个应用链接想走。按已记住的答案决定这一次怎么办：记过 allow 就直接开，记过 deny 就说出来，
   * 没记过就把这一问挂上快照等人回答。
   *
   * 判定与「真的开」都在 `appLinkOutcome` 里，这里只负责把结局投影出去——让这里写成
   * `if (decision.shouldOpen) this.appLinks.openExternal(url)` 是**实测可被劫持**的形状，
   * 见 `window-security.ts` 里 `windowOpenOutcome` 的注释。
   */
  private async handOffAppLink(entry: BrowserEntry, url: string, scheme: string): Promise<void> {
    const view = entry.view, navigationId = entry.navigationId, request = Symbol('app-link request')
    entry.appLinkRequest = request
    const current = () => this.owns(entry, view) && entry.navigationId === navigationId && entry.appLinkRequest === request
    const remembered = (await this.appLinks.rememberedSchemes())[scheme]
    // 读盘是异步的，这中间页面可能已经换掉或被顶掉。既有的每一处异步回写都先判这一句。
    if (!current()) return
    this.projectAppLinkOutcome(entry, appLinkOutcome(url, scheme, remembered, (target) => {
      void this.openExternalWithFeedback(entry, target, current)
    }))
  }

  private async openExternalWithFeedback(entry: BrowserEntry, target: string, current: () => boolean): Promise<void> {
    try {
      await this.appLinks.openExternal(target)
    } catch (error) {
      if (!current()) return
      entry.error = `Could not open this link: ${error instanceof Error ? error.message : String(error)}. Inspect the exact target before trying the link again.`
      this.emit(entry)
    }
  }

  /** 把一次移交结局写进 entry 并广播。三档各自对应快照上不同的一组字段，不许有第二处这样写。 */
  private projectAppLinkOutcome(
    entry: BrowserEntry,
    outcome: ReturnType<typeof appLinkOutcome>
  ): void {
    entry.appLinkPrompt = outcome.kind === 'ask' ? { url: outcome.url, scheme: outcome.scheme } : null
    entry.error = outcome.kind === 'refused' ? appLinkRefusedMessage(outcome.scheme) : null
    this.emit(entry)
  }

  /**
   * 用户回答了那个提问。
   *
   * url 取自 entry 上挂着的那一次，不从渲染进程收——渲染进程回传 url 等于开了第二个事实源，
   * 页面可以在人回答之前又发起一次，两边就对不上了。
   */
  async answerAppLink(id: string, allow: boolean, remember: boolean): Promise<BrowserSnapshot> {
    const entry = this.require(id)
    const pending = entry.appLinkPrompt
    if (!pending) throw new Error('No app link is waiting for an answer on this Browser')
    const request = entry.appLinkRequest, view = entry.view, navigationId = entry.navigationId
    const current = () => this.owns(entry, view) && entry.navigationId === navigationId && entry.appLinkRequest === request
    const choice: AppLinkSchemeChoice = allow ? 'allow' : 'deny'
    if (remember) await this.appLinks.rememberScheme(pending.scheme, choice)
    if (!current() || entry.appLinkPrompt !== pending) return this.snapshot(entry)
    // 记不记得住是两回事：这一次照答案走。传 choice 而不是 remembered，才让「只答这一次」成立。
    this.projectAppLinkOutcome(entry, appLinkOutcome(pending.url, pending.scheme, choice, (target) => {
      void this.openExternalWithFeedback(entry, target, current)
    }))
    return this.snapshot(entry)
  }

  async selectElement(id: string, inspectTarget?: (revision: number, inspectionToken: string) => Promise<void>): Promise<BrowserElementSelection | null> {
    if (this.entries.get(id)?.releaseAttempt?.pending) await this.prepareForConsumption(id)
    const entry = this.require(id)
    this.requireHumanInput(entry)
    const view = entry.view
    const pending = Symbol('initial document selection')
    entry.selectionOperation = pending
    try { await this.waitForInitialDocument(entry, view) }
    catch (error) { if (entry.selectionOperation === pending) entry.selectionOperation = null; throw error }
    if (entry.selectionOperation !== pending) return null
    this.requireHumanInput(entry)
    const navigationId = entry.navigationId
    entry.selectionOperation = null
    const preflightRevision = ++entry.selectionRevision
    await view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_SELECTION_WORLD_ID,
      [{ code: buildCancelBrowserElementSelectionScript(preflightRevision) }]
    )
    if (
      this.entries.get(id) !== entry ||
      entry.view !== view ||
      view.webContents.isDestroyed() ||
      entry.navigationId !== navigationId ||
      entry.selectionRevision !== preflightRevision
    ) {
      return null
    }
    this.requireHumanInput(entry)
    const operation = ++entry.selectionRevision
    const inspectionToken = mintCapabilityToken()
    entry.selectionOperation = operation
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const raw = await Promise.race([
        view.webContents.executeJavaScriptInIsolatedWorld(
          BROWSER_SELECTION_WORLD_ID,
          [{ code: buildBrowserElementSelectionScript(operation, inspectTarget ? inspectionToken : undefined) }],
          true
        ),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Browser element selection timed out')), BROWSER_SELECTION_TIMEOUT_MS)
        })
      ])
      if (raw === null) return null
      if (
        this.entries.get(id) !== entry ||
        entry.view !== view ||
        view.webContents.isDestroyed() ||
        entry.navigationId !== navigationId ||
        entry.selectionOperation !== operation
      ) {
        throw new Error('Browser page changed while an element was being selected')
      }
      if (inspectTarget) await inspectTarget(operation, inspectionToken)
      return {
        browserId: id,
        navigationId,
        ...sanitizeBrowserElementSelection(raw)
      }
    } finally {
      if (timeout) clearTimeout(timeout)
      if (entry.selectionOperation === operation) entry.selectionOperation = null
      if (this.entries.get(id) === entry && entry.view === view && !view.webContents.isDestroyed()) {
        void view.webContents.executeJavaScriptInIsolatedWorld(
          BROWSER_SELECTION_WORLD_ID,
          [{ code: buildCancelBrowserElementSelectionScript(operation) }]
        ).catch(() => {})
      }
    }
  }

  async cancelElementSelection(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry || entry.view.webContents.isDestroyed()) return
    entry.selectionOperation = null
    const revision = ++entry.selectionRevision
    await entry.view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_SELECTION_WORLD_ID,
      [{ code: buildCancelBrowserElementSelectionScript(revision) }]
    )
  }

  async setAnnotationMarkers(
    id: string,
    navigationId: string,
    markers: readonly BrowserAnnotationMarker[]
  ): Promise<void> {
    const entry = this.require(id)
    const view = entry.view
    if (entry.navigationId !== navigationId) {
      return
    }
    if (!Array.isArray(markers) || markers.length > BROWSER_MARKER_MAX_COUNT) {
      throw new Error('Browser annotation marker count exceeds the limit')
    }
    const ids = new Set<string>()
    const indexes = new Set<number>()
    const normalized = Array.from(markers, (marker, index): BrowserAnnotationMarker => {
      if (
        !marker ||
        typeof marker.id !== 'string' ||
        !marker.id ||
        marker.id.length > 100 ||
        !Number.isInteger(marker.index) ||
        marker.index < 0 ||
        marker.index >= BROWSER_MARKER_MAX_COUNT ||
        typeof marker.isFixed !== 'boolean'
      ) {
        throw new Error(`Browser annotation marker ${index} is invalid`)
      }
      if (ids.has(marker.id) || indexes.has(marker.index)) {
        throw new Error(`Browser annotation marker ${index} duplicates an id or index`)
      }
      ids.add(marker.id)
      indexes.add(marker.index)
      return {
        id: marker.id,
        index: marker.index,
        isFixed: marker.isFixed,
        rectViewport: normalizeMarkerRect(marker.rectViewport),
        rectPage: normalizeMarkerRect(marker.rectPage)
      }
    })
    const revision = ++entry.annotationRevision
    await view.webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_SELECTION_WORLD_ID,
      [{ code: buildBrowserAnnotationMarkerScript(normalized, revision) }]
    )
    if (
      this.entries.get(id) !== entry ||
      entry.view !== view ||
      view.webContents.isDestroyed() ||
      entry.navigationId !== navigationId ||
      entry.annotationRevision !== revision
    ) {
      if (this.entries.get(id) === entry && entry.view === view && !view.webContents.isDestroyed()) {
        void view.webContents.executeJavaScriptInIsolatedWorld(
          BROWSER_SELECTION_WORLD_ID,
          [{ code: buildCancelBrowserAnnotationMarkerScript(revision) }]
        ).catch(() => {})
      }
    }
  }

  setBounds(id: string, bounds: BrowserBounds | null): void {
    const entry = this.entries.get(id)
    if (!entry) return
    try {
      if (bounds === null) {
        const wasVisible = entry.visible
        entry.visible = false
        this.cancelRecoveryPreview(entry)
        void entry.feedback?.clear()
        void entry.controlFeedback?.synchronize()
        entry.view.setVisible(false)
        if (wasVisible) { this.notifyNativeVisibility(this.windowForView(entry.view)); this.emit(entry) }
        return
      }
      // 归一化与 renderer 侧共用一份判定（shared/browser-bounds.ts）。这一侧拿到 null 抛错而不是静默
      // 隐藏：矩形到了 main 还不可用，意味着上游算错了或有人绕过 renderer 直接发 IPC，隐藏会把 bug 埋掉。
      const normalized = normalizeBrowserBounds(bounds)
      if (!normalized) {
        throw new Error('Browser bounds must be finite with a positive size')
      }
      const becomingVisible = !entry.visible
      const boundsChanged = !entry.bounds || entry.bounds.x !== normalized.x || entry.bounds.y !== normalized.y ||
        entry.bounds.width !== normalized.width || entry.bounds.height !== normalized.height
      const sizeChanged = !entry.bounds || entry.bounds.width !== normalized.width || entry.bounds.height !== normalized.height
      const selectedLease = entry.inputLeaseId ? this.presentationLeases.get(entry.inputLeaseId) : null
      const nativeWindow = selectedLease?.window ?? this.windowForView(entry.view)
      const previousWindow = this.windowForView(entry.view), hostChanged = previousWindow !== nativeWindow
      // Admission can fail. Keep the original reachable geometry until its same
      // native page has actually entered the selected host; placeView restores
      // the original host if attachment fails.
      if (becomingVisible || hostChanged) this.placeView(entry.view, nativeWindow)
      entry.bounds = normalized
      entry.visible = true
      entry.view.setBounds(entry.bounds)
      if (sizeChanged && entry.viewport !== 'responsive') this.applyViewport(entry)
      entry.view.setVisible(true)
      if (becomingVisible) { this.synchronizeVisiblePage(entry, entry.view); this.sampleRecoveryPreview(entry, entry.view); this.emit(entry) }
      if (hostChanged) this.notifyNativeVisibility(previousWindow)
      if (becomingVisible || boundsChanged || hostChanged) this.notifyNativeVisibility(nativeWindow)
    } finally { this.synchronizeInputShield(entry); this.publishNativeCoverage(entry) }
  }

  /**
   * Synchronize the loaded, visible embedded page without changing its policy or geometry.
   * Electron's setter also synchronizes its owner and platform view; reapplying bounds alone
   * does not guarantee a drawable surface. Run at load/show/promotion edges, not every layout.
   * Actual same-policy recovery evidence: browser-main-retained-policy-native-diagnostic.md.
   */
  private synchronizeVisiblePage(entry: BrowserEntry, view: WebContentsView): void {
    if (!this.owns(entry, view) || !entry.visible || !entry.bounds || view.webContents.isLoading() || !view.webContents.getURL()) return
    view.webContents.setBackgroundThrottling(view.webContents.getBackgroundThrottling())
  }

  private cancelRecoveryPreview(entry: BrowserEntry): void {
    entry.recoveryPreviewJob?.abort()
  }

  /** A single small historical appearance at load/show edges; never an operation or keepalive. */
  private sampleRecoveryPreview(entry: BrowserEntry, view: WebContentsView): void {
    const store = this.recoveryPreviews
    if (!store || this.presentationDisposed || entry.recoveryPreviewRetired || !this.owns(entry, view) || !entry.visible || !entry.bounds || entry.error ||
      view.webContents.isDestroyed() || view.webContents.isLoading() || entry.recoveryPreviewJob ||
      entry.recoveryPreviewNavigation === entry.navigationId) return
    const contents = view.webContents, url = contents.getURL()
    if (!url || url === 'about:blank') return
    const scope = this.recoveryPreviewScope(entry.id)
    if (!scope) return
    const navigationId = entry.navigationId, storage = entry.storage, controller = new AbortController()
    entry.recoveryPreviewJob = controller
    void (async () => {
      try {
        const frame = contents.mainFrame, processId = frame.processId, frameToken = frame.frameToken
        const title = contents.getTitle(), capturedAt = Date.now()
        const current = (): boolean => {
          try {
            return !controller.signal.aborted && this.owns(entry, view) && entry.storage === storage &&
              entry.navigationId === navigationId && entry.visible && !entry.error && !contents.isDestroyed() &&
              contents.getURL() === url && contents.mainFrame.processId === processId && contents.mainFrame.frameToken === frameToken
          } catch { return false } // An unknown source only cancels this optional preview.
        }
        if (!current()) return
        const pixels = await contents.capturePage()
        if (!current()) return
        const size = pixels.getSize()
        if (pixels.isEmpty() || size.width <= 0 || size.height <= 0) return
        const scale = Math.min(1, BROWSER_RECOVERY_PREVIEW_MAX_WIDTH / size.width, BROWSER_RECOVERY_PREVIEW_MAX_HEIGHT / size.height)
        const width = Math.max(1, Math.round(size.width * scale)), height = Math.max(1, Math.round(size.height * scale))
        const thumbnail = pixels.resize({ width, height, quality: 'good' }), bytes = thumbnail.toJPEG(55)
        if (bytes.length > BROWSER_RECOVERY_PREVIEW_MAX_IMAGE_BYTES) {
          console.warn('Browser preview exceeded its image budget. The original page remains available.')
          return
        }
        const result = await store.record(scope, { scope, url, title, navigationId, capturedAt,
          image: { width, height, dataUrl: BROWSER_RECOVERY_PREVIEW_JPEG_PREFIX + bytes.toString('base64') }
        }, current, controller.signal)
        if (result.status === 'recorded') entry.recoveryPreviewNavigation = navigationId
        if (result.warning) console.warn(result.warning)
      } catch (error) {
        if (!controller.signal.aborted) console.warn('Browser preview could not be captured. The original page remains available.', error)
      } finally {
        if (entry.recoveryPreviewJob === controller) entry.recoveryPreviewJob = undefined
        // A replacement document may have become visible while the old capture was in flight.
        if (this.owns(entry, entry.view) && (entry.navigationId !== navigationId || controller.signal.aborted)) this.sampleRecoveryPreview(entry, entry.view)
      }
    })()
  }

  close(id: string): void | Promise<void> {
    const previewScope = this.recoveryPreviewScope(id)
    const entry = this.entries.get(id)
    if (entry?.nativeChild) return this.closeNativeChild(entry).then(closed => {
      if (!closed) throw new Error('The page stayed open. Its original Browser and workface are kept.')
    })
    if (entry) { entry.recoveryPreviewRetired = true; this.cancelRecoveryPreview(entry) }
    const storage = this.entries.get(id)?.storage ?? this.releasedEntries.get(id)?.storage
    if (storage?.mode === 'private') return this.closePrivateOwner(id, storage)
    // Ordered behind any publication already in progress, independent of native teardown success.
    if (previewScope) void this.recoveryPreviews?.remove(previewScope)
    const previous = this.closingOwners(id), errors: unknown[] = []
    let removed = false
    try { removed = this.destroyOwner(id) } catch (error) { errors.push(error) }
    try { this.retryClosingViews(previous) } catch (error) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Browser closed with native cleanup failures.')
    if (removed || previous.length) this.send({ type: 'closed', id })
  }

  private async closePrivateOwner(id: string, storage: Extract<BrowserStorage, { mode: 'private' }>, notify = true): Promise<void> {
    const failures: unknown[] = [], previousClosures = this.closingOwners(id)
    const entry = this.entries.get(id)
    const previewScope = this.recoveryPreviewScope(id)
    if (entry) { entry.recoveryPreviewRetired = true; this.cancelRecoveryPreview(entry) }
    if (previewScope) void this.recoveryPreviews?.remove(previewScope)
    try { this.destroyOwner(id) } catch (error) { failures.push(error) }
    // A failed native teardown must still retire this incarnation. Late popup callbacks compare
    // this exact storage object; a newly created Browser with the same id remains independent.
    if (this.entries.get(id)?.storage === storage) {
      if (entry) this.retainClosedInputShield(entry)
      this.entries.delete(id)
    }
    // destroyOwner can remove the map entry before native close throws. Keep using the captured
    // exact view to finish that consumer, independently of any later incarnation with this id.
    try { if (entry && !entry.view.webContents.isDestroyed() && !this.window.isDestroyed()) this.detachView(entry.view) } catch (error) { failures.push(error) }
    try { if (entry && !entry.view.webContents.isDestroyed() && !this.closingViews.get(id)?.has(entry.view)) this.closeNativeView(entry, entry.view) } catch (error) { failures.push(error) }
    try { this.retryClosingViews(previousClosures) } catch (error) { failures.push(error) }
    if (this.releasedEntries.get(id)?.storage === storage && !this.releasedEntries.get(id)?.inputShield) this.releasedEntries.delete(id)
    try { if (notify) this.send({ type: 'closed', id }) } catch (error) { failures.push(error) }
    try { await this.clearPrivateStorage(storage) } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Private Browser closed with website-data cleanup failures.')
  }

  private async clearPrivateStorage(storage: Extract<BrowserStorage, { mode: 'private' }>): Promise<void> {
    // A Session has no public destroy API. End its consumers, clear only this session and never
    // reuse its partition; failure cannot send a future Browser back into this incarnation.
    const failures: unknown[] = []
    for (const child of [...this.entries.values()].filter(entry => entry.storage === storage)) {
      // The private root ends the whole original website Session. Closing an
      // individual child never reaches this shared-storage cleanup.
      try { if (this.destroyOwner(child.id)) this.send({ type: 'closed', id: child.id }) } catch (error) { failures.push(error) }
    }
    try { this.webAuthnSessions.get(storage.session)?.() } catch (error) { failures.push(error) }
    this.webAuthnSessions.delete(storage.session)
    // A native consumer whose teardown failed must not fall back to Electron's permission
    // defaults. This retired session has no future owner and is never used for a new Browser.
    for (const deny of [
      () => storage.session.setPermissionCheckHandler(() => false),
      () => storage.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)),
      () => storage.session.setDevicePermissionHandler(() => false)
    ]) {
      try { deny() } catch (error) { failures.push(error) }
    }
    const results = await Promise.allSettled([
      () => storage.session.clearStorageData(), () => storage.session.clearCache(), () => storage.session.closeAllConnections()
    ].map(cleanup => Promise.resolve().then(cleanup)))
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
    if (failures.length) throw new AggregateError(failures, 'Private website-data cleanup was incomplete.')
  }

  /** Native teardown has no authority to retire the Renderer Region. */
  private destroyOwner(id: string): boolean {
    const entry = this.entries.get(id)
    if (entry) this.cancelRecoveryPreview(entry)
    if (!entry) {
      const released = this.releasedEntries.get(id)
      if (!released) return false
      if (released.inputShield) released.cleanupOnly = true
      this.cleanupReleasedOwner(released)
      if (!released.inputShield && !this.inputSurfaceCleanup.has(id)) this.releasedEntries.delete(id)
      return true
    }
    const surface = this.inputSurfaces.get(entry.view)
    if (surface) {
      surface.presentations.clear()
      if (!entry.inputShield) entry.inputShield = surface.shield
    }
    this.releaseInputShield(entry)
    this.cancelPendingSwitch(entry, new Error('Browser owner released during profile switch'))
    cancelBrowserWebAuthnAccounts(entry.view.webContents)
    cancelBrowserWebAuthnAccess(entry.view.webContents)
    this.revokePresentationCapture(entry, 'source-released')
    if (entry.captureId) this.presentationCaptures.delete(entry.captureId)
    entry.captureId = null
    for (const leaseId of [...entry.presentationLeaseIds]) this.removePresentationLease(this.presentationLeases.get(leaseId)!)
    this.releaseUploadFiles(entry)
    void entry.feedback?.hide()
    void entry.controlFeedback?.hide()
    void this.releaseDemonstrationCapture(entry)
    if (!entry.view.webContents.isDestroyed()) {
      entry.selectionOperation = null
      const selectionRevision = ++entry.selectionRevision
      const annotationRevision = ++entry.annotationRevision
      void entry.view.webContents.executeJavaScriptInIsolatedWorld(
        BROWSER_SELECTION_WORLD_ID,
        [{ code: buildCancelBrowserElementSelectionScript(selectionRevision) }]
      ).catch(() => {})
      void entry.view.webContents.executeJavaScriptInIsolatedWorld(
        BROWSER_SELECTION_WORLD_ID,
        [{ code: buildBrowserAnnotationMarkerScript([], annotationRevision) }]
      ).catch(() => {})
    }
    this.clearFavicon(entry)
    this.retainClosedInputShield(entry)
    this.entries.delete(id)
    this.notifyNativeVisibility(this.windowForView(entry.view))
    if (!this.window.isDestroyed()) {
      try { this.detachView(entry.view) } catch { /* already detached */ }
    }
    this.closeNativeView(entry, entry.view)
    return true
  }

  dispose(): void {
    const previousClosures = this.closingOwners(), cleanupErrors: unknown[] = [], privateClosures = new Set<string>()
    this.presentationDisposed = true
    this.invalidatePresentationRequester()
    this.disposePresentationRequester?.()
    this.disposePresentationRequester = null
    this.presentationCaptures.clear()
    this.unsubscribeTaskAssets?.()
    for (const id of [...this.entries.keys(), ...this.releasedEntries.keys()]) {
      const storage = this.entries.get(id)?.storage ?? this.releasedEntries.get(id)?.storage
      if (storage?.mode === 'private') {
        privateClosures.add(id)
        void this.closePrivateOwner(id, storage, false).catch(error => console.warn('Private website-data cleanup failed during disposal:', error))
      }
    }
    // Retire private incarnations before the existing normal teardown, whose synchronous error
    // contract is preserved. A normal native failure cannot strand a later private consumer.
    for (const id of [...this.entries.keys(), ...this.releasedEntries.keys()]) {
      try { this.destroyOwner(id) } catch (error) { cleanupErrors.push(error) }
    }
    try { this.retryClosingViews(previousClosures.filter(owner => !privateClosures.has(owner.id))) } catch (error) { cleanupErrors.push(error) }
    for (const unsubscribe of this.webAuthnSessions.values()) unsubscribe()
    this.webAuthnSessions.clear()
    for (const session of this.capsuleResponseSessions) {
      session.webRequest.onBeforeRequest(null)
      session.webRequest.onResponseStarted(null)
    }
    this.capsuleResponseSessions.clear()
    void this.uploads?.dispose().catch(error => console.warn('Browser upload staging cleanup failed during disposal:', error))
    void this.recoveryPreviews?.dispose().catch(error => console.warn('Browser preview cleanup failed during disposal:', error))
    if (cleanupErrors.length === 1) throw cleanupErrors[0]
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Browser native cleanup failed during disposal.')
  }

  /** Staging IO never blocks a healthy Browser; only this document's selected files are released. */
  private releaseUploadFiles(entry: BrowserEntry): void {
    void this.uploads?.releaseBrowser(entry.id).catch(() => {
      if (this.entries.get(entry.id) !== entry || entry.view.webContents.isDestroyed()) return
      entry.activity = { ...entry.activity, warning: 'Selected-file staging could not be fully released. The Browser remains usable; navigate or close it to retry cleanup.' }
      this.emit(entry)
    })
  }

  private attach(entry: BrowserEntry, view: WebContentsView): BrowserControlFeedback {
    this.entriesByContents.set(view.webContents, entry)
    this.browserIdsByView.set(view, entry.id)
    const contents = view.webContents
    contents.on('will-prevent-unload', () => {
      // The same event can veto reload/navigation. Only a recorded Close intent
      // may ask to close this page; ordinary navigation never becomes Close.
      if (entry.nativeChild?.closing && this.owns(entry, view)) void this.confirmNativeChildClose(entry, view)
    })
    const controlFeedback: BrowserControlFeedback = new BrowserControlFeedback({ contents, browserId: entry.id, ownerId: mintObjectId(),
      navigationId: () => entry.navigationId, nextRevision: () => ++entry.feedbackRevision,
      isCurrent: () => this.owns(entry, view) && entry.controlFeedback === controlFeedback && this.agentOwnsInput(entry) &&
        (entry.visible || this.hasVisiblePresentation(entry)),
      preferences: this.feedbackPreferences,
      report: available => {
        if (!this.owns(entry, view) || entry.controlFeedback !== controlFeedback) return
        const warning = 'Browser control feedback could not be displayed. The page and Agent remain usable; show the page again or save its appearance to retry.'
        // Reconcile only this display notice. It never grants or revokes input authority.
        const current = entry.activity.warning?.split('\n') ?? []
        const lines = available ? current.filter(line => line !== warning)
          : current.includes(warning) ? current : [...current, warning]
        const next = lines.length ? lines.join('\n') : undefined
        if (next === entry.activity.warning) return
        const { warning: _warning, ...activity } = entry.activity
        entry.activity = { ...activity, ...(next === undefined ? {} : { warning: next }) }
        this.emit(entry)
      } })
    // A Profile candidate does not own this Browser until the prepared view commits.
    if (entry.view === view) entry.controlFeedback = controlFeedback
    installTextEditContextMenu(contents, () => this.windowForView(view), {
      isCurrent: () => this.nativeOwner(entry.id)?.view === view && !this.agentOwnsInput(entry),
      origin: () => view.getBounds()
    })
    contents.on('input-event', (_event, input) => {
      if (!BROWSER_PASSIVE_INPUT_TYPES.has(input.type)) this.markResourceRisk(entry, view, 'document-used')
      if (this.owns(entry, view) && !this.agentOwnsInput(entry) && BROWSER_FEEDBACK_CLEAR_INPUT_TYPES.has(input.type)) void entry.feedback?.clear()
      if (!this.onNativeInput || !this.owns(entry, view) || !['mouseDown', 'mouseMove', 'mouseEnter', 'mouseLeave'].includes(input.type)) return
      const owner = this.nativeOwner(entry.id)
      if (owner) this.onNativeInput(owner, { type: 'pointer', event: input as Electron.MouseInputEvent })
    })
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown') this.markResourceRisk(entry, view, 'document-used')
      // Native keys may already be queued for the old focused page when its child
      // shield takes focus. CDP key input bypasses this native boundary in Electron.
      if (this.owns(entry, view) && this.agentOwnsInput(entry) && entry.inputShield?.isolated) {
        event.preventDefault()
        if (contents.isFocused()) {
          if (this.inputSurfaces.get(view)?.presentations.size) this.windowForView(view).webContents.focus()
          else entry.inputShield.contents.focus()
        }
        return
      }
      // Only this real page's non-IME Escape may be consumed by its open containing float.
      // Electron Input.isComposing is authoritative; input-event keyboard modifiers are not.
      if (!this.onNativeInput || !this.owns(entry, view) || input.type !== 'keyDown' || input.key !== 'Escape' || input.isComposing) return
      const owner = this.nativeOwner(entry.id)
      if (owner && this.onNativeInput(owner, { type: 'escape' })) event.preventDefault()
    })
    const guardNavigation = (event: { url: string; isMainFrame: boolean; preventDefault(): void }): void => {
      // 应用链接在闸门**之前**分流。闸门本身逐字不变：`customapp://` 装不进 WebContentsView，它要的不是
      // 放行进视图，是改道给系统。两件事分开之后，`javascript:` 一类仍然原地死在闸门上。
      const target = classifyBrowserTarget(event.url)
      if (target.kind === 'hand-off') {
        event.preventDefault()
        if (!this.owns(entry, view)) return
        void this.handOffAppLink(entry, event.url, target.scheme!)
        return
      }
      // 普通 child-frame navigation belongs to the page. Only the application-link
      // branch above crosses the Browser boundary for embedded frames.
      if (!event.isMainFrame) return
      try {
        assertAllowedBrowserUrl(event.url)
        if (this.owns(entry, view)) entry.nativeChild?.closing?.settle(false)
      } catch (error) {
        event.preventDefault()
        if (!this.owns(entry, view)) return
        entry.error = error instanceof Error ? error.message : String(error)
        this.emit(entry)
      }
    }
    contents.on('will-navigate', guardNavigation)
    // Chromium reports cross-origin child-frame src changes through this event;
    // An external app's device-authorize iframe uses exactly that path.
    contents.on('will-frame-navigate', guardNavigation)
    contents.on('will-redirect', guardNavigation)
    // Application schemes keep their original handoff. For native website windows,
    // Electron finishes the original request using its complete child-creation options.
    {
      installNativeBrowserWindows(contents, {
        create: options => this.createNativeChild(entry, view, options),
        handOff: (target, scheme) => {
        if (!this.owns(entry, view)) return
        void this.handOffAppLink(entry, target, scheme)
        },
        report: (warning, page) => {
          const owner = page ? this.entriesByContents.get(page) : entry
          if (!owner || !this.owns(owner, owner.view)) return
          owner.activity = { ...owner.activity, warning }
          this.emit(owner)
        }
      })
    }
    contents.on('devtools-opened', () => this.emitRetentionChange(entry))
    contents.on('devtools-closed', () => this.emitRetentionChange(entry))
    contents.on('media-started-playing', () => this.markResourceRisk(entry, view, 'media'))
    contents.on('did-finish-load', () => {
      if (!this.owns(entry, view)) return
      contents.setZoomFactor(DEFAULT_BROWSER_ZOOM_FACTOR)
      this.applyViewport(entry, view)
      void this.refreshFaviconAfterLoad(entry, view)
    })
    contents.on('dom-ready', () => {
      if (!this.owns(entry, view)) return
      void entry.controlFeedback?.synchronize(true)
      const document = entry.initialDocument
      if (!this.owns(entry, view) || !document || document.view !== view ||
        !document.navigationId || document.navigationId !== entry.navigationId ||
        document.committedNavigationId !== entry.navigationId) return
      // The original viewport policy must be active before the first consumer,
      // even when images or child frames keep the full load in progress.
      contents.setZoomFactor(DEFAULT_BROWSER_ZOOM_FACTOR)
      this.applyViewport(entry, view)
      document.resolve()
    })
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument && this.faviconUrls.get(view)?.documentUrl !== details.url) this.faviconUrls.delete(view)
      if (!details.isMainFrame || !this.owns(entry, view)) return
      this.cancelRecoveryPreview(entry)
      let requestedUrl: string
      try {
        requestedUrl = assertAllowedBrowserUrl(details.url)
      } catch {
        // `will-navigate`/`will-redirect` owns rejection and error publication. Do not replace a
        // known-good projection with an unsupported target if an embedder emits this callback first.
        return
      }
      // A new main-frame navigation supersedes Close of the prior document. Its
      // late unload answer cannot close the new document or block a fresh Close.
      entry.nativeChild?.closing?.settle(false)
      // The originating explicit operation already attempted cleanup of a canceled candidate.
      // Its late native navigation fact must not retry cleanup or stop this healthy page.
      if (entry.pendingSwitch?.token === entry.switchRevision) {
        this.cancelPendingSwitchForNavigation(entry, new Error('Browser profile switch was superseded by navigation'))
      }
      // A pending picker has no document handles yet. The initial navigation can
      // settle without canceling it; explicit cancel still clears this owner token.
      if (typeof entry.selectionOperation !== 'symbol' || !entry.initialDocument) entry.selectionOperation = null
      void entry.feedback?.hide()
      void entry.controlFeedback?.hide()
      const selectionRevision = ++entry.selectionRevision
      const annotationRevision = ++entry.annotationRevision
      void contents.executeJavaScriptInIsolatedWorld(
        BROWSER_SELECTION_WORLD_ID,
        [{ code: buildCancelBrowserElementSelectionScript(selectionRevision) }]
      ).catch(() => {})
      void contents.executeJavaScriptInIsolatedWorld(
        BROWSER_SELECTION_WORLD_ID,
        [{ code: buildBrowserAnnotationMarkerScript([], annotationRevision) }]
      ).catch(() => {})
      this.clearFavicon(entry, details.isSameDocument)
      entry.requestedUrl = requestedUrl
      const previousNavigationId = entry.navigationId
      entry.navigationId = mintObjectId()
      entry.appLinkRequest = null
      entry.appLinkPrompt = null
      entry.committedNavigationId = null
      if (details.isSameDocument && entry.capsuleResponse?.navigationId === previousNavigationId) entry.capsuleResponse.navigationId = entry.navigationId
      else { entry.capsuleRequest = null; entry.capsuleResponse = null }
      const document = entry.initialDocument
      if (document?.view === view && (!details.isSameDocument || document.navigationId)) {
        const previous = document.navigationId
        document.navigationId = entry.navigationId
        if (details.isSameDocument) {
          if (document.loadNavigationId === previous) document.loadNavigationId = entry.navigationId
          if (document.committedNavigationId === previous) document.committedNavigationId = entry.navigationId
        } else {
          document.loadNavigationId ??= entry.navigationId
          document.committedNavigationId = null
        }
      }
      entry.error = null
      this.emit(entry)
    })
    contents.on('did-start-loading', () => {
      if (!this.owns(entry, view)) return
      entry.error = null
      this.emit(entry)
    })
    contents.on('did-stop-loading', () => {
      if (!this.owns(entry, view)) return
      // did-finish-load can still report isLoading() === true; synchronize only once
      // Electron's public loading state has settled, retaining the current page policy.
      this.synchronizeVisiblePage(entry, view)
      this.sampleRecoveryPreview(entry, view)
      this.emit(entry)
      if ('capsule' in entry.storage && entry.storage.capsule.record.mode === 'injected' && this.isCapsuleDocument(entry, contents.mainFrame)) {
        try { this.capsuleDocumentReady?.(entry.id) }
        catch { /* Optional appearance cannot take away the original document or its available SDK methods. */ }
      }
    })
    contents.on('did-navigate', (_event, url) => {
      if (!this.owns(entry, view)) return
      entry.nativeChild?.closing?.settle(false)
      const document = entry.initialDocument
      if (document?.view === view && document.navigationId === entry.navigationId) document.committedNavigationId = entry.navigationId
      entry.committedNavigationId = entry.navigationId
      entry.resourceDocumentConfirmed = true
      this.releaseUploadFiles(entry)
      entry.requestedUrl = url
      entry.error = null
      this.emit(entry)
    })
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame || !this.owns(entry, view)) return
      entry.nativeChild?.closing?.settle(false)
      entry.committedNavigationId = entry.navigationId
      const reported = this.faviconUrls.get(view)
      if (reported) this.faviconUrls.set(view, { ...reported, documentUrl: url })
      entry.requestedUrl = url
      this.sampleRecoveryPreview(entry, view)
      this.emit(entry)
    })
    contents.on('page-favicon-updated', (_event, urls) => {
      this.faviconUrls.set(view, { documentUrl: contents.getURL(), navigationId: this.owns(entry, view) ? entry.navigationId : undefined, urls })
      if (this.owns(entry, view)) this.updateFavicon(entry, view)
    })
    contents.on('page-title-updated', () => {
      if (!this.owns(entry, view)) return
      this.emit(entry)
    })
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || !this.owns(entry, view)) return
      this.cancelRecoveryPreview(entry)
      entry.requestedUrl = validatedURL || entry.requestedUrl
      entry.error = `${errorDescription} (${errorCode})`
      this.emit(entry)
    })
    contents.on('render-process-gone', (_event, details) => {
      if (!this.owns(entry, view)) return
      entry.committedNavigationId = null
      entry.appLinkRequest = null
      entry.appLinkPrompt = null
      this.cancelRecoveryPreview(entry)
      this.revokePresentationCapture(entry, 'source-replaced')
      entry.error = `Browser renderer stopped: ${details.reason}`
      this.emit(entry)
    })
    contents.once('destroyed', () => {
      this.entriesByContents.delete(contents)
      if (entry.view === view) entry.nativeChild?.closing?.settle(true)
      if (entry.view === view) this.cancelRecoveryPreview(entry)
      const attempt = entry.releaseAttempt
      if (attempt?.view === view) attempt.settle('released', [])
      if (this.owns(entry, view)) this.clearFavicon(entry)

      if (entry.pendingSwitch?.view === view) {
        try { this.cancelPendingSwitch(entry, new Error('Browser profile candidate was destroyed')) } catch (error) {
          if (!this.owns(entry, entry.view) || entry.view.webContents.isDestroyed()) return
          const warning = error instanceof Error ? error.message : String(error)
          if (entry.pendingSwitch) entry.pendingSwitch.cleanupWarning = warning
          entry.activity = { ...entry.activity, warning }
          this.emit(entry)
        }
        return
      }
      if (!this.owns(entry, view)) return
      const nativeWindow = entry.nativeChild ? this.windowForView(view) : null
      // Native destruction is authoritative even if a separate resource's cleanup throws. Retain
      // only the existing metadata: a dead WebContents cannot supply a fresh live snapshot.
      const released: ReleasedBrowser = {
        id: entry.id, workspaceId: entry.workspaceId, storage: entry.storage, requestedUrl: entry.requestedUrl, viewport: entry.viewport, agent: entry.agent, agentWarning: entry.agentWarning
      }
      this.releasedEntries.set(entry.id, released)
      const cleanupErrors: unknown[] = []
      this.releaseInputShield(entry)
      if (entry.inputShield) { released.inputShield = entry.inputShield; entry.inputShield = undefined }
      try { this.revokePresentationCapture(entry, 'source-released') } catch (error) { cleanupErrors.push(error) }
      if (entry.captureId) this.presentationCaptures.delete(entry.captureId)
      entry.captureId = null
      for (const leaseId of [...entry.presentationLeaseIds]) {
        try { this.removePresentationLease(this.presentationLeases.get(leaseId)!) } catch (error) { cleanupErrors.push(error) }
      }
      try { void this.releaseDemonstrationCapture(entry) } catch (error) { cleanupErrors.push(error) }
      try { this.releaseUploadFiles(entry) } catch (error) { cleanupErrors.push(error) }
      try { this.cancelPendingSwitch(entry, new Error('Browser native owner was destroyed during profile switch')) } catch (error) {
        cleanupErrors.push(error)
        if (entry.pendingSwitch) released.pendingSwitch = entry.pendingSwitch
      }
      if (this.entries.get(entry.id) !== entry || entry.view !== view) return
      this.entries.delete(entry.id)
      this.notifyNativeVisibility(this.windowForView(view))
      if (!this.window.isDestroyed()) {
        try { this.detachView(view) } catch (error) {
          released.detachedView = view
          cleanupErrors.push(error)
        }
      }
      if (entry.releaseAttempt?.view === view) {
        this.send({ type: 'released', id: entry.id, navigationId: entry.navigationId })
        return
      }
      if (entry.nativeChild) {
        // The original child page ended, rather than becoming a restorable URL.
        released.cleanupOnly = true
        if (!released.inputShield && !released.pendingSwitch && !released.detachedView && !cleanupErrors.length) this.releasedEntries.delete(entry.id)
        entry.nativeChild.closing?.settle(true)
        this.send({ type: 'closed', id: entry.id })
        if (nativeWindow && nativeWindow !== this.window && !nativeWindow.isDestroyed()) nativeWindow.close()
        return
      }
      const reason = [...cleanupErrors.map(error => error instanceof Error ? error.message : String(error)),
        ...(released.inputShield ? ['Native input surface cleanup is unconfirmed; reopening or Close retries its retained cleanup identity.'] : [])].join('; ')
      this.send({ type: 'unavailable', id: entry.id, error: 'Browser native page was destroyed. Retry to reopen this page.' + (reason ? ` Cleanup failed: ${reason}` : '') })
    })
    return controlFeedback
  }

  private require(id: string): BrowserEntry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Unknown browser: ${id}`)
    return entry
  }

  private assertWorkspaceBinding(bound: string | null, requested: string | null): void {
    // Unknown remains unknown; a recovery handshake never upgrades or replaces this owner's binding.
    if (bound !== null && requested !== null && bound !== requested) {
      throw new Error('This Browser belongs to another Workspace. Restore its original Workspace binding.')
    }
  }

  private createView(partition: string, capsule?: CapsuleRecord): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition,
        ...(capsule?.mode === 'injected' ? { preload: fileURLToPath(new URL('../preload/capsule.cjs', import.meta.url)) } : {}),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })
    const session = view.webContents.session
    if (capsule && !this.capsuleResponseSessions.has(session)) {
      this.capsuleResponseSessions.add(session)
      const owner = (details: { webContents?: WebContents; frame?: WebFrameMain | null; resourceType: string; url: string }): BrowserEntry | null => {
        try {
          const sender = details.webContents, frame = details.frame
          if (!sender || !frame || details.resourceType !== 'mainFrame') return null
          const entry = this.entriesByContents.get(sender)
          if (!entry || !('capsule' in entry.storage) || !this.owns(entry, entry.view) || entry.view.webContents !== sender ||
            sender.isDestroyed() || frame.detached || frame.isDestroyed() || frame !== sender.mainFrame) return null
          return new URL(details.url).origin === entry.storage.capsuleOrigin ? entry : null
        } catch { return null }
      }
      session.webRequest.onBeforeRequest((details, callback) => {
        try {
          const entry = owner(details)
          if (entry) entry.capsuleRequest = { id: details.id, navigationId: entry.navigationId, frame: details.frame! }
        } catch { /* An unconfirmed observation cannot interrupt the original HTTP request. */ }
        finally { callback({}) }
      })
      session.webRequest.onResponseStarted(details => {
        const entry = owner(details), request = entry?.capsuleRequest
        if (!entry || !request || request.id !== details.id || request.navigationId !== entry.navigationId ||
          request.frame !== details.frame || details.statusCode < 200 || details.statusCode >= 300) return
        const headers = Object.entries(details.responseHeaders ?? {}).filter(([name]) => name.toLowerCase() === 'x-agentmux-capsule-instance')
        const values = headers.length === 1 ? headers[0]![1] : []
        if (values.length !== 1 || !isObjectId(values[0])) return
        entry.capsuleResponse = { instanceId: values[0], navigationId: entry.navigationId, frame: details.frame! }
      })
    }
    if (!this.webAuthnSessions.has(session)) {
      const resolveOwner = (contents: WebContents): BrowserWebAuthnOwner | null => this.webAuthnOwner(contents)
      const releaseAccess = registerBrowserWebAuthnAccess(session, resolveOwner)
      const releaseAccounts = registerBrowserWebAuthnAccounts(session, resolveOwner)
      const downloading = (_event: Electron.Event, _item: Electron.DownloadItem, contents: WebContents): void => {
        const entry = [...this.entries.values()].find(candidate => candidate.view.webContents === contents)
        if (entry) this.markResourceRisk(entry, entry.view, 'download')
      }
      session.on('will-download', downloading)
      this.webAuthnSessions.set(session, () => { releaseAccess(); releaseAccounts(); session.removeListener('will-download', downloading) })
    }
    return view
  }

  private webAuthnOwner(contents: WebContents): BrowserWebAuthnOwner | null {
    const entry = [...this.entries.values()].find(candidate => candidate.view.webContents === contents)
    if (!entry) return null
    const view = entry.view
    const profileId = entry.storage.profileId
    const navigationId = entry.navigationId
    const ownsRequest = (): boolean => this.owns(entry, view) && entry.storage.profileId === profileId && entry.navigationId === navigationId
    const currentWindow = () => this.windowForView(view)
    const currentBounds = (): BrowserBounds | null => this.nativeOwner(entry.id)?.bounds ?? null
    return {
      get window() { return currentWindow() },
      get bounds() { return currentBounds() },
      isCurrent: () => ownsRequest() && !contents.isDestroyed() &&
        !currentWindow().isDestroyed(),
      report: message => {
        // Hidden original pages keep their notice. Visibility never changes the request's owner.
        if (!ownsRequest()) return
        entry.activity = { ...entry.activity, warning: message }
        this.emit(entry)
      }
    }
  }

  private resolvePartition(profileId: string): string {
    if (!profileId.trim()) throw new Error('Browser profile id is required')
    const partition = this.profiles.resolvePartition(profileId)
    if (!partition.trim()) throw new Error(`Browser profile has no partition: ${profileId}`)
    return partition
  }

  private owns(entry: BrowserEntry, view: WebContentsView): boolean {
    return this.entries.get(entry.id) === entry && entry.view === view
  }

  private cancelPendingSwitchForNavigation(entry: BrowserEntry, error: Error): void {
    const view = entry.view
    try { this.cancelPendingSwitch(entry, error) } catch (cleanupError) {
      // A broken candidate cannot take away an independently healthy original page. Cancellation
      // has fenced the candidate and retained its cleanup reference; only explicit operations retry.
      if (!this.owns(entry, view) || view.webContents.isDestroyed()) throw cleanupError
      const warning = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      if (entry.pendingSwitch) entry.pendingSwitch.cleanupWarning = warning
      entry.activity = { ...entry.activity, warning }
      this.emit(entry)
    }
  }

  private cancelPendingSwitch(entry: BrowserEntry, error: Error): void {
    entry.switchRevision += 1
    const pending = entry.pendingSwitch
    if (!pending) return
    entry.pendingSwitch = null
    try {
      this.releasePendingSwitch(pending)
      if (pending.cleanupWarning && entry.activity.warning === pending.cleanupWarning) {
        const { warning: _warning, ...activity } = entry.activity
        entry.activity = activity
      }
      delete pending.cleanupWarning
    } catch (cleanupError) {
      if (!pending.released) entry.pendingSwitch = pending
      error = new AggregateError([error, cleanupError], `${error.message}; ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
      throw error
    } finally { pending.rejectCancellation(error) }
  }

  private releasePendingSwitch(pending: PendingProfileSwitch): void {
    if (pending.released) return
    const errors: unknown[] = []
    if (pending.attached) {
      try {
        if (!this.window.isDestroyed()) this.detachView(pending.view)
        pending.attached = false
      } catch (error) { errors.push(error) }
    }
    try { if (!pending.view.webContents.isDestroyed()) pending.view.webContents.close() } catch (error) { errors.push(error) }
    pending.released = !pending.attached && pending.view.webContents.isDestroyed()
    if (!pending.released && !errors.length) errors.push(new Error('Browser profile candidate cleanup is not confirmed. Its original cleanup reference is kept.'))
    if (errors.length) throw new AggregateError(errors, 'Browser profile candidate cleanup failed: ' + errors.map(error => error instanceof Error ? error.message : String(error)).join('; '))
  }

  private retainClosedInputShield(entry: BrowserEntry): void {
    if (!entry.inputShield && !this.inputSurfaceCleanup.has(entry.id)) return
    this.releasedEntries.set(entry.id, { id: entry.id, workspaceId: entry.workspaceId, storage: entry.storage,
      requestedUrl: entry.requestedUrl, viewport: entry.viewport, agent: entry.agent, agentWarning: entry.agentWarning, ...(entry.inputShield ? { inputShield: entry.inputShield } : {}), cleanupOnly: true })
    entry.inputShield = undefined
  }

  private cleanupReleasedOwner(released: ReleasedBrowser): void {
    const errors: unknown[] = []
    for (const surface of this.inputSurfaceCleanup.get(released.id) ?? []) {
      try {
        surface.shield.dispose()
        this.forgetInputSurfaceCleanup(surface)
      } catch { /* The exact pending native cleanup remains available for another explicit Close. */ }
    }
    if (released.inputShield) {
      try { released.inputShield.dispose(); delete released.inputShield }
      catch { /* Keep its unique cleanup reference; a healthy same-ID restore remains available. */ }
    }
    if (released.pendingSwitch) {
      try {
        this.releasePendingSwitch(released.pendingSwitch)
        delete released.pendingSwitch
      } catch (error) { errors.push(error) }
    }
    if (released.detachedView) {
      try {
        if (!this.window.isDestroyed()) this.detachView(released.detachedView)
        delete released.detachedView
      } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Browser native cleanup failed: ' + errors.map(error => error instanceof Error ? error.message : String(error)).join('; '))
  }

  private applyViewport(entry: BrowserEntry, view = entry.view, viewport = entry.viewport): void {
    const contents = view.webContents
    const size = browserViewportSize(viewport)
    if (size === null) {
      contents.disableDeviceEmulation()
      return
    }
    // Desktop emulation includes page zoom in its layout size. Compensate locally:
    // changing zoom would also change same-origin pages in this profile.
    const zoom = contents.getZoomFactor()
    const viewSize = size.screenPosition === 'desktop'
      ? { width: Math.round(size.width * zoom), height: Math.round(size.height * zoom) }
      : { width: size.width, height: size.height }
    if (!isBrowserViewport({ ...viewSize, screenPosition: size.screenPosition })) {
      throw new Error('Browser viewport dimensions cannot be represented at the current page zoom')
    }
    const scale = entry.bounds
      ? Math.min(1, entry.bounds.width / viewSize.width, entry.bounds.height / viewSize.height)
      : 1
    contents.enableDeviceEmulation({
      screenPosition: size.screenPosition,
      screenSize: { width: size.width, height: size.height },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize,
      scale
    })
  }

  private clearFavicon(entry: BrowserEntry, keepImage = false): void {
    entry.faviconRequest?.abort()
    entry.faviconRequest = undefined
    entry.faviconUrl = undefined
    if (!keepImage) entry.faviconDataUrl = undefined
  }

  /** Chromium may omit an unchanged icon event on reload. Revalidate its earlier report in this document. */
  private async refreshFaviconAfterLoad(entry: BrowserEntry, view: WebContentsView): Promise<void> {
    const reported = this.faviconUrls.get(view), navigationId = entry.navigationId
    if (!this.owns(entry, view) || !reported?.urls[0] || reported.documentUrl !== view.webContents.getURL() || reported.navigationId === navigationId) return
    let url: string
    try { url = new URL(reported.urls[0], reported.documentUrl).href } catch { return }
    let timer: ReturnType<typeof setTimeout> | undefined
    let confirmed = false
    try {
      confirmed = await Promise.race([
        view.webContents.executeJavaScript(`Array.from(document.querySelectorAll('link[rel~="icon" i]')).some(link => link.href === ${JSON.stringify(url)})`),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), BROWSER_FAVICON_TIMEOUT_MS) })
      ]) === true
    } catch { /* Optional artwork remains generic when the current declaration cannot be observed. */ }
    finally { if (timer) clearTimeout(timer) }
    if (!this.owns(entry, view) || entry.navigationId !== navigationId || this.faviconUrls.get(view) !== reported || reported.documentUrl !== view.webContents.getURL()) return
    if (!confirmed) { this.faviconUrls.delete(view); this.clearFavicon(entry); this.emit(entry); return }
    this.updateFavicon(entry, view)
  }

  private updateFavicon(entry: BrowserEntry, view: WebContentsView): void {
    if (!this.owns(entry, view)) return
    const reported = this.faviconUrls.get(view)?.urls[0]
    if (!reported) { this.clearFavicon(entry); this.emit(entry); return }
    let url: string
    try { url = new URL(reported, view.webContents.getURL()).href } catch { this.clearFavicon(entry); this.emit(entry); return }
    if (entry.faviconUrl === url && (entry.faviconDataUrl || entry.faviconRequest)) return
    this.clearFavicon(entry)
    const request = new AbortController(), navigationId = entry.navigationId, profileId = entry.storage.profileId
    entry.faviconUrl = url
    entry.faviconRequest = request
    this.emit(entry)
    void readBrowserFavicon(view.webContents.session, url, request.signal).then(dataUrl => {
      if (request.signal.aborted || entry.faviconRequest !== request || !this.owns(entry, view) || entry.navigationId !== navigationId || entry.storage.profileId !== profileId) return
      entry.faviconRequest = undefined
      entry.faviconDataUrl = dataUrl
      this.emit(entry)
    })
  }

  private snapshot(entry: BrowserEntry): BrowserSnapshot {
    const contents = entry.view.webContents
    const persistenceWarning = this.operationJournal?.getPersistenceWarning()
    const currentWarnings = [entry.agentWarning, entry.activity.warning ?? persistenceWarning].filter(Boolean).join(' ')
    const warning = this.closingWarning(entry.id, currentWarnings || undefined)
    return {
      id: entry.id,
      ...(entry.source ? { source: entry.source } : {}),
      mode: entry.storage.mode,
      navigationId: entry.navigationId,
      faviconDataUrl: entry.faviconDataUrl,
      profileId: entry.storage.profileId,
      ...('capsule' in entry.storage ? { capsuleId: entry.storage.capsule.record.capsuleId,
        capsuleOrigin: entry.storage.capsuleOrigin, capsuleOpenOperationIds: [...entry.storage.capsuleOpenOperationIds],
        capsuleActive: this.isCapsuleDocument(entry, contents.mainFrame) } : {}),
      url: contents.getURL() || entry.requestedUrl,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      viewport: entry.viewport,
      error: entry.error,
      driving: entry.driving,
      retention: this.retention(entry),
      control: this.controlState(entry),
      ...(entry.demonstration ? { demonstration: entry.demonstration } : {}),
      ...(entry.taskAssets ? { taskAssets: entry.taskAssets } : {}),
      appLinkPrompt: entry.appLinkPrompt,
      activity: warning
        ? { ...entry.activity, warning }
        : entry.activity
    }
  }

  private emitRetentionChange(entry: BrowserEntry): void {
    if (!this.owns(entry, entry.view) || entry.view.webContents.isDestroyed()) return
    if (JSON.stringify(this.retention(entry)) !== entry.publishedRetention) this.emit(entry)
  }

  private emit(entry: BrowserEntry): void {
    if (entry.activity.control === 'human' || ['waiting', 'failed', 'stopped', 'indeterminate'].includes(entry.activity.operation?.phase ?? '')) void entry.feedback?.clear()
    if (this.entries.get(entry.id) !== entry || entry.view.webContents.isDestroyed()) return
    this.projectInputIsolationNotice(entry)
    void entry.controlFeedback?.synchronize()
    if (entry.activity.operation) entry.activity.operation.control = this.controlState(entry)
    const browser = this.snapshot(entry)
    entry.publishedRetention = JSON.stringify(browser.retention)
    this.send({ type: 'updated', browser })
  }

  private agentOwnsInput(entry: BrowserEntry): boolean { return entry.activity.control === 'agent' && !entry.humanControl }

  /** Saved presentation changes wake only live Browser feedback; input ownership is unchanged. */
  refreshAgentFeedback(): void {
    for (const entry of this.entries.values()) if (this.agentOwnsInput(entry)) {
      void entry.controlFeedback?.synchronize()
      if (entry.visible) void entry.feedback?.refreshPreferences()
      const shield = entry.inputShield
      if (shield) this.refreshInputAppearance(entry, shield)
    }
  }

  private refreshInputAppearance(entry: BrowserEntry, shield: BrowserNativeInputShield): void {
    void shield.refreshAppearance().catch(() => {
      if (this.entries.get(entry.id) !== entry || this.inputSurfaces.get(entry.view)?.shield !== shield) return
      const warning = 'Browser edge appearance could not be updated. The page and Agent remain usable; save the appearance again to retry.'
      entry.activity = { ...entry.activity, warning: entry.activity.warning ?? warning }
      try { this.emit(entry) } catch { /* The original owner retains its presentation notice without changing input. */ }
    })
  }

  /** Trusted presentation bytes for an already-live owner; never acquires or restores a Browser. */
  setOperatorAvatar(input: { browserId: string; operationId: string; operatorId: string; png: string }): boolean {
    if (!input || typeof input.browserId !== 'string' || typeof input.operationId !== 'string' ||
      typeof input.operatorId !== 'string' || typeof input.png !== 'string') return false
    const entry = this.entries.get(input.browserId)
    if (!entry || !entry.visible || !this.agentOwnsInput(entry) || !entry.feedback ||
      entry.activeRun?.operationId !== input.operationId || entry.activity.operation?.id !== input.operationId ||
      entry.activity.operation.operator.id !== input.operatorId || entry.view.webContents.isDestroyed()) return false
    const view = entry.view, feedback = entry.feedback, navigationId = entry.navigationId, revision = entry.controlRevision
    const png = validateBrowserOperatorAvatarPng(input.png)
    if (!png || this.entries.get(input.browserId) !== entry || entry.view !== view || entry.feedback !== feedback ||
      entry.navigationId !== navigationId || entry.controlRevision !== revision || !entry.visible ||
      !this.agentOwnsInput(entry) || entry.activeRun?.operationId !== input.operationId || view.webContents.isDestroyed()) return false
    return feedback.setAvatar(png)
  }

  private requireHumanInput(entry: BrowserEntry): void {
    if (!this.agentOwnsInput(entry)) return
    throw Object.assign(new Error('An Agent program owns this Browser. Use explicit Take control before changing its page, navigation, Profile or execution Viewport.'),
      { code: 'BROWSER_AGENT_CONTROL_ACTIVE' satisfies AgentMuxControlErrorCode })
  }

  private controlState(entry: BrowserEntry): AgentMuxBrowserControl {
    return { owner: this.agentOwnsInput(entry) ? 'agent' : 'human',
      activeOperationId: entry.activeRun?.operationId ?? null, revision: entry.controlRevision,
      inputIsolation: entry.inputIsolation === 'isolated' && !entry.inputShield?.isolated ? 'unconfirmed' : entry.inputIsolation,
      ...(entry.agent === undefined ? {} : { agent: entry.agent === null ? null : { ...entry.agent } }) }
  }

  private async prepareInputShield(entry: BrowserEntry, view: WebContentsView): Promise<void> {
    if (!this.owns(entry, view) || !this.agentOwnsInput(entry)) return
    if (entry.inputShield?.isCurrentFor(view) && entry.inputShield.isolated) {
      entry.inputIsolation = 'isolated'
      this.synchronizeInputShield(entry)
      if (entry.inputIsolation === 'isolated') {
        this.resolveInputIsolationNotice(entry, view)
        this.emit(entry)
      }
      return
    }
    if (entry.inputShield) {
      this.releaseInputShield(entry)
      if (entry.inputShield) { this.inputIsolationFailed(entry); return }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let preparedShield: BrowserNativeInputShield | undefined
    try {
      const surface = this.inputSurface(entry, view), shield = surface.shield
      preparedShield = shield
      entry.inputShield = shield
      if (surface.ready) this.refreshInputAppearance(entry, shield)
      await Promise.race([this.prepareInputSurface(surface), new Promise<void>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Native input surface preparation was not confirmed')), 1500)
      })])
      if (entry.inputShield !== shield || !this.agentOwnsInput(entry)) return
      if (!shield.isolated) throw new Error('The original native input surface is not attached')
      entry.inputIsolation = 'isolated'
      this.resolveInputIsolationNotice(entry, view)
      this.emit(entry)
    } catch {
      if (preparedShield && entry.inputShield !== preparedShield) return
      if (!this.owns(entry, view) || !this.agentOwnsInput(entry)) return
      this.releaseInputShield(entry)
      this.inputIsolationFailed(entry)
    } finally {
      clearTimeout(timer)
    }
  }

  private retainInputSurfaceCleanup(surface: NativeBrowserInputSurface): void {
    let surfaces = this.inputSurfaceCleanup.get(surface.entry.id)
    if (!surfaces) { surfaces = new Set(); this.inputSurfaceCleanup.set(surface.entry.id, surfaces) }
    surfaces.add(surface)
  }

  private forgetInputSurfaceCleanup(surface: NativeBrowserInputSurface): boolean {
    const surfaces = this.inputSurfaceCleanup.get(surface.entry.id), removed = surfaces?.delete(surface) === true
    if (surfaces?.size === 0) this.inputSurfaceCleanup.delete(surface.entry.id)
    return removed
  }

  private inputSurface(entry: BrowserEntry, page: WebContentsView): NativeBrowserInputSurface {
    const existing = this.inputSurfaces.get(page)
    if (existing?.shield.isCurrentFor(page)) return existing
    if (existing) {
      this.inputSurfaces.delete(page)
      if (!existing.shield.contents.isDestroyed()) this.retainInputSurfaceCleanup(existing)
    }
    const source = page.webContents
    const presentations = new Map<object, () => void>()
    const surface: NativeBrowserInputSurface = { entry, page, presentations, shield: undefined! }
    const shield: BrowserNativeInputShield = new BrowserNativeInputShield(page, () => this.windowForView(page), () =>
      this.owns(entry, page) && (presentations.size > 0 || entry.inputShield === shield && this.agentOwnsInput(entry)),
      () => this.inputSurfaceFailed(surface), () => this.agentOwnsInput(entry) ? this.feedbackPreferences() : null,
      () => {
        if (presentations.size > 0) this.windowForView(page).webContents.focus()
        else shield.contents.focus()
      })
    surface.shield = shield
    this.inputSurfaces.set(page, surface)
    const pageDestroyed = (): void => this.inputSurfaceFailed(surface)
    shield.contents.once('destroyed', () => queueMicrotask(() => {
      if (!source.isDestroyed()) source.off('destroyed', pageDestroyed)
      const retained = this.forgetInputSurfaceCleanup(surface)
      const retired = this.releasedEntries.get(entry.id)
      if (retained && retired?.cleanupOnly && !retired.inputShield && !retired.pendingSwitch && !retired.detachedView && !this.inputSurfaceCleanup.has(entry.id)) this.releasedEntries.delete(entry.id)
      this.observeInputShieldDestruction(entry.id, shield)
      this.inputSurfaceFailed(surface)
      if (retained && this.entries.get(entry.id) === entry) {
        try { this.emit(entry) } catch { /* Native completion remains authoritative if projection is unavailable. */ }
      }
    }))
    shield.contents.on('input-event', (_event, input) => {
      if (this.inputSurfaces.get(page) !== surface || !['mouseDown', 'mouseMove', 'mouseEnter', 'mouseLeave'].includes(input.type)) return
      const owner = this.nativeOwner(entry.id)
      if (owner?.view === page) this.onNativeInput?.(owner, { type: 'pointer', event: input as Electron.MouseInputEvent })
    })
    shield.contents.on('before-input-event', (event, input) => {
      if (this.inputSurfaces.get(page) !== surface || input.type !== 'keyDown' || input.key !== 'Escape' || input.isComposing) return
      const owner = this.nativeOwner(entry.id)
      if (owner?.view === page && this.onNativeInput?.(owner, { type: 'escape' })) event.preventDefault()
    })
    shield.contents.on('render-process-gone', () => this.inputSurfaceFailed(surface))
    source.once('destroyed', pageDestroyed)
    return surface
  }

  private prepareInputSurface(surface: NativeBrowserInputSurface): Promise<void> {
    if (!surface.ready) {
      try { surface.ready = surface.shield.prepare() }
      catch (error) { surface.ready = Promise.reject(error) }
    }
    return surface.ready
  }

  private releaseInputSurface(surface: NativeBrowserInputSurface): void {
    try { surface.shield.dispose() } finally {
      if (this.inputSurfaces.get(surface.page) === surface) this.inputSurfaces.delete(surface.page)
      if (!surface.shield.contents.isDestroyed()) this.retainInputSurfaceCleanup(surface)
    }
  }

  private async releasePresentationInputSurface(surface: NativeBrowserInputSurface): Promise<void> {
    if (surface.presentations.size || surface.entry.inputShield === surface.shield) return
    const contents = surface.shield.contents
    let settle!: () => void
    const destroyed = new Promise<void>(resolve => { settle = resolve })
    if (contents.isDestroyed()) settle()
    else contents.once('destroyed', settle)
    try {
      try { this.releaseInputSurface(surface) } catch (error) {
        if (!surface.shield.closing) throw error
        await destroyed
        surface.shield.dispose()
      }
    } finally {
      if (!contents.isDestroyed()) contents.off('destroyed', settle)
    }
  }

  private inputSurfaceFailed(surface: NativeBrowserInputSurface): void {
    if (this.inputSurfaces.get(surface.page) !== surface) return
    for (const failed of [...surface.presentations.values()]) {
      try { failed() } catch { /* Each original presentation retains its own failure receipt. */ }
    }
    surface.presentations.clear()
    if (surface.entry.inputShield === surface.shield) {
      this.releaseInputShield(surface.entry)
      if (this.agentOwnsInput(surface.entry)) this.inputIsolationFailed(surface.entry)
    }
    try { this.releaseInputSurface(surface) } catch { /* Keep the exact native cleanup identity for its original owner. */ }
  }

  private inputIsolationFailed(entry: BrowserEntry): void {
    entry.inputIsolation = 'unconfirmed'
    const previous = entry.inputIsolationNotice
    const operation = entry.activity.operation
    if (!previous || previous.view !== entry.view || previous.operation !== operation) {
      entry.inputIsolationNotice = { view: entry.view, operation, resolved: false }
    } else previous.resolved = false
    // A failed native surface is already unknown here. Notification failure must
    // not turn the still-healthy page/program into a failure; inspect retains the
    // original operation, isolation fact and persistent warning for the next read.
    try { this.emit(entry) } catch { /* Keep current owner facts even when this projection is unavailable. */ }
  }

  private addCurrentOperationWarning(entry: BrowserEntry, view: WebContentsView, operation: BrowserOperation, warning: string): void {
    if (!this.owns(entry, view) || entry.activity.operation !== operation) return
    entry.activity = { ...entry.activity, warning: appendWarning(entry.activity.warning, warning) }
  }

  private resolveInputIsolationNotice(entry: BrowserEntry, view: WebContentsView): void {
    if (!this.owns(entry, view) || entry.inputIsolationNotice?.view !== view) return
    entry.inputIsolationNotice.resolved = true
    this.projectInputIsolationNotice(entry)
  }

  private projectInputIsolationNotice(entry: BrowserEntry): void {
    const notice = entry.inputIsolationNotice
    if (!notice || notice.view !== entry.view) return
    // The exact native owner above grants removal. Matching its published whole
    // notice is presentation bookkeeping, never a source of control/isolation facts.
    let warning = removeWarning(entry.activity.warning, INPUT_ISOLATION_HISTORY)
    if (notice.resolved) warning = removeWarning(warning, INPUT_ISOLATION_WARNING)
    if (notice.operation === entry.activity.operation && notice.operation) {
      // Outcome producers may replace their summary warning. Retain this incident in
      // the original bounded history before later outcome prose, without projecting
      // a resolved incident as a live notice.
      const history = removeWarning(removeWarning(notice.operation.warning, INPUT_ISOLATION_WARNING), INPUT_ISOLATION_HISTORY)
      notice.operation.warning = [INPUT_ISOLATION_HISTORY, history].filter(Boolean).join('\n')
    }
    if (!notice.resolved) {
      warning = appendWarning(warning, INPUT_ISOLATION_WARNING)
    } else if (notice.operation !== entry.activity.operation) delete entry.inputIsolationNotice
    entry.activity = { ...entry.activity }
    if (warning === undefined) delete entry.activity.warning
    else entry.activity.warning = warning
  }

  private observeInputShieldDestruction(id: string, shield: BrowserNativeInputShield): void {
    try {
      const current = this.entries.get(id)
      if (current?.inputShield === shield) {
        this.releaseInputShield(current)
        if (this.agentOwnsInput(current)) this.inputIsolationFailed(current)
        else this.emit(current)
        return
      }
      const retired = this.releasedEntries.get(id)
      if (retired?.inputShield !== shield) return
      this.cleanupReleasedOwner(retired)
      if (retired.cleanupOnly && !retired.inputShield && !retired.pendingSwitch && !retired.detachedView) this.releasedEntries.delete(id)
    } catch { /* The original owner retains any unconfirmed cleanup reference; native notification cannot fail a healthy Browser. */ }
  }

  private synchronizeInputShield(entry: BrowserEntry): void {
    const surface = this.inputSurfaces.get(entry.view)
    try { (surface?.shield ?? entry.inputShield)?.synchronize() }
    catch {
      if (surface) this.inputSurfaceFailed(surface)
      else { this.releaseInputShield(entry); this.inputIsolationFailed(entry) }
    }
  }

  private releaseInputShield(entry: BrowserEntry): void {
    const shield = entry.inputShield
    try {
      const surface = this.inputSurfaces.get(entry.view)
      if (!surface || surface.shield !== shield || !surface.presentations.size) {
        shield?.dispose()
        if (surface?.shield === shield) this.inputSurfaces.delete(entry.view)
      }
      entry.inputShield = undefined
      if (surface && shield && surface.shield === shield && surface.presentations.size) this.refreshInputAppearance(entry, shield)
      entry.inputIsolation = 'inactive'
      const notice = entry.inputShieldCleanupNotice
      if (notice && shield && notice.shield === shield) {
        delete entry.inputShieldCleanupNotice
        if (notice.originalOperation) {
          const warning = removeWarning(notice.originalOperation.warning, INPUT_SHIELD_CLEANUP_WARNING)
          if (warning === undefined) delete notice.originalOperation.warning
          else notice.originalOperation.warning = warning
        }
        if (entry.activity.operation === notice.originalOperation) {
          const warning = removeWarning(entry.activity.warning, INPUT_SHIELD_CLEANUP_WARNING)
          entry.activity = { ...entry.activity }
          if (warning === undefined) delete entry.activity.warning
          else entry.activity.warning = warning
        }
      }
      if (entry.humanControl) this.resolveInputIsolationNotice(entry, entry.view)
    } catch {
      entry.inputIsolation = 'unconfirmed'
      if (!shield || entry.inputShieldCleanupNotice?.shield === shield) return
      const originalOperation = entry.activity.operation
      entry.inputShieldCleanupNotice = { shield, originalOperation }
      entry.activity = { ...entry.activity, warning: appendWarning(entry.activity.warning, INPUT_SHIELD_CLEANUP_WARNING) }
      if (originalOperation) originalOperation.warning = appendWarning(originalOperation.warning, INPUT_SHIELD_CLEANUP_WARNING)
    }
  }

  private send(event: BrowserEvent): void {
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      this.window.webContents.send(BROWSER_EVENT_CHANNEL, event)
    }
  }
}

function normalizeMarkerRect(value: BrowserElementRect): BrowserElementRect {
  if (
    !value ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.width) ||
    !Number.isFinite(value.height) ||
    value.width < 0 ||
    value.height < 0
  ) {
    throw new Error('Browser annotation marker geometry is invalid')
  }
  return {
    x: Math.min(BROWSER_MARKER_MAX_COORDINATE, Math.max(-BROWSER_MARKER_MAX_COORDINATE, value.x)),
    y: Math.min(BROWSER_MARKER_MAX_COORDINATE, Math.max(-BROWSER_MARKER_MAX_COORDINATE, value.y)),
    width: Math.min(BROWSER_MARKER_MAX_COORDINATE, value.width),
    height: Math.min(BROWSER_MARKER_MAX_COORDINATE, value.height)
  }
}
