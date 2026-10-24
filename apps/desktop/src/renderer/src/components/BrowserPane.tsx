import { mintObjectId } from '@agentmux/core/object-id'
import { BrowserOutcomeCriteria } from './BrowserOutcomeCriteria'
import { BrowserSourceNavigation } from './BrowserSourceNavigation'
import { CapsuleInteractionChrome } from './CapsuleInteractionChrome'
import type { SplitDirection } from '@agentmux/layout'
import { WORKBENCH_TAB_SPLIT_ACTIONS } from '../lib/workbench-tab-actions'
import { WorkbenchLayoutMenuRows } from './WorkbenchLayoutMenuRows'
import * as DropdownMenu from './HoverDropdownMenu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { StableWorkbenchView } from './StableWorkbenchView'
import { createRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import {
  type BrowserScreenshotCapture,
  type BrowserElementSelection,
  type BrowserSnapshot,
  type BrowserReplayPlan,
  type BrowserScriptRunReport
} from '../../../shared/contracts'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { narrowBrowserOperation, narrowBrowserReplayPlan, type BrowserOperation } from '../../../shared/browser-operation'
import { api } from '../lib/api'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { useBrowserAnnotationMarkers } from '../hooks/useBrowserAnnotationMarkers'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import {
  formatBrowserElementContext,
  normalizeBrowserAnnotationNote,
  type BrowserAnnotation
} from '../lib/browser-annotations'
import { composeScreenshot } from './browser-screenshot/compose'
import { formatScreenshotContext } from './browser-screenshot/context'
import { ComposerTextarea } from '@agentmux/client-ui/input'
import { BrowserOperationHistory, BrowserOperatorPresence, BrowserOperationWarning, BrowserOperationTimeline, BrowserReplayPreview } from './BrowserOperationSurface'
import { BrowserStartPage } from './BrowserStartPage'
import { BrowserRecoverySurface } from './BrowserRecoverySurface'
import type { BrowserStartPageConfig } from '../../../shared/browser-start-page'
import type { BrowserRecoveryPreviewReadResult } from '../../../shared/browser-recovery-preview'
import { BrowserAddressInput, type BrowserAddressInputHandle } from './BrowserAddressInput'
import { BrowserViewportOptions, BrowserViewportSizeDialog } from './BrowserViewportControls'
import { selectedBrowserPresentationId } from '../lib/browser-presentation-selection'
import { BrowserDemonstrationSurface } from './BrowserDemonstrationSurface'
import { BrowserTaskAssetEditor } from './BrowserTaskAssetEditor'
import { BrowserTaskReliability, useBrowserTaskReliabilityRefresh, type BrowserTaskReliabilityRequest } from './BrowserTaskReliability'
import type { BrowserTaskContent } from '../../../shared/browser-task-assets'
import { BrowserStepEvidence } from './BrowserStepEvidence'
import { useBrowserContextualComposer } from './BrowserContextualComposer'
import { BrowserTraceReadingHost } from './BrowserTraceReadingHost'
import {
  ScreenshotEditor,
  type ScreenshotCompleteInput,
  type ScreenshotEditorHandle
} from './browser-screenshot/ScreenshotEditor'
import {
  LatestBrowserBoundsSynchronizer,
  focusRingYieldOf,
  hasPositiveBrowserStageGeometry,
  nativeBoundsClearOfFocusRing,
  regionAncestorOf,
  rendererCssBoundsToWindowDip
} from '../lib/browser-bounds-sync'
import { observeBrowserStageGeometry } from '../lib/browser-stage-geometry'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { BrowserWorkbenchSurface, WorkbenchSurface } from '../lib/workbench-tabs'
import { useAppStore } from '../store'
import { BrowserPresentationStage, useBrowserPresentationCapture, type WorkbenchBrowserPresentation } from './BrowserPresentationStage'
import { resolveBrowserAgentControl } from '../../../shared/browser-agent-control'
import { WorkbenchPresentationContext, useWorkbenchBrowserPresentation, workbenchBrowserWindowTarget, type WorkbenchViewTarget } from '../lib/workbench-presentation'
import { useWorkbenchDocument } from '../lib/workbench-document'
import { sameWorkbenchProjectionSelection, type WorkbenchProjection, type WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { spatialCatalog, zoneContext } from '../lib/space-agent-control'
import { scratchTopicsForWorkspace } from '../lib/scratch-topic-snapshots'
import { readPmoTeamsTopicFloatingState, subscribePmoTeamsTopicFloatingState } from '../lib/pmo-teams-topic-floating'
import { FullPageLoadingSurface } from './FullPageLoadingSurface'
import { BrowserToolsPanel } from './BrowserToolsPanel'
import type { SurveyBrowserPreparation } from '../lib/survey-browser-creation'
import { BrowserWorkfaceBoundary, type BrowserWorkfaceAddressDraft } from './BrowserWorkfaceBoundary'
import { createBrowserAgent, type BrowserAgentCreationResult } from '../lib/browser-agent-creation'

const ThemeActionAddAnnotationIcon = semanticIconComponent('action.add-annotation')
const ThemeStatusSavedIcon = semanticIconComponent('status.saved')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeObjectBrowserIcon = semanticIconComponent('object.browser')
const ThemeActionInspectIcon = semanticIconComponent('action.inspect')
const ThemeActionCopyIcon = semanticIconComponent('action.copy')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeNavigationBackIcon = semanticIconComponent('navigation.back')
const ThemeNavigationForwardIcon = semanticIconComponent('navigation.forward')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeActionCaptureIcon = semanticIconComponent('action.capture')
const ThemeObjectToolsIcon = semanticIconComponent('object.tools')
const ThemeObjectDisplayIcon = semanticIconComponent('object.display')
const ThemeNavigationSubmenuIcon = semanticIconComponent('navigation.submenu')
const ThemeObjectBookmarkIcon = semanticIconComponent('object.bookmark')
const ThemeFileCodeIcon = semanticIconComponent('file.code')
const ThemeActionMoreIcon = semanticIconComponent('action.more')
const ThemeObjectHistoryIcon = semanticIconComponent('object.history')
const ThemeActionAdjustIcon = semanticIconComponent('action.adjust')


const NO_BROWSER_ANNOTATIONS: readonly BrowserAnnotation[] = []

type BrowserIdentity = Pick<BrowserSnapshot, 'id' | 'navigationId'>
type BookmarkSource = Pick<BrowserWorkbenchSurface, 'browserId' | 'navigationId' | 'workspaceId' | 'url' | 'title'>
type BookmarkSave = BookmarkSource & ({ status: 'saving' } | { status: 'saved'; path: string } | { status: 'error'; message: string })
type UnconfirmedBookmark = BookmarkSource & { path: string | null; message: string }

function sameBookmarkSource(source: BookmarkSource, current: BookmarkSource): boolean {
  return source.browserId === current.browserId && source.navigationId === current.navigationId &&
    source.workspaceId === current.workspaceId && source.url === current.url
}

export function browserCaptureMatchesIdentity(
  capture: Pick<BrowserScreenshotCapture, 'browserId' | 'navigationId'>,
  identity: BrowserIdentity
): boolean {
  return capture.browserId === identity.id && capture.navigationId === identity.navigationId
}

type BrowserPaneProps = Omit<Parameters<typeof BrowserPaneContent>[0], 'addressDraft' | 'connection'>

export function BrowserPane(props: BrowserPaneProps) {
  return <BrowserPaneOwner key={props.tab.browserId} {...props} />
}

// Main connection state must survive a failed child tree and its local view retry.
function useBrowserOwnerConnection({ tab, visible, presentations = [], released = false, onControlConfirmation }: BrowserPaneProps) {
  const consumed = visible || presentations.some(presentation => presentation.visible)
  const applyBrowserEvent = useAppStore(state => state.applyBrowserEvent)
  const reportError = useAppStore(state => state.reportError)
  const [restoring, setRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restoreAttempt, setRestoreAttempt] = useState(0)
  const [nativeReleased, setNativeReleased] = useState(Boolean(tab.nativeOwnerReleased || tab.nativeOwnerDeferred || tab.nativeOwnerUnavailable))
  const nativeLifecycleRef = useRef<'present' | 'releasing' | 'released' | 'restoring'>(tab.nativeOwnerReleased || tab.nativeOwnerDeferred || tab.nativeOwnerUnavailable ? 'released' : 'present')
  const lifecycleTokenRef = useRef(0)
  const mounted = useRef(true)
  const recoveryInputs = useRef({ tab, released, onControlConfirmation })
  recoveryInputs.current = { tab, released, onControlConfirmation }
  useEffect(() => {
    lifecycleTokenRef.current += 1
    setRestoring(false)
    setRestoreError(null)
    if (tab.nativeOwnerReleased || tab.nativeOwnerDeferred || tab.nativeOwnerUnavailable) { setNativeReleased(true); nativeLifecycleRef.current = 'released' }
    else { setNativeReleased(false); nativeLifecycleRef.current = 'present' }
  }, [tab.nativeOwnerReleased, tab.nativeOwnerDeferred, tab.nativeOwnerUnavailable, tab.navigationId])
  useEffect(() => {
    if (!released || nativeReleased || nativeLifecycleRef.current !== 'present') return
    nativeLifecycleRef.current = 'releasing'
    const source = { id: tab.browserId, navigationId: tab.navigationId }
    void api.browser.release(source.id, source.navigationId).then(receipt => {
      if (!mounted.current || recoveryInputs.current.tab.nativeOwnerReleased) return
      if (recoveryInputs.current.tab.navigationId !== source.navigationId) {
        if (!recoveryInputs.current.tab.nativeOwnerReleased) nativeLifecycleRef.current = 'present'
        return
      }
      if (receipt.browserId !== source.id || receipt.navigationId !== source.navigationId) throw new Error('Browser release returned a different source. The original page is kept.')
      if (receipt.status === 'released') {
        nativeLifecycleRef.current = 'released'
        setNativeReleased(true)
        applyBrowserEvent({ type: 'released', id: source.id, navigationId: source.navigationId })
      } else nativeLifecycleRef.current = 'present'
    }).catch(error => {
      if (!mounted.current || recoveryInputs.current.tab.navigationId !== source.navigationId || recoveryInputs.current.tab.nativeOwnerReleased) return
      nativeLifecycleRef.current = 'present'
      reportError(error)
    })
  }, [applyBrowserEvent, nativeReleased, released, reportError, tab.browserId, tab.navigationId])

  useEffect(() => {
    if (released || !nativeReleased || !consumed || restoreError !== null || nativeLifecycleRef.current === 'restoring') return
    const token = ++lifecycleTokenRef.current
    nativeLifecycleRef.current = 'restoring'
    onControlConfirmation?.(tab.regionId, true)
    setRestoreError(null)
    setRestoring(true)
    void api.browser.restore(tab.browserId, {
      workspaceId: tab.workspaceId, profileId: tab.profileId, mode: tab.mode, viewport: tab.viewport
    }).then(browser => {
      if (browser.id !== tab.browserId) throw new Error('The Browser restore returned a different page identity. The original page and address are kept; retry its connection.')
      if (!mounted.current || lifecycleTokenRef.current !== token) return
      // A later native updated event is authoritative. Never repaint it with this older receipt.
      const current = recoveryInputs.current.tab
      if (current.navigationId !== tab.navigationId) return
      applyBrowserEvent({ type: 'updated', browser }, tab.navigationId)
      nativeLifecycleRef.current = 'present'
      setNativeReleased(false)
      setRestoring(false)
      recoveryInputs.current.onControlConfirmation?.(current.regionId, false)
    }).catch(error => {
      if (!mounted.current || lifecycleTokenRef.current !== token) return
      nativeLifecycleRef.current = 'released'
      setRestoring(false)
      setRestoreError(presentError(error))
    })
  }, [applyBrowserEvent, consumed, nativeReleased, released, restoreAttempt, restoreError, tab.browserId, tab.navigationId, tab.nativeOwnerReleased, tab.nativeOwnerDeferred, tab.nativeOwnerUnavailable])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      lifecycleTokenRef.current += 1
      recoveryInputs.current.onControlConfirmation?.(recoveryInputs.current.tab.regionId, false)
    }
  }, [])
  return { restoring, restoreError, nativeReleased, nativeLifecycleRef, retryConnection: () => { setRestoreError(null); setRestoreAttempt(attempt => attempt + 1) } }
}

