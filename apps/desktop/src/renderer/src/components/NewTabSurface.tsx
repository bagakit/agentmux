import { Button } from '@agentmux/client-ui/components/Button'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { SurfaceState } from './SurfaceState'
import { useWorkbenchWindowDocument } from '../lib/workbench-document'
import { moteDefaultExecutor } from '../lib/mote-quick-preferences'
import { scratchTopicsForWorkspace, scratchTopicKind } from '../lib/scratch-topic-snapshots'
import { MoteWorkfaceContext } from '../lib/mote-workface'
import { AgentAvatar } from './AgentAvatar'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { TERMINAL_FONT_SIZE_DEFAULT, isScratchWorkspaceId } from '../../../shared/contracts'
import { lifecycleNotification, notificationEventIdentity, useAppStore, warmTerminalKey, currentCoreSpatialGraph } from '../store'
import { originalSourceEntryForSelection, originalSourceLauncherExecution, originalSpaceWorkspace, originalRawSourceOccurrenceConfirmed, isOriginalSourceWorkspaceProjection } from '../lib/original-space-navigation'
import { useWorkbenchBrowserPresentation, useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { mainRegionReference } from '../lib/desktop-focus-navigation'
import { workbenchTabDisplayWorkspaceId } from '../lib/workbench-resource-display'
import { currentHostCheck } from '../lib/host-check'
import { formatPathForDisplay } from '../lib/copy-path-display'
import { defaultExecutorChoice, hostExecutorInventoryMatches, executorsForHost } from '../lib/executors'
import { useLauncherExecutorRecovery } from '../hooks/useLauncherExecutorRecovery'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useLauncherInputs } from '../lib/launcher-inputs'
import { EMPTY_LAUNCH_OPTION_SELECTION } from '../lib/launcher-option-draft'
import { useComposerAttachments } from '../lib/use-composer-attachments'
import { expandSemanticReferences, parseComposerDraft } from '@agentmux/client-ui/composer-semantic-reference'
import { launcherCanLaunch, launcherKeydownLaunches } from '../lib/launcher-submit'
import { resolveLauncherWorkspaceId } from '../lib/launcher-workspace'
import { warmLauncherId, warmTerminalForLauncher, warmTerminalPreview } from '../lib/warm-terminal-preview'
import { ComposerCompletionEditor } from '@agentmux/client-ui/components/ComposerCompletionEditor'
import { useComposerCandidates, skillComposerSuggestion } from '../lib/use-composer-candidates'
import { LaunchRefine } from './LaunchOptionControls'
import { isMacPlatform } from '../lib/host-platform'
import { api } from '../lib/api'
import { AgentComposerTools } from './AgentComposerTools'
import { ComposerReferenceTool } from '@agentmux/client-ui/components/ComposerReferenceTool'
import { ComposerFeedback, useComposerFeedback } from './ComposerFeedback'
import { AgentLifecycleFeedback } from './AgentLifecycleFeedback'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { LauncherSecondarySurfaces } from './LauncherSecondarySurfaces'
import { LauncherMoteAction } from './LauncherMoteAction'
import { LauncherResumePicker } from './LauncherResumePicker'
import { LauncherEnvironment } from './LauncherEnvironment'
import { LauncherAgentDevice } from './LauncherAgentDevice'
import type { LauncherExecutionSelection } from '../store'
import { ComposerFileReferences } from './ComposerFileReferences'
import { AgentExecutorPicker } from './AgentExecutorPicker'
import { LauncherAvailabilityNotice } from './LauncherAvailabilityNotice'
import { DEFAULT_LAUNCHER_SECTIONS, useLauncherState, type LauncherSection, type LauncherSectionMode } from '../lib/launcher-state'
import { PMO_TEAMS_TOPIC_ID } from '@agentmux/host/mote-model'
import { primaryMoteExecutorId, primaryMoteHasBot } from '../lib/primary-mote-executor'
import { SettingsNavigation } from './SettingsNavigation'
import { useContext } from 'react'
import { WorkbenchProjectionContext } from '../lib/workbench-projection'
import { resolveBrandHero } from '../lib/brand-hero'
import { useShallow } from 'zustand/react/shallow'
import { AgentOperationFeedback } from './AgentOperationFeedback'
import { launcherSourceExecution, launcherSourceMatches } from '../lib/launcher-source'
import { useSourceLauncher } from '../hooks/useSourceLauncher'
import { SourceLauncherRequest } from './SourceLauncherRequest'
import { mountedAgentOpenInput, mountedAgentOpenKey, type MountedAgentOpenInput } from '../lib/space-mount-launch'
import { ordinarySourceLauncherRequests, sendSourceLauncherRequest } from '../lib/source-launcher-request'
import { newSourceAgentInput } from '../lib/new-source-agent-input'
import { SourceCoordinatorRequests } from './SourceCoordinatorRequests'

const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')
const ThemeStatusLoadingIcon = semanticIconComponent('status.loading')
const ThemeActionRefreshIcon = semanticIconComponent('action.refresh')
const ThemeActionCollapseIcon = semanticIconComponent('action.collapse')
const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeActionStartIcon = semanticIconComponent('action.start')
const ThemeNavigationDownIcon = semanticIconComponent('navigation.down')


