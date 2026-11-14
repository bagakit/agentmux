import { usePathDisplay } from '../hooks/usePathDisplay'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import understandArtwork from '@agentmux/client-ui/brand/illustrations/goals/goal-understand.png'
import ideasArtwork from '@agentmux/client-ui/brand/illustrations/goals/goal-ideas.png'
import nextArtwork from '@agentmux/client-ui/brand/illustrations/goals/goal-next.png'
import customArtwork from '@agentmux/client-ui/brand/illustrations/goals/goal-custom.png'
import { commonActionsDirectory, resolveGoalsCommonAction, type GoalsCommonAction } from '../lib/goals-common-actions'
import { saveGoalsCommonActions } from '../lib/goals-common-actions-config'
import { goalExplorationPending, goalExplorationProject, startGoalExploration, subscribeGoalExploration } from '../lib/goals-entry-actions'
import { useAppStore } from '../store'
import { primaryMoteExecutorId, primaryMoteHasBot } from '../lib/primary-mote-executor'
import { useLauncherState } from '../lib/launcher-state'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { SettingsNavigation } from './SettingsNavigation'

const Down = semanticIconComponent('navigation.down'), Up = semanticIconComponent('navigation.up')
const Forward = semanticIconComponent('navigation.forward'), Settings = semanticIconComponent('object.settings')
const errorText = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause)
const builtinArtwork = { understand: understandArtwork, ideas: ideasArtwork, next: nextArtwork }
function RequestBody({ action }: { action: GoalsCommonAction }) {
  const emphasis = action.ref.kind === 'builtin' ? action.ref.id === 'understand' ? '了解我并给我建议吗？' : action.ref.id === 'ideas' ? '开始尝试一个项目' : '建议我下一步应该做什么' : ''
  return <span className="goals-entry__request">{emphasis && action.body.endsWith(emphasis) ? <>{action.body.slice(0, -emphasis.length)}<strong>{emphasis}</strong></> : action.body}</span>
}
function TargetFacts({ action }: { action: GoalsCommonAction }) {
  const displayPath = usePathDisplay()
  return <span className="goals-common__facts">
    {action.project ? <small title={`${action.project.hostId} · ${displayPath(action.project.path, action.project.hostId)}`}>{action.project.source === 'recent' ? '最近项目' : '当前项目'} · {action.project.name}</small> : null}
    <small>{action.executor ? `${action.initialExecutor ? '首次选择' : '主 Mote'} · ${action.executor.label}` : action.reason ?? '主 Mote 的 Agent 待确认'}</small>
  </span>
}