function BrowserPaneOwner(props: BrowserPaneProps) {
  const connection = useBrowserOwnerConnection(props)
  const addressDraft = useRef<BrowserWorkfaceAddressDraft>({ browserId: props.tab.browserId,
    value: props.tab.url === 'about:blank' ? '' : props.tab.url, edited: false })
  if (addressDraft.current.browserId !== props.tab.browserId) addressDraft.current = { browserId: props.tab.browserId,
    value: props.tab.url === 'about:blank' ? '' : props.tab.url, edited: false }
  else if (!addressDraft.current.edited) addressDraft.current.value = props.tab.url === 'about:blank' ? '' : props.tab.url
  return <BrowserWorkfaceBoundary key={props.tab.browserId} tab={props.tab} addressDraft={addressDraft}
    presentations={props.presentations} presentationTargetId={props.presentationTargetId} onRegionClose={props.onRegionClose}>
    <BrowserPaneContent {...props} released={connection.nativeReleased} addressDraft={addressDraft} connection={connection} />
  </BrowserWorkfaceBoundary>
}

function BrowserPaneContent({
  tab,
  addressDraft,
  connection,
  visible,
  released = false,
  yieldToFocusRing = false,
  presentationTargetId,
  controlPanelOpen,
  onControlConfirmation,
  presentations = [],
  renderPresentationFrame,
  onPresentationInputSelected,
  onRegionSplit,
  regionSplitSurface,
  startPage,
  onRegionClose
}: {
  tab: BrowserWorkbenchSurface
  addressDraft: import('react').RefObject<BrowserWorkfaceAddressDraft>
  connection: ReturnType<typeof useBrowserOwnerConnection>
  /** Original Region actions; these never create or dispose the page directly. */
  onRegionSplit?: ((direction: SplitDirection) => void) | undefined
  regionSplitSurface?: WorkbenchViewTarget['surface'] | undefined
  startPage?: BrowserStartPageConfig | undefined
  onRegionClose?: (() => void) | undefined
  presentations?: readonly WorkbenchBrowserPresentation[] | undefined
  renderPresentationFrame?: ((content: ReactNode, target: WorkbenchViewTarget) => ReactNode) | undefined
  onPresentationInputSelected?: ((target: WorkbenchViewTarget) => void) | undefined
  visible: boolean
  /** Main-owned WebContentsView is released for a long-hidden, rebuildable Region. */
  released?: boolean
  /**
   * 这一格是当前聚焦的那一格，所以原生视图要按焦点环宽内缩让位。由上游的 `regionFocusExpression`
   * 与挂在 Region 上的类名**同一次**算出（见 lib/region-focus.ts）——别在这里自己判焦点：环宽那个
   * 自定义属性声明在 `:root`，任何 Region 都继承得到，所以「有没有 Region 祖先」根本不是焦点判据，
   * 那样每一格都内缩，未聚焦的 browser 区会镶一圈无环的深边。
   */
  yieldToFocusRing?: boolean
  /** The actual presentation host may change without changing page visibility or size. */
  presentationTargetId?: string | undefined
  /** Survey has its own controls; hidden Space dock state cannot cover this page. */
  controlPanelOpen?: boolean | undefined
  /** Presentation notice from this sole native owner; it never drives lifecycle. */
  onControlConfirmation?: ((regionId: string, unconfirmed: boolean) => void) | undefined
}) {
  const applyBrowserEvent = useAppStore((state) => state.applyBrowserEvent)
  const executeControl = useAppStore((state) => state.executeControl)
  const reportError = useAppStore((state) => state.reportError)
  const resourceWorkspace = useAppStore(state => state.config?.workspaces.find(workspace => workspace.id === tab.workspaceId))
  const saveBrowserBookmark = useAppStore((state) => state.saveBrowserBookmark)
  const openFile = useAppStore((state) => state.openFile)
  const primaryPresentation = useWorkbenchBrowserPresentation()
  const independentDocument = useWorkbenchDocument() !== document
  const windowTarget = independentDocument ? workbenchBrowserWindowTarget(presentations.map(presentation => presentation.target), primaryPresentation, tab.regionId) : undefined
  const windowPresentation = presentations.find(presentation => presentation.target === windowTarget && presentation.visible && presentation.active)
  const sourcePresentations = useRef({ primary: primaryPresentation, targets: presentations })
  sourcePresentations.current = { primary: primaryPresentation, targets: presentations }
  const discussion = useBrowserContextualComposer(tab.browserId, tab.control?.agent, tab.activity?.operation ?? null, visible, tab.navigationId)
  const toolbar = useAppStore((state) => state.config?.browser.toolbar)
  const agentAppearance = useAppStore(state => state.config?.browser.agentControl)
  const toolsOpen = useAppStore((state) => state.toolsOpen)
  // Selection comes from the owning surface, never the first rendered occurrence.
  const selectedPresentationId = useAppStore(state => windowPresentation?.occurrence.presentationId ?? selectedBrowserPresentationId(presentations, state))
  const media = useBrowserPresentationCapture(tab.browserId)
  const stageRef = useRef<HTMLDivElement>(null)
  // 焦点结论用 ref 承接，边界同步那条 effect 从 ref 读它而不订阅它（#545）：直接把 prop 放进那条
  // effect 的依赖数组会让它在每次焦点切换时拆了重建，中间闪一帧（见那条 effect 的注释）。ref 保证
  // 边界计算里读到的永远是当前焦点值（不会 stale），而焦点翻转由下方那条独立 effect 触发一次重算。
  const yieldToFocusRingRef = useRef(yieldToFocusRing)
  // 边界同步那条 effect 每次挂载时把它的重算入口挂上来；焦点那条 effect 借它在不拆 synchronizer 的
  // 前提下重算。effect 未挂载（stage 还没有）时是 null，焦点 effect 的 `?.()` 便安全地什么都不做。
  const recomputeBoundsRef = useRef<(() => void) | null>(null)
  const rebindBoundsObserverRef = useRef<(() => void) | null>(null)
  const screenshotToken = useRef(0)
  const selectionToken = useRef(0)
  const [screenshot, setScreenshot] = useState<{ kind: 'capture'; capture: BrowserScreenshotCapture; key: number } | { kind: 'open'; key: number } | null>(null)
  const browserIdentity = useRef<BrowserIdentity>({ id: tab.browserId, navigationId: tab.navigationId })
  if (browserIdentity.current.id !== tab.browserId || browserIdentity.current.navigationId !== tab.navigationId) {
    browserIdentity.current = { id: tab.browserId, navigationId: tab.navigationId }
    if (screenshot?.kind !== 'open') screenshotToken.current += 1
    selectionToken.current += 1
  }
  const [address, setAddress] = useState(addressDraft.current.value)
  const [addressError, setAddressError] = useState<string | null>(null)
  const addressInputs = useRef(new Map<string, ReturnType<typeof createRef<BrowserAddressInputHandle>>>())
  const addressDraftEdited = useRef(addressDraft.current.edited)
  const addressBrowser = useRef(tab.browserId)
  const [inputHistoryNotice, setInputHistoryNotice] = useState<string | null>(null)
  const [historyRevision, setHistoryRevision] = useState(0)
  const [bookmarkSave, setBookmarkSave] = useState<BookmarkSave | null>(null)
  const [unconfirmedBookmarks, setUnconfirmedBookmarks] = useState<UnconfirmedBookmark[]>([])
  const bookmarkRequest = useRef<BookmarkSource | null>(null)
  const inSurvey = controlPanelOpen !== undefined
  const [busy, setBusy] = useState(false)
  const [creatingAgent, setCreatingAgent] = useState(false)
  const [agentCreationNotice, setAgentCreationNotice] = useState<Exclude<BrowserAgentCreationResult, { kind: 'confirmed' }> | null>(null)
  const browserAgentIntent = useAppStore(state => tab.agentCreationRequestId ? state.spatialRequests[tab.agentCreationRequestId]?.browserAgent : undefined)
  const initialInputQueue = useAppStore(state => agentCreationNotice?.kind === 'input-unconfirmed' ? state.agentSteerQueues[agentCreationNotice.agentSessionId] : undefined)
  const initialInputConfirmed = useMemo(() => {
    if (agentCreationNotice?.kind !== 'input-unconfirmed') return false
    const receipt = initialInputQueue?.find(entry => entry.operationId === agentCreationNotice.messageOperationId)?.inputReceipt
    return receipt?.key.kind === 'prompt' && receipt.key.agentSessionId === agentCreationNotice.agentSessionId &&
      receipt.key.submissionId === agentCreationNotice.messageOperationId && receipt.key.expectedRun.runId === agentCreationNotice.runId &&
      (receipt.status === 'admitted' || receipt.status === 'terminal-confirmed')
  }, [agentCreationNotice, initialInputQueue])
  useEffect(() => {
    if (initialInputConfirmed) setAgentCreationNotice(current => current === agentCreationNotice ? null : current)
  }, [agentCreationNotice, initialInputConfirmed])
  async function startBrowserAgent(target: { reference?: WorkbenchProjectionSelection | undefined } = primaryPresentation): Promise<void> {
    const reference = target.reference && { ...target.reference, regionId: tab.regionId }
    if (!reference) { setAgentCreationNotice({ kind: 'setup-unconfirmed', message: 'The original Browser presentation is unconfirmed. The page is kept; select this Browser occurrence and try again.' }); return }
    setCreatingAgent(true)
    setAgentCreationNotice(null)
    try { const result = await createBrowserAgent(tab.browserId, reference); setAgentCreationNotice(result.kind === 'confirmed' ? null : result) }
    catch (error) { setAgentCreationNotice({ kind: 'setup-unconfirmed', message: presentError(error) }) }
    finally { setCreatingAgent(false) }
  }
  const [menuOpen, setMenuOpen] = useState(false)
  const [capsuleToolbarHost, setCapsuleToolbarHost] = useState<HTMLSpanElement | null>(null)
  const [customViewport, setCustomViewport] = useState<string | null>(null)
  const [managementOpen, setManagementOpen] = useState(false)
  const [managementVisited, setManagementVisited] = useState(false)
  const research = useRef<{ url: string; mode: BrowserSnapshot['mode']; preparation: SurveyBrowserPreparation | null } | null>(null)
  const privateCreation = useRef<{ source: WorkbenchProjectionSelection; reference: WorkbenchProjectionSelection; zoneId: string; launcher: WorkbenchSurface } | null>(null)
  async function startResearch(): Promise<void> {
    if (busy) return
    const before = useAppStore.getState()
    if (!research.current) research.current = { url: tab.url, mode: tab.mode, preparation: null }
    const pending = research.current
    setBusy(true); setAddressError(null)
    try {
      const created = await before.createSurveyBrowser({ workspaceId: tab.workspaceId, url: pending.url, mode: pending.mode,
        preparation: pending.preparation, onPrepared(value) { pending.preparation = value } })
      research.current = null
      const current = useAppStore.getState()
      // A later user navigation wins; the new research remains saved and reachable.
      const previousLayout = before.activeWorkspaceId ? before.layouts[before.activeWorkspaceId] : undefined
      const currentLayout = before.activeWorkspaceId ? current.layouts[before.activeWorkspaceId] : undefined
      const previousGroup = previousLayout?.groups.find(group => group.id === previousLayout.activeGroupId)
      const currentGroup = currentLayout?.groups.find(group => group.id === currentLayout.activeGroupId)
      if (current.mainSurface === before.mainSurface && current.activeWorkspaceId === before.activeWorkspaceId && current.agentFocus === before.agentFocus &&
        current.workbenchSpaceSelection === before.workbenchSpaceSelection && current.surveyZoneSelection === before.surveyZoneSelection &&
        currentLayout?.activeGroupId === previousLayout?.activeGroupId && currentGroup?.activeTabId === previousGroup?.activeTabId) {
        current.setSurveyZoneSelection({ zoneId: created.zone.zoneId, selection: [created.reference], active: created.reference })
        current.setMainSurface('survey')
      }
    } catch (cause) { setAddressError(`Research could not open: ${presentError(cause)}. The original page and research target are kept; retry here.`) }
    finally { setBusy(false) }
  }
  async function newPrivatePage(target?: WorkbenchViewTarget): Promise<void> {
    const reference = target?.reference ?? primaryPresentation.reference
    if (!reference) throw new Error('The exact Browser display is unconfirmed. Your current page is kept; reopen its original view to create a private page.')
    const before = useAppStore.getState(), origin = before.tabs[reference.tabId]
    const source = origin?.regions[reference.regionId]
    if (!origin || source?.kind !== 'browser' || source.browserId !== tab.browserId) throw new Error('The original Browser display changed. Your page is kept.')
    const workspace = before.config?.workspaces.find(workspace => workspace.id === tab.workspaceId)
    const topics = scratchTopicsForWorkspace(before.scratchTopicSnapshots, workspace) ?? []
    const zoneId = privateCreation.current?.zoneId ?? spatialCatalog(before, topics).tabs.find(item => item.tabId === origin.id)?.zoneId
    if (!zoneId) throw new Error('The original Browser Zone is unconfirmed. Your page is kept; recover that same display before creating another page.')
    if (!privateCreation.current) {
      const tabId = before.openLauncher({ workspaceId: tab.workspaceId, displayWorkspaceId: reference.displayWorkspaceId,
        tabGroupId: reference.groupId, zoneId, reveal: false })
      const pending = tabId ? useAppStore.getState().tabs[tabId] : undefined
      if (!pending) throw new Error('The exact display Group is still restoring. Existing pages are kept.')
      const regionId = pending.layout.activeRegionId
      privateCreation.current = { source: reference, reference: { ...reference, tabId: pending.id, regionId }, zoneId, launcher: pending.regions[regionId]! }
    }
    const prepared = privateCreation.current, next = prepared.reference
    const pending = useAppStore.getState().tabs[next.tabId]?.regions[next.regionId]
    if (!sameWorkbenchProjectionSelection(prepared.source, reference) || !pending ||
      pending !== prepared.launcher && !(pending.kind === 'browser' && pending.browserId === next.regionId && pending.mode === 'private')) {
      throw new Error('The original private page preparation changed. Its exact reference and your page are kept.')
    }
    if (pending === prepared.launcher) await before.createBrowser(next.groupId, { tabId: next.tabId, regionId: next.regionId }, 'about:blank', undefined,
      tab.workspaceId, next.displayWorkspaceId, 'private')
    const confirmed = useAppStore.getState().tabs[next.tabId]?.regions[next.regionId]
    if (confirmed?.kind !== 'browser' || confirmed.browserId !== next.regionId || confirmed.mode !== 'private') {
      throw new Error('The original private Browser has not confirmed attachment. Its preparation is kept; recover that same page.')
    }
    privateCreation.current = null
    const current = useAppStore.getState()
    if (current.mainSurface !== before.mainSurface || current.workbenchSpaceSelection !== before.workbenchSpaceSelection || current.surveyZoneSelection !== before.surveyZoneSelection) return
    if ((target?.surface ?? primaryPresentation.surface) === 'survey') {
      current.setSurveyZoneSelection({ zoneId, selection: [next], active: next })
    } else current.selectMainRegion(next, before.workbenchSpaceSelection)
  }
  async function startPrivatePage(target?: WorkbenchViewTarget): Promise<void> {
    await runCommand(async () => {
      setAddressError(null)
      try { await newPrivatePage(target) }
      catch (cause) { setAddressError(`Private page could not open: ${presentError(cause)}. The original page and exact preparation are kept; retry here.`) }
    })
  }
  const screenshotEditor = useRef<ScreenshotEditorHandle>(null)
  const [screenshotBusy, setScreenshotBusy] = useState(false)
  const [screenshotCopied, setScreenshotCopied] = useState<string | null>(null)
  const screenshotEdited = useCallback(() => setScreenshotCopied(null), [])
  const [elementSelection, setElementSelection] = useState<BrowserElementSelection | null>(null)
  const [selectionBusy, setSelectionBusy] = useState(false)
  // 「记住」的勾选是**这一问的草稿**，不是已保存的状态——真正记住发生在主进程，由回答那一次带过去。
  // 留在渲染进程做本地 state 而不是读 config：读 config 会让这个勾选看起来像已生效的设置。
  const [rememberAppLink, setRememberAppLink] = useState(false)
  // 每换一个 scheme 就把勾选清回去。不清的话，上一次勾了「记住」会让下一个**不同的** scheme
  // 一出现就预先勾着——用户扫一眼点 Open，等于替他记住了一件他没答应的事。
  useEffect(() => setRememberAppLink(false), [tab.appLinkPrompt?.scheme])
  const { restoring, restoreError, retryConnection, nativeLifecycleRef } = connection
  const recoveryVisible = (visible || presentations.some(presentation => presentation.visible)) && Boolean(
    tab.error || released || restoring || tab.nativeOwnerDeferred || tab.nativeOwnerUnavailable || restoreError !== null)
  const previewKey = JSON.stringify([tab.browserId, tab.profileId, tab.mode, tab.workspaceId, tab.navigationId])
  const [recoveryPreview, setRecoveryPreview] = useState<{ key: string; result: BrowserRecoveryPreviewReadResult } | null>(null)
  useEffect(() => {
    if (!recoveryVisible) return
    let current = true
    void api.browser.getRecoveryPreview(tab.browserId).then(result => {
      if (!current) return
      if (result.status === 'available' && (result.preview.scope.browserId !== tab.browserId ||
        result.preview.scope.profileId !== tab.profileId || result.preview.scope.mode !== tab.mode ||
        result.preview.scope.workspaceId !== tab.workspaceId)) {
        setRecoveryPreview({ key: previewKey, result: { status: 'unavailable',
          warning: 'The previous preview belongs to a different page context. Retry and address editing remain available.' } })
      } else setRecoveryPreview({ key: previewKey, result })
    }, () => {
      if (current) setRecoveryPreview({ key: previewKey, result: { status: 'unavailable',
        warning: 'The previous preview could not be read. Retry and address editing remain available.' } })
    })
    return () => { current = false }
  }, [recoveryVisible, previewKey, tab.browserId])
  const currentRecoveryPreview = recoveryPreview?.key === previewKey ? recoveryPreview.result : undefined
  const [annotationNote, setAnnotationNote] = useState('')
  const [replayPlan, setReplayPlan] = useState<BrowserReplayPlan | null>(null)
  const [replayBusy, setReplayBusy] = useState(false)
  const [replayOutcome, setReplayOutcome] = useState<BrowserScriptRunReport['outcome'] | undefined>()
  const [traceViews, setTraceViews] = useState<Record<string, { open: boolean; mode: 'docked' | 'floating' }>>({})
  const traceAnchors = useRef(new Map<string, HTMLElement>())
  // Retention's operation reason includes the original in-flight dispatch after stop.
  // Missing owner observations cannot shrink an already reserved execution viewport.
  const traceCanDock = !tab.driving && Boolean(tab.retention && !tab.retention.reasons.includes('operation') &&
    !tab.retention.reasons.includes('owner-unavailable') && !tab.nativeOwnerUnavailable && !restoring)
  if (traceCanDock && Object.values(traceViews).some(view => !view.open && view.mode === 'docked')) {
    setTraceViews(Object.fromEntries(Object.entries(traceViews).filter(([, view]) => view.open || view.mode !== 'docked')))
  }
  const [operationHistory, setOperationHistory] = useState<BrowserOperation[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null)
  const [selectedStep, setSelectedStep] = useState<{ operationId: string; sequence: number } | null>(null)
  const [demonstrationBusy, setDemonstrationBusy] = useState(false)
  const demonstrationRequest = useRef(0)
  const [taskBusy, setTaskBusy] = useState(false)
  const [selectedTaskAssetId, setSelectedTaskAssetId] = useState<string | null>(null)
  const [taskAssetReview, setTaskAssetReview] = useState<{ assetId: string; version: number } | null>(null)
  const taskRequest = useRef(0)
  const taskReliabilityRefresh = useBrowserTaskReliabilityRefresh(tab.browserId)
  const annotations = useAppStore((state) => state.browserAnnotationsByBrowserId[tab.browserId]) ?? NO_BROWSER_ANNOTATIONS
  const addBrowserAnnotation = useAppStore((state) => state.addBrowserAnnotation)

  useEffect(() => {
    if (addressBrowser.current !== tab.browserId || !addressDraftEdited.current) {
      addressBrowser.current = tab.browserId
      addressDraftEdited.current = false
      setAddress(tab.url === 'about:blank' ? '' : tab.url)
      setAddressError(null)
    }
  }, [tab.url, tab.browserId])

  // History and replay belong to the Browser identity. A Region can reuse this pane while switching
  // tabs, so never leave a previous Browser's selected operation or replay plan attached to the new page.
  useEffect(() => {
    setTraceViews({})
    setOperationHistory([])
    setSelectedOperationId(null)
    setSelectedStep(null)
    setHistoryError(null)
    setReplayPlan(null)
    setReplayOutcome(undefined)
    demonstrationRequest.current += 1
    setDemonstrationBusy(false)
    taskRequest.current += 1
    setTaskBusy(false)
    setSelectedTaskAssetId(null)
    setTaskAssetReview(null)
  }, [tab.browserId])

  useEffect(() => () => {
    screenshotToken.current += 1
    selectionToken.current += 1
    void api.browser.cancelElementSelection(tab.browserId).catch(() => {})
  }, [])

  useEffect(() => {
    if (screenshot?.kind !== 'open') { setScreenshot(null); setScreenshotBusy(false) }
    setElementSelection(null)
    setAnnotationNote('')
    setSelectionBusy(false)
    void api.browser.cancelElementSelection(tab.browserId).catch(() => {})
  }, [tab.browserId, tab.navigationId])

  const annotationOwnerPresent = useCallback(() => nativeLifecycleRef.current === 'present', [])
  const annotationSync = useBrowserAnnotationMarkers({
    browserId: tab.browserId, navigationId: tab.navigationId, annotations,
    active: !released && !restoring && !tab.nativeOwnerDeferred && !tab.nativeOwnerUnavailable && restoreError === null, nativeOwnerPresent: annotationOwnerPresent
  })

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage || presentations.length > 0) return
    let frame = 0
    const synchronizer = new LatestBrowserBoundsSynchronizer(
      async (bounds) => await api.browser.setBounds(tab.browserId, bounds),
      reportError
    )
    const update = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const navigatorCoversBrowser = (controlPanelOpen ?? toolsOpen) && window.innerWidth <= (inSurvey ? 1100 : 900)
        if (
          !visible ||
          released ||
          restoring ||
          restoreError !== null ||
          screenshot !== null ||
          elementSelection !== null ||
          navigatorCoversBrowser ||
          __AGENTMUX_WEB_PREVIEW__ ||
          tab.error ||
          // 原生视图是**窗口级**层，画在页面之上。不把它藏起来，那个提问就渲染在它背后——看不见，
          // 也点不到，于是这一问永远没人能回答，而页面看起来只是什么都没发生。和 `tab.error` 同理。
          tab.appLinkPrompt !== null ||
          tab.url === 'about:blank'
        ) {
          synchronizer.observe(null)
          return
        }
        const rect = stage.getBoundingClientRect()
        // During native window/pane resize the stage can briefly report zero geometry while still
        // belonging to the visible Browser. Keep the last valid native frame until a usable rect arrives;
        // explicit visibility/release branches above still hide it when the surface really goes away.
        if (!hasPositiveBrowserStageGeometry(rect)) return
        // 让开 Region 的焦点框：原生视图是窗口级层，画在页面之上，焦点框盖不过它（详见
        // nativeBoundsClearOfFocusRing 的注释）。让位量走 focusRingYieldOf——**只有聚焦的那一格**
        // 取环宽，其余格取 0。不能像从前那样只问「有没有 .workbench-region 祖先」：环宽声明在 :root，
        // 每个 Region 都继承得到，那等于无条件内缩，未聚焦的 browser 区镶一圈无环的深边（#350）。
        // 求交本身与焦点无关（让位量 0 时就是「把 stage 夹进 Region」），没有 Region 祖先
        // （独立窗口等）时按原样铺满。
        //
        // 焦点结论从 ref 读，不直接读 yieldToFocusRing prop（#545）：见下方 yieldToFocusRingRef 的
        // 注释。读 ref 不是 stale closure——ref 永远是当前值；直接读 prop 才会 stale，那正是把它
        // 放进依赖数组的理由，而放进依赖数组会让整条 effect 在焦点变化时拆了重建（闪烁）。
        const stageBounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        const region = regionAncestorOf(stage)
        let bounds = stageBounds
        if (region) {
          const regionRect = region.getBoundingClientRect()
          bounds = nativeBoundsClearOfFocusRing(
            stageBounds,
            { x: regionRect.x, y: regionRect.y, width: regionRect.width, height: regionRect.height },
            focusRingYieldOf(region, yieldToFocusRingRef.current)
          )
        }
        synchronizer.observe(rendererCssBoundsToWindowDip(bounds, api.ui.getZoomFactor()))
      })
    }
    // 把重算入口交给焦点那条 effect，让它能在**不拆掉这个 synchronizer** 的前提下重算边界。
    recomputeBoundsRef.current = update
    let stopObserving = observeBrowserStageGeometry(stage, update, visible && !released && !restoring)
    rebindBoundsObserverRef.current = () => {
      stopObserving()
      stopObserving = observeBrowserStageGeometry(stage, update, visible && !released && !restoring)
      update()
    }
    return () => {
      recomputeBoundsRef.current = null
      rebindBoundsObserverRef.current = null
      cancelAnimationFrame(frame)
      synchronizer.dispose()
      stopObserving()
      void api.browser.setBounds(tab.browserId, null).catch(() => {})
    }
    // yieldToFocusRing **故意不在**这里（#545）：它在焦点切换时变化，若列进来，整条 effect 会拆了
    // 重建——cleanup 那句 `setBounds(null)` 先把原生视图藏起来，重建那次 rAF 下一帧才重新显示，中间
    // 空一帧就是那道闪烁。它改由 ref 读、由下面那条独立 effect 触发重算。其余被 update 读到的值都在。
  }, [screenshot, elementSelection, released, restoring, restoreError, toolsOpen, controlPanelOpen, reportError, tab.appLinkPrompt, tab.browserId, tab.error, tab.url, visible, presentations.length])

  useLayoutEffect(() => {
    // Portal children run before their host moves. Rebind against connected ancestors after that
    // commit, keeping the existing synchronizer alive (no transient setBounds(null) on a host move).
    let cancelled = false
    queueMicrotask(() => { if (!cancelled) rebindBoundsObserverRef.current?.() })
    return () => { cancelled = true }
  }, [presentationTargetId])

  // 焦点环内缩是一件与「边界同步的生命周期」正交的事，所以它有自己的依赖数组（#545）。焦点结论翻转时
  // 只重算一次边界——复用上面那个还活着的 synchronizer（recomputeBoundsRef），不拆不建，因此没有那道
  // 藏一帧再显示的闪烁。焦点变化不改变任何尺寸，ResizeObserver 不会触发，所以必须由这条 effect 显式重算，
  // 否则焦点到达 browser 区时不内缩（#341 回归）、离开时不退回（#350 回归）。
  useLayoutEffect(() => {
    yieldToFocusRingRef.current = yieldToFocusRing
    recomputeBoundsRef.current?.()
  }, [yieldToFocusRing])

  async function run(action: () => Promise<BrowserSnapshot>, onFailure?: (cause: unknown) => void): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const browser = await action()
      applyBrowserEvent({ type: 'updated', browser })
    } catch (error) {
      if (onFailure) onFailure(error)
      else reportError(error)
    } finally {
      setBusy(false)
    }
  }

  function navigateAddress(submittedAddress: string): void {
    if (!submittedAddress.trim()) return
    if (released || restoring || restoreError !== null) {
      setAddressError('The original page connection is not confirmed. Your input is kept; retry the connection or open the address in your external browser.')
      return
    }
    addressDraftEdited.current = false
    addressDraft.current.edited = false
    setAddressError(null)
    void run(() => api.browser.navigate(tab.browserId, submittedAddress), cause => {
      setAddressError(`Page could not open: ${presentError(cause)}. Your input and page are kept; retry here.`)
    })
  }

  async function runCommand(action: () => Promise<void>): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (error) {
      reportError(error)
    } finally {
      setBusy(false)
    }
  }

  // Stop addresses the exact execution through the public protocol. Human takeover
  // addresses this Browser through its trusted host API, including between executions.
  async function stopBrowserOperation(): Promise<void> {
    const operationId = tab.control?.owner === 'agent' ? tab.control.activeOperationId : tab.activity?.operation?.id
    if (!operationId) {
      reportError('The current Browser operation identity is unconfirmed. The original page is kept; retry Take control when its Main control details reconnect.', { kind: 'process-degraded' })
      return
    }
    try {
      await executeControl({
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: mintObjectId(),
        operation: 'browser.stop',
        operationId
      })
    } catch (error) {
      reportError(error)
    }
  }

  async function takeBrowserControl(): Promise<void> {
    try { await api.browser.takeControl(tab.browserId) }
    catch (error) { reportError(error) }
  }

  async function beginScreenshot(): Promise<void> {
    if (elementSelection || selectionBusy || screenshot || screenshotBusy || busy || tab.url === 'about:blank') return
    const token = ++screenshotToken.current
    setScreenshotCopied(null)
    setScreenshotBusy(true)
    try {
      const captured = await api.browser.captureScreenshot(tab.browserId)
      if (screenshotToken.current !== token) return
      if (!browserCaptureMatchesIdentity(captured, browserIdentity.current)) {
        throw new Error('Browser page changed before the screenshot editor opened')
      }
      setScreenshot({ kind: 'capture', capture: captured, key: token })
    } catch (error) {
      if (screenshotToken.current === token) reportError(error)
    } finally {
      if (screenshotToken.current === token) setScreenshotBusy(false)
    }
  }

  async function beginElementSelection(): Promise<void> {
    if (selectionBusy || screenshot || screenshotBusy || busy || tab.url === 'about:blank') return
    const token = ++selectionToken.current
    setElementSelection(null)
    setAnnotationNote('')
    setSelectionBusy(true)
    try {
      const selected = await api.browser.selectElement(tab.browserId)
      if (selectionToken.current !== token || !selected) return
      if (!browserCaptureMatchesIdentity(selected, browserIdentity.current)) {
        throw new Error('Browser page changed before the element selection was delivered')
      }
      setElementSelection(selected)
    } catch (error) {
      if (selectionToken.current === token) reportError(error)
    } finally {
      if (selectionToken.current === token) setSelectionBusy(false)
    }
  }

  function cancelElementSelection(): void {
    selectionToken.current += 1
    setSelectionBusy(false)
    setElementSelection(null)
    setAnnotationNote('')
    void api.browser.cancelElementSelection(tab.browserId).catch(reportError)
  }

  async function copyElementContext(): Promise<void> {
    if (!elementSelection) return
    // 成功才收起选区：复制失败要把选区留着让用户重试，而不是既没进剪贴板又丢了选中目标。
    if (await copyTextToClipboard(formatBrowserElementContext(elementSelection), reportError)) {
      cancelElementSelection()
    }
  }

  function addElementAnnotation(): void {
    if (!elementSelection) return
    addBrowserAnnotation({
      id: mintObjectId(),
      workspaceId: tab.workspaceId,
      browserId: tab.browserId,
      navigationId: tab.navigationId,
      selection: elementSelection,
      note: normalizeBrowserAnnotationNote(annotationNote)
    })
    cancelElementSelection()
  }

  function cancelScreenshot(): void {
    screenshotToken.current += 1
    setScreenshotBusy(false)
    setScreenshot(null)
    setScreenshotCopied(null)
  }

  async function copyScreenshot(input: ScreenshotCompleteInput, kind: 'png' | 'context' = 'png'): Promise<void> {
    if (!screenshot || screenshotBusy) return
    const token = screenshotToken.current
    setScreenshotBusy(true)
    setScreenshotCopied(null)
    try {
      const image = await composeScreenshot({
        image: input.image,
        displayWidth: input.displayWidth,
        displayHeight: input.displayHeight,
        outputScale: 1,
        shapes: input.shapes,
        crop: input.crop
      })
      if (screenshotToken.current !== token) return
      if (kind === 'png') await api.ui.writeClipboardImage(image)
      else if (!await copyTextToClipboard(formatScreenshotContext(input.capture, input, image, input.source), error => { if (screenshotToken.current === token) reportError(error) })) return
      if (screenshotToken.current !== token) return
      setScreenshotCopied(kind === 'png' ? 'PNG copied' : 'Context copied')
    } catch (error) {
      if (screenshotToken.current === token) reportError(error)
    } finally {
      if (screenshotToken.current === token) setScreenshotBusy(false)
    }
  }

  async function loadOperationHistory(): Promise<void> {
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      // 经协议，并且**按 browserId 过滤交给协议**而不是在这里过滤：协议的 history 本来就收这个参数，
      // 在客户端再滤一遍就是把同一条规则写两处。
      const receipt = await executeControl({
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: mintObjectId(),
        operation: 'browser.history',
        browserId: tab.browserId
      })
      if (receipt.operation !== 'browser.history') throw new Error('Control returned another operation for Browser history.')
      setOperationHistory(receipt.operations.map(narrowBrowserOperation))
    } catch (error) {
      setHistoryError('Operation history is unavailable. Retry to restore the record view.')
      reportError(error)
    } finally {
      setHistoryLoading(false)
    }
  }

  function openOperationTimeline(presentationId: string): void {
    setTraceViews(current => ({ ...current, [presentationId]: { open: true,
      mode: current[presentationId]?.mode === 'docked' && !traceCanDock ? 'docked' : traceCanDock ? 'docked' : 'floating' } }))
    void loadOperationHistory()
    void api.browser.getDemonstration(tab.browserId).catch(reportError)
    void api.browser.getTaskAssets(tab.browserId).catch(reportError)
  }

  async function controlDemonstration(event: MouseEvent<HTMLButtonElement>, action: 'start' | 'stop'): Promise<void> {
    if (event.nativeEvent.isTrusted !== true) return
    const browserId = tab.browserId
    const request = ++demonstrationRequest.current
    setDemonstrationBusy(true)
    try {
      if (action === 'start') await api.browser.startDemonstration(browserId)
      else await api.browser.stopDemonstration(browserId)
    } catch (error) {
      if (browserIdentity.current.id === browserId && demonstrationRequest.current === request) reportError(error)
    } finally {
      if (browserIdentity.current.id === browserId && demonstrationRequest.current === request) setDemonstrationBusy(false)
    }
  }

  const taskAsset = tab.taskAssets?.assets.find(asset => asset.id === selectedTaskAssetId) ?? tab.taskAssets?.assets.at(-1) ?? null
  const taskRun = taskAsset ? tab.taskAssets?.runs.find(run => run.id === tab.taskAssets?.selectedRunId && run.assetId === taskAsset.id && run.browserId === tab.browserId) ?? null : null
  const loadTaskReliability = useCallback(async (input: BrowserTaskReliabilityRequest) => {
    const receipt = await executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: mintObjectId(),
      operation: 'browser.task.reliability', ...input })
    if (receipt.operation !== 'browser.task.reliability') throw new Error('The exact version reliability read is unavailable.')
    return receipt.reliability
  }, [executeControl])

  async function taskAction<T>(event: MouseEvent<HTMLButtonElement>, action: () => Promise<T>): Promise<T | undefined> {
    if (event.nativeEvent.isTrusted !== true) return
    const id = tab.browserId
    const request = ++taskRequest.current
    setTaskBusy(true)
    try { return await action() }
    finally { if (browserIdentity.current.id === id && taskRequest.current === request) setTaskBusy(false) }
  }

  async function importTaskAsset(event: MouseEvent<HTMLButtonElement>): Promise<void> {
    try { await taskAction(event, async () => { const asset = await api.browser.importTaskAsset(tab.browserId); setSelectedTaskAssetId(asset.id) }) }
    catch (error) { reportError(error) }
  }

  async function saveTaskAsset(content: BrowserTaskContent, event: MouseEvent<HTMLButtonElement>, asVersion: boolean): Promise<void> {
    if (!taskAsset) return
    await taskAction(event, async () => await (asVersion ? api.browser.saveTaskAssetVersion : api.browser.saveTaskAssetDraft)(
      tab.browserId, taskAsset.id, taskAsset.revision, content))
  }

  function operationForTimeline(): BrowserOperation | null {
    if (selectedOperationId) {
      return operationHistory.find((operation) => operation.id === selectedOperationId) ?? tab.activity?.operation ?? null
    }
    return tab.activity?.operation ?? operationHistory[0] ?? null
  }

  async function runReplayStep(sequence: number): Promise<void> {
    if (!replayPlan || replayBusy) return
    const step = replayPlan.steps[sequence - 1]
    if (!step || step.blockedReason) return
    setReplayBusy(true)
    setReplayOutcome(undefined)
    try {
      // 单步回放的 mode/step 语义在协议里（它自己判越界、判 blockedReason，并把两者分成不同的
      // typed 失败）。这里把 step 交过去，不在客户端裁一份 plan——裁 plan 等于把"哪些步能重放"
      // 这条人工闸门规则搬到了 Renderer。
      const receipt = await executeControl({
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: mintObjectId(),
        operation: 'browser.replay',
        browserId: tab.browserId,
        operationId: replayPlan.operationId,
        mode: 'step',
        step: sequence
      })
      if (receipt.operation !== 'browser.replay') throw new Error('Control returned another operation for Browser replay.')
      setReplayOutcome(receipt.mode === 'preview' ? undefined : receipt.outcome)
    } catch (error) {
      reportError(error)
    } finally {
      setReplayBusy(false)
    }
  }

  async function runReplay(): Promise<void> {
    if (!replayPlan || replayBusy || replayPlan.steps.some((step) => step.blockedReason)) return
    setReplayBusy(true)
    setReplayOutcome(undefined)
    try {
      const receipt = await executeControl({
        schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: mintObjectId(),
        operation: 'browser.replay',
        browserId: tab.browserId,
        operationId: replayPlan.operationId,
        mode: 'run'
      })
      if (receipt.operation !== 'browser.replay') throw new Error('Control returned another operation for Browser replay.')
      setReplayOutcome(receipt.mode === 'preview' ? undefined : receipt.outcome)
    } catch (error) {
      reportError(error)
    } finally {
      setReplayBusy(false)
    }
  }

  const timelineOperation = operationForTimeline()
  const browserActivity = tab.activity ?? { operation: null, control: tab.driving ? 'agent' as const : 'human' as const }
  const timelineSelectedStep = selectedStep?.operationId === timelineOperation?.id
    ? timelineOperation?.steps.find(step => step.sequence === selectedStep?.sequence) : undefined
  // A persistence warning belongs to the current live projection. Do not attach it to a historical
  // operation after the user selects another record; the timeline and warning must share one identity.
  const timelineWarning = timelineOperation?.id === tab.activity?.operation?.id ? tab.activity?.warning : undefined

  const selectElementDisabled = tab.url === 'about:blank' || busy || screenshotBusy || screenshot !== null || elementSelection !== null
  const screenshotDisabled = tab.url === 'about:blank' || busy || screenshotBusy || screenshot !== null || selectionBusy || elementSelection !== null
  const pageToolDisabled = tab.url === 'about:blank' || busy
  const selectElement = () => selectionBusy ? cancelElementSelection() : void beginElementSelection()
  const openDevTools = () => void runCommand(async () => await api.browser.openDevTools(tab.browserId))
  async function saveBookmark(): Promise<void> {
    // Only this original page's duplicate save waits. File I/O never owns navigation or page tools.
    if (busy || bookmarkRequest.current && sameBookmarkSource(bookmarkRequest.current, tab)) return
    const source: BookmarkSource = { browserId: tab.browserId, navigationId: tab.navigationId,
      workspaceId: tab.workspaceId, url: tab.url, title: tab.title }
    bookmarkRequest.current = source
    setBookmarkSave({ ...source, status: 'saving' })
    try {
      const path = await saveBrowserBookmark(source.workspaceId, source.url, source.title)
      if (bookmarkRequest.current === source) setBookmarkSave({ ...source, status: 'saved', path })
    } catch (cause) {
      const failure = cause !== null && typeof cause === 'object' ? cause as { status?: unknown; path?: unknown } : null
      if (failure?.status === 'error') {
        if (bookmarkRequest.current === source) setBookmarkSave({ ...source, status: 'error', message: presentError(cause) })
      } else {
        // An unknown write may already have published. Keep its exact candidate when another copy is requested.
        setUnconfirmedBookmarks(current => [...current, { ...source,
          path: typeof failure?.path === 'string' ? failure.path : null, message: presentError(cause) }])
        if (bookmarkRequest.current === source) setBookmarkSave(null)
      }
    } finally {
      if (bookmarkRequest.current === source) bookmarkRequest.current = null
    }
  }
  const currentBookmarkSave = bookmarkSave && sameBookmarkSource(bookmarkSave, tab) ? bookmarkSave : null
  const currentBookmark = currentBookmarkSave?.status === 'saved' ? currentBookmarkSave : null
  const bookmarkSaving = currentBookmarkSave?.status === 'saving'
  const currentUnconfirmedBookmarks = unconfirmedBookmarks.filter(source => sameBookmarkSource(source, tab))
  const bookmarkSaveLabel = currentUnconfirmedBookmarks.length ? 'Save another copy as a bookmark' : 'Save this page as a bookmark'
  const openSavedBookmark = (target?: WorkbenchViewTarget) => void runCommand(async () => {
    if (!currentBookmark || browserIdentity.current.id !== currentBookmark.browserId ||
      browserIdentity.current.navigationId !== currentBookmark.navigationId) return
    await openBookmarkFile(currentBookmark.path, false, target)
  })
  const viewBookmarkSource = (target?: WorkbenchViewTarget) => void runCommand(async () => {
    const origin = tab.bookmarkOrigin
    if (!origin || origin.binary) return
    await openBookmarkFile(origin.path, true, target)
  })
  async function openBookmarkFile(path: string, openAsText: boolean, target?: WorkbenchViewTarget): Promise<void> {
    const presentation = target ?? primaryPresentation
    if (presentation.surface !== 'survey' && presentation.surface !== 'mote') {
      if (openAsText) await openFile(path, undefined, undefined, tab.workspaceId, true)
      else await openFile(path, undefined, undefined, tab.workspaceId)
      return
    }
    const state = useAppStore.getState(), reference = presentation.reference && { ...presentation.reference, regionId: tab.regionId }
    const workspace = state.config?.workspaces.find(workspace => workspace.id === tab.workspaceId)
    const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace) ?? []
    const catalog = spatialCatalog(state, topics), zone = catalog.zones.find(zone => zone.zoneId === catalog.tabs.find(item => item.tabId === reference?.tabId)?.zoneId)
    if (!reference || !workspace || !zone || state.tabs[reference.tabId]?.regions[tab.regionId] !== tab ||
      !catalog.locations.some(location => location.displayWorkspaceId === reference.displayWorkspaceId && location.groupId === reference.groupId && location.tabId === reference.tabId && location.regionId === reference.regionId) ||
      !presentation.onSelectRegion && !presentation.projection) throw new Error('The original bookmark source occurrence is unconfirmed. Its Browser and file are kept.')
    flushSync(() => {
      if (presentation.onSelectRegion) presentation.onSelectRegion(reference.regionId)
      else presentation.projection!.onSelect(reference)
    })
    const choice = () => {
      if (presentation.surface === 'survey') return JSON.stringify(useAppStore.getState().surveyZoneSelection)
      const floating = readPmoTeamsTopicFloatingState()
      return JSON.stringify([floating?.open, floating?.preview, floating?.targetTopicId, floating?.targetTabId, floating?.reference])
    }
    const expected = choice()
    let superseded = false
    const observe = () => { if (choice() !== expected) superseded = true }
    const release = presentation.surface === 'mote' ? subscribePmoTeamsTopicFloatingState(observe) : useAppStore.subscribe(observe)
    const projection: WorkbenchProjection = { ...presentation.projection, entity: { kind: 'tab', tabId: reference.tabId }, catalog,
      presentationId: presentation.projection?.presentationId ?? (presentation.surface === 'survey' ? 'survey-workbench' : 'mote-floating-tab'),
      displayWorkspaceId: reference.displayWorkspaceId, selectionMode: 'occurrence', selection: [reference], onSelect: next => {
        if (superseded || choice() !== expected) return
        const current = target ? sourcePresentations.current.targets.find(item => item.target.hostId === target.hostId)?.target : sourcePresentations.current.primary
        if (!current || current.surface !== presentation.surface || !current.reference ||
          !sameWorkbenchProjectionSelection({ ...current.reference, regionId: tab.regionId }, reference)) return
        release()
        if (current.onSelectRegion) current.onSelectRegion(next.regionId)
        else current.projection?.onSelect(next)
      } }
    try {
      await openFile(path, reference.groupId, undefined, tab.workspaceId, openAsText, { displayWorkspaceId: reference.displayWorkspaceId,
        resource: { hostId: workspace.hostId, path: workspace.path }, space: { zoneId: zone.zoneId, spaceId: zoneContext(state, topics, zone) },
        ...(openAsText ? { fileOnly: true } : {}), split: { tabId: reference.tabId, regionId: reference.regionId, direction: 'right' }, projection })
    } finally { release() }
  }
  const viewportOptions = (presentationId: string) => <BrowserViewportOptions value={tab.viewport} disabled={busy}
    onSelect={viewport => void run(() => api.browser.setViewport(tab.browserId, viewport))}
    onCustom={() => setCustomViewport(presentationId)} />

  const regionCloseButton = onRegionClose ? <button
    type="button" className="browser-toolbar__close" title="Close split" aria-label="Close split"
    onPointerDown={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); onRegionClose() }}
  ><ThemeActionCloseIcon size={12} /></button> : null

  const defaultPresentationVisible = visible
  const renderPane = (presentation?: WorkbenchBrowserPresentation): ReactNode => {
    const key = presentation?.occurrence.presentationId ?? tab.browserId
    let addressInput = addressInputs.current.get(key)
    if (!addressInput) { addressInput = createRef<BrowserAddressInputHandle>(); addressInputs.current.set(key, addressInput) }
    const visible = presentation?.visible ?? defaultPresentationVisible
    const regionSurface = presentation?.target.surface ?? regionSplitSurface
    const inSurvey = regionSurface === 'survey'
    const startPageConfig = presentation ? presentation.target.browserStartPage : startPage
    const regionSplitAllowed = regionSurface !== undefined && regionSurface !== 'survey'
    const regionSplitItems = regionSplitAllowed && onRegionSplit ? <WorkbenchLayoutMenuRows
      entries={WORKBENCH_TAB_SPLIT_ACTIONS.map(action => ({ ...action, kind: 'split' as const,
        onSelect: () => onRegionSplit(action.direction) }))}
      Item={DropdownMenu.Item} Group={DropdownMenu.Group} Label={DropdownMenu.Label} /> : null
    const connectionUnavailable = released || restoring || tab.nativeOwnerDeferred || tab.nativeOwnerUnavailable || restoreError !== null
    const blocked = connectionUnavailable || screenshot !== null || elementSelection !== null || Boolean(tab.error) || tab.appLinkPrompt !== null || tab.url === 'about:blank' ||
      Boolean((presentation?.target.controlsOpen ?? toolsOpen) && window.innerWidth <= (inSurvey ? 1100 : 900))
    const stageContent = <>

        {screenshot ? (
          <ScreenshotEditor
            ref={screenshotEditor}
            key={screenshot.key}
            {...(screenshot.kind === 'capture' ? { capture: screenshot.capture } : {})}
            workspaceId={tab.workspaceId}
            active={visible}
            busy={screenshotBusy}
            copied={screenshotCopied}
            onCancel={cancelScreenshot}
            onComplete={(input) => void copyScreenshot(input)}
            onCopyContext={(input) => void copyScreenshot(input, 'context')}
            onEdited={screenshotEdited}
            onOriginalOpened={() => setScreenshot(current => current ? { kind: 'open', key: current.key } : null)}
            onError={reportError}
          /> ) : connectionUnavailable ? <BrowserRecoverySurface
          url={tab.url} title={tab.title} faviconDataUrl={tab.faviconDataUrl}
          preview={currentRecoveryPreview}
          heading={restoring ? 'Restoring browser' : restoreError ? 'Browser connection needs attention' : 'Browser parked'}
          description={restoring ? 'Reconnecting the original page. Your tab, address and other work are kept.'
            : restoreError ? 'Your tab and address are kept. Retry the connection or edit the address.'
              : 'Return to this tab to restore the original page. Your address is kept.'}
          error={restoreError ?? tab.error} busy={busy} restoring={restoring} retryLabel="Retry connection"
          onRetry={restoreError ? retryConnection : undefined}
          onEditAddress={() => addressInput.current?.focus()}
          onCopy={text => copyTextToClipboard(text, reportError)}
        /> : elementSelection ? (
          <section className="browser-selection-result" aria-label="Selected element context">
            <header><ThemeActionInspectIcon size={17} /><span><strong>{elementSelection.accessibleName || `<${elementSelection.tagName}>`}</strong><small>{elementSelection.pageTitle || elementSelection.pageUrl}</small></span></header>
            <dl>
              <div><dt>Element</dt><dd>{`<${elementSelection.tagName}>${elementSelection.role ? ` · ${elementSelection.role}` : ''}`}</dd></div>
              <div><dt>Selector</dt><dd>{elementSelection.selector || 'No stable selector'}</dd></div>
              <div><dt>Text</dt><dd>{elementSelection.text || 'No visible text'}</dd></div>
            </dl>
            <label>
              <span>Annotation note</span>
              <ComposerTextarea
                aria-label="Annotation note"
                value={annotationNote}
                maxLength={1_000}
                placeholder="What should the Agent notice about this element?"
                onValueChange={setAnnotationNote}
              />
            </label>
            <footer>
              <button className="small-button" type="button" onClick={cancelElementSelection}>Cancel</button>
              <button className="small-button" type="button" onClick={() => void copyElementContext()}><ThemeActionCopyIcon size={12} /> Copy context</button>
              <button className="primary-button" type="button" onClick={addElementAnnotation}><ThemeActionAddAnnotationIcon size={12} /> Add annotation</button>
            </footer>
          </section>
        ) : tab.appLinkPrompt ? (
          <div className="pane-state browser-app-link-prompt">
            <ThemeActionOpenExternalIcon size={20} />
            <strong>Open this link in another app?</strong>
            <span>
              This page wants to hand <code>{tab.appLinkPrompt.scheme}:</code> links to an app on your
              computer. AgentMux cannot show them itself.
            </span>
            <small className="browser-app-link-prompt__url">{tab.appLinkPrompt.url}</small>
            <label className="browser-app-link-prompt__remember">
              <input
                type="checkbox"
                checked={rememberAppLink}
                onChange={(event) => setRememberAppLink(event.target.checked)}
              />
              <span>Remember for every <code>{tab.appLinkPrompt.scheme}:</code> link</span>
            </label>
            <div className="browser-app-link-prompt__actions">
              <button
                className="small-button"
                type="button"
                onClick={() => void run(async () => await api.browser.answerAppLink(tab.browserId, false, rememberAppLink))}
              >Not now</button>
              <button
                className="primary-button"
                type="button"
                onClick={() => void run(async () => await api.browser.answerAppLink(tab.browserId, true, rememberAppLink))}
              >Open</button>
            </div>
          </div>
        ) : tab.error ? (
          <BrowserRecoverySurface url={tab.url} title={tab.title} faviconDataUrl={tab.faviconDataUrl}
            preview={currentRecoveryPreview}
            heading="Page needs attention"
            description="Your tab and address are kept. Retry, or check the address to continue."
            error={tab.error} busy={busy}
            onEditAddress={() => addressInput.current?.focus()}
            onCopy={text => copyTextToClipboard(text, reportError)}
            onRetry={() => void run(async () => {
              if (tab.capsuleId) return api.browser.reload(tab.browserId)
              const browser = await api.browser.create(tab.browserId, tab.url, tab.workspaceId, tab.profileId || undefined, tab.mode)
              return browser.error ? await api.browser.reload(tab.browserId) : browser
            })}
          />
        ) : tab.url === 'about:blank' ? (
          startPageConfig ? <BrowserStartPage config={startPageConfig} visible={visible} historyRevision={historyRevision}
            historyTarget={{ kind: 'browser', browserId: tab.browserId, profileId: tab.profileId }}
            onChooseHistory={value => { addressDraftEdited.current = true; addressDraft.current.value = value; addressDraft.current.edited = true; setAddress(value); addressInput.current?.submit(value) }}>
            <form className="browser-start-page__input" onSubmit={event => { event.preventDefault(); addressInput.current?.submit() }}>
              <BrowserAddressInput ref={addressInput} aria-label="Search or enter a web address" placeholder="Search or enter a web address" value={address}
                onHistoryChange={() => setHistoryRevision(value => value + 1)}
                historyTarget={{ kind: 'browser', browserId: tab.browserId, profileId: tab.profileId }}
                onValueChange={value => { addressDraftEdited.current = true; addressDraft.current.value = value; addressDraft.current.edited = true; setAddress(value); setAddressError(null) }} onSubmit={navigateAddress} onHistoryNotice={setInputHistoryNotice} onDeferredHistoryFailure={message => useAppStore.getState().reportError(message, { kind: 'process-degraded' })} />
              <button type="submit" aria-label="Search or open page" disabled={busy || !address.trim()}><ThemeActionOpenExternalIcon size={16} /></button>
            </form>
            {tab.mode === 'private' ? <p className="browser-private-notice" role="status"><strong>{tab.privateSessionEnded ? 'Temporary data has ended' : 'Private browsing'}</strong><span>Website data stays in this session and ends when you close this page. It does not hide your network identity. Explicit saves, downloads and Agent operation records are retained normally.</span></p> : null}
          </BrowserStartPage> : <div className={`browser-empty${tab.mode === 'private' ? ' browser-empty--private' : ''}`}><ThemeObjectBrowserIcon size={25} /><strong>{tab.mode === 'private' ? tab.privateSessionEnded ? 'Temporary data has ended' : 'Private browsing' : 'New browser tab'}</strong><span>{tab.mode === 'private' ? 'This is a new private session. Website data ends when you close it. Your network identity is not hidden; explicit saves, downloads and Agent operation records are retained normally.' : 'Search or enter an address above to begin.'}</span></div>
        ) : __AGENTMUX_WEB_PREVIEW__ ? (
          <div className="browser-preview"><ThemeObjectBrowserIcon size={25} /><strong>{tab.title || tab.url}</strong><span>{tab.url}</span><small>Web Preview represents the Main-owned WebContentsView here.</small></div>
        ) : null}
    </>
    return (
    <section className={`browser-surface${inSurvey ? ' browser-surface--survey' : ''}`} ref={node => { if (node) traceAnchors.current.set(key, node); else traceAnchors.current.delete(key) }}>
      <form
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          addressInput.current?.submit()
        }}
      >
        {tab.mode === 'private' ? <span className="browser-private-badge" aria-label="Private session" title="Temporary website data ends when this page closes. Network identity is not hidden; explicit saves, downloads and Agent operation records follow their normal retention.">Private</span> : null}
        {tab.source ? <BrowserSourceNavigation source={tab.source} onOpenChange={setMenuOpen} /> : null}
        <button
          type="button"
          aria-label="Open in external browser"
          title="Open in external browser"
          disabled={tab.url === 'about:blank' || busy}
          onClick={() => void runCommand(async () => await api.ui.openExternal(tab.url))}
        >
          <ThemeActionOpenExternalIcon size={14} />
        </button>
        <button type="button" className="browser-toolbar__navigation" aria-label="Back" title="Back" disabled={!tab.canGoBack || busy} onClick={() => void run(() => api.browser.back(tab.browserId))}><ThemeNavigationBackIcon size={13} /></button>
        <button type="button" className="browser-toolbar__navigation" aria-label="Forward" title="Forward" disabled={!tab.canGoForward || busy} onClick={() => void run(() => api.browser.forward(tab.browserId))}><ThemeNavigationForwardIcon size={13} /></button>
        <button type="button" className="browser-toolbar__reload" aria-label={connectionUnavailable ? 'Retry browser connection' : 'Reload'}
          title={connectionUnavailable ? restoring ? 'Waiting for the original page connection' : 'Retry the original page connection' : 'Reload'}
          disabled={busy || released || restoring}
          onClick={() => { if (restoreError !== null) retryConnection(); else void run(() => api.browser.reload(tab.browserId)) }}>
          {tab.loading || busy ? <ThemeStatusLoadingIcon animation="spin" size={13} /> : <ThemeActionRefreshIcon size={13} />}
        </button>
        {startPageConfig && tab.url === 'about:blank' ? <span className="browser-toolbar__empty-address">New page</span> : <label>
          <ThemeObjectBrowserIcon size={13} />
          <BrowserAddressInput
            onHistoryChange={() => setHistoryRevision(value => value + 1)}
            ref={addressInput} aria-label="Browser address" value={address} placeholder="Search or enter an address"
            historyTarget={{ kind: 'browser', browserId: tab.browserId, profileId: tab.profileId }}
            onValueChange={value => { addressDraftEdited.current = true; addressDraft.current.value = value; addressDraft.current.edited = true; setAddress(value); setAddressError(null) }}
            onSubmit={navigateAddress} onHistoryNotice={setInputHistoryNotice} onDeferredHistoryFailure={message => useAppStore.getState().reportError(message, { kind: 'process-degraded' })}
          />
        </label>}
        <BrowserOperatorPresence
          activity={browserActivity}
          control={tab.control}
          browserId={tab.browserId}
          {...(tab.taskAssets ? { taskAssets: tab.taskAssets } : {})}
          onOpenTaskRun={(assetId, version) => { setSelectedTaskAssetId(assetId); setTaskAssetReview({ assetId, version }); openOperationTimeline(key) }}
          onTakeControl={() => void takeBrowserControl()}
          onStop={() => void stopBrowserOperation()}
          onReturnControl={() => void run(() => api.browser.returnControl(tab.browserId))}
          onCreateAgent={() => void startBrowserAgent(presentation?.target ?? primaryPresentation)}
          creatingAgent={creatingAgent}
          onOpenTimeline={() => openOperationTimeline(key)}
          onOpenChange={setMenuOpen}
        />
        <button type="button" ref={visible ? discussion.buttonRef : undefined} aria-label="Message Browser operator"
          title="Send an opinion to the original Agent" onClick={event => discussion.open(event.currentTarget, undefined, traceAnchors.current.get(key))}>{discussion.button}</button>
        {toolbar?.selectElement ? (
          <button
            type="button"
            className="browser-toolbar__secondary"
            aria-label={selectionBusy ? 'Cancel element selection' : 'Select element'}
            title={selectionBusy ? 'Cancel element selection' : 'Select an element for context or annotation'}
            disabled={selectElementDisabled}
            onClick={selectElement}
          >
            {selectionBusy ? <ThemeStatusLoadingIcon animation="spin" size={14} /> : <ThemeActionInspectIcon size={14} />}
          </button>
        ) : null}
        {toolbar?.screenshot ? (
          <button
            type="button"
            className="browser-toolbar__secondary"
            aria-label="Screenshot"
            title="Capture and mark up this viewport"
            disabled={screenshotDisabled}
            onClick={() => void beginScreenshot()}
          >
            {screenshotBusy && !screenshot ? <ThemeStatusLoadingIcon animation="spin" size={14} /> : <ThemeActionCaptureIcon size={14} />}
          </button>
        ) : null}
        {toolbar?.devTools ? (
          <button
            type="button"
            className="browser-toolbar__secondary"
            aria-label="Open DevTools"
            title="Open DevTools"
            disabled={pageToolDisabled}
            onClick={openDevTools}
          >
            <ThemeObjectToolsIcon size={14} />
          </button>
        ) : null}
        {toolbar?.viewport ? (
          <DropdownMenu.Root onOpenChange={setMenuOpen}>
            <DropdownMenu.Trigger asChild>
              <button type="button" className="browser-toolbar__secondary" aria-label="Viewport" title="Viewport" disabled={busy}>
                <ThemeObjectDisplayIcon size={14} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="browser-menu browser-viewport-menu" align="end" sideOffset={5} collisionPadding={8}>
                <DropdownMenu.Label className="browser-menu__label">Viewport</DropdownMenu.Label>
                {viewportOptions(key)}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}
        {toolbar?.saveBookmark ? (
          <button
            type="button"
            className="browser-toolbar__secondary"
            aria-label={bookmarkSaveLabel}
            title={currentUnconfirmedBookmarks.length ? 'Save another .webloc copy; the previous write is still unconfirmed' : 'Save this page as a .webloc bookmark in the workspace'}
            disabled={pageToolDisabled || bookmarkSaving}
            onClick={saveBookmark}
          >
            <ThemeObjectBookmarkIcon size={14} />
          </button>
        ) : null}
        {tab.bookmarkOrigin ? (
          <button
            type="button"
            className="browser-toolbar__secondary"
            aria-label="View bookmark source"
            // 二进制 plist 过 `files.read` 的 utf8 会坏，那一档不给看源码（§2.7）。表达方式按用户原话
            // 「按钮灰掉，hover 告知」——不弹框不 toast 不插警告条；这句只说清为什么这一个不行。
            title={tab.bookmarkOrigin.binary
              ? "This bookmark is a binary file — its source can't be shown as text"
              : "View this bookmark's source"}
            disabled={tab.bookmarkOrigin.binary || busy}
            onClick={() => viewBookmarkSource(presentation?.target)}
          >
            <ThemeFileCodeIcon size={14} />
          </button>
        ) : null}
        {tab.capsuleId ? <span className="capsule-toolbar" ref={setCapsuleToolbarHost} /> : null}
          <DropdownMenu.Root modal={false} onOpenChange={setMenuOpen}>
            <DropdownMenu.Trigger asChild>
              <button type="button" className={toolbar?.more || regionSplitItems ? undefined : 'browser-toolbar__more--optional'} aria-label="More browser tools" title="More browser tools"><ThemeActionMoreIcon size={14} /></button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="browser-menu" align="end" sideOffset={5} collisionPadding={8}>
                {regionSplitItems ? <>{regionSplitItems}<DropdownMenu.Separator className="browser-menu__separator" /></> : null}
                <DropdownMenu.Label className="browser-menu__label">Page</DropdownMenu.Label>
                <DropdownMenu.Item className="browser-menu__item" aria-label="New private page" disabled={busy} onSelect={() => void startPrivatePage(presentation?.target)}>
                  <ThemeObjectBrowserIcon size={12} /><span>New private page</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className="browser-menu__item" aria-label="Back" disabled={!tab.canGoBack || busy} onSelect={() => void run(() => api.browser.back(tab.browserId))}>
                  <ThemeNavigationBackIcon size={12} /><span>Back</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className="browser-menu__item" aria-label="Forward" disabled={!tab.canGoForward || busy} onSelect={() => void run(() => api.browser.forward(tab.browserId))}>
                  <ThemeNavigationForwardIcon size={12} /><span>Forward</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className="browser-menu__item" disabled={busy} onSelect={() => void run(() => api.browser.reload(tab.browserId))}>
                  <ThemeActionRefreshIcon size={12} /><span>Reload page</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className="browser-menu__item" aria-label="Open human demonstration draft" onSelect={() => openOperationTimeline(key)}>
                  <ThemeObjectHistoryIcon size={12} /><span>Demonstration</span>
                </DropdownMenu.Item>
                {toolbar?.selectElement ? <DropdownMenu.Item className="browser-menu__item" aria-label={selectionBusy ? 'Cancel element selection' : 'Select element'} disabled={selectElementDisabled} onSelect={selectElement}>
                  <ThemeActionInspectIcon size={12} /><span>{selectionBusy ? 'Cancel element selection' : 'Select element'}</span>
                </DropdownMenu.Item> : null}
                {toolbar?.screenshot ? <DropdownMenu.Item className="browser-menu__item" aria-label="Screenshot" disabled={screenshotDisabled} onSelect={() => void beginScreenshot()}>
                  <ThemeActionCaptureIcon size={12} /><span>Screenshot</span>
                </DropdownMenu.Item> : null}
                {toolbar?.screenshot ? <DropdownMenu.Item className="browser-menu__item" aria-label="Open annotation original" disabled={screenshotBusy || selectionBusy || elementSelection !== null}
                  onSelect={() => { if (screenshot) screenshotEditor.current?.openOriginal(); else { const key = ++screenshotToken.current; setScreenshotCopied(null); setScreenshot({ kind: 'open', key }) } }}>
                  <ThemeActionOpenExternalIcon size={12} /><span>Open annotation original…</span>
                </DropdownMenu.Item> : null}
                {toolbar?.devTools ? <DropdownMenu.Item className="browser-menu__item" aria-label="Open DevTools" disabled={pageToolDisabled} onSelect={openDevTools}>
                  <ThemeObjectToolsIcon size={12} /><span>Open DevTools</span>
                </DropdownMenu.Item> : null}
                {toolbar?.saveBookmark ? <DropdownMenu.Item className="browser-menu__item" aria-label={bookmarkSaveLabel} disabled={pageToolDisabled || bookmarkSaving} onSelect={saveBookmark}>
                  <ThemeObjectBookmarkIcon size={12} /><span>{currentUnconfirmedBookmarks.length ? 'Save another copy' : 'Save bookmark'}</span>
                </DropdownMenu.Item> : null}
                {tab.bookmarkOrigin ? <DropdownMenu.Item className="browser-menu__item" aria-label="View bookmark source" title={tab.bookmarkOrigin.binary ? "This bookmark is a binary file — its source can't be shown as text" : "View this bookmark's source"} disabled={tab.bookmarkOrigin.binary || busy} onSelect={() => viewBookmarkSource(presentation?.target)}>
                  <ThemeFileCodeIcon size={12} /><span>View bookmark source</span>
                </DropdownMenu.Item> : null}
                {toolbar?.viewport ? <>
                  <DropdownMenu.Separator className="browser-menu__separator" />
                  <DropdownMenu.Sub>
                    <DropdownMenu.SubTrigger className="browser-menu__item" disabled={busy}>
                      <ThemeObjectDisplayIcon size={12} /><span>Viewport</span><ThemeNavigationSubmenuIcon size={12} aria-hidden="true" />
                    </DropdownMenu.SubTrigger>
                    <DropdownMenu.Portal><DropdownMenu.SubContent className="browser-menu browser-viewport-menu" sideOffset={5} collisionPadding={8}>
                      {viewportOptions(key)}
                    </DropdownMenu.SubContent></DropdownMenu.Portal>
                  </DropdownMenu.Sub>
                </> : null}
                <DropdownMenu.Separator className="browser-menu__separator" />
                <DropdownMenu.Item className="browser-menu__item" aria-label="Browser tools" onSelect={() => { setManagementVisited(true); setManagementOpen(true) }}>
                  <ThemeActionAdjustIcon size={12} /><span>Browser tools…</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className="browser-menu__item" aria-label="Research in Survey" disabled={busy} onSelect={() => void startResearch()}>
                  <ThemeObjectBrowserIcon size={12} /><span>{research.current ? 'Resume research creation' : 'Research in Survey…'}</span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        {regionCloseButton}
      </form>
      {tab.capsuleId ? <CapsuleInteractionChrome key={tab.capsuleId} capsuleId={tab.capsuleId} active={tab.capsuleActive === true} visible={visible} toolbarHost={capsuleToolbarHost} /> : null}
      {bookmarkSaving ? <p className="browser-bookmark-result" role="status">
        <ThemeStatusLoadingIcon size={12} animation="spin" aria-hidden="true" /><span>Saving bookmark…</span>
      </p> : null}
      {currentBookmark ? <p className="browser-bookmark-result" role="status">
        <ThemeStatusSavedIcon size={12} aria-hidden="true" /><span>Saved</span>
        <code title={currentBookmark.path}>{currentBookmark.path}</code>
        <button type="button" className="small-button" disabled={busy} onClick={() => openSavedBookmark(presentation?.target)}>Open bookmark</button>
      </p> : null}
      {currentBookmarkSave?.status === 'error' ? <p className="browser-address-error" role="alert">
        Bookmark could not be saved: {currentBookmarkSave.message}. <button type="button" className="small-button" disabled={busy} onClick={saveBookmark}>Retry bookmark save</button>
      </p> : null}
      {currentUnconfirmedBookmarks.map((original, index) => <p key={index} className="browser-address-error browser-bookmark-error" role="alert">
        Bookmark save not confirmed{original.path ? <>: <code>{original.path}</code></> : null}. {original.message}. Check the workspace before saving another copy.
        {original.path ? <button type="button" className="small-button" onClick={() => void openBookmarkFile(original.path!, false, presentation?.target).catch(reportError)}>Check bookmark</button> : null}
      </p>)}
      {currentUnconfirmedBookmarks.length ? <p className="browser-bookmark-result">
        <button type="button" className="small-button" disabled={pageToolDisabled || bookmarkSaving} onClick={saveBookmark}>Save another copy</button>
      </p> : null}
      {addressError ? <p className="browser-address-error" role="alert">{addressError}{research.current ? <button type="button" className="small-button" disabled={busy} onClick={() => void startResearch()}>Retry same research</button> : null}{privateCreation.current ? <button type="button" className="small-button" disabled={busy} onClick={() => void startPrivatePage()}>Retry same private page</button> : null}</p> : null}
      {inputHistoryNotice ? <p className="browser-address-error" role="status">{inputHistoryNotice}</p> : null}
      <BrowserOperationWarning activity={browserActivity} />
      {(agentCreationNotice || browserAgentIntent && !browserAgentIntent.inputStarted && !creatingAgent) ? <ServiceWindowNotice notice={{
        kind: 'indeterminate', notice: {
          step: 'Browser Agent setup needs attention',
          mode: agentCreationNotice?.message ?? 'The original Agent creation request is retained. Its first task has not been confirmed.',
          restore: 'Check the same request to continue. The existing Agent and original page are kept.'
        }
      }} actions={<button type="button" className="small-button" disabled={creatingAgent}
        onClick={() => void startBrowserAgent(presentation?.target ?? primaryPresentation)}>Check Agent setup</button>} /> : null}
      {!connectionUnavailable && !tab.nativeOwnerReleased && tab.retention?.status === 'unknown' && tab.retention.reasons.includes('close-unconfirmed') ? <ServiceWindowNotice notice={{
        kind: 'indeterminate', notice: {
          step: 'Browser close unconfirmed',
          mode: 'This page remains available.',
          restore: 'Keep browsing. If it closes, reopen this same Browser. The close request is not repeated.'
        }
      }} /> : null}
      {/* 页面与详情共享布局，正常并排，极窄 Pane 沿 SSOT 改为有限高度阅读区。
          原生 WebContentsView 跟随 stage 的真实矩形，详情不覆盖页面。 */}
      <ServiceWindowNotice notice={annotationSync.notice} title={annotationSync.retryAvailable ? 'Browser annotations unconfirmed' : 'Restoring Browser annotations'} disclosure={{
        scope: JSON.stringify(['local:browser-annotations', tab.browserId, tab.navigationId]), id: 'annotations',
        ...(annotationSync.cause ? { cause: annotationSync.cause } : {}), available: annotationSync.available, visible
      }} actions={annotationSync.retryAvailable ? <button type="button" className="small-button" onClick={annotationSync.retry}>Retry annotations</button> : null} />
      <div className="browser-body">
      {presentation && !connectionUnavailable && !__AGENTMUX_WEB_PREVIEW__ ? <BrowserPresentationStage browserId={tab.browserId} navigationId={tab.navigationId} presentation={presentation}
        control={tab.control} preferences={resolveBrowserAgentControl(agentAppearance)}
        inputSelected={presentation.occurrence.presentationId === selectedPresentationId}
        onInputSelected={() => onPresentationInputSelected?.(presentation.target)}
        blocked={blocked} media={media} stageRef={presentation.stageHostId === presentations[0]?.stageHostId ? stageRef : undefined}>{stageContent}</BrowserPresentationStage>
        : <div className="browser-stage" data-native-browser-stage={tab.browserId} ref={stageRef}>{stageContent}</div>}

      {managementVisited ? <aside className="browser-trace-rail browser-management-rail" aria-label="Browser management controls" hidden={!managementOpen} inert={!managementOpen || !visible}>
        <header><strong>Browser tools</strong><button type="button" className="icon-button" aria-label="Close browser tools" onClick={() => setManagementOpen(false)}><ThemeActionCloseIcon size={14} /></button></header>
        {resourceWorkspace ? <BrowserToolsPanel workspace={resourceWorkspace} visible={visible && managementOpen} /> : <p role="status">The browser resource is still restoring. Your page remains available.</p>}
      </aside> : null}
      {traceViews[key] ? (
        <BrowserTraceReadingHost mode={traceViews[key].mode} open={traceViews[key].open} held={!traceCanDock} visible={visible}
          anchor={() => traceAnchors.current.get(key) ?? null}
          onReopen={() => setTraceViews(current => ({ ...current, [key]: { ...current[key]!, open: true } }))}>
          <BrowserDemonstrationSurface
            suggestions={tab.demonstration?.suggestions}
            draft={tab.demonstration?.draft ?? null}
            collapseSteps={Boolean(taskAsset)}
            {...(tab.demonstration?.warning ? { warning: tab.demonstration.warning } : {})}
            busy={demonstrationBusy || tab.driving}
            onStart={event => void controlDemonstration(event, 'start')}
            onStop={event => void controlDemonstration(event, 'stop')}
          />
          {tab.taskAssets && tab.taskAssets.assets.length > 1 ? <label className="browser-task-asset__field"><span>Task asset</span><select aria-label="Browser task asset" value={taskAsset?.id ?? ''} onChange={event => setSelectedTaskAssetId(event.target.value)}>{tab.taskAssets.assets.map(asset => <option key={asset.id} value={asset.id}>{asset.draft.name}</option>)}</select></label> : null}
          <BrowserTaskAssetEditor
            asset={taskAsset}
            {...(taskAssetReview ? { reviewRequest: taskAssetReview } : {})}
            onReviewRequestConsumed={() => setTaskAssetReview(null)}
            recording={tab.demonstration?.draft ?? null}
            suggestions={tab.demonstration?.suggestions}
            run={taskRun}
            renderReliability={version => taskAsset ? <BrowserTaskReliability browserId={tab.browserId} assetId={taskAsset.id} version={version}
              load={loadTaskReliability} refreshKey={JSON.stringify([
                taskReliabilityRefresh.revisionFor(taskAsset.id, version),
                tab.taskAssets?.runs.filter(run => run.assetId === taskAsset.id && run.version === version),
                tab.taskAssets?.selectedRunId, tab.taskAssets?.warning,
                tab.activity?.operation && tab.taskAssets?.runs.some(run => run.assetId === taskAsset.id && run.version === version && run.operationIds.includes(tab.activity!.operation!.id))
                  ? tab.activity.operation.outcome?.evaluation : null
              ])} /> : null}
            {...(tab.taskAssets?.warning ? { warning: tab.taskAssets.warning } : {})}
            busy={taskBusy || tab.driving || demonstrationBusy}
            onImport={event => void importTaskAsset(event)}
            onSaveDraft={(content, event) => saveTaskAsset(content, event, false)}
            onSaveVersion={(content, event) => saveTaskAsset(content, event, true)}
            onLocateStep={(stepId, event) => { if (event.nativeEvent.isTrusted !== true || !taskAsset) return; void taskAction(event, () => api.browser.locateTaskAssetStep(tab.browserId, taskAsset.id, taskAsset.revision, stepId)).catch(reportError) }}
            batch={tab.taskAssets?.batches?.find(batch => batch.assetId === taskAsset?.id && (batch.id === tab.taskAssets?.activeBatchId || batch.items.some(item => item.runId === tab.taskAssets?.selectedRunId))) ?? null}
            batchRuns={tab.taskAssets?.runs ?? []}
            onRunBatch={(input, event) => taskAction(event, async () => {
              if (!taskAsset) return
              await api.browser.runTaskBatch({ ...input, assetId: taskAsset.id, browserId: tab.browserId })
            })}
            onStopBatch={(batchId, event) => { if (event.nativeEvent.isTrusted !== true) return; void api.browser.stopTaskBatch(tab.browserId, batchId).catch(reportError) }}
            onRun={(input, event) => taskAction(event, async () => {
              if (!taskAsset) return
              await api.browser.runTaskAsset({ ...input, assetId: taskAsset.id, browserId: tab.browserId })
            })}
            onStop={(runId, event) => { if (event.nativeEvent.isTrusted !== true) return; void api.browser.stopTaskAsset(tab.browserId, runId).catch(reportError) }}
            onVerify={async (runId, event) => {
              const result = await taskAction(event, async () => {
                const operations = await api.browser.listOperationHistory()
                const original = operations.find(operation => operation.browserId === tab.browserId && operation.outcome?.registration.assetRun?.runId === runId &&
                  operation.outcome.registration.assetRun.assetId === taskAsset?.id && operation.outcome.registration.assetRun.version === taskRun?.version)
                if (!original) throw new Error('The declared producer is unavailable. Existing work remains; no action was repeated.')
                const result = await api.browser.verifyOutcome(tab.browserId, original.id)
                taskReliabilityRefresh.markVerified(result)
                await loadOperationHistory()
                return result
              })
              if (!result) throw new Error('Verification requires the actual person using this Browser.')
              return result
            }}
          />
          <BrowserOutcomeCriteria
            evaluation={timelineOperation?.outcome?.evaluation ?? null}
            historical={Boolean(timelineOperation?.outcome && (timelineOperation.id !== tab.activity?.operation?.id ||
              timelineOperation.outcome.registration.context.navigationId !== tab.navigationId))}
            onVerify={event => taskAction(event, async () => {
              if (!timelineOperation?.outcome) return
              const result = await api.browser.verifyOutcome(tab.browserId, timelineOperation.id)
              taskReliabilityRefresh.markVerified(result)
              await loadOperationHistory()
            })}
            busy={taskBusy || tab.driving || demonstrationBusy}
            onRun={(input, event) => taskAction(event, async () => {
              setSelectedOperationId(null)
              setSelectedStep(null)
              await api.browser.checkOutcomeFields(tab.browserId, input)
              await loadOperationHistory()
            })}
          />
          <BrowserOperationHistory
            operations={[
              ...(tab.activity?.operation && !operationHistory.some((operation) => operation.id === tab.activity?.operation?.id) ? [tab.activity.operation] : []),
              ...operationHistory
            ]}
            selectedOperationId={selectedOperationId ?? tab.activity?.operation?.id ?? null}
            loading={historyLoading}
            error={historyError}
            onRetry={() => void loadOperationHistory()}
            onClose={() => setTraceViews(current => ({ ...current, [key]: { ...current[key]!, open: false } }))}
            onSelect={(operation) => {
              setSelectedOperationId(operation.id)
              setSelectedStep(null)
              setReplayPlan(null)
              setReplayOutcome(undefined)
            }}
          />
          {timelineOperation ? <BrowserOperationTimeline
            operation={timelineOperation}
            {...(timelineSelectedStep ? { selectedSequence: timelineSelectedStep.sequence } : {})}
            onSelectStep={(step) => {
              if (timelineOperation) setSelectedStep({ operationId: timelineOperation.id, sequence: step.sequence })
            }}
            {...(timelineWarning ? { warning: timelineWarning } : {})}
            onReplay={(operation) => {
              setReplayOutcome(undefined)
              void executeControl({
                schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
                requestId: mintObjectId(),
                operation: 'browser.replay',
                browserId: tab.browserId,
                operationId: operation.id,
                mode: 'preview'
              }).then((receipt) => {
                // preview 那一枝才带 plan。判 mode 而不是直接读 `receipt.plan`：run/step 两枝没有
                // 这个字段，tsc 在这里要求收窄。
                if (receipt.operation === 'browser.replay' && receipt.mode === 'preview') setReplayPlan(narrowBrowserReplayPlan(receipt.plan))
              }).catch(reportError)
            }}
          /> : null}
          {timelineOperation && timelineSelectedStep ? <button type="button" className="small-button" onClick={event => discussion.open(event.currentTarget as HTMLButtonElement, { operationId: timelineOperation.id, sequence: timelineSelectedStep.sequence }, traceAnchors.current.get(key))}>Comment on step {timelineSelectedStep.sequence}</button> : null}
          {timelineOperation && timelineSelectedStep
            ? <BrowserStepEvidence operation={timelineOperation} step={timelineSelectedStep} /> : null}
          {replayPlan ? (
            <BrowserReplayPreview
              plan={replayPlan}
              busy={replayBusy}
              {...(replayOutcome ? { outcome: replayOutcome } : {})}
              onClose={() => setReplayPlan(null)}
              onStep={(sequence) => void runReplayStep(sequence)}
              onRun={() => void runReplay()}
            />
          ) : null}
        </BrowserTraceReadingHost>
      ) : null}
      </div>
      {customViewport === key ? <BrowserViewportSizeDialog value={tab.viewport} visible={visible}
        onApply={async viewport => { const browser = await api.browser.setViewport(tab.browserId, viewport); applyBrowserEvent({ type: 'updated', browser }) }}
        onClose={() => setCustomViewport(null)} /> : null}
    </section>
  )
  }
  const primary = presentations.find(presentation => presentation.target.hostId === presentationTargetId) ?? presentations[0]
  return <>
    {renderPane(primary)}
    {discussion.dialog}
    {renderPresentationFrame ? presentations.filter(presentation => presentation !== primary).map(presentation =>
      <StableWorkbenchView key={presentation.occurrence.presentationId} kind="region"
        homeId={`${presentation.stageHostId}:parked`} targetId={presentation.stageHostId}
        reference={presentation.occurrence.location}
        active={presentation.active} visible={presentation.visible}
        retainedRegionId={presentation.occurrence.location.regionId}>
        <WorkbenchPresentationContext.Consumer>
          {({ tabHostId }) => renderPresentationFrame(renderPane({ ...presentation,
            visible: presentation.visible && tabHostId === presentation.stageHostId }), presentation.target)}
        </WorkbenchPresentationContext.Consumer>
      </StableWorkbenchView>) : null}
  </>
}
