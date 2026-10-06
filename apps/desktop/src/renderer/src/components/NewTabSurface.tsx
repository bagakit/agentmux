import { moteDefaultExecutor } from '../lib/mote-quick-preferences'
import { scratchTopicsForWorkspace, scratchTopicKind } from '../lib/scratch-topic-snapshots'
import { MoteWorkfaceContext } from '../lib/mote-workface'
import { AgentAvatar } from './AgentAvatar'
import type { ComposerInsertionHandle } from '@agentmux/client-ui/composer-insertion'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { TERMINAL_FONT_SIZE_DEFAULT } from '../../../shared/contracts'
import { useAppStore, warmTerminalKey } from '../store'
import { useWorkbenchBrowserPresentation, useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { mainRegionReference } from '../lib/desktop-focus-navigation'
import { currentHostCheck } from '../lib/host-check'
import { formatPathForDisplay } from '../lib/copy-path-display'
import { hostExecutorInventoryMatches, executorsForHost } from '../lib/executors'
import { executorDetectionLabel } from '../lib/executor-detection'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useLauncherInputs } from '../lib/launcher-inputs'
import { EMPTY_LAUNCH_OPTION_SELECTION } from '../lib/launcher-option-draft'
import { appendFileReferences } from '@agentmux/client-ui/composer-file-reference'
import { expandSemanticReferences } from '@agentmux/client-ui/composer-semantic-reference'
import { launcherCanLaunch, launcherKeydownLaunches } from '../lib/launcher-submit'
import { resolveLauncherWorkspaceId } from '../lib/launcher-workspace'
import { warmLauncherId, warmTerminalPreview } from '../lib/warm-terminal-preview'
import { InlineComposer } from '@agentmux/client-ui/components/InlineComposer'
import { LaunchRefine } from './LaunchOptionControls'
import { isMacPlatform } from '../lib/host-platform'
import { api } from '../lib/api'
import { AgentComposerTools } from './AgentComposerTools'
import { ComposerReferenceTool } from '@agentmux/client-ui/components/ComposerReferenceTool'
import { ComposerFeedback, useComposerFeedback } from './ComposerFeedback'
import { AgentLifecycleFeedback } from './AgentLifecycleFeedback'
import { lifecycleFailureBelongsTo } from '../lib/agent-lifecycle-feedback'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { LauncherSecondarySurfaces } from './LauncherSecondarySurfaces'
import { LauncherMoteAction } from './LauncherMoteAction'
import { LauncherResumePicker } from './LauncherResumePicker'
import { LauncherEnvironment } from './LauncherEnvironment'
import { LauncherFileReferences } from './LauncherFileReferences'
import { AgentExecutorPicker } from './AgentExecutorPicker'
import { DEFAULT_LAUNCHER_SECTIONS, useLauncherState, type LauncherSection, type LauncherSectionMode } from '../lib/launcher-state'
import { PMO_TEAMS_TOPIC_ID } from '../../../shared/scratch-topics'
import { primaryMoteExecutorId, primaryMoteHasBot } from '../lib/primary-mote-executor'
import { SettingsNavigation } from './SettingsNavigation'
import { useContext } from 'react'

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
  visible = true
}: {
  tabGroupId: string
  tabId?: string
  regionId?: string
  /** Hidden Workbench slots stay mounted, but only the visible launcher may own the warm PTY. */
  visible?: boolean
}) {
  const presentationActive = useWorkbenchPresentationActive()
  const presentation = useWorkbenchBrowserPresentation()
  const settings = useContext(SettingsNavigation)
  const surfaceRef = useRef<HTMLElement>(null)
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
    return surface?.kind === 'launcher' ? surface.executorId ?? moteExecutor ?? 'codex' : moteExecutor ?? 'codex'
  })
  const [manualChoice, setManualChoice] = useState<{ regionId: string | undefined; executorId: string; moteId?: string | undefined } | null>(null)
  const insertionRef = useRef<ComposerInsertionHandle>(null)
  // Every Launcher has an input owner, including a Workspace's first empty Tab Group.
  const launcherId = warmLauncherId({ tabGroupId, regionId })
  const { prompt, setPrompt, names, setName, optionsByProvider, selectOption } = useLauncherInputs(regionId, launcherId)
  const [optionsExpanded, setOptionsExpanded] = useState(false)
  const [fileReferencesOpen, setFileReferencesOpen] = useState(false)
  useEffect(() => { if (!motionActive) setOptionsExpanded(false) }, [motionActive])
  const [busy, setBusy] = useState<'agent' | 'terminal' | 'browser' | 'note' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const config = useAppStore((state) => state.config)
  const providerCatalog = useAppStore((state) => state.providerCatalog)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const tabWorkspaceId = useAppStore((state) => tabId ? state.tabs[tabId]?.workspaceId : undefined)
  const launcherWorkspaceId = useAppStore(state => {
    const surface = tabId && regionId ? state.tabs[tabId]?.regions[regionId] : undefined
    return surface?.kind === 'launcher' ? surface.workspaceId : undefined
  })
  const topicPreparation = useAppStore(state => tabId ? state.tabs[tabId]?.topicPreparation : undefined)
  const primaryBotUnconfirmed = useAppStore(state => Boolean(tabId && prompt && state.tabs[tabId]?.topicId === PMO_TEAMS_TOPIC_ID &&
    primaryMoteHasBot(state) && !primaryMoteExecutorId(state)))
  const explicitExecutorChoice = Boolean(moteExecutor || manualChoice?.regionId === regionId && manualChoice?.moteId === moteId && manualChoice?.executorId === executorId)
  const displayedExecutorId = primaryBotUnconfirmed && !explicitExecutorChoice ? '' : executorId
  const detections = useAppStore((state) => state.executorDetections)
  const detectExecutors = useAppStore((state) => state.detectExecutors)
  const launchAgent = useAppStore((state) => state.launchAgent)
  const prewarmTerminal = useAppStore((state) => state.prewarmTerminal)
  const controlNavigation = useAppStore(state => state.workbenchNavigationInputPolicy !== null ||
    state.workbenchSpaceSelection !== null && state.workbenchSpaceSelection.tabId === null)
  // A visible Tab can contain an unselected Launcher created by Control. Only its
  // selected Region may acquire input; the original empty-group Launcher has no Region.
  const inputRegionActive = useAppStore(state => {
    if (!tabId || !regionId) return tabId === undefined && regionId === undefined
    if (state.tabs[tabId]?.regions[regionId]?.kind !== 'launcher') return false
    const reference = (presentation.surface === 'mote' || presentation.surface === 'recall') ? presentation.reference : mainRegionReference(state.workbenchSpaceSelection)
    return reference ? reference.tabId === tabId && reference.regionId === regionId
      : !presentation.surface && state.tabs[tabId]?.layout.activeRegionId === regionId
  })
  const warmTerminal = useAppStore((state) => state.warmTerminal)
  const terminalThemeId = useAppStore((state) => state.config?.appearance.terminalTheme)
  const terminalFontSize = useAppStore(
    (state) => state.config?.appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT
  )
  // 卡片上写「Start in ⟨谁⟩」的那个 Workspace，与五个启动动作真正落进去的那个，必须是**同一次**
  // 判定（resolveLauncherWorkspaceId）。分开算的症状不是报错：标题写着 A、点下去建到 B。
  const workspace = config?.workspaces.find((item) => item.id === resolveLauncherWorkspaceId({
    launcherWorkspaceId,
    launcherTabWorkspaceId: tabWorkspaceId,
    activeWorkspaceId
  }))
  const host = workspace ? config?.hosts.find((candidate) => candidate.id === workspace.hostId) : undefined
  const inventory = useAppStore(state => workspace ? state.hostExecutorInventories[workspace.hostId] : undefined)
  const localHome = useAppStore(state => state.localHome)
  const displayPath = workspace ? formatPathForDisplay(workspace.path, {
    home: host?.kind === 'local' ? localHome : '', copyPathsAsAbsolute: config?.copyPathsAsAbsolute
  }) : ''
  const storedHostCheck = useAppStore((state) => workspace ? state.hostChecks[workspace.hostId] : undefined)
  const hostCheck = host ? currentHostCheck(storedHostCheck, host) : undefined
  // Only show a warm shell created for this exact host and working directory.
  // It remains outside the ordinary Session list until the user claims it.
  const warmKey = workspace ? warmTerminalKey(workspace.hostId, workspace.path) : null
  const automaticWarmAttempt = useRef<string | null>(null)
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
    () => executorsForHost(config, workspace?.hostId, detections, inventory),
    [config?.executors, config?.hosts, detections, workspace, inventory]
  )
  // An unconfirmed discovery check is not evidence that the configured Agent cannot work.
  const installedExecutors = executors.filter(executor => executor.detection?.state !== 'missing').sort((a, b) => Number(b.detection?.state === 'ready') - Number(a.detection?.state === 'ready'))
  const detecting = inventory?.state === 'checking' || executors.some((executor) => executor.detection?.state === 'checking')
  const savedSections = useLauncherState(state => workspace ? state.sections[workspace.id] : undefined)
  const sections = { ...DEFAULT_LAUNCHER_SECTIONS,
    terminal: presentation.surface === 'mote' || presentation.surface === 'recall' || presentation.surface === 'survey' || presentation.survey ? 'collapsed' as const : 'expanded' as const,
    ...savedSections }
  const persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const saveSection = useLauncherState(state => state.setSection)
  const saveExecutor = useLauncherState(state => state.selectExecutor)
  const savedExecutor = useLauncherState(state => workspace ? state.executors[workspace.id] : undefined)
  const selectedExecutor = executors.find(executor => executor.id === displayedExecutorId)
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
  const launchOptions = useMemo(
    () => providerCatalog.find((entry) => entry.id === selectedProviderId)?.launchOptions ?? [],
    [providerCatalog, selectedProviderId]
  )
  // Each Provider keeps its own explicit choices. Changing the target closes the disclosure,
  // while returning to the original Provider restores its unsent selection.
  useEffect(() => {
    setOptionsExpanded(false)
  }, [selectedProviderId])

  useEffect(() => {
    // The create page owns the prewarm trigger.
    //
    // 依赖里带上 `warmSlotHeld`（而不是只有 workspace 与 visible）：promote 会把槽清空，若只依赖后
    // 两者，仍然在场的同胞 launcher 此后永远看不到热 shell——它的 Terminal 卡片静默退化成冷路径，
    // 本次会话再不恢复。槽空了就重新预热一个。
    //
    // 依赖必须是**与归属无关**的「槽在不在」，不能是带归属的 session/pending：归属会在同胞之间转移，
    // 若依赖跟着归属翻动，失去归属的那个立刻重新预热去夺回来，对方随即再夺回——两个同时在场的
    // launcher 之间无限 ping-pong。prewarmTerminal 对同 key 是幂等的（只转移归属，不重开 PTY），
    // 所以这条 effect 多跑几次不会攒出多余进程。
    // A failed speculative warm clears its slot. That is not a new request to
    // launch again; retain the ordinary cold launch and the current input.
    if (warmSlotHeld && warmTerminal?.session) automaticWarmAttempt.current = null
    // A target choice must not stop another project's healthy reusable shell.
    // The ordinary explicit Terminal action remains available for this exact target.
    if (workspace && (!warmTerminal || warmSlotHeld) && visible && presentationActive && inputRegionActive && !controlNavigation && sections.terminal === 'expanded' &&
      (warmSlotHeld || automaticWarmAttempt.current !== warmKey)) {
      if (!warmSlotHeld) automaticWarmAttempt.current = warmKey
      prewarmTerminal(workspace.id, launcherId)
    }
  }, [prewarmTerminal, visible, presentationActive, inputRegionActive, controlNavigation, workspace?.id, launcherId, warmSlotHeld, warmTerminal?.session?.id, Boolean(warmTerminal), warmKey, sections.terminal])

  useEffect(() => {
    if (sections.agents === 'hidden') return
    if (!workspace || (host?.kind === 'ssh' ? hostExecutorInventoryMatches(inventory, host) : executors.every((executor) => executor.detection))) return
    if (!visible || !presentationActive || !inputRegionActive || controlNavigation) return
    void detectExecutors(workspace.hostId)
  }, [executors, inventory, host, detectExecutors, visible, presentationActive, inputRegionActive, controlNavigation, workspace, sections.agents])

  useEffect(() => {
    if (moteId && (explicitSavedExecutor || moteExecutor || manualChoice?.moteId === moteId)) return
    if (installedExecutors.some((executor) => executor.id === executorId)) return
    const first = installedExecutors[0]
    if (first) setExecutorId(first.id)
  }, [executorId, installedExecutors, moteId, explicitSavedExecutor, moteExecutor, manualChoice])

  async function run<T>(kind: 'agent' | 'terminal' | 'browser' | 'note', action: () => Promise<T>): Promise<void> {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      await action()
    } catch (cause) {
      if (kind === 'agent' && regionId && tabId) {
        const state = useAppStore.getState()
        if (state.tabs[tabId]?.regions[regionId]?.kind !== 'launcher') return
        if (state.error !== presentError(cause) || !lifecycleFailureBelongsTo(state.errorNoticeContext?.lifecycle, { regionId })) {
          state.reportError(cause, { kind: 'indeterminate', lifecycle: { step: 'launch', regionId, tabId } })
        }
      } else setError(presentError(cause))
    } finally {
      setBusy(null)
    }
  }

  // 「现在能不能启动」判一次，主按钮的 disabled 与 Cmd/Ctrl+Enter 那条路共用它。手抄两份时两条路会对
  // 同一概念判得不一样，症状是按钮灰着而键盘照旧发车（或反过来）。
  const readiness = {
    hasWorkspace: Boolean(workspace),
    busy: busy !== null,
    installedExecutorCount: primaryBotUnconfirmed && !explicitExecutorChoice ? 0 : installedExecutors.length
  }
  // 启动这一件事也只写一次：按钮的 onClick 与键盘那条路调的是同一个函数。抄两遍时任何一处漏掉
  // launchOptionSelection 或那两个名字，就变成「用鼠标点带着精调启动、用键盘发就丢掉精调」。
  function launchFromLauncher(): void {
    if (!launcherCanLaunch(readiness)) return
    void run('agent', () => {
      let target = launcherRef
      if (!target && workspace) {
        const createdId = useAppStore.getState().openLauncher({ workspaceId: workspace.id, tabGroupId, reveal: false,
          initialInputs: { prompt, names, optionsByProvider } })
        const created = createdId ? useAppStore.getState().tabs[createdId] : undefined
        if (!created) return Promise.resolve()
        target = { tabId: created.id, regionId: created.layout.activeRegionId }
      }
      return launchAgent(
        executorId,
        expandSemanticReferences(prompt),
        tabGroupId,
        target,
        launchOptionSelection,
        // trim 后为空即不传：空白不该变成一个 "launch" 档的名字，也绝不阻塞启动。
        { agentName: names.agentName.trim() || undefined, tabName: names.tabName.trim() || undefined }
      )
    })
  }

  function chooseExecutionWorkspace(workspaceId: string): void {
    if (busy) return
    try {
      const state = useAppStore.getState()
      let target = launcherRef
      if (!target) {
        if (!workspace) throw new Error('The original display Group is unavailable; restore its project before creating a new Launcher')
        const createdId = state.openLauncher({ workspaceId: workspace.id, tabGroupId, reveal: false,
          initialInputs: { prompt, names, optionsByProvider } })
        const created = createdId ? useAppStore.getState().tabs[createdId] : undefined
        if (!created) return
        target = { tabId: created.id, regionId: created.layout.activeRegionId }
      }
      state.setLauncherExecutionWorkspace(target, workspaceId, executorId)
    } catch (cause) { setError(presentError(cause)) }
  }

  function appendReference(path: string): void {
    void feedback.run(() => insertionRef.current?.insert(() => appendFileReferences('', [path]), { separate: true }))
  }

  async function captureComposerScreenshot(): Promise<void> {
    await insertionRef.current?.insert(async () => {
      const path = await api.ui.captureScreenshot()
      if (!feedback.isCurrent()) return null
      return path ? appendFileReferences('', [path]) : null
    }, { separate: true })
  }

  async function chooseComposerFiles(): Promise<void> {
    if (host?.kind !== 'local') { setFileReferencesOpen(true); return }
    await insertionRef.current?.insert(async () => {
      const paths = await api.ui.chooseFiles(workspace?.path ? { defaultPath: workspace.path } : undefined)
      if (!feedback.isCurrent()) return null
      return paths?.length ? appendFileReferences('', paths, workspace?.path) : null
    }, { separate: true })
  }

  return (
    <section ref={surfaceRef} className="launch-surface" data-agent-section={sections.agents} data-motion-active={motionActive}
      data-density={regionHeight !== null && regionHeight < 520 ? 'compact' : 'normal'}
      style={regionHeight === null ? undefined : { '--launcher-region-height': `${regionHeight}px` } as CSSProperties}>
      <LauncherEnvironment workspace={workspace} host={host} check={hostCheck} displayPath={displayPath} active={motionActive}
        hosts={config?.hosts ?? []} workspaces={config?.workspaces ?? []} onSelectWorkspace={chooseExecutionWorkspace}
        selectionDisabled={busy !== null} onManageProjects={() => settings?.open('hosts')} />

      {primaryBotUnconfirmed ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
        step: 'Primary Mote Agent is unconfirmed',
        mode: 'Your request has not been sent. The same Mote, Region and complete draft are kept.',
        restore: explicitExecutorChoice && selectedExecutor ? `You chose ${selectedExecutor.label}. Launch here sends the preserved request with this Agent.`
          : 'Choose an Agent explicitly, then Launch here; or wait for the original bot facts to recover.'
      } }} /> : null}

      {topicPreparation || (executors.length === 0 && prompt) ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
        step: topicPreparation ? 'Mote Topic preparation is unconfirmed' : 'No Agent Executor is configured',
        mode: `${executors.length === 0 ? 'No Agent Executor is configured. ' : ''}Your request has not been sent. ${topicPreparation ? 'The same Topic, Region and complete draft are kept.' : 'The same Region and complete draft are kept.'}`,
        restore: executors.length === 0 ? 'Add an Agent in Settings, then Launch agent here with the preserved request.' : 'Launch agent here to retry preparation for this same Topic, then send the preserved request.'
      } }} /> : null}
      {persistenceIssue ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: persistenceIssue?.includes('could not be read') ? 'Saved Launcher preferences could not be read' : 'Launcher preferences could not be saved', mode: `${persistenceIssue ?? ''} Current sections and drafts remain usable in this window. They may not survive a restart.`, restore: persistenceIssue?.includes('could not be read') ? 'Copy any new drafts before reopening this window to retry reading saved preferences. The existing saved data is kept.' : 'Restore local storage access, then change a section or edit the draft to retry saving.' } }} /> : null}

      {sections.agents !== 'hidden' ? <div className="launcher-agents-head">
        {sections.agents === 'collapsed' ? <button type="button" className="launcher-agent-entry" aria-label="Expand Agents" onClick={() => setSection('agents', 'expanded')}>
          <AgentAvatar executorId={displayedExecutorId} providerId={selectedProviderId} label={selectedExecutor?.label ?? 'Choose Agent'} size={17} /><span><strong>{selectedExecutor?.label ?? 'Choose Agent'}</strong><small title={prompt}>{prompt ? prompt.split('\n')[0] : 'Start a task'}</small></span><ThemeNavigationDisclosureIcon size={14} />
        </button> : <span className="launcher-agents-head__identity"><strong>Agent</strong></span>}
        <span className="launcher-section-actions">
          {sections.agents === 'collapsed' ? <LauncherResumePicker workspace={workspace} disabled={busy !== null} /> : null}
          <button type="button" className="icon-button" aria-label="Refresh agents on this host" title="Refresh agents on this host" disabled={!workspace || detecting} onClick={() => workspace && void detectExecutors(workspace.hostId)}>{detecting ? <ThemeStatusLoadingIcon size={13} className="spin" /> : <ThemeActionRefreshIcon size={13} />}</button>
          {sections.agents === 'expanded' ? <button type="button" className="icon-button" aria-label="Collapse Agents" title="Collapse" onClick={() => setSection('agents', 'collapsed')}><ThemeActionCollapseIcon size={13} /></button> : null}
          <button type="button" className="icon-button" aria-label="Close Agents" title="Close Agents" onClick={() => setSection('agents', 'hidden')}><ThemeActionCloseIcon size={13} /></button>
        </span>
      </div> : null}

      {sections.agents === 'expanded' ? <>
        {moteId && displayedExecutorId && !executors.some(item => item.id === displayedExecutorId) ? <div className="launcher-error" role="status">Saved Agent {displayedExecutorId} is unavailable. Choose another Agent or edit this Mote’s quick mode.</div> : null}
        <AgentExecutorPicker executors={executors} selected={displayedExecutorId || null}
          active={visible && presentationActive} onSelect={chooseExecutor} />
        <div className="launcher-composer composer"><InlineComposer aria-label="Agent prompt" disabled={false} readPastedImage={path => api.ui.readPastedImage(path)} insertionRef={insertionRef}
          onPasteImage={(file, insert) => { void feedback.run(async () => {
            if (host?.kind !== 'local') throw new Error('This image has not been sent to the selected machine. Your draft is kept; use Files to reference an image in that project, or paste it after choosing the local machine.')
            await insert(async () => { const path = await api.ui.savePastedImage({ bytes: new Uint8Array(await file.arrayBuffer()), extension: file.type.slice(6).split('+')[0] ?? 'png' }); return feedback.isCurrent() ? appendFileReferences('', [path]) : null }, { separate: true }) }) }}
          autoFocus={visible && presentationActive && inputRegionActive && !controlNavigation} value={prompt} onValueChange={setPrompt}
          onKeyDown={event => { if (!launcherKeydownLaunches(event, isMacPlatform(), readiness)) return; event.preventDefault(); launchFromLauncher() }}
          placeholder="What would you like to work on?" /></div>
        <div className="composer__toolbar launcher-tools"><div>
          <AgentComposerTools key={toolsScope} layoutControl={false} disabled={busy !== null || !workspace}
            commands={providerCatalog.find(entry => entry.id === selectedProviderId)?.composer?.commands ?? []}
            loadSkills={() => workspace && selectedProviderId ? api.ui.listWorkspaceSkills(workspace.id, selectedProviderId) : Promise.resolve([])}
            onChooseSkill={skill => appendReference(skill.path)} onCommand={command => setPrompt(`${command}${prompt ? ` ${prompt}` : ' '}`)}
            {...(host?.kind === 'local' ? { onCapture: captureComposerScreenshot } : {})} runAction={feedback.run} />
          <ComposerReferenceTool disabled={busy !== null || !workspace} onSelect={() => { void feedback.run(chooseComposerFiles) }} label="Reference files for the Agent" />
        </div><LaunchRefine options={launchOptions} selection={launchOptionSelection} expanded={optionsExpanded} active={motionActive}
          onToggle={() => setOptionsExpanded(value => !value)} disabled={busy !== null} names={names} onNameChange={setName}
          onReset={() => { if (selectedProviderId) for (const optionId of Object.keys(launchOptionSelection)) selectOption(selectedProviderId, optionId, null) }}
          onSelect={(optionId, choiceId) => { if (selectedProviderId) selectOption(selectedProviderId, optionId, choiceId) }} /></div>
        <ComposerFeedback failure={feedback.failure} onDismiss={feedback.dismiss} />
      </> : null}
      {sections.agents === 'expanded' ? <div className="launch-surface__footer">
        <div className="launcher-primary-actions"><LauncherResumePicker workspace={workspace} disabled={busy !== null} />
          <button className="primary-button launcher-launch-button" title={`Launch · ${isMacPlatform() ? '⌘' : 'Ctrl+'}Enter`} disabled={!launcherCanLaunch(readiness)} onClick={launchFromLauncher}>{busy === 'agent' ? <ThemeStatusLoadingIcon size={13} className="spin" /> : <ThemeActionStartIcon size={13} />}{busy === 'agent' ? 'Launching…' : 'Launch'}</button>
        </div>
        <LauncherMoteAction workspace={workspace} prompt={prompt} sourceTabId={tabId} sourceRegionId={regionId} disabled={busy !== null || !workspace} />
      </div> : null}
      {inventory?.state === 'error' && sections.agents !== 'hidden' ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
        step: 'Host Executor discovery failed', mode: `${host?.label ?? workspace?.hostId}: ${inventory.detail ?? 'Current inventory is unknown.'} Previously read configurations remain selectable.`,
        restore: 'Refresh agents on this host. Configure custom commands in Settings → Agents on this Host.'
      } }} /> : selectedExecutor && selectedExecutor.detection?.state !== 'ready' && selectedExecutor.detection?.state !== 'missing' && sections.agents !== 'hidden' ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: 'Agent availability check is unconfirmed', mode: `${selectedExecutor.label} is configured; ${executorDetectionLabel(selectedExecutor.detection).toLowerCase()}. Launch remains available and reports its actual result.`, restore: 'Recheck agents on this host to confirm discovery.' } }} /> : null}
      {fileReferencesOpen && workspace && motionActive ? <LauncherFileReferences key={toolsScope} workspace={workspace} hostLabel={host?.label}
        onSelect={appendReference} onClose={() => setFileReferencesOpen(false)} /> : null}
      {regionId ? <AgentLifecycleFeedback owner={{ regionId }} visible={visible} busy={busy !== null} retry={launchFromLauncher} /> : null}
      {error ? <div className="surface-inline-error" role="alert">{error}</div> : null}
      <LauncherSecondarySurfaces workspace={workspace} tabGroupId={tabGroupId} launcherRef={launcherRef} launcherId={launcherId}
        sections={sections} onSectionChange={setSection} warmPreview={warmPreview}
        terminalThemeId={terminalThemeId} terminalFontSize={terminalFontSize} visible={visible} busy={busy}
        onRun={run} />
      {sections.agents === 'hidden' ? <div className="launcher-restores"><button type="button" className="launcher-restore" aria-label="Restore Agents" onClick={() => setSection('agents', 'expanded')}><AgentAvatar executorId={executorId} label={selectedExecutor?.label ?? executorId} providerId={selectedProviderId} size={15} />Agents · {selectedExecutor?.label ?? executorId}<ThemeNavigationDownIcon size={12} /></button></div> : null}
    </section>
  )
}
