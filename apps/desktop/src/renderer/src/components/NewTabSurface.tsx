import { AgentAvatar } from './AgentAvatar'
import type { ComposerInsertionHandle } from '../lib/composer-insertion'
import { Check, ChevronRight, ChevronDown, Folder, LoaderCircle, Minus, Play, RadioTower, RefreshCw, SquareTerminal, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LaunchOptionSelection } from '@agentmux/core'
import { TERMINAL_FONT_SIZE_DEFAULT } from '../../../shared/contracts'
import { executorDetectionKey, useAppStore, warmTerminalKey } from '../store'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { currentHostCheck, hostCheckLabel } from '../lib/host-check'
import { configuredExecutors } from '../lib/executors'
import { currentExecutorDetection, executorDetectionLabel } from '../lib/executor-detection'
import { presentError } from '../lib/error-presentation'
import { EMPTY_LAUNCHER_NAMES, launcherNameBinding } from '../lib/launcher-name-draft'
import { launcherPromptBinding } from '../lib/launcher-prompt-draft'
import { appendFileReferences } from '../lib/composer-file-reference'
import { expandSemanticReferences } from '../lib/composer-semantic-reference'
import { launcherCanLaunch, launcherKeydownLaunches } from '../lib/launcher-submit'
import { resolveLauncherWorkspaceId } from '../lib/launcher-workspace'
import { warmLauncherId, warmTerminalPreview } from '../lib/warm-terminal-preview'
import { agentProviderLabel } from './AgentProviderIcon'
import { InlineComposer } from './InlineComposer'
import { LaunchRefine } from './LaunchOptionControls'
import { isMacPlatform } from '../lib/host-platform'
import { api } from '../lib/api'
import { AgentComposerTools } from './AgentComposerTools'
import { ComposerReferenceTool } from './ComposerReferenceTool'
import { ComposerFeedback, useComposerFeedback } from './ComposerFeedback'
import { AgentLifecycleFeedback } from './AgentLifecycleFeedback'
import { lifecycleFailureBelongsTo } from '../lib/agent-lifecycle-feedback'
import { ServiceWindowNotice } from './ServiceWindowNotice'
import { LauncherSecondarySurfaces } from './LauncherSecondarySurfaces'
import { LauncherMoteAction } from './LauncherMoteAction'
import { LauncherResumePicker } from './LauncherResumePicker'
import { DEFAULT_LAUNCHER_SECTIONS, useLauncherState, type LauncherSection, type LauncherSectionMode } from '../lib/launcher-state'

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
  const [executorId, setExecutorId] = useState('codex')
  const insertionRef = useRef<ComposerInsertionHandle>(null)
  // 草稿存进 store，按 regionId 归属。启动的一瞬间本组件就被换成 pending agent surface 而卸载，
  // 若草稿只活在组件里，启动失败翻回 launcher（reduceSessionLaunchFailed 沿用同一 regionId）就会
  // 重挂一个空的新实例——正是用户报告的"报错退回初始页、之前输入没缓存"。store 是唯一数据源，
  // 复用 Agent Composer 同一套 agentComposerDrafts，不另起第二套草稿机制。
  const promptDrafts = useAppStore((state) => state.agentComposerDrafts)
  const setAgentComposerDraft = useAppStore((state) => state.setAgentComposerDraft)
  // 空分组占位（无 regionId）没有可跨卸载存活的稳定键，且它启动后由 store 新建带 region 的 Tab、
  // 失败时重挂的是另一个组件，天然无法保草稿；退回本地 state 保持原行为，不引入伪键污染共享表。
  const [localPrompt, setLocalPrompt] = useState('')
  // 读与写的 key 由 launcherPromptBinding 判一次，与名字那两格同一范式。分开算两次会漂移，而
  // 漂移的症状是 textarea 静默不响应——实测只改写侧那处 key，18 条全绿地存活（读侧则有 1 条红）。
  const { prompt, set: writePrompt } = launcherPromptBinding({
    regionId,
    drafts: promptDrafts,
    writeShared: setAgentComposerDraft,
    local: localPrompt,
    writeLocal: setLocalPrompt
  })
  function setPrompt(value: string) {
    writePrompt(value)
  }
  const [launchOptionSelection, setLaunchOptionSelection] = useState<LaunchOptionSelection>({})
  // 启动时给名字是可选的。两个都留空是最常见的情况，此时一个字都不写，显示名交还派生链
  // （lib/display-name.ts）。名字只在启动成功后由 store 落地——它自己才握有 sessionId 与 tabId。
  //
  // 与 prompt 同一机制、同一理由存进 store：启动的一瞬间本组件就被换成 pending agent surface 而卸载，
  // 若名字只活在组件里，启动失败翻回 launcher 就会重挂一个空的新实例，用户填的名字丢掉——prompt
  // 当初正是为这个搬进 store 的，名字这两格当时没跟上。
  const storedNames = useAppStore((state) => state.launcherNameDrafts)
  const setLauncherNameDraft = useAppStore((state) => state.setLauncherNameDraft)
  // 空分组占位（无 regionId）没有可跨卸载存活的稳定键，与 prompt 那格同一处理：退回本地 state。
  const [localNames, setLocalNames] = useState(EMPTY_LAUNCHER_NAMES)
  // 读与写的 key 由 launcherNameBinding 判一次。分开算两次就会漂移，而漂移的症状是输入框静默不
  // 响应（写 A 键读 B 键，用户敲什么都看不见，且不报错）——实测把写回那处 key 换掉，14 条全绿。
  const { names, set: setName } = launcherNameBinding({
    regionId,
    drafts: storedNames,
    writeShared: setLauncherNameDraft,
    local: localNames,
    writeLocal: (field, value) => setLocalNames((current) => ({ ...current, [field]: value }))
  })
  const [optionsExpanded, setOptionsExpanded] = useState(false)
  const [busy, setBusy] = useState<'agent' | 'terminal' | 'browser' | 'note' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showUnavailable, setShowUnavailable] = useState(false)
  const config = useAppStore((state) => state.config)
  const providerCatalog = useAppStore((state) => state.providerCatalog)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const tabWorkspaceId = useAppStore((state) => tabId ? state.tabs[tabId]?.workspaceId : undefined)
  const topicPreparation = useAppStore(state => tabId ? state.tabs[tabId]?.topicPreparation : undefined)
  const detections = useAppStore((state) => state.executorDetections)
  const detectExecutors = useAppStore((state) => state.detectExecutors)
  const launchAgent = useAppStore((state) => state.launchAgent)
  const prewarmTerminal = useAppStore((state) => state.prewarmTerminal)
  const controlNavigation = useAppStore(state => state.workbenchNavigationInputPolicy !== null || state.workbenchSpaceSelection !== null)
  // A visible Tab can contain an unselected Launcher created by Control. Only its
  // selected Region may acquire input; the original empty-group Launcher has no Region.
  const inputRegionActive = useAppStore(state => tabId && regionId
    ? state.tabs[tabId]?.layout.activeRegionId === regionId
    : tabId === undefined && regionId === undefined)
  const warmTerminal = useAppStore((state) => state.warmTerminal)
  const terminalThemeId = useAppStore((state) => state.config?.appearance.terminalTheme)
  const terminalFontSize = useAppStore(
    (state) => state.config?.appearance.terminalFontSize ?? TERMINAL_FONT_SIZE_DEFAULT
  )
  // 卡片上写「Start in ⟨谁⟩」的那个 Workspace，与五个启动动作真正落进去的那个，必须是**同一次**
  // 判定（resolveLauncherWorkspaceId）。分开算的症状不是报错：标题写着 A、点下去建到 B。
  const workspace = config?.workspaces.find((item) => item.id === resolveLauncherWorkspaceId({
    launcherTabWorkspaceId: tabWorkspaceId,
    activeWorkspaceId
  }))
  const host = workspace ? config?.hosts.find((candidate) => candidate.id === workspace.hostId) : undefined
  const hostLabel = host?.label ?? workspace?.hostId ?? 'No host'
  const storedHostCheck = useAppStore((state) => workspace ? state.hostChecks[workspace.hostId] : undefined)
  const hostCheck = host ? currentHostCheck(storedHostCheck, host) : undefined
  // Only show a warm shell created for this exact host and working directory.
  // It remains outside the ordinary Session list until the user claims it.
  const warmKey = workspace ? warmTerminalKey(workspace.hostId, workspace.path) : null
  // 这个 launcher 挂载点的归属身份。取值规则在 warmLauncherId 里判一次——**不能**直接用 regionId：
  // 空分组占位没有 region，而那恰是新建 workspace 的第一眼，用可缺席的字段当归属键会把最主要那条
  // 路径永久降级成冷卡片。
  const launcherId = warmLauncherId({ tabGroupId, regionId })
  // 「这次启动来自哪个 launcher Region」——五个动作共用的同一个实参，只在这里算一次。
  // 手抄五遍时任何一处写成 `regionId ? …`（漏掉 tabId）都会让那一个动作静默丢掉 launcher 上下文，
  // 于是它按活动 Workspace 解析——正是 createNote 已经犯过的那个缺陷的另一种入口。
  const launcherRef = tabId && regionId ? { tabId, regionId } : undefined
  // 「这个槽在我眼里是什么样」只判一次，落点在 warmTerminalPreview。要显示哪个 session、要不要显示
  // 「正在预热」、槽在不在，分开算必然漂移，症状是转圈提示归 A 而终端画面归 B 这种自相矛盾的画面。
  const { session: warmSession, pending: warmPending, slotHeld: warmSlotHeld } = warmTerminalPreview({
    warmTerminal,
    warmKey,
    launcherId
  })
  const executors = useMemo(
    () => configuredExecutors(config).map((executor) => ({
      ...executor,
      detection: workspace ? currentExecutorDetection(detections[executorDetectionKey(workspace.hostId, executor.id)], executor.id, executor,
        config?.hosts.find(host => host.id === workspace.hostId)) : undefined
    })),
    [config?.executors, config?.hosts, detections, workspace]
  )
  // An unconfirmed discovery check is not evidence that the configured Agent cannot work.
  const installedExecutors = executors.filter(executor => executor.detection?.state !== 'missing').sort((a, b) => Number(b.detection?.state === 'ready') - Number(a.detection?.state === 'ready'))
  const unavailableExecutors = executors.filter(executor => executor.detection?.state === 'missing')
  const detecting = executors.some((executor) => executor.detection?.state === 'checking')
  const savedSections = useLauncherState(state => workspace ? state.sections[workspace.id] : undefined)
  const sections = { ...DEFAULT_LAUNCHER_SECTIONS, ...savedSections }
  const persistenceIssue = useLauncherState(state => state.persistenceIssue)
  const saveSection = useLauncherState(state => state.setSection)
  const saveExecutor = useLauncherState(state => state.selectExecutor)
  const savedExecutor = useLauncherState(state => workspace ? state.executors[workspace.id] : undefined)
  const selectedExecutor = executors.find(executor => executor.id === executorId)
  function setSection(section: LauncherSection, mode: LauncherSectionMode) {
    if (workspace) saveSection(workspace.id, section, mode)
  }
  function chooseExecutor(id: string) {
    setExecutorId(id)
    if (workspace) saveExecutor(workspace.id, id)
  }
  useEffect(() => { if (savedExecutor) setExecutorId(savedExecutor) }, [workspace?.id, savedExecutor])

  // Launch options are read purely from the selected Provider's catalog declaration — no branch on
  // providerId. A Provider that declares none yields [], so LaunchRefine renders nothing.
  const selectedProviderId = executors.find((executor) => executor.id === executorId)?.providerId
  const toolsScope = JSON.stringify([regionId, workspace?.id, selectedProviderId])
  const feedback = useComposerFeedback(toolsScope)
  const launchOptions = useMemo(
    () => providerCatalog.find((entry) => entry.id === selectedProviderId)?.launchOptions ?? [],
    [providerCatalog, selectedProviderId]
  )
  // Clear the picked choices whenever the target Provider changes, so a choice picked for one Provider can
  // never launch another. Every option starts unset, leaving the Provider's own default untouched until the
  // user picks.
  useEffect(() => {
    setLaunchOptionSelection({})
    // Switching Provider re-collapses the disclosure so an untouched agent shows no options noise, and the
    // freshly-reset choices are never revealed mid-flight against the previous Provider's expanded panel.
    setOptionsExpanded(false)
  }, [launchOptions])

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
    if (workspace && visible && presentationActive && inputRegionActive && !controlNavigation && sections.terminal === 'expanded') prewarmTerminal(workspace.id, launcherId)
  }, [prewarmTerminal, visible, presentationActive, inputRegionActive, controlNavigation, workspace?.id, launcherId, warmSlotHeld, sections.terminal])

  useEffect(() => {
    if (!workspace || executors.every((executor) => executor.detection)) return
    if (!visible || !presentationActive || !inputRegionActive || controlNavigation) return
    void detectExecutors(workspace.hostId)
  }, [executors, detectExecutors, visible, presentationActive, inputRegionActive, controlNavigation, workspace])

  useEffect(() => {
    if (installedExecutors.some((executor) => executor.id === executorId)) return
    const first = installedExecutors[0]
    if (first) setExecutorId(first.id)
  }, [executorId, installedExecutors])

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
    installedExecutorCount: installedExecutors.length
  }
  // 启动这一件事也只写一次：按钮的 onClick 与键盘那条路调的是同一个函数。抄两遍时任何一处漏掉
  // launchOptionSelection 或那两个名字，就变成「用鼠标点带着精调启动、用键盘发就丢掉精调」。
  function launchFromLauncher(): void {
    void run('agent', () => launchAgent(
      executorId,
      expandSemanticReferences(prompt),
      tabGroupId,
      launcherRef,
      launchOptionSelection,
      // trim 后为空即不传：空白不该变成一个 "launch" 档的名字，也绝不阻塞启动。
      { agentName: names.agentName.trim() || undefined, tabName: names.tabName.trim() || undefined }
    ))
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
    await insertionRef.current?.insert(async () => {
      const paths = await api.ui.chooseFiles(workspace?.path ? { defaultPath: workspace.path } : undefined)
      return paths?.length ? appendFileReferences('', paths, workspace?.path) : null
    }, { separate: true })
  }

  return (
    <section className="launch-surface" data-agent-section={sections.agents}>
      <details className="launcher-environment">
        <summary aria-label="Runtime environment">
          <span className="launcher-environment__project"><Folder size={18} /><h2>{workspace?.name ?? 'Choose a workspace'}</h2></span>
          <span className="launcher-environment__host">{host?.kind === 'ssh' ? <RadioTower size={13} /> : <SquareTerminal size={13} />}{host?.kind === 'local' ? 'Local' : host?.kind === 'ssh' ? 'SSH' : 'Unknown host'}<span>· {hostLabel}</span><ChevronDown size={12} /></span>
          <span className="launcher-environment__path" title={workspace?.path}>{workspace?.path ?? 'No working directory selected'}</span>
        </summary>
        <div className="launcher-environment__details">
          <dl><div><dt>Working directory</dt><dd>{workspace?.path ?? 'Not selected'}</dd></div>
            <div><dt>Host</dt><dd>{hostLabel}{host?.kind === 'ssh' ? ` · ${host.user ? `${host.user}@` : ''}${host.hostname}${host.port ? `:${host.port}` : ''}` : ''}</dd></div>
            <div><dt>Connection check</dt><dd>{hostCheck ? hostCheckLabel(hostCheck) : 'Not tested'}{hostCheck?.detail ? <small>{hostCheck.detail}</small> : null}</dd></div>
            <div><dt>Execution environment</dt><dd>Configured host shell<small>Isolated environments are not supported yet.</small></dd></div>
          </dl>
        </div>
      </details>

      {topicPreparation || (executors.length === 0 && prompt) ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: {
        step: topicPreparation ? 'Mote Topic preparation is unconfirmed' : 'No Agent Executor is configured',
        mode: `${executors.length === 0 ? 'No Agent Executor is configured. ' : ''}Your request has not been sent. ${topicPreparation ? 'The same Topic, Region and complete draft are kept.' : 'The same Region and complete draft are kept.'}`,
        restore: executors.length === 0 ? 'Add an Agent in Settings, then Launch agent here with the preserved request.' : 'Launch agent here to retry preparation for this same Topic, then send the preserved request.'
      } }} /> : null}
      {persistenceIssue ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: persistenceIssue?.includes('could not be read') ? 'Saved Launcher preferences could not be read' : 'Launcher preferences could not be saved', mode: `${persistenceIssue ?? ''} Current sections and drafts remain usable in this window. They may not survive a restart.`, restore: persistenceIssue?.includes('could not be read') ? 'Copy any new drafts before reopening this window to retry reading saved preferences. The existing saved data is kept.' : 'Restore local storage access, then change a section or edit the draft to retry saving.' } }} /> : null}

      {sections.agents !== 'hidden' ? <div className="launcher-agents-head">
        <span className="launcher-agents-head__identity">{sections.agents === 'collapsed' && selectedExecutor ? <AgentAvatar executorId={selectedExecutor.id} providerId={selectedExecutor.providerId} label={selectedExecutor.label} size={16} /> : null}<strong>{sections.agents === 'collapsed' ? selectedExecutor?.label ?? 'Agent' : 'Agent'}</strong>
          {sections.agents === 'collapsed' && prompt ? <small title={prompt}>{prompt.split('\n')[0]}</small> : null}</span>
        <span className="launcher-section-actions">
          <button type="button" className="icon-button" aria-label="Refresh agents on this host" title="Refresh agents on this host" disabled={!workspace || detecting} onClick={() => workspace && void detectExecutors(workspace.hostId)}>{detecting ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}</button>
          <button type="button" className="icon-button" aria-label={sections.agents === 'expanded' ? 'Collapse Agents' : 'Expand Agents'} title={sections.agents === 'expanded' ? 'Collapse' : 'Expand'} onClick={() => setSection('agents', sections.agents === 'expanded' ? 'collapsed' : 'expanded')}>{sections.agents === 'expanded' ? <Minus size={13} /> : <ChevronDown size={13} />}</button>
          <button type="button" className="icon-button" aria-label="Close Agents" title="Close Agents" onClick={() => setSection('agents', 'hidden')}><X size={13} /></button>
        </span>
      </div> : null}

      {sections.agents === 'expanded' ? <>
        <div className="agent-catalog" aria-label="Agent executors">
          <div className="agent-picks">
            {installedExecutors.map(executor => <button type="button" key={executor.id} aria-pressed={executor.id === executorId}
              className={`agent-pick ${executor.id === executorId ? 'agent-pick--selected' : ''}`}
              title={`${agentProviderLabel(executor.providerId)} · ${executorDetectionLabel(executor.detection)}`} onClick={() => chooseExecutor(executor.id)}>
              <AgentAvatar executorId={executor.id} label={executor.label} providerId={executor.providerId} size={16} /><strong>{executor.label}</strong>
              {executor.detection?.state !== 'ready' ? <span className="agent-pick__unconfirmed" aria-label={executorDetectionLabel(executor.detection)}>?</span> : null}
              {executor.id === executorId ? <Check size={12} className="agent-pick__check" /> : null}
            </button>)}
            {unavailableExecutors.length ? <button type="button" className="launcher-other-agents" aria-expanded={showUnavailable} onClick={() => setShowUnavailable(value => !value)}>{showUnavailable ? 'Hide unavailable' : `Unavailable · ${unavailableExecutors.length}`}<ChevronDown size={12} /></button> : null}
            {!executors.length ? <div className="agent-catalog__empty">No Agent is configured. Add one in Settings to launch here.</div> : !installedExecutors.length ? <div className="agent-catalog__empty">Configured Agent commands were not found on this host. Recheck after installation.</div> : null}
          </div>
          {showUnavailable ? <div className="launcher-unavailable-agents">{unavailableExecutors.map(executor => <span key={executor.id} title={executor.detection?.detail}><AgentAvatar executorId={executor.id} label={executor.label} providerId={executor.providerId} size={14} /><strong>{executor.label}</strong><small>{executorDetectionLabel(executor.detection)}</small></span>)}</div> : null}
        </div>
        <div className="launcher-composer composer"><InlineComposer aria-label="Agent prompt" disabled={false} readPastedImage={path => api.ui.readPastedImage(path)} insertionRef={insertionRef}
          onPasteImage={(file, insert) => { void feedback.run(() => insert(async () => { const path = await api.ui.savePastedImage({ bytes: new Uint8Array(await file.arrayBuffer()), extension: file.type.slice(6).split('+')[0] ?? 'png' }); return appendFileReferences('', [path]) }, { separate: true })) }}
          autoFocus={visible && presentationActive && inputRegionActive && !controlNavigation} value={prompt} onValueChange={setPrompt}
          onKeyDown={event => { if (!launcherKeydownLaunches(event, isMacPlatform(), readiness)) return; event.preventDefault(); launchFromLauncher() }}
          placeholder="What would you like to work on?" /></div>
        <div className="composer__toolbar launcher-tools"><div>
          <AgentComposerTools key={toolsScope} layoutControl={false} disabled={busy !== null || !workspace}
            commands={providerCatalog.find(entry => entry.id === selectedProviderId)?.composer?.commands ?? []}
            loadSkills={() => workspace && selectedProviderId ? api.ui.listWorkspaceSkills(workspace.id, selectedProviderId) : Promise.resolve([])}
            onChooseSkill={skill => appendReference(skill.path)} onCommand={command => setPrompt(`${command}${prompt ? ` ${prompt}` : ' '}`)}
            {...(workspace?.hostId === 'local' ? { onCapture: captureComposerScreenshot } : {})} runAction={feedback.run} />
          <ComposerReferenceTool disabled={busy !== null || !workspace} onSelect={() => { void feedback.run(chooseComposerFiles) }} label="Reference files for the Agent" />
        </div></div>
        <ComposerFeedback failure={feedback.failure} onDismiss={feedback.dismiss} />
      </> : null}
      {sections.agents !== 'hidden' ? <div className="launch-surface__footer">
        <div className="launcher-launch-tools"><LaunchRefine options={launchOptions} selection={launchOptionSelection} expanded={optionsExpanded}
          onToggle={() => setOptionsExpanded(value => !value)} disabled={busy !== null} names={names} onNameChange={setName}
          onSelect={(optionId, choiceId) => setLaunchOptionSelection(current => { if (choiceId === null) { const { [optionId]: _cleared, ...rest } = current; return rest }; return { ...current, [optionId]: choiceId } })} /><LauncherMoteAction workspace={workspace} prompt={prompt} sourceTabId={tabId} sourceRegionId={regionId} disabled={busy !== null || !workspace} /></div>
        <button className="primary-button" disabled={!launcherCanLaunch(readiness)} onClick={launchFromLauncher}>{busy === 'agent' ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />}{busy === 'agent' ? 'Launching…' : 'Launch agent'}</button>
        <LauncherResumePicker workspace={workspace} disabled={busy !== null} />
      </div> : null}
      {selectedExecutor && selectedExecutor.detection?.state !== 'ready' && selectedExecutor.detection?.state !== 'missing' && sections.agents !== 'hidden' ? <ServiceWindowNotice notice={{ kind: 'indeterminate', notice: { step: 'Agent availability check is unconfirmed', mode: `${selectedExecutor.label} is configured; ${executorDetectionLabel(selectedExecutor.detection).toLowerCase()}. Launch remains available and reports its actual result.`, restore: 'Recheck agents on this host to confirm discovery.' } }} /> : null}
      {regionId ? <AgentLifecycleFeedback owner={{ regionId }} visible={visible} busy={busy !== null} retry={launchFromLauncher} /> : null}
      {error ? <div className="new-tab-error" role="alert">{error}</div> : null}
      <LauncherSecondarySurfaces workspace={workspace} tabGroupId={tabGroupId} launcherRef={launcherRef} launcherId={launcherId}
        sections={sections} onSectionChange={setSection} warmSession={warmSession} warmPending={warmPending}
        terminalThemeId={terminalThemeId} terminalFontSize={terminalFontSize} visible={visible} busy={busy}
        onRun={run} />
      {sections.agents === 'hidden' ? <div className="launcher-restores"><button type="button" className="launcher-restore" onClick={() => setSection('agents', 'expanded')}><AgentAvatar executorId={executorId} label={selectedExecutor?.label ?? executorId} providerId={selectedProviderId} size={15} />Agents · {selectedExecutor?.label ?? executorId}<ChevronDown size={12} /></button></div> : null}
    </section>
  )
}
