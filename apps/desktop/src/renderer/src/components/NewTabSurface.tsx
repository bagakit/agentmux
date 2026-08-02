import { ArrowUpRight, Check, ChevronRight, Globe2, LoaderCircle, NotebookPen, Play, RadioTower, RefreshCw, Sparkles, SquareTerminal } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LaunchOptionSelection } from '@agentmux/core'
import { DESKTOP_ACTIONS } from '../../../shared/desktop-actions'
import { executorDetectionKey, useAppStore, warmTerminalKey } from '../store'
import { configuredExecutors } from '../lib/executors'
import { EMPTY_LAUNCHER_NAMES, launcherNameBinding } from '../lib/launcher-name-draft'
import { launcherPromptBinding } from '../lib/launcher-prompt-draft'
import { launcherCanLaunch, launcherKeydownLaunches } from '../lib/launcher-submit'
import { resolveLauncherWorkspaceId } from '../lib/launcher-workspace'
import { warmLauncherId, warmTerminalPreview } from '../lib/warm-terminal-preview'
import { AgentProviderIcon, agentProviderLabel } from './AgentProviderIcon'
import { LaunchRefine } from './LaunchOptionControls'
import { TerminalView } from './TerminalView'
import { isMacPlatform } from '../lib/host-platform'

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
  const [executorId, setExecutorId] = useState('codex')
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
  const { prompt, set: setPrompt } = launcherPromptBinding({
    regionId,
    drafts: promptDrafts,
    writeShared: setAgentComposerDraft,
    local: localPrompt,
    writeLocal: setLocalPrompt
  })
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
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const config = useAppStore((state) => state.config)
  const providerCatalog = useAppStore((state) => state.providerCatalog)
  const activeWorkspaceId = useAppStore((state) => state.activeWorkspaceId)
  const tabWorkspaceId = useAppStore((state) => tabId ? state.tabs[tabId]?.workspaceId : undefined)
  const detections = useAppStore((state) => state.executorDetections)
  const detectExecutors = useAppStore((state) => state.detectExecutors)
  const launchAgent = useAppStore((state) => state.launchAgent)
  const promoteWarmTerminal = useAppStore((state) => state.promoteWarmTerminal)
  const prewarmTerminal = useAppStore((state) => state.prewarmTerminal)
  const warmTerminal = useAppStore((state) => state.warmTerminal)
  const terminalThemeId = useAppStore((state) => state.config?.appearance.terminalTheme)
  const createBrowser = useAppStore((state) => state.createBrowser)
  const createNote = useAppStore((state) => state.createNote)
  // 卡片上写「Start in ⟨谁⟩」的那个 Workspace，与五个启动动作真正落进去的那个，必须是**同一次**
  // 判定（resolveLauncherWorkspaceId）。分开算的症状不是报错：标题写着 A、点下去建到 B。
  const workspace = config?.workspaces.find((item) => item.id === resolveLauncherWorkspaceId({
    launcherTabWorkspaceId: tabWorkspaceId,
    activeWorkspaceId
  }))
  const hostLabel = workspace ? (config?.hosts.find((host) => host.id === workspace.hostId)?.label ?? workspace.hostId) : 'No host'
  const hostCheck = useAppStore((state) => workspace ? state.hostChecks[workspace.hostId] : undefined)
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
      detection: workspace ? detections[executorDetectionKey(workspace.hostId, executor.id)] : undefined
    })),
    [config?.executors, detections, workspace]
  )
  const installedExecutors = executors.filter((executor) => executor.detection?.state === 'ready')
  const unavailableExecutors = executors.filter((executor) => executor.detection?.state !== 'ready')
  const detecting = executors.some((executor) => executor.detection?.state === 'checking')

  // Launch options are read purely from the selected Provider's catalog declaration — no branch on
  // providerId. A Provider that declares none yields [], so LaunchRefine renders nothing.
  const selectedProviderId = executors.find((executor) => executor.id === executorId)?.providerId
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
    if (visible) promptRef.current?.focus()
  }, [visible])

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
    if (workspace && visible) prewarmTerminal(workspace.id, launcherId)
  }, [prewarmTerminal, visible, workspace?.id, launcherId, warmSlotHeld])

  useEffect(() => {
    if (!workspace || executors.every((executor) => executor.detection)) return
    if (!visible) return
    void detectExecutors(workspace.hostId)
  }, [executors, detectExecutors, visible, workspace])

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
      setError(cause instanceof Error ? cause.message : String(cause))
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
      prompt,
      tabGroupId,
      launcherRef,
      launchOptionSelection,
      // trim 后为空即不传：空白不该变成一个 "launch" 档的名字，也绝不阻塞启动。
      { agentName: names.agentName.trim() || undefined, tabName: names.tabName.trim() || undefined }
    ))
  }

  return (
    <section className="launch-surface">
      <div className="launch-surface__heading">
        <span className="launch-surface__icon" aria-hidden="true"><Sparkles size={20} /></span>
        <div className="launch-surface__heading-content">
          <div className="eyebrow">New session</div>
          <h2>Start in {workspace?.name ?? 'this workspace'}</h2>
          <p>Pick an Agent and describe the outcome — or open a terminal or browser instead.</p>
        </div>
        <button
          type="button"
          className="icon-button launch-surface__refresh"
          title="Refresh agents on this host"
          disabled={!workspace || detecting}
          onClick={() => workspace && void detectExecutors(workspace.hostId)}
        >
          {detecting ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
        </button>
      </div>

      <div className="agent-catalog" aria-label="Agent executors">
        <div className="agent-catalog__group">
          <div className="agent-catalog__label">
            <span><i className="agent-catalog__ready-dot" />Available Agents</span>
            <div className="agent-catalog__label-actions">
              <em>{installedExecutors.length}</em>
              {unavailableExecutors.length > 0 ? (
                <button
                  type="button"
                  className={`agent-catalog__more-btn ${showUnavailable ? 'agent-catalog__more-btn--active' : ''}`}
                  title={showUnavailable ? 'Hide unavailable agents' : `View ${unavailableExecutors.length} more uninstalled agents`}
                  onClick={() => setShowUnavailable((prev) => !prev)}
                >
                  <ChevronRight size={12} className={showUnavailable ? 'icon-rotate-90' : ''} />
                  <span>{showUnavailable ? 'Less' : `+${unavailableExecutors.length} more`}</span>
                </button>
              ) : null}
            </div>
          </div>
          <div className="agent-picks">
            {installedExecutors.map((executor) => (
              <button
                type="button"
                key={executor.id}
                aria-pressed={executor.id === executorId}
                className={`agent-pick ${executor.id === executorId ? 'agent-pick--selected' : ''}`}
                onClick={() => setExecutorId(executor.id)}
              >
                <span className="agent-pick__icon"><AgentProviderIcon providerId={executor.providerId} size={16} /></span>
                <span className="agent-pick__copy"><strong>{executor.label}</strong><small>{agentProviderLabel(executor.providerId)} · Ready</small></span>
                {executor.id === executorId ? <span className="agent-pick__check"><Check size={10} strokeWidth={3} /></span> : null}
              </button>
            ))}
            {installedExecutors.length === 0 ? (
              detecting ? (
                <div className="agent-catalog__empty">Checking providers…</div>
              ) : (
                <div className="agent-catalog__empty agent-catalog__empty--action">
                  <strong>No agent providers found on {hostLabel}</strong>
                  <small>Install a supported CLI (codex, claude, …) on this host, then re-check.</small>
                  <button
                    type="button"
                    className="small-button"
                    disabled={!workspace || detecting}
                    onClick={() => workspace && void detectExecutors(workspace.hostId)}
                  >
                    <RefreshCw size={12} /> Re-check host
                  </button>
                </div>
              )
            ) : null}
          </div>
        </div>

        {showUnavailable && unavailableExecutors.length > 0 ? (
          <div className="agent-catalog__group agent-catalog__group--unavailable animate-fade-in">
            <div className="agent-catalog__label">
              <span>Not installed on {workspace?.hostId ?? 'this host'}</span>
              <em>{unavailableExecutors.length}</em>
            </div>
            <div className="agent-picks">
              {unavailableExecutors.map((executor) => (
                <button type="button" key={executor.id} className="agent-pick agent-pick--unavailable" disabled>
                  <span className="agent-pick__icon"><AgentProviderIcon providerId={executor.providerId} size={16} /></span>
                  <span className="agent-pick__copy"><strong>{executor.label}</strong><small>{agentProviderLabel(executor.providerId)} · Unavailable</small></span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <textarea
        ref={promptRef}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        // Cmd/Ctrl+Enter 从这里发车。挂在 textarea 上而不是整个 section 上：section 里还嵌着热终端的
        // 预览（TerminalView），keydown 会从它冒泡上来，挂在外层就会把用户敲进那个终端的 Cmd+Enter
        // 抢掉。这一格是 prompt 唯一被输入的地方，也正是注册表里 `launcher.submit` 不带 gate 的理由。
        //
        // 壳里没有任何条件：要不要发车整条判定在 launcherKeydownLaunches 里（含那道与按钮共用的闸），
        // 这里只转发。它说不发时也**不** preventDefault——那一下不属于我们，Enter 该照旧换行。
        onKeyDown={(event) => {
          if (!launcherKeydownLaunches(event, isMacPlatform(), readiness)) return
          event.preventDefault()
          launchFromLauncher()
        }}
        placeholder="Describe the outcome. You can steer the agent after launch."
        rows={4}
      />

      <div className="launch-names">
        <input
          className="launch-names__input"
          value={names.agentName}
          onChange={(event) => setName('agentName', event.target.value)}
          placeholder="Agent name (optional)"
          aria-label="Agent name"
          disabled={busy !== null}
        />
        <input
          className="launch-names__input"
          value={names.tabName}
          onChange={(event) => setName('tabName', event.target.value)}
          placeholder="Tab name (optional)"
          aria-label="Tab name"
          disabled={busy !== null}
        />
      </div>

      <LaunchRefine
        options={launchOptions}
        selection={launchOptionSelection}
        expanded={optionsExpanded}
        onToggle={() => setOptionsExpanded((value) => !value)}
        disabled={busy !== null}
        onSelect={(optionId, choiceId) =>
          setLaunchOptionSelection((current) => {
            if (choiceId === null) {
              const { [optionId]: _cleared, ...rest } = current
              return rest
            }
            return { ...current, [optionId]: choiceId }
          })
        }
      />

      <div className="launch-surface__footer">
        <span>
          {workspace?.hostId !== 'local' ? <RadioTower size={13} /> : null}
          {hostLabel}
          {hostCheck ? <em className={`launch-host-health launch-host-health--${hostCheck.state}`}>{hostCheck.state === 'ready' ? 'Ready' : hostCheck.state === 'checking' ? 'Checking' : 'Needs attention'}</em> : null}
        </span>
        <button
          className="primary-button"
          disabled={!launcherCanLaunch(readiness)}
          onClick={() => launchFromLauncher()}
        >
          {busy === 'agent' ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />} {busy === 'agent' ? 'Launching…' : 'Launch agent'}
        </button>
      </div>
      {error ? <div className="new-tab-error" role="alert">{error}</div> : null}

      <div className="launch-surface__alt">
        <div className="agent-catalog__label">
          <span>Quick Surfaces</span>
        </div>

        {/*
          热终端在场时它自己占满一行（带实时预览），不在场时退化成 grid 里的一张卡。分支只包住
          终端这一件东西——Browser / Note 两张卡在**分支之外**只写一次。原先是整个 quick-grid
          分两份、Browser 卡逐字抄两遍，那种形状下「加一张卡只加进一条分支」会让用户在另一条
          分支里彻底看不到入口，而组件照旧渲染成功、测试照旧全绿（实测删掉其中一处，7 条全过）。
        */}
        <div className="launch-surfaces-stack">
          {workspace && warmSession && terminalThemeId ? (
            <div className="launch-terminal">
              <div className="launch-terminal__head">
                <span className="launch-terminal__hint">
                  <SquareTerminal size={13} className="launch-terminal__icon" />
                  Terminal · Ready for quick commands
                </span>
                <button
                  type="button"
                  className="small-button launch-terminal__claim"
                  aria-label="Open reusable Terminal in tab"
                  data-agentmux-action={DESKTOP_ACTIONS.claimReusableTerminal}
                  data-agentmux-session-id={warmSession.id}
                  disabled={busy !== null}
                  onClick={() => void run('terminal', () => promoteWarmTerminal(
                    tabGroupId,
                    launcherRef
                  ))}
                >
                  {busy === 'terminal' ? <LoaderCircle className="spin" size={12} /> : <ArrowUpRight size={12} />}
                  {busy === 'terminal' ? 'Opening…' : 'Open in tab'}
                </button>
              </div>
              <div className="launch-terminal__body">
                <TerminalView
                  session={warmSession}
                  themeId={terminalThemeId}
                  interactiveResize={false}
                  visible={visible}
                  autoFocus={false}
                  linkOrigin={{ workspaceId: workspace.id, tabGroupId }}
                />
              </div>
            </div>
          ) : null}

          <div className="launch-surface-quick-grid">
            {workspace && warmSession && terminalThemeId ? null : (
              <button
                type="button"
                className="agent-pick agent-pick--action launch-quick-card launch-terminal__fallback"
                aria-label="Open Terminal"
                data-agentmux-action={DESKTOP_ACTIONS.claimReusableTerminal}
                disabled={!workspace || busy !== null}
                onClick={() => void run('terminal', () => promoteWarmTerminal(
                  tabGroupId,
                  launcherRef
                ))}
              >
                <span className="agent-pick__icon">{warmPending ? <LoaderCircle className="spin" size={16} /> : <SquareTerminal size={16} />}</span>
                <span className="agent-pick__copy"><strong>Terminal</strong><small>{warmPending ? 'Warming a reusable host shell…' : 'Host shell in a recoverable core session'}</small></span>
                <span className="agent-pick__go">{busy === 'terminal' ? <LoaderCircle className="spin" size={14} /> : <ChevronRight size={14} />}</span>
              </button>
            )}

            <button
              type="button"
              className="agent-pick agent-pick--action launch-quick-card"
              aria-label="Open Browser"
              data-agentmux-action={DESKTOP_ACTIONS.openBrowser}
              disabled={!workspace || busy !== null}
              onClick={() => void run('browser', () => createBrowser(
                tabGroupId,
                launcherRef
              ))}
            >
              <span className="agent-pick__icon"><Globe2 size={16} /></span>
              <span className="agent-pick__copy"><strong>Browser</strong><small>Main-owned embedded WebContents</small></span>
              <span className="agent-pick__go">{busy === 'browser' ? <LoaderCircle className="spin" size={14} /> : <ChevronRight size={14} />}</span>
            </button>

            <button
              type="button"
              className="agent-pick agent-pick--action launch-quick-card"
              aria-label="Create note"
              data-agentmux-action={DESKTOP_ACTIONS.createNote}
              disabled={!workspace || busy !== null}
              onClick={() => void run('note', () => createNote(
                tabGroupId,
                launcherRef
              ))}
            >
              <span className="agent-pick__icon"><NotebookPen size={16} /></span>
              <span className="agent-pick__copy"><strong>Note</strong><small>Date-stamped markdown in this workspace</small></span>
              <span className="agent-pick__go">{busy === 'note' ? <LoaderCircle className="spin" size={14} /> : <ChevronRight size={14} />}</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