export function NewTabSurface({
  tabGroupId,
  tabId,
  regionId,
  emptyGroupWorkspaceId,
  creationTarget,
  visible = true
}: {
  tabGroupId: string
  tabId?: string
  regionId?: string
  /** Ordinary empty Group owner; global selection belongs to a different workface. */
  emptyGroupWorkspaceId?: string
  /** Confirmed empty Zone; materialize only on an explicit action. */
  creationTarget?: { workspaceId: string; displayWorkspaceId: string; zoneId: string }
  /** Hidden Workbench slots stay mounted, but only the visible launcher may own the warm PTY. */
  visible?: boolean
}) {
  const presentationActive = useWorkbenchPresentationActive()
  const presentation = useWorkbenchBrowserPresentation()
  const projection = useContext(WorkbenchProjectionContext)
  const emptyWorkspaceId = !tabId && !regionId ? emptyGroupWorkspaceId : undefined
  const ordinaryEmptyGroup = emptyWorkspaceId !== undefined && !isOriginalSourceWorkspaceProjection(emptyWorkspaceId)
  const settings = useContext(SettingsNavigation)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const operationHosts = useAppStore(useShallow(useMemo(() => {
    let references: ReturnType<typeof useAppStore.getState>['agentOperations'] | undefined
    let hosts: string[] = []
    return (state: ReturnType<typeof useAppStore.getState>) => {
      if (state.agentOperations !== references) {
        references = state.agentOperations
        hosts = regionId ? [...new Set(Object.values(references).filter(operation => operation.subject.regionId === regionId)
          .map(operation => operation.subject.hostId))] : []
      }
      return hosts
    }
  }, [regionId])))
  const [regionHeight, setRegionHeight] = useState<number | null>(null)
  const restoreAgentsFocus = useRef<LauncherSectionMode | null>(null)
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden)
  const motionActive = visible && presentationActive && documentVisible
  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (!motionActive || !surface) return
    const measure = () => {
      const height = surface.getBoundingClientRect().height
      if (height > 0) setRegionHeight(current => current === height ? current : height)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(surface)
    return () => observer.disconnect()
  }, [motionActive])
  useEffect(() => {
    if (!visible || !presentationActive) return
    const changed = () => setDocumentVisible(!document.hidden)
    changed()
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [visible, presentationActive])
  const mote = useContext(MoteWorkfaceContext)
  const moteId = useAppStore(state => {
    const tab = tabId ? state.tabs[tabId] : undefined
    const topicId = tabId ? tab?.topicId : mote?.topic.id
    const resourceId = tabId ? tab?.workspaceId : mote?.workspace.id
    const workspace = state.config?.workspaces.find(item => item.id === resourceId)
    return topicId && scratchTopicKind(topicId, scratchTopicsForWorkspace(state.scratchTopicSnapshots, workspace)) === 'mote' ? topicId : undefined
  })
  const moteExecutor = useAppStore(state => moteDefaultExecutor(state, tabId ? state.tabs[tabId]?.workspaceId ?? '' : mote?.workspace.id ?? '', moteId))
  const [executorId, setExecutorId] = useState(() => {
    const surface = tabId && regionId ? useAppStore.getState().tabs[tabId]?.regions[regionId] : undefined
    return (surface?.kind === 'launcher' ? surface.executorId : undefined) ?? moteExecutor ?? ''
  })
  const [manualChoice, setManualChoice] = useState<{ regionId: string | undefined; executorId: string; moteId?: string | undefined } | null>(null)
  const insertionRef = useRef<ComposerInsertionHandle>(null)
  // Every Launcher has an input owner, including a Workspace's first empty Tab Group.
  const launcherId = creationTarget && !regionId
    ? `zone:${JSON.stringify([creationTarget.zoneId, creationTarget.displayWorkspaceId, tabGroupId])}`
    : warmLauncherId({ tabGroupId, regionId })
  const sourceValue = useLauncherState(state => state.drafts[launcherId]?.sourceExecution)
  const sourceInputs = useAppStore(state => state.mountedSpaceInputs)
  const rawSourceSelection = useAppStore(state => !ordinaryEmptyGroup && Boolean(state.workbenchSpaceSelection?.sourceRuntimeId &&
    !isOriginalSourceWorkspaceProjection(state.workbenchSpaceSelection.workspaceId)))
  const rawSourceUnknown = useAppStore(state => rawSourceSelection && !originalRawSourceOccurrenceConfirmed(state, currentCoreSpatialGraph()))
  const implicitSourceKey = useAppStore(state => ordinaryEmptyGroup || rawSourceSelection ? undefined : originalSourceEntryForSelection(state)?.key)
  const implicitSourceObservation = useAppStore(state => implicitSourceKey ? state.mountedSpaceObservations[implicitSourceKey] : undefined)
  const implicitSource = useMemo(() => implicitSourceKey ? originalSourceLauncherExecution(useAppStore.getState(), tabId, regionId, currentCoreSpatialGraph()) : undefined,
    [implicitSourceKey, sourceInputs, implicitSourceObservation, tabId, regionId])
  let sourceExecution: ReturnType<typeof launcherSourceExecution>, sourceSelectionIssue: string | undefined
  try { sourceExecution = sourceValue === undefined ? implicitSource : launcherSourceExecution(sourceValue) } catch (cause) { sourceSelectionIssue = presentError(cause) }
  const sourceMode = sourceValue !== undefined || implicitSourceKey !== undefined || rawSourceUnknown
  const sourceUnavailable = sourceMode ? 'Mote discussion, Terminal, Browser and Note creation through this original Source are unavailable here. No local substitute will be created.' : undefined
  const sourceLauncher = useSourceLauncher(sourceExecution, motionActive && !moteId)
  const { prompt, setPrompt, names, setName, optionsByProvider, selectOption } = useLauncherInputs(regionId, launcherId)
  const sourceBusy = useRef(new Map<string, symbol>())
  const retainedSourceRequests = useMemo(() => {
    try { return { inputs: ordinarySourceLauncherRequests(sourceInputs, launcherId), issue: undefined } }
    catch (cause) { return { inputs: [], issue: presentError(cause) } }
  }, [sourceInputs, launcherId])
  const promptDisplayText = useMemo(() => parseComposerDraft(prompt).map(part =>
    'text' in part ? part.text : part.reference.label).join(''), [prompt])
  const [optionsExpanded, setOptionsExpanded] = useState(false)
  const [fileReferencesOpen, setFileReferencesOpen] = useState(false)
  useEffect(() => { if (!motionActive) setOptionsExpanded(false) }, [motionActive])
  const sourceSlot = tabId && regionId ? { kind: 'region' as const, tabId, regionId } : undefined
  const operationKey = sourceMode && sourceExecution && sourceSlot ? mountedAgentOpenKey(sourceExecution.target, sourceSlot) : launcherId
  const [busy, setBusy] = useState<{ kind: 'agent' | 'terminal' | 'browser' | 'note'; key: string } | null>(null)
  const busyKind = busy?.key === operationKey ? busy.kind : null
  const [executionPreparing, setExecutionPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const config = useAppStore((state) => state.config)
  // One resolver owns hero art; the stylesheet only places whatever image this surface is given.
  const launcherHero = resolveBrandHero('banner', config?.appearance.appIcon, config !== null).art
  const providerCatalog = useAppStore((state) => state.providerCatalog)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const tabWorkspaceId = useAppStore((state) => tabId ? state.tabs[tabId]?.workspaceId : undefined)
  const launcherWorkspaceId = useAppStore(state => {
    const surface = tabId && regionId ? state.tabs[tabId]?.regions[regionId] : undefined
    return surface?.kind === 'launcher' ? surface.workspaceId : undefined
  })
  const agentTarget = useAppStore(state => {
    const surface = tabId && regionId ? state.tabs[tabId]?.regions[regionId] : undefined
    return surface?.kind === 'launcher' ? surface : undefined
  })
  const topicPreparation = useAppStore(state => tabId ? state.tabs[tabId]?.topicPreparation : undefined)
  const primaryBotUnconfirmed = useAppStore(state => Boolean(tabId && prompt && state.tabs[tabId]?.topicId === PMO_TEAMS_TOPIC_ID &&
    primaryMoteHasBot(state) && !primaryMoteExecutorId(state)))
  const explicitExecutorChoice = Boolean(moteExecutor || manualChoice?.regionId === regionId && manualChoice?.moteId === moteId && manualChoice?.executorId === executorId)
  const ordinaryExecutorId = primaryBotUnconfirmed && !explicitExecutorChoice ? '' : executorId
  const detections = useAppStore((state) => state.executorDetections)
  const detectExecutors = useAppStore((state) => state.detectExecutors)
  const launchAgent = useAppStore((state) => state.launchAgent)
  const prewarmTerminal = useAppStore((state) => state.prewarmTerminal)
  const releaseWarmTerminal = useAppStore(state => state.releaseWarmTerminal)
  const controlNavigation = useAppStore(state => state.workbenchNavigationInputPolicy !== null ||
    state.workbenchSpaceSelection !== null && state.workbenchSpaceSelection.tabId === null)
  // A visible Tab can contain an unselected Launcher created by Control. Only its
  // selected Region may acquire input; the original empty-group Launcher has no Region.
  const inputRegionActive = useAppStore(state => {
    if (ordinaryEmptyGroup) return state.layouts[creationTarget?.displayWorkspaceId ?? emptyWorkspaceId!]?.activeGroupId === tabGroupId
    if (!tabId || !regionId) return tabId === undefined && regionId === undefined
    if (state.tabs[tabId]?.regions[regionId]?.kind !== 'launcher') return false
    const reference = (presentation.surface === 'mote' || presentation.surface === 'recall') ? presentation.reference : mainRegionReference(state.workbenchSpaceSelection)
    return reference ? reference.tabId === tabId && reference.regionId === regionId
      : !presentation.surface && state.tabs[tabId]?.layout.activeRegionId === regionId
  })
  const terminalThemeId = useAppStore((state) => state.config?.appearance.terminalTheme)
  const terminalFontSize = useAppStore(
    (state) => state.config?.appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT
  )
  // 卡片上写「Start in ⟨谁⟩」的那个 Workspace，与五个启动动作真正落进去的那个，必须是**同一次**
  // 判定（resolveLauncherWorkspaceId）。分开算的症状不是报错：标题写着 A、点下去建到 B。
  const resolvedWorkspaceId = resolveLauncherWorkspaceId({
    launcherWorkspaceId,
    launcherTabWorkspaceId: tabWorkspaceId ?? creationTarget?.workspaceId ?? emptyWorkspaceId,
    activeWorkspaceId
  })
  const workspace = useMemo(() => {
    const state = useAppStore.getState()
    return originalSpaceWorkspace(ordinaryEmptyGroup ? { ...state, workbenchSpaceSelection: null } : state,
      resolvedWorkspaceId, currentCoreSpatialGraph())
  }, [ordinaryEmptyGroup, resolvedWorkspaceId, config, sourceInputs, implicitSourceObservation, rawSourceUnknown])
  const host = workspace ? config?.hosts.find((candidate) => candidate.id === workspace.hostId) : undefined
  const splitExecution = agentTarget?.agentWorkspaceId !== undefined
  const agentWorkspace = splitExecution ? config?.workspaces.find(item => item.id === agentTarget.agentWorkspaceId) : workspace
  const splitWorkspaceSupported = Boolean(workspace && agentWorkspace && !isScratchWorkspaceId(workspace.id) && !isScratchWorkspaceId(agentWorkspace.id))
  const splitProjectUnsupported = Boolean(workspace && isScratchWorkspaceId(workspace.id) || agentWorkspace && isScratchWorkspaceId(agentWorkspace.id))
  const agentHost = agentWorkspace ? config?.hosts.find(candidate => candidate.id === agentWorkspace.hostId) : undefined
  const usesHostInventory = !sourceMode && (splitExecution || agentHost?.kind === 'ssh')
  const inventory = useAppStore(state => agentWorkspace ? state.hostExecutorInventories[agentWorkspace.hostId] : undefined)
  const displayedExecutorId = sourceMode ? sourceLauncher.executorId ?? '' : splitExecution ? agentTarget?.agentExecutor?.executorId ?? '' : ordinaryExecutorId
  const checkAgents = (hostId: string, options?: { onlyUnconfirmed?: boolean }) => sourceMode ? sourceLauncher.refresh() : detectExecutors(hostId, { ...options, ...(splitExecution ? { source: 'host' as const } : {}) })
  const localHome = useAppStore(state => state.localHome)
  const displayPath = workspace ? formatPathForDisplay(workspace.path, {
    home: host?.kind === 'local' ? localHome : '', copyPathsAsAbsolute: config?.copyPathsAsAbsolute
  }) : ''
  const storedHostCheck = useAppStore((state) => workspace ? state.hostChecks[workspace.hostId] : undefined)
  const hostCheck = host ? currentHostCheck(storedHostCheck, host) : undefined
  // Only show a warm shell created for this exact host and working directory.
  // It remains outside the ordinary Session list until the user claims it.
  const warmKey = workspace ? warmTerminalKey(workspace.hostId, workspace.path) : null
  const warmTerminal = useAppStore(state => sourceMode ? null : warmTerminalForLauncher(
    warmKey === null ? undefined : state.warmTerminals[warmKey], launcherId))
  // 「这次启动来自哪个 launcher Region」——五个动作共用的同一个实参，只在这里算一次。
  // 手抄五遍时任何一处写成 `regionId ? …`（漏掉 tabId）都会让那一个动作静默丢掉 launcher 上下文，
  // 于是它按活动 Workspace 解析——正是 createNote 已经犯过的那个缺陷的另一种入口。
  const launcherRef = tabId && regionId ? { tabId, regionId } : undefined
  // 「这个槽在我眼里是什么样」只判一次，落点在 warmTerminalPreview。要显示哪个 session、要不要显示
  // 「正在预热」、槽在不在，分开算必然漂移，症状是转圈提示归 A 而终端画面归 B 这种自相矛盾的画面。
  const warmPreview = warmTerminalPreview({
    warmTerminal,
    warmKey,
    launcherId
  })
  const { slotHeld: warmSlotHeld } = warmPreview
  const executors = useMemo(
    () => sourceMode ? sourceLauncher.executors : executorsForHost(config, agentWorkspace?.hostId, detections, inventory, splitExecution ? 'host' : undefined),
    [sourceMode, sourceLauncher.executors, config?.executors, config?.hosts, detections, agentWorkspace, inventory, splitExecution]
  )
  // An unconfirmed discovery check is not evidence that the configured Agent cannot work.
  const installedExecutors = executors.filter(executor => executor.detection?.state !== 'missing')
  const detecting = sourceMode ? sourceLauncher.inventoryState === 'pending'
    : inventory?.state === 'checking' || executors.some((executor) => executor.detection?.state === 'checking')
  const savedSections = useLauncherState(state => workspace ? state.sections[workspace.id] : undefined)
  const sections = { ...DEFAULT_LAUNCHER_SECTIONS,
    terminal: presentation.surface === 'mote' || presentation.surface === 'recall' || presentation.surface === 'survey' || presentation.survey ? 'collapsed' as const : 'expanded' as const,
    ...savedSections }
  const persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const saveSection = useLauncherState(state => state.setSection)
  const saveExecutor = useLauncherState(state => state.selectExecutor)
  const savedExecutor = useLauncherState(state => workspace ? state.executors[workspace.id] : undefined)
  const selectedExecutor = executors.find(executor => executor.id === displayedExecutorId && (sourceMode || !splitExecution || agentTarget?.agentExecutor?.hostId === agentWorkspace?.hostId && agentTarget?.agentExecutor?.executorRevision === executor.executorRevision))
  const unconfirmedAvailability = (splitExecution || agentHost?.kind === 'ssh') && (!hostExecutorInventoryMatches(inventory, agentHost) || inventory.state !== 'ready') ||
    executors.some(executor => executor.detection?.state !== 'ready' && executor.detection?.state !== 'missing')
  const emptyHostInventoryUnconfirmed = executors.length === 0 && (sourceMode ? sourceLauncher.inventoryState !== 'ready' :
    usesHostInventory && (!hostExecutorInventoryMatches(inventory, agentHost) || inventory?.state !== 'ready'))
  const confirmedEmptyExecutors = executors.length === 0 && !emptyHostInventoryUnconfirmed
  const retryingAvailability = useLauncherExecutorRecovery(agentHost,
    !sourceMode && motionActive && inputRegionActive && !controlNavigation && sections.agents !== 'hidden', unconfirmedAvailability, splitExecution ? 'host' : undefined)
  function setSection(section: LauncherSection, mode: LauncherSectionMode) {
    if (section === 'agents' && mode !== 'expanded' && surfaceRef.current?.contains(document.activeElement)) restoreAgentsFocus.current = mode
    if (workspace) saveSection(workspace.id, section, mode)
  }
  useLayoutEffect(() => {
    const mode = restoreAgentsFocus.current
    restoreAgentsFocus.current = null
    if (!mode || !motionActive || !surfaceRef.current || sections.agents !== mode) return
    const label = mode === 'hidden' ? 'Restore Agents' : 'Expand Agents'
    surfaceRef.current.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.focus({ preventScroll: true })
  }, [sections.agents, motionActive])
  function chooseExecutor(id: string) {
    if (sourceMode) { if (sourceExecution) useLauncherState.getState().setSourceExecution(launcherId, { ...sourceExecution, executorId: id }); return }
    if (splitExecution) {
      const target = materializeLauncher()
      if (target) useAppStore.getState().setLauncherAgentExecutor(target, id)
      return
    }
    if (launcherRef && workspace) useAppStore.getState().setLauncherExecutionWorkspace(launcherRef, workspace.id, id)
    setManualChoice({ regionId, executorId: id, moteId })
    setExecutorId(id)
    if (workspace && !moteId) saveExecutor(workspace.id, id)
  }
  const explicitSavedExecutor = useAppStore(state => {
    const surface = tabId && regionId ? state.tabs[tabId]?.regions[regionId] : undefined
    return surface?.kind === 'launcher' ? surface.executorId : undefined
  })
  useEffect(() => {
    if (explicitSavedExecutor) setExecutorId(explicitSavedExecutor)
    else if (!manualChoice || manualChoice.regionId !== regionId || manualChoice.moteId !== moteId) {
      if (moteExecutor) setExecutorId(moteExecutor)
      else if (savedExecutor) setExecutorId(savedExecutor)
    }
  }, [workspace?.id, savedExecutor, explicitSavedExecutor, moteExecutor, moteId])

  // Launch options are read purely from the selected Provider's catalog declaration — no branch on
  // providerId. A Provider that declares none yields [], so LaunchRefine renders nothing.
  const selectedProviderId = selectedExecutor?.providerId
  const launchOptionSelection = selectedProviderId ? optionsByProvider[selectedProviderId] ?? EMPTY_LAUNCH_OPTION_SELECTION : EMPTY_LAUNCH_OPTION_SELECTION
  const toolsScope = JSON.stringify([regionId, workspace?.id, workspace?.hostId, workspace?.path, selectedProviderId])
  useEffect(() => { setFileReferencesOpen(false) }, [toolsScope, motionActive])
  const feedback = useComposerFeedback(toolsScope)
  const completion = useComposerCandidates({ scope: toolsScope, active: !sourceMode && motionActive && sections.agents === 'expanded' && busyKind === null, config, resourceWorkspace: workspace, runtimeWorkspace: agentWorkspace,
    providerId: selectedProviderId, commands: sourceMode ? [] : providerCatalog.find(entry => entry.id === selectedProviderId)?.composer?.commands ?? [], insertion: insertionRef })
  const launchOptions = useMemo(
    () => sourceMode ? sourceLauncher.selected?.launchOptions ?? [] : providerCatalog.find((entry) => entry.id === selectedProviderId)?.launchOptions ?? [],
    [sourceMode, sourceLauncher.selected, providerCatalog, selectedProviderId]
  )
  // Each Provider keeps its own explicit choices. Changing the target closes the disclosure,
  // while returning to the original Provider restores its unsent selection.
  useEffect(() => {
    setOptionsExpanded(false)
  }, [selectedProviderId])

  useEffect(() => {
    // Acquisition is idempotent for this Launcher. Retaining its original candidate
    // also keeps an unknown request from being retried by ordinary rendering.
    if (!sourceUnavailable && workspace && visible && presentationActive && inputRegionActive && !controlNavigation && sections.terminal === 'expanded') {
      prewarmTerminal(workspace.id, launcherId)
    }
  }, [prewarmTerminal, sourceUnavailable, visible, presentationActive, inputRegionActive, controlNavigation, workspace?.id, launcherId, warmSlotHeld, warmTerminal?.session?.id, warmKey, sections.terminal])

  useEffect(() => {
    if (sourceUnavailable || !workspace || !visible || !presentationActive || sections.terminal !== 'expanded') return
    // Losing input focus leaves the visible preview intact. Only removing its
    // presentation makes this still-unused candidate available to another Launcher.
    return () => releaseWarmTerminal(workspace.id, launcherId)
  }, [releaseWarmTerminal, sourceUnavailable, workspace?.id, warmKey, launcherId, visible, presentationActive, sections.terminal])

  useEffect(() => {
    if (sourceMode || sections.agents === 'hidden') return
    if (!agentWorkspace || (splitExecution || agentHost?.kind === 'ssh' ? hostExecutorInventoryMatches(inventory, agentHost) : executors.every((executor) => executor.detection))) return
    if (!visible || !presentationActive || !inputRegionActive || controlNavigation) return
    void checkAgents(agentWorkspace.hostId)
  }, [executors, inventory, agentHost, detectExecutors, visible, presentationActive, inputRegionActive, controlNavigation, agentWorkspace, splitExecution, sourceMode, sections.agents])

  useEffect(() => {
    if (sourceMode) return
    if (splitExecution) {
      const fallback = defaultExecutorChoice(executors)
      if (!agentTarget?.agentExecutor && fallback && launcherRef) chooseExecutor(fallback.id)
      return
    }
    if (moteId && (explicitSavedExecutor || moteExecutor || manualChoice?.moteId === moteId)) return
    if (installedExecutors.some((executor) => executor.id === executorId)) return
    const fallback = defaultExecutorChoice(executors, savedExecutor)
    if (fallback) setExecutorId(fallback.id)
  }, [executorId, executors, installedExecutors, savedExecutor, moteId, explicitSavedExecutor, moteExecutor, manualChoice, splitExecution, sourceMode, agentTarget?.agentExecutor])

  async function run<T>(kind: 'agent' | 'terminal' | 'browser' | 'note', action: () => Promise<T>): Promise<void> {
    if (kind !== 'agent' && sourceUnavailable) { setError(sourceUnavailable); return }
    const owner = operationKey
    if (busy?.key === owner) return
    setBusy({ kind, key: owner })
    setError(null)
    try {
      await action()
    } catch (cause) {
      if (kind === 'agent' && regionId && tabId) {
        const state = useAppStore.getState()
        if (state.tabs[tabId]?.regions[regionId]?.kind !== 'launcher') return
        const context = { kind: 'indeterminate' as const, lifecycle: { step: 'launch' as const, regionId, tabId } }
        if (lifecycleNotification(state.notificationEvents, { regionId })?.id !== notificationEventIdentity(presentError(cause), context)) {
          state.reportError(cause, context)
        }
      } else setError(presentError(cause))
    } finally {
      setBusy(current => current?.key === owner ? null : current)
    }
  }

  // 「现在能不能启动」判一次，主按钮的 disabled 与 Cmd/Ctrl+Enter 那条路共用它。手抄两份时两条路会对
  // 同一概念判得不一样，症状是按钮灰着而键盘照旧发车（或反过来）。
  let sourceOriginal: MountedAgentOpenInput | undefined
  try { if (sourceExecution && sourceSlot) sourceOriginal = mountedAgentOpenInput(sourceInputs, mountedAgentOpenKey(sourceExecution.target, sourceSlot)) }
  catch (cause) { sourceSelectionIssue = presentError(cause) }
  const readiness = {
    hasWorkspace: sourceMode ? Boolean(sourceExecution && sourceExecution.kind !== 'source-coordinator' && launcherSourceMatches(sourceExecution, workspace) && sourceLauncher.ready && !sourceSelectionIssue) : Boolean(workspace && agentWorkspace && (!splitExecution || splitWorkspaceSupported)),
    busy: busyKind !== null || executionPreparing || !!sourceOriginal,
    installedExecutorCount: sourceMode ? sourceLauncher.selected ? 1 : 0 : splitExecution ? selectedExecutor ? 1 : 0 : primaryBotUnconfirmed && !explicitExecutorChoice ? 0 : installedExecutors.length
  }
  // 启动这一件事也只写一次：按钮的 onClick 与键盘那条路调的是同一个函数。抄两遍时任何一处漏掉
  // launchOptionSelection 或那两个名字，就变成「用鼠标点带着精调启动、用键盘发就丢掉精调」。
  function launchFromLauncher(): void {
    if (!launcherCanLaunch(readiness) || sourceOriginal) return
    void run('agent', () => {
      const target = materializeLauncher()
      if (!target) return Promise.resolve()
      if (sourceMode) return launchAtSource(target)
      return launchAgent(
        displayedExecutorId,
        expandSemanticReferences(prompt),
        tabGroupId,
        target,
        launchOptionSelection,
        // trim 后为空即不传：空白不该变成一个 "launch" 档的名字，也绝不阻塞启动。
        { agentName: names.agentName.trim() || undefined, tabName: names.tabName.trim() || undefined }
      )
    })
  }

  async function launchAtSource(slot: { tabId: string; regionId: string }, original?: MountedAgentOpenInput) {
    if (!original && (!sourceExecution || !launcherSourceMatches(sourceExecution, workspace))) throw Error('The original Source project changed. Its draft and request are retained.')
    const source = sourceExecution
    if (!original && !source) throw Error('The original Source target is unavailable. Your draft is retained.')
    if (!original && source?.kind === 'source-coordinator') {
      const selected = sourceLauncher.selected
      if (!selected || selected.executorId !== displayedExecutorId) throw Error('The selected original Coordinator declaration is unconfirmed. Your input is retained.')
      return await useAppStore.getState().launchAgent(selected.executorId, expandSemanticReferences(prompt), tabGroupId, slot,
        { ...launchOptionSelection }, { ...names }, undefined, undefined, { selection: source, executor: selected })
    }
    const sourceOwned = source && source.kind !== 'source-coordinator' ? source : undefined
    const key = mountedAgentOpenKey(original?.target ?? source!.target, original?.slot ?? { kind: 'region', ...slot }), token = Symbol(key)
    if (sourceBusy.current.has(key)) return
    sourceBusy.current.set(key, token)
    try {
      const note = useAppStore.getState().agentComposerNotes[slot.regionId]
      const sourceInput = original ? undefined : await newSourceAgentInput(sourceOwned!.target, sourceOwned!.agentTarget)
      const input: MountedAgentOpenInput = original ?? { kind: 'agent-open', target: source!.target, ...(sourceInput?.issue ? { issue: sourceInput.issue } : {}),
        slot: { kind: 'region', ...slot }, submitted: false, origin: { kind: 'ordinary-launcher', launcherId: warmLauncherId({ tabGroupId, regionId: slot.regionId }), project: source!.project, names: { ...names } },
        request: { operationId: crypto.randomUUID(), content: { kind: 'new-agent', executorId: displayedExecutorId, agentTarget: sourceOwned!.agentTarget, ...sourceInput?.fields,
          prompt: expandSemanticReferences(prompt), launchOptions: { ...launchOptionSelection },
          ...(note === undefined ? {} : { agentMuxNote: note }) },
          destination: { spaceId: source!.target.reference.spaceId, zoneId: source!.target.zoneId, newTab: true }, focus: false } }
      await sendSourceLauncherRequest(input, !!original?.submitted)
    }
    finally { if (sourceBusy.current.get(key) === token) sourceBusy.current.delete(key) }
  }

  function materializeLauncher() {
    if (launcherRef) return launcherRef
    if (!workspace) return undefined
    const createdId = useAppStore.getState().openLauncher({ workspaceId: workspace.id, ...creationTarget, tabGroupId,
      reveal: Boolean(creationTarget && !projection),
      initialInputs: { prompt, names, optionsByProvider, sourceLauncherId: launcherId } })
    const created = createdId ? useAppStore.getState().tabs[createdId] : undefined
    if (!created) return undefined
    const target = { tabId: created.id, regionId: created.layout.activeRegionId }
    if (projection) projection.onSelect({ displayWorkspaceId: creationTarget?.displayWorkspaceId ?? workspace.id,
      groupId: tabGroupId, ...target })
    return target
  }

  function getTakeoverOrigin() {
    const target = materializeLauncher()
    if (!target || !workspace) return undefined
    const displayWorkspaceId = projection?.displayWorkspaceId ?? creationTarget?.displayWorkspaceId ??
      workbenchTabDisplayWorkspaceId(useAppStore.getState().layouts, target.tabId, tabGroupId)
    return displayWorkspaceId ? { workspaceId: displayWorkspaceId, tabGroupId, ...target } : undefined
  }

  function chooseArrangement(selection: LauncherExecutionSelection): boolean {
    if (busyKind || !workspace) return false
    try {
      if (sourceValue !== undefined && !sourceExecution) throw Error('The original arrangement is unreadable. Its complete input is retained; no replacement has been applied.')
      if (selection.source) {
        if (selection.resourceWorkspaceId !== workspace.id || !launcherSourceMatches(selection.source, workspace)) throw Error('The original Source selection belongs to another project. Your draft is kept.')
        return useLauncherState.getState().setSourceExecution(launcherId, selection.source)
      }
      const state = useAppStore.getState()
      if (launcherRef) {
        const displayWorkspaceId = projection?.displayWorkspaceId ?? workbenchTabDisplayWorkspaceId(state.layouts, launcherRef.tabId, tabGroupId)
        if (!displayWorkspaceId) throw new Error('The original Launcher location is still restoring. Your draft is kept.')
        const result = state.selectLauncherExecution({ ...launcherRef, displayWorkspaceId, groupId: tabGroupId }, selection, { navigateProject: false, reveal: !projection })
        if (projection) projection.onSelect(result)
      } else {
        const displayWorkspaceId = projection?.displayWorkspaceId ?? creationTarget?.displayWorkspaceId ?? workspace.id
        const result = state.selectLauncherExecution({ displayWorkspaceId, groupId: tabGroupId, resourceWorkspaceId: workspace.id },
          selection, { navigateProject: false, reveal: !projection })
        if (projection) projection.onSelect(result)
      }
      useLauncherState.getState().setSourceExecution(launcherId, undefined)
      return true
    } catch (cause) { setError(presentError(cause)); return false }
  }

  const sourceSupportIssue = sourceSelectionIssue ?? sourceLauncher.issue ?? (sourceMode ? !sourceExecution || !launcherSourceMatches(sourceExecution, workspace)
    ? 'The original project is unconfirmed. Your complete draft is kept; review Agent location.'
    : !sourceLauncher.description ? 'Reading this project device’s launch support…' : !(sourceExecution.kind === 'source-coordinator' ? sourceLauncher.description.contracts.externalAssociation : sourceLauncher.description.contracts.ordinaryLaunch)
      ? `Update AgentMux Core on ${host?.label ?? 'this project device'} before launching this arrangement. The current Core cannot retain its complete launch fields.`
      : !sourceLauncher.selected ? undefined : !sourceLauncher.selected.creationContract
        ? 'This Agent device has not confirmed support for complete launch fields. Review it through the project device; your draft is kept.' : undefined : undefined)

  const dialogDocument = useWorkbenchWindowDocument() ?? undefined
  const attachments = useComposerAttachments({ scope: toolsScope, hostId: workspace?.hostId, workspacePath: workspace?.path,
    disabled: false, insertion: insertionRef, feedback, document: dialogDocument, shortcutActive: visible && presentationActive && sections.agents === 'expanded',
    onRemoteFiles: () => setFileReferencesOpen(true) })

  const compact = regionHeight !== null && regionHeight < 520
  const unconfirmedConfigurations = <ServiceWindowNotice disclosure={{ scope: launcherId, id: 'agent-inventory',
    cause: sourceMode ? sourceLauncher.inventoryIssue ?? sourceLauncher.inventoryState : inventory?.detail ?? inventory?.state ?? 'unconfirmed', visible: motionActive }} notice={{ kind: 'indeterminate', notice: {
    step: 'Agent configurations are unconfirmed',
    mode: sourceMode ? `${sourceLauncher.inventoryIssue ?? (sourceLauncher.inventoryState === 'pending'
      ? 'Reading the original Agent device configurations.' : 'The original Agent configuration list is unconfirmed.')} Your draft and saved selection are kept.`
      : `${agentHost?.label ?? agentWorkspace?.hostId ?? 'Agent environment'}: ${inventory?.detail ?? (inventory?.state === 'checking' ? 'Reading the original Host configuration.' : 'The original Host inventory has not been confirmed.')} Your draft and saved selection are kept.`,
    restore: sourceMode ? 'Check the original Agent device again to read its configurations.'
      : agentWorkspace ? 'Check this Host again to read its configurations, or choose another Agent environment.' : 'Choose the registered Agent environment to read its configurations.'
  } }} actions={sourceMode || agentWorkspace ? <Button type="button" disabled={detecting}
    onClick={() => sourceMode ? sourceLauncher.refresh() : agentWorkspace && void checkAgents(agentWorkspace.hostId)}>{detecting ? 'Checking…' : 'Check again'}</Button> : undefined} />

  const executorPicker = <AgentExecutorPicker executors={executors} selected={selectedExecutor?.id ?? null}
    {...(compact ? { presentation: 'field' as const, label: 'Agent configuration', unsetLabel: 'Choose Agent' } : { presentation: 'catalog' as const })}
    active={visible && presentationActive} onSelect={chooseExecutor}
    onConfigure={usesHostInventory && agentWorkspace && settings ? () => settings.openHostExecutors
      ? settings.openHostExecutors(agentWorkspace.hostId) : settings.openHost(agentWorkspace.hostId) : undefined} />
  return (
    <SurfaceState ref={surfaceRef} className="launch-surface" data-agent-section={sections.agents} data-motion-active={motionActive}
      data-density={compact ? 'compact' : 'normal'} data-short={regionHeight !== null && regionHeight < 240 || undefined}
      style={{ '--launcher-hero': `url("${launcherHero}")`, ...(regionHeight === null ? {} : { '--launcher-region-height': `${regionHeight}px` }) } as CSSProperties} body={<>
      <LauncherEnvironment workspace={workspace} host={host} check={hostCheck} displayPath={displayPath}
        executionControl={workspace && sections.agents === 'expanded' ? <LauncherAgentDevice key={launcherId} hosts={config?.hosts ?? []} workspace={workspace} agentWorkspace={agentWorkspace}
          explicitAgentWorkspaceId={agentTarget?.agentWorkspaceId} sourceExecution={sourceExecution} disabled={busyKind !== null} active={motionActive}
          onSelect={chooseArrangement} onPreparingChange={setExecutionPreparing}
          onEditArrangement={settings ? () => settings.open('remote-execution') : undefined} /> : undefined} />
      {regionId ? operationHosts.map(hostId => <AgentOperationFeedback key={hostId} compact subject={{ hostId, regionId }} />) : null}


      {sourceMode && sourceSupportIssue ? <ServiceWindowNotice disclosure={{ scope: launcherId, id: 'launch-support', cause: sourceSupportIssue, visible: motionActive }}
        notice={{ kind: 'indeterminate', notice: { step: 'Launch support unconfirmed', mode: sourceSupportIssue,
          restore: 'Check this original project device again. Your complete task draft is kept.' } }}
        actions={<><Button type="button" disabled={detecting} onClick={sourceLauncher.refresh}>Check Source</Button>
          {settings && workspace ? <Button type="button" onClick={() => settings.openHost(workspace.hostId)}>Project device settings</Button> : null}</>} /> : null}
      {retainedSourceRequests.inputs.map(input => <SourceLauncherRequest key={`${mountedAgentOpenKey(input.target, input.slot)}:${input.request.operationId}`} input={input} busy={busyKind !== null} active={motionActive && !moteId}
        onContinue={original => { if (original.slot.kind === 'region') void run('agent', () => launchAtSource({ tabId: original.slot.kind === 'region' ? original.slot.tabId : '', regionId: original.slot.kind === 'region' ? original.slot.regionId : '' }, original)) }} />)}
      {retainedSourceRequests.issue ? <p role="status">{retainedSourceRequests.issue}</p> : null}
      <SourceCoordinatorRequests active={motionActive && !moteId} origin={{ launcherId }} />
      {splitExecution && !splitWorkspaceSupported ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
        step: splitProjectUnsupported ? 'Separate tools need project folders' : 'Original Agent location is unconfirmed',
        mode: 'Your original project, Agent selection and task are kept. No request has been sent.',
        restore: splitProjectUnsupported ? 'Choose project folders in Remote work to prepare separate tools.'
          : 'Open Agent location to confirm or explicitly change the Agent device. Your project stays here.'
      } }} /> : null}
      {splitExecution && agentTarget?.agentExecutor && !selectedExecutor && inventory?.state === 'ready' ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
        step: 'Choose the current Agent configuration', mode: 'The saved Agent configuration does not match this Host revision. Your original selection and draft are retained.',
        restore: 'Select an Agent from this Host before launching.'
      } }} /> : null}
      {primaryBotUnconfirmed ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
        step: 'Primary Mote Agent is unconfirmed',
        mode: 'Your request has not been sent. The same Mote, Region and complete draft are kept.',
        restore: explicitExecutorChoice && selectedExecutor ? `You chose ${selectedExecutor.label}. Launch here sends the preserved request with this Agent.`
          : 'Choose an Agent explicitly, then Launch here; or wait for the original bot facts to recover.'
      } }} /> : null}

      {topicPreparation || (confirmedEmptyExecutors && prompt && sections.agents !== 'expanded') ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
        step: topicPreparation ? 'Mote Topic preparation is unconfirmed' : 'No Agent Executor is configured',
        mode: `${confirmedEmptyExecutors ? 'No Agent Executor is configured. ' : ''}Your request has not been sent. ${topicPreparation ? 'The same Topic, Region and complete draft are kept.' : 'The same Region and complete draft are kept.'}`,
        restore: confirmedEmptyExecutors ? 'Add an Agent in Settings, then Launch agent here with the preserved request.' : 'Launch agent here to retry preparation for this same Topic, then send the preserved request.'
      } }} /> : null}
      {persistenceIssue ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: persistenceIssue?.includes('could not be read') ? 'Saved Launcher preferences could not be read' : 'Launcher preferences could not be saved', mode: `${persistenceIssue ?? ''} Current sections and drafts remain usable in this window. They may not survive a restart.`, restore: persistenceIssue?.includes('could not be read') ? 'Copy any new drafts before reopening this window to retry reading saved preferences. The existing saved data is kept.' : 'Restore local storage access, then change a section or edit the draft to retry saving.' } }} /> : null}

      {sections.agents !== 'hidden' ? <div className="launcher-agents-head">
        {sections.agents === 'collapsed' ? <button type="button" className="launcher-agent-entry" aria-label="Expand Agents" onClick={() => setSection('agents', 'expanded')}>
          <AgentAvatar executorId={displayedExecutorId} providerId={selectedProviderId} label={selectedExecutor?.label ?? 'Choose Agent'} size={17} /><span><strong>{selectedExecutor?.label ?? 'Choose Agent'}</strong><small title={promptDisplayText}>{prompt ? promptDisplayText.split('\n')[0] : 'Start a task'}</small></span><ThemeNavigationDisclosureIcon size={14} />
        </button> : <span className="launcher-agents-head__identity">{compact && executors.length ? executorPicker : <strong>Agent</strong>}</span>}
        <span className="launcher-section-actions">
          {sections.agents === 'collapsed' ? <LauncherResumePicker getTakeoverOrigin={getTakeoverOrigin} workspace={workspace} originalTarget={splitExecution || sourceMode} disabled={busyKind !== null} /> : null}
          <IconButton type="button" aria-label="Refresh agents on this device" title="Refresh agents on this device" disabled={!agentWorkspace || detecting} onClick={() => agentWorkspace && void checkAgents(agentWorkspace.hostId)}>{detecting ? <ThemeStatusLoadingIcon size={13} animation="spin" /> : <ThemeActionRefreshIcon size={13} />}</IconButton>
          {sections.agents === 'expanded' ? <IconButton type="button" aria-label="Collapse Agents" title="Collapse" onClick={() => setSection('agents', 'collapsed')}><ThemeActionCollapseIcon size={13} /></IconButton> : null}
          <IconButton type="button" aria-label="Close Agents" title="Close Agents" onClick={() => setSection('agents', 'hidden')}><ThemeActionCloseIcon size={13} /></IconButton>
        </span>
      </div> : null}

      {sections.agents === 'expanded' ? <>
        {moteId && displayedExecutorId && !executors.some(item => item.id === displayedExecutorId) ? <div className="launcher-error" role="status">Saved Agent {displayedExecutorId} is unavailable. Choose another Agent or edit this Mote’s quick mode.</div> : null}
        {emptyHostInventoryUnconfirmed ? unconfirmedConfigurations : sourceMode && confirmedEmptyExecutors
          ? <div className="agent-catalog__empty">No Agent is configured on the original Agent device. Refresh its configurations after adding an Agent there.</div>
          : compact ? null : <div className="launcher-agent-catalog" key={agentWorkspace?.hostId ?? 'none'} data-host-id={agentWorkspace?.hostId}>{executorPicker}</div>}

        <div className="launcher-composer composer" onFocusCapture={attachments.claimScreenshotTarget}><ComposerCompletionEditor completionConfig={completion.completionConfig} commands={completion.commands} skills={completion.skills}
          references={completion.references} promptKeywords={completion.promptKeywords} onCompletionQuery={completion.onCompletionQuery}
          completionFeedback={completion.completionFeedback} active={visible && presentationActive} aria-label={sourceMode ? 'Original Space task draft' : 'Agent prompt'} disabled={false} readPastedImage={api.ui.readPastedImage} insertionRef={insertionRef}
          onPasteImage={attachments.pasteImage} onDropFiles={attachments.dropFiles}
          autoFocus={visible && presentationActive && inputRegionActive && !controlNavigation} value={prompt} onValueChange={setPrompt}
          onKeyDown={event => { if (!launcherKeydownLaunches(event, isMacPlatform(), readiness)) return; event.preventDefault(); launchFromLauncher() }}
          placeholder="What would you like to work on?" /></div>
        <div className="composer__toolbar launcher-tools" onFocusCapture={attachments.claimScreenshotTarget}><div>
          <AgentComposerTools key={completion.scope} layoutControl={false} disabled={busyKind !== null || !workspace}
            commands={completion.commands} loadSkills={completion.loadSkills}
            onChooseSkill={skill => { void feedback.run(() => completion.insertCandidate(skillComposerSuggestion(skill))) }}
            onCommand={(_command, candidate) => { void feedback.run(() => completion.insertCandidate(candidate)) }}
            referenceTools={<ComposerReferenceTool disabled={busyKind !== null || !workspace} onSelect={() => { void attachments.chooseFiles() }} label="Reference files for the Agent" />}
            {...(host?.kind === 'local' ? { onCapture: attachments.capture } : {})} runAction={feedback.run} />
        </div><LaunchRefine options={launchOptions} selection={launchOptionSelection} expanded={optionsExpanded} active={motionActive}
          onToggle={() => setOptionsExpanded(value => !value)} disabled={busyKind !== null} names={names} onNameChange={setName}
          onReset={() => { if (selectedProviderId) for (const optionId of Object.keys(launchOptionSelection)) selectOption(selectedProviderId, optionId, null) }}
          onSelect={(optionId, choiceId) => { if (selectedProviderId) selectOption(selectedProviderId, optionId, choiceId) }} /></div>
        <ComposerFeedback failure={feedback.failure} onDismiss={feedback.dismiss} />
      </> : null}
      {sections.agents === 'expanded' ? <div className="launch-surface__footer">
        <LauncherMoteAction workspace={workspace} prompt={prompt} sourceTabId={tabId} sourceRegionId={regionId} disabled={busyKind !== null || !workspace || Boolean(sourceUnavailable)} />
        <div className="launcher-primary-actions"><LauncherResumePicker getTakeoverOrigin={getTakeoverOrigin} workspace={workspace} originalTarget={splitExecution || sourceMode} disabled={busyKind !== null} />
          <button className="primary-button launcher-launch-button" title={`Launch · ${isMacPlatform() ? '⌘' : 'Ctrl+'}Enter`} disabled={!launcherCanLaunch(readiness)} onClick={launchFromLauncher}>{busyKind === 'agent' ? <ThemeStatusLoadingIcon size={15} animation="spin" /> : <ThemeActionStartIcon size={15} />}{busyKind === 'agent' ? 'Launching…' : executionPreparing ? 'Review arrangement…' : 'Launch'}</button>
        </div>
      </div> : null}
      {sourceMode && !sourceSupportIssue && sections.agents === 'expanded' ? <details className="agent-work-startup launcher-compatibility"><summary>Launch compatibility</summary><p>The project device and selected Agent accept complete launch fields. Native tool qualification is unconfirmed here and checked during Launch preparation.</p></details> : null}
      {sourceMode ? null : emptyHostInventoryUnconfirmed && sections.agents !== 'hidden' ? sections.agents === 'expanded' ? null : unconfirmedConfigurations : (splitExecution || agentHost?.kind === 'ssh') && inventory && inventory.state !== 'ready' && sections.agents !== 'hidden' ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
        step: inventory.state === 'checking' ? 'Checking agents on this host' : 'Host Executor discovery failed', mode: `${agentHost?.label ?? agentWorkspace?.hostId}: ${inventory.detail ?? 'Current inventory is unknown.'} Previously read configurations remain selectable.`,
        restore: inventory.state === 'checking' ? 'Checking this host. Existing configurations remain selectable.'
          : retryingAvailability ? 'Rechecking automatically. You can keep writing or check again now.'
            : 'Check again to refresh this host. Existing configurations and your draft are kept.'
      } }} actions={<Button type="button" disabled={inventory.state === 'checking'}
        onClick={() => { if (agentWorkspace) void checkAgents(agentWorkspace.hostId) }}>{inventory.state === 'checking' ? 'Checking…' : 'Check again'}</Button>} /> : sections.agents !== 'hidden' ? <LauncherAvailabilityNotice executor={selectedExecutor}
        checking={selectedExecutor?.detection?.state === 'checking'} retrying={retryingAvailability} onCheck={() => { if (agentWorkspace) void checkAgents(agentWorkspace.hostId) }} /> : null}
      {fileReferencesOpen && workspace && motionActive ? <ComposerFileReferences key={toolsScope} workspace={workspace} hostLabel={host?.label}
        onSelect={path => { void attachments.referencePaths([path]) }} onClose={() => setFileReferencesOpen(false)} /> : null}
      {regionId ? <AgentLifecycleFeedback owner={{ regionId }} visible={visible} busy={busyKind !== null} retry={launchFromLauncher} /> : null}
      {error ? <div className="surface-inline-error" role="alert">{error}</div> : null}
      <LauncherSecondarySurfaces workspace={workspace} tabGroupId={tabGroupId} launcherRef={launcherRef} launcherId={launcherId}
        materializeLauncher={creationTarget ? materializeLauncher : undefined}
        sections={sections} onSectionChange={setSection} warmPreview={warmPreview}
        terminalThemeId={terminalThemeId} terminalFontSize={terminalFontSize} visible={visible} busy={busyKind}
        sourceUnavailable={sourceUnavailable}
        onRun={run} />
      {sections.agents === 'hidden' ? <div className="launcher-restores"><button type="button" className="launcher-restore" aria-label="Restore Agents" onClick={() => setSection('agents', 'expanded')}><AgentAvatar executorId={executorId} label={selectedExecutor?.label ?? executorId} providerId={selectedProviderId} size={15} />Agents · {selectedExecutor?.label ?? executorId}<ThemeNavigationDownIcon size={12} /></button></div> : null}
    </>} />
  )
}
