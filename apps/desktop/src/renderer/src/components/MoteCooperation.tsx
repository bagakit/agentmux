import { useMoteDialogueView } from '../lib/mote-dialogue-view'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { mintObjectId } from '@agentmux/core/object-id'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { fileNavigationSelection, useAppStore } from '../store'
import { workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { workbenchNavigationTabs } from '../lib/workbench-navigation-catalog'
import { agentSessionPresentationIndex, sessionStatusLabel } from '../lib/session-presentation'
import { useObservedAppStore } from '../lib/use-observed-app-store'
import { moteMembers, moteMemberSnapshot, type MoteMember } from '../lib/mote-team'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { sameWorkbenchProjectionSelection, type WorkbenchProjectionSelection } from '../lib/workbench-projection'
import { moteCurrentGoals, goalsForMote } from '../lib/mote-goals'
import { ResolvedAgentAvatar } from './AgentAvatar'
import { MoteQuickModeDialog } from './MoteQuickMode'
import { openMoteMaterial } from '../lib/mote-materials-actions'
import { resolveMoteDefaultConversation, moteDefaultCatalog, useMoteDefaultConversation } from '../lib/mote-quick-preferences'
import '../styles/mote-cooperation.css'

const Team = semanticIconComponent('object.team')
const Forward = semanticIconComponent('navigation.forward')
const Down = semanticIconComponent('navigation.down')
const Close = semanticIconComponent('action.close')
const Settings = semanticIconComponent('action.quick-mode')

/** One compact reading surface over original members. All actions navigate existing owners. */
export function MoteCooperation({ scope, active, reference, onSelect, actions, presentation }: {
  scope: MoteWorkfaceScope; active: boolean; reference?: WorkbenchProjectionSelection | null | undefined
  onSelect(reference: WorkbenchProjectionSelection): boolean; actions?: ReactNode; presentation: 'navigation' | 'threads'
}) {
  const facts = useAppStore(useShallow(state => ({ config: state.config, tabs: workbenchNavigationTabs(state.tabs), layouts: state.layouts,
    spaceZoneBindings: state.spaceZoneBindings, topicCategories: state.topicCategories, projectGroups: state.projectGroups,
    scratchTopicSnapshots: state.scratchTopicSnapshots })))
  const graph = useMemo(() => workbenchSelectionCatalog(useAppStore.getState()), [facts])
  const spaces = graph.spaces.filter(space => space.kind === 'mote' && space.hostId === scope.workspace.hostId && space.topicId === scope.topic.id)
  const spaceId = spaces.length === 1 ? spaces[0]!.spaceId : null
  const currentMembers = useMemo(() => spaceId ? moteMembers(graph, spaceId) : [], [graph, spaceId])
  const retained = useRef({ identity: '', members: currentMembers })
  const identity = JSON.stringify([scope.workspace.hostId, scope.workspace.id, scope.rootPath, scope.topic.id])
  if (retained.current.identity !== identity || spaceId) retained.current = { identity, members: currentMembers }
  const members = retained.current.members
  const ids = useMemo(() => [...new Set(members.flatMap(member => member.regions.flatMap(item => {
    const region = facts.tabs[item.tabId]?.regions[item.regionId]
    return region?.kind === 'agent' ? [region.sessionId] : []
  })))], [members, facts.tabs])
  const consumer = useMemo(() => ({ sessionIds: ids, navigation: false }), [ids])
  const sessions = useObservedAppStore('workbenchTab', active, consumer, useShallow(state => {
    return Object.fromEntries(members.map(member => [member.key, moteMemberSnapshot(member, facts.tabs, state.sessions)]))
  }))
  const defaults = useMoteDefaultConversation(scope.topic, scope.workspace.id, active)
  const saved = scope.topic.quickMode?.status === 'saved' ? scope.topic.quickMode.defaults.conversation : undefined
  const dialogue = useMoteDialogueView()
  const observedMain = dialogue?.page?.main
  const hasMainSnapshot = observedMain?.identity?.hostId === scope.workspace.hostId && observedMain.identity.moteId === scope.topic.id
  const primary = hasMainSnapshot ? observedMain.current ?? undefined : defaults.conversation ?? saved
  const roleConfirmed = Boolean(hasMainSnapshot && observedMain.status === 'ready' && !dialogue?.unavailable)
  const primaryResolution = hasMainSnapshot ? resolveMoteDefaultConversation(useAppStore.getState(), { ...scope.topic,
    quickMode: { status: 'saved', version: observedMain.documentRevision ?? '', defaults: primary ? { conversation: primary } : {} } }, scope.workspace.id, primary ? moteDefaultCatalog(useAppStore.getState(), scope.topic, primary) : graph) : defaults
  const primaryLocation = primaryResolution.conversation
  const primaryIssue = primaryResolution.issue
  const current = reference ? members.find(member => member.locations.some(location => sameWorkbenchProjectionSelection(location, reference))) : undefined
  const isPrimary = (member: MoteMember) => {
    const observed = sessions[member.key]
    return Boolean(primary && (observed ? observed.control.hostId === primary.hostId && observed.control.agentSessionId === primary.sessionId
      : member.hostId === primary.hostId && member.agentSessionId === primary.sessionId))
  }
  const requestFor = (member: MoteMember) => {
    const source = sessions[member.key]
    const request = source?.pendingInteraction
    return request && request.agentSessionId === source!.control.agentSessionId &&
      (!request.evidence?.run || request.evidence.run.runId === source!.control.run.runId) ? request : null
  }
  const attention = members.filter(member => requestFor(member))
  const demands = useAppStore(state => state.demands)
  const index = agentSessionPresentationIndex(useAppStore.getState().sessions)
  const identities = members.map(member => ({ hostId: sessions[member.key]?.control.hostId ?? member.hostId,
    agentSessionId: sessions[member.key]?.control.agentSessionId ?? member.agentSessionId,
    associated: (index.get(member.agentSessionId)?.length ?? 0) === 1 && Boolean(sessions[member.key]) }))
  // Status updates affect the member row, never the cost of scanning unrelated Goals.
  const goalMembers = useMemo(() => identities, [JSON.stringify(identities)])
  const work = useMemo(() => {
    const contentZone = spaceId ? graph.zones.find(zone => graph.bindings.some(binding => binding.spaceId === spaceId && binding.zoneId === zone.zoneId) &&
      zone.kind === 'home' && zone.hostId === scope.workspace.hostId && zone.workspaceId === scope.workspace.id) : undefined
    const unambiguousIds = goalMembers.filter(member => member.associated).map(member => member.agentSessionId)
    const content = contentZone ? {
      hostId: scope.workspace.hostId, workspaceId: scope.workspace.id, zoneId: contentZone.zoneId
    } : null
    const contentOwned = (goal: (typeof demands)[string]) => Boolean(content && goal.contentRefs?.some(ref =>
      ref.hostId === content.hostId && ref.workspaceId === content.workspaceId && ref.zoneId === content.zoneId))
    const memberRow = (row: NonNullable<(typeof demands)[string]['responsibility']>['executions'][number]) => goalMembers.some(member =>
      row.execution.hostId === member.hostId && row.execution.agentSessionId === member.agentSessionId)
    const current = moteCurrentGoals(goalsForMote(demands, unambiguousIds, content).filter(goal =>
      contentOwned(goal) || !goal.responsibility?.executions.length || goal.responsibility.executions.some(memberRow)))
    return { current, human: current.filter(goal => goal.responsibility?.executions.some(row =>
      row.nextOwner.kind === 'human' && (contentOwned(goal) || memberRow(row)))) }
  }, [demands, goalMembers, graph, spaceId, scope.workspace.hostId, scope.workspace.id])
  const humanGoals = work.human
  const needed = attention.length + humanGoals.length
  const [expanded, setExpanded] = useState(false), [editing, setEditing] = useState(false)
  const [issue, setIssue] = useState('')
  const trigger = useRef<HTMLButtonElement | null>(null)
  const navigation = useRef<AbortController | null>(null)
  useEffect(() => {
    setIssue(''); setEditing(false); setExpanded(false)
    return () => navigation.current?.abort()
  }, [identity])
  const [panel, setPanel] = useState<HTMLDivElement | null>(null)
  useEffect(() => { if (!active) setExpanded(false) }, [active])
  useLayoutEffect(() => {
    const anchor = trigger.current
    if (presentation !== 'navigation' || !expanded || !active || !anchor || !panel) return
    let current = true
    const update = async () => {
      const result = await computePosition(anchor, panel, { strategy: 'fixed', placement: 'bottom-end',
        middleware: [offset(6), flip(), shift({ padding: 10 }), size({ padding: 10, apply: ({ availableHeight, availableWidth }) => {
          if (current) Object.assign(panel.style, { maxHeight: Math.max(0, availableHeight) + 'px', maxWidth: Math.max(0, availableWidth) + 'px' })
        } })] })
      if (current) Object.assign(panel.style, { left: result.x + 'px', top: result.y + 'px', visibility: 'visible' })
    }
    const release = autoUpdate(anchor, panel, () => { void update() })
    return () => { current = false; release() }
  }, [presentation, expanded, active, panel])
  const id = useId()
  const title = (member: MoteMember) => member.regions.find(region => region.title)?.title || sessions[member.key]?.label || member.agentSessionId
  function open(location: WorkbenchProjectionSelection) {
    const expected = members.find(member => member.locations.some(item => sameWorkbenchProjectionSelection(item, location)))
    const now = workbenchSelectionCatalog(useAppStore.getState())
    const actual = spaceId ? moteMembers(now, spaceId).find(member => member.key === expected?.key) : undefined
    const before = expected && sessions[expected.key], after = actual && moteMemberSnapshot(actual, useAppStore.getState().tabs, useAppStore.getState().sessions)
    if (!actual?.locations.some(item => sameWorkbenchProjectionSelection(item, location)) || before && after &&
      (before.control.hostId !== after.control.hostId || before.control.agentSessionId !== after.control.agentSessionId)) {
      setIssue('原成员位置尚未确认，你的对话和草稿都保留；请重新打开它的原位置。')
      return
    }
    if (onSelect(location)) { setIssue(''); setExpanded(false) }
    else setIssue('原位置尚未确认，当前对话和草稿都保留；请重新选择它的原位置。')
  }
  async function openGoal(goalId: string) {
    // This existing action opens the Goal owner. It does not continue, approve or answer it.
    navigation.current?.abort()
    const state = useAppStore.getState(), origin = fileNavigationSelection(state), controller = new AbortController()
    navigation.current = controller
    const cancel = () => controller.abort()
    const unsubscribe = useAppStore.subscribe(next => {
      if (fileNavigationSelection(next) !== origin && !(next.mainSurface === 'board' && next.selectedDemandId === goalId)) cancel()
    })
    const events = ['pointerdown', 'keydown', 'input'] as const
    for (const event of events) document.addEventListener(event, cancel, true)
    try {
      const result = await state.executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: mintObjectId(), operation: 'focus',
        target: { kind: 'goal', goalId }, inputPolicy: 'preserve' }, controller.signal)
      if (!controller.signal.aborted && result.operation === 'focus' && result.navigation.state === 'rejected') setIssue(result.issues.map(item => item.message).join(' '))
    } catch (error) { if (!controller.signal.aborted) setIssue(error instanceof Error ? error.message : String(error)) }
    finally { unsubscribe(); for (const event of events) document.removeEventListener(event, cancel, true); if (navigation.current === controller) navigation.current = null }
  }
  const ordered = [...attention, ...members.filter(member => !attention.includes(member)).sort((a, b) => Number(isPrimary(b)) - Number(isPrimary(a)))].filter(member => presentation !== 'threads' || !isPrimary(member))
  const membersPanel = <div className="mote-cooperation__team-body" id={id} data-mote-team>
      <div className="mote-cooperation__team-heading"><strong>{presentation === 'threads' ? '其他 Agent' : '团队协作'}</strong><span>{ordered.length} 个 Agent</span></div>
      {scope.issue || !spaceId ? <p className="mote-cooperation__issue" role="status">{spaceId ? '显示最后确认的成员及其原对话。' : '原团队绑定尚未确认，已有成员和对话都保留。'}</p> : null}
      {humanGoals.map(goal => <button key={goal.id} type="button" className="mote-cooperation__goal" onClick={() => openGoal(goal.id)}>
        <span>待你审阅</span><strong>{goal.title}</strong><Forward size={14} /></button>)}
      {ordered.map(member => {
        const observed = sessions[member.key], request = requestFor(member), name = title(member)
        const detail = request ? request.kind === 'permission' ? request.title || '请求权限' : '等你回答'
          : observed ? sessionStatusLabel(observed) : '状态未确认'
        return <div className="mote-cooperation__member" key={member.key} data-mote-member={member.agentSessionId}
          data-member-host={member.hostId ?? ''} data-attention={request ? 'true' : undefined}>
          <div className="mote-cooperation__member-info">
            {observed ? <ResolvedAgentAvatar label={observed.label} providerId={observed.providerId} state={observed.status.state} size={22} /> : <Team size={20} />}
            <div><strong title={name}>{name}</strong><span>{isPrimary(member) ? roleConfirmed ? '主 Agent' : '最后确认的主 Agent' : roleConfirmed ? '成员' : 'Agent'}<span aria-hidden="true"> · </span>{detail}</span></div>
          </div>
          <div className="mote-cooperation__locations">
            {member.locations.map((location, index) => <button type="button" key={JSON.stringify(location)} aria-label={`打开 ${name}${member.locations.length > 1 ? ` · 位置 ${index + 1}` : ''}`}
              aria-current={reference && sameWorkbenchProjectionSelection(reference, location) ? 'page' : undefined} onClick={() => open(location)}>
              {member.locations.length > 1 ? `位置 ${index + 1}` : request ? '查看请求' : '打开'}<Forward size={13} /></button>)}
            {!member.locations.length ? <span>原位置未确认</span> : null}
          </div>
        </div>
      })}
      {!members.length && spaceId ? <p className="mote-cooperation__empty">这个 Mote 还没有 Agent，从原讨论开始。</p> : null}
      {!needed && members.length ? <p className="mote-cooperation__empty">目前没有需要你处理的已确认请求。</p> : null}
    </div>
  const editDialog = editing ? <MoteQuickModeDialog scope={scope} reference={reference} onOpenPath={path => openMoteMaterial(scope, path)}
      onClose={() => setEditing(false)} returnFocus={() => trigger.current} /> : null
  if (presentation === 'threads') return <section className="mote-cooperation mote-cooperation--threads" aria-label="其他 Agent 对话">{issue ? <p role="status">{issue}</p> : null}{membersPanel}</section>
  return <Dialog.Root modal={false} open={expanded && active} onOpenChange={setExpanded}>
    <section className="mote-cooperation mote-cooperation--navigation" data-mote-cooperation={scope.topic.id} aria-label="Mote 协作">
      <Dialog.Trigger asChild><button type="button" ref={trigger} className="mote-cooperation__team" aria-label="团队协作" title="团队与协作设置"
        aria-expanded={expanded} aria-controls={id} data-needs-you={needed > 0 ? 'true' : undefined}>
        <Team size={15} /><span>{needed ? `${needed} 项待你处理` : '团队'}</span><Down size={12} />
      </button></Dialog.Trigger>
      <DocumentOverlayPortal component={Dialog.Portal}>
        <Dialog.Content ref={setPanel} className="mote-cooperation mote-cooperation__popover" style={{ visibility: 'hidden' }} aria-describedby={undefined}
          onOpenAutoFocus={event => { event.preventDefault(); panel?.focus({ preventScroll: true }) }}>
          <header className="mote-cooperation__popover-heading"><Dialog.Title>团队与协作</Dialog.Title>
            <Dialog.Close type="button" className="icon-button" aria-label="关闭团队协作"><Close size={14} /></Dialog.Close></header>
          {issue || primaryIssue ? <p className="mote-cooperation__issue" role="status">{issue || primaryIssue}</p> : null}
          {primary && primaryLocation && (!current || !isPrimary(current)) ? <button type="button" className="mote-cooperation__return" aria-label="返回主 Agent"
            onClick={() => open(primaryLocation!)}>主对话<Forward size={13} /></button> : null}
          {membersPanel}
          <footer className="mote-cooperation__popover-actions">
            <button type="button" className="mote-cooperation__return" onClick={() => { setExpanded(false); setEditing(true) }}><Settings size={14} />协作设置</button>
            {actions}
          </footer>
        </Dialog.Content>
      </DocumentOverlayPortal>
      {editDialog}
    </section>
  </Dialog.Root>
}