/** Goals consumes the saved references; authoring stays in Settings' original Prompts editor. */
export function GoalsCommonActions({ contextCompact = false, onReturnToCommon }: { contextCompact?: boolean; onReturnToCommon?: () => void }) {
  const config = useAppStore(state => state.config), focus = useAppStore(state => state.agentFocus)
  const savedExecutor = useLauncherState(state => state.executors[SCRATCH_WORKSPACE_ID])
  const primaryExecutorId = useAppStore(state => primaryMoteExecutorId(state, savedExecutor)), initialExecutor = !useAppStore(primaryMoteHasBot)
  const activeWorkspaceId = useAppStore(state => state.activeWorkspaceId)
  const project = useMemo(() => goalExplorationProject(config, focus, activeWorkspaceId), [config, focus, activeWorkspaceId])
  const directory = commonActionsDirectory(config)
  const actions = useMemo(() => directory.items.map(ref => resolveGoalsCommonAction(ref, config, project, primaryExecutorId, initialExecutor)), [directory, config, project, primaryExecutorId, initialExecutor])
  const visible = actions.filter(action => !action.conditional)
  const pending = useSyncExternalStore(subscribeGoalExploration, goalExplorationPending, goalExplorationPending)
  const [expanded, setExpanded] = useState(false), [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null), [launchError, setLaunchError] = useState<string | null>(null)
  const navigation = useContext(SettingsNavigation), settingsButton = useRef<HTMLButtonElement>(null)
  const mounted = useRef(true), returnFocus = useRef<HTMLElement | null>(null), revealRequested = useRef(false)
  const displayed = expanded ? visible : visible.slice(0, 3)
  const compactFeedback = [saveError ? '显隐保存未完成' : null, launchError ? '对话准备未确认' : null, saving ? '正在保存' : null, pending ? '正在准备对话' : null].filter(Boolean).join(' · ')
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useLayoutEffect(() => {
    if (contextCompact || !revealRequested.current) return
    const target = [returnFocus.current, settingsButton.current].find(candidate => candidate?.isConnected && !candidate.matches(':disabled') && !candidate.closest('[hidden]'))
    target?.focus(); revealRequested.current = false
  }, [contextCompact])
  async function toggleCollapsed() {
    if (saving) return
    setSaving(true); setSaveError(null)
    try { await saveGoalsCommonActions({ directory: { ...directory, collapsed: !directory.collapsed }, expectedDirectory: config?.goalsCommonActions }) }
    catch (cause) { setSaveError(errorText(cause)) }
    finally { setSaving(false) }
  }
  function start(action: GoalsCommonAction) {
    if (pending || action.reason || !action.body) return
    setLaunchError(null)
    void startGoalExploration(action.body, action.project, action.executor?.id).catch(cause => {
      if (mounted.current && useAppStore.getState().mainSurface === 'board') setLaunchError(errorText(cause))
    })
  }
  const openSettings = () => navigation?.open('goals', undefined, 'goals-common-actions')
  return <section className={`goals-entry goals-common${contextCompact ? ' goals-common--compact' : ''}${compactFeedback ? ' goals-common--attention' : ''}`} aria-label="常用操作" aria-busy={saving || pending} data-common-context={contextCompact ? 'compact' : 'full'} onFocusCapture={event => { if (!contextCompact) returnFocus.current = event.target as HTMLElement }}>
    <div className="goals-common__column">
      <header className="goals-common__heading"><h2>常用操作</h2>{contextCompact ? <button type="button" className="goals-common__icon" aria-label="回到常用操作" title="回到常用操作" onClick={() => { revealRequested.current = true; onReturnToCommon?.() }}><Up size={13} /></button> : <div>
        {navigation ? <button ref={settingsButton} type="button" className="goals-common__icon" aria-label="Configure common actions" title="Configure common actions" onClick={openSettings}><Settings size={13} /></button> : null}
        <button type="button" className="goals-common__text-button" disabled={saving} aria-label={directory.collapsed ? '展开常用操作' : '收起常用操作'} aria-expanded={!directory.collapsed} onClick={() => void toggleCollapsed()}>{directory.collapsed ? <Down size={13} /> : <Up size={13} />}</button>
      </div>}</header>
      {contextCompact && compactFeedback ? <p className="goals-common__context-feedback" role="status">{compactFeedback}。原操作仍在。</p> : null}
      <div className="goals-common__content" hidden={contextCompact}>
        {!directory.collapsed ? <>
          <div className="goals-entry__actions goals-common__reading" role="region" aria-label="阅读常用操作完整请求" tabIndex={0} aria-busy={pending}>
            {displayed.map(action => <button key={action.key} type="button" data-goals-entry-action={action.ref.id} data-common-action={action.key} disabled={pending || Boolean(action.reason) || !action.body} onClick={() => start(action)}>
              <img className="goals-common__art" src={action.ref.kind === 'builtin' ? builtinArtwork[action.ref.id] : customArtwork} alt="" aria-hidden="true" onError={event => { event.currentTarget.hidden = true }} />
              <span className="goals-common__copy"><span className="goals-common__request-line"><RequestBody action={action} /><Forward size={15} aria-hidden="true" /></span><TargetFacts action={action} /></span>
            </button>)}
            {!displayed.length ? <p className="goals-common__empty">你的常用操作可以放在这里。{navigation ? <button type="button" className="goals-common__text-button" onClick={openSettings}>Configure in Settings</button> : null}</p> : null}
          </div>
          {visible.length > 3 ? <button type="button" className="goals-common__all goals-common__text-button" aria-expanded={expanded} onClick={() => { setExpanded(!expanded); const active = document.activeElement; queueMicrotask(() => (active as HTMLElement)?.focus()) }}>{expanded ? '收起更多' : `全部操作（${visible.length}）`}{expanded ? <Up size={12} /> : <Down size={12} />}</button> : null}
        </> : null}
        {pending ? <p className="goals-entry__preparing" role="status">正在准备对话…</p> : null}
        {saveError ? <p className="goals-service" role="alert">显隐保存未完成，原配置仍保留。<span>{saveError}</span></p> : null}
        {launchError ? <p className="goals-service" role="status">对话准备未确认。原请求与工作面保留，请查看对话中的准备状态。<span>{launchError}</span></p> : null}
      </div>
    </div>
  </section>
}
