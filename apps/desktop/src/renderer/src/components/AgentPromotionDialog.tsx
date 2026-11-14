import * as Dialog from '@agentmux/client-ui/components/Modal'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { MoteIcon } from '@agentmux/client-ui/components/MoteIcon'
import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentPromotionApply, AgentPromotionClub, AgentPromotionDestination, AgentPromotionDiscovery, AgentPromotionReceipt } from '@agentmux/core/agent-promotion'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import { api } from '../lib/api'
import { workbenchSelectionCatalog } from '../lib/desktop-focus-navigation'
import { workbenchNavigationTabs } from '../lib/workbench-navigation-catalog'
import { usePathDisplay } from '../hooks/usePathDisplay'
import { useAppStore } from '../store'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { SettingsNavigation } from './SettingsNavigation'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { executorAvatarAppearance, ResolvedAgentAvatar } from './AgentAvatar'

const Loading = semanticIconComponent('status.loading'), Promotion = semanticIconComponent('object.promotion')
export type AgentPromotionSelection = Omit<AgentPromotionApply, 'operationId' | 'destination'>
function ClubIdentity({ club, catalog }: { club: AgentPromotionClub; catalog: AgentMuxSpaceCatalog }) {
  const icons = useAppStore(state => state.spaceObjectIcons)
  const hosts = useAppStore(state => state.config?.hosts), displayPath = usePathDisplay()
  const original = catalog.spaces.find(space => space.spaceId === club.target.spaceId)
  const hostId = club.target.expectedResource?.hostId ?? original?.hostId
  const resource = club.directoryPath
  return <><SpaceObjectIcon kind="mote" name={club.title} manualIcon={icons[club.target.spaceId] ?? null}
    avatarObjectKey={club.target.spaceId} avatarWorkspaceId={club.target.expectedResource?.workspaceId} avatarTopicId={original?.topicId} visible={false} /><span>{club.title}
      <small>{hosts?.find(host => host.id === hostId)?.label ?? hostId ?? '位置待确认'}{resource ? ' · ' + displayPath(resource, hostId) : ''}</small></span></>
}

/** The original Host owns operations and membership; historical success is never the new intent. */
export function AgentPromotionDialog({ selection, initialIntent, onIntent, onClose, onPromoted }: {
  selection: AgentPromotionSelection; initialIntent?: AgentPromotionApply | null; onIntent?(intent: AgentPromotionApply): void
  onClose(): void; onPromoted(receipt: AgentPromotionReceipt): void
}) {
  const settings = useContext(SettingsNavigation)
  const allowed = useAppStore(state => state.config ? state.config.promotion?.enabled !== false : null)
  const agent = useAppStore(state => state.sessions.find(session => session.kind === 'agent' && session.control.hostId === selection.target.hostId && session.control.agentSessionId === selection.target.agentSessionId))
  const appearance = useAppStore(state => agent?.kind === 'agent' ? executorAvatarAppearance(state.config, agent.executorId) : undefined)
  const facts = useAppStore(useShallow(state => ({ config: state.config, tabs: workbenchNavigationTabs(state.tabs), layouts: state.layouts,
    spaceZoneBindings: state.spaceZoneBindings, topicCategories: state.topicCategories, projectGroups: state.projectGroups, scratchTopicSnapshots: state.scratchTopicSnapshots })))
  const catalog = useMemo(() => workbenchSelectionCatalog(useAppStore.getState()), [facts])
  const displayPath = usePathDisplay()
  const [receipt, setReceipt] = useState<AgentPromotionReceipt | null>(null)
  const [discovery, setDiscovery] = useState<AgentPromotionDiscovery | null>(null)
  const [destination, setDestination] = useState<AgentPromotionDestination | null>(null)
  const [phase, setPhase] = useState<'reading' | 'ready' | 'writing' | 'unknown'>('reading'), [error, setError] = useState<string | null>(null)
  const intent = useRef<AgentPromotionApply | null>(initialIntent?.target.hostId === selection.target.hostId && initialIntent.target.agentSessionId === selection.target.agentSessionId ? initialIntent : null), alive = useRef(true), writing = useRef(false), content = useRef<HTMLDivElement>(null)
  const invoker = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  function retain(input: AgentPromotionApply) { intent.current = input; setDestination(input.destination); onIntent?.(input) }
  async function complete(result: AgentPromotionReceipt) {
    onPromoted(result)
    if (alive.current) onClose()
    try {
      await useAppStore.getState().refreshSpatialState()
      await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true, result.topicId)
    } catch (cause) { useAppStore.getState().reportError(new Error('Club 关联已经保存，界面尚未刷新。' + presentError(cause))) }
  }
  async function observe(cursor?: string) {
    setPhase('reading'); setError(null)
    try {
      const frozen = intent.current
      const result = await api.agentPromotions.call('agent.promote.inspect', { target: selection.target,
        ...(frozen ? { operationId: frozen.operationId } : cursor ? { cursor } : {}) })
      if (!alive.current) return
      if (result.discovery) setDiscovery(previous => cursor && previous ? { ...result.discovery!, pending: [...previous.pending,
        ...result.discovery!.pending.filter(item => !previous.pending.some(old => old.operationId === item.operationId))],
        issue: [...new Set([previous.issue, result.discovery!.issue].filter(Boolean))].join('\n') || null } : result.discovery)
      setReceipt(result.promotion); setPhase('ready')
      if (frozen && result.promotion?.state === 'complete') await complete(result.promotion)
    } catch (cause) { if (alive.current) { setError(presentError(cause)); setPhase('unknown') } }
  }
  useEffect(() => { alive.current = true; void observe(); return () => { alive.current = false } }, [])
  function resume(original: AgentPromotionReceipt) {
    retain({ target: original.target, source: original.source, title: original.title, destination: original.destination, operationId: original.operationId })
    setReceipt(original); setPhase('ready'); setError(null)
  }
  async function promote() {
    if (writing.current || phase !== 'ready' || !receipt && allowed !== true) return
    const frozen = intent.current
    if (!frozen && (!destination || discovery?.memberships.length || !discovery)) return
    const input = frozen ?? { ...selection, destination: destination!, operationId: mintObjectId() }
    retain(input); writing.current = true; setPhase('writing'); setError(null)
    try {
      const result = await api.agentPromotions.call('agent.promote.apply', input)
      if (result.promotion.state === 'complete') await complete(result.promotion)
      else if (alive.current) { setReceipt(result.promotion); setPhase('ready') }
    } catch (cause) { if (alive.current) { setError(presentError(cause)); setPhase('unknown') } }
    finally { writing.current = false }
  }
  const busy = phase === 'writing', reading = phase === 'reading', partial = receipt?.state === 'partial'
  const blocked = !receipt && allowed !== true, frozen = intent.current, selected = frozen?.destination ?? destination
  const organized = Boolean(discovery?.memberships.length), joining = selected?.kind === 'existing-club'
  const ready = Boolean(frozen || selected && !organized && discovery)
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><DocumentOverlayPortal component={Dialog.Portal}>
    <Dialog.Overlay className="confirmation-dialog__overlay dialog-scrim topic-promotion-scrim" />
    <Dialog.Content ref={content} className="confirmation-dialog dialog-surface topic-promotion-dialog agent-promotion-dialog" data-phase={phase}
      onCloseAutoFocus={event => { event.preventDefault(); const active = document.activeElement
        if (active === document.body || active === null || content.current?.contains(active)) invoker.current?.isConnected && invoker.current.focus() }}>
      <div className="topic-promotion__body">
        <div className="agent-promotion__heading"><ResolvedAgentAvatar label={selection.title} providerId={agent?.kind === 'agent' ? agent.providerId : undefined} appearance={appearance} size={32} /><span className="topic-promotion__eyebrow">Promotion · Agent → Thread</span></div>
        <Dialog.Title className="topic-promotion__title">{selection.title}</Dialog.Title>
        <Dialog.Description className="topic-promotion__continuity">加入一个 Club，继续同一个 Agent 和原来的对话。项目、工作目录和正在做的事都会保留。</Dialog.Description>
        {!frozen && !reading && discovery ? <>
          {organized ? <div className="topic-promotion__recovery" role="status"><strong>当前 Club</strong>
            {discovery.memberships.map(club => <p key={JSON.stringify(club.target)}>{club.title}{club.main === true ? ' · Main' : ''}</p>)}<p>这个 Thread 已有团队归属。</p>
          </div> : <fieldset className="agent-promotion__clubs" disabled={busy || blocked}>
            <legend>选择已有 Club</legend>
            {discovery.clubs.map(club => <label key={JSON.stringify(club.target)} className="agent-promotion__club" data-selected={joining && selected.target.spaceId === club.target.spaceId}>
              <input type="radio" name="promotion-club" checked={joining && selected.target.spaceId === club.target.spaceId} onChange={() => setDestination({ kind: 'existing-club', target: club.target })} /><ClubIdentity club={club} catalog={catalog} />
            </label>)}
            {!discovery.clubs.length ? <p className="topic-promotion__continuity">还没有可加入的 Club。</p> : null}
            <label className="agent-promotion__club agent-promotion__new" data-selected={selected?.kind === 'new-club'}>
              <input type="radio" name="promotion-club" checked={selected?.kind === 'new-club'} onChange={() => setDestination({ kind: 'new-club' })} />
              <MoteIcon size={20} /><span>新建 Club 并加入<small>两级晋升：建立团队，再加入这个 Thread。</small></span>
            </label>
          </fieldset>}
          {discovery.issue ? <div className="topic-promotion__recovery" role="status"><p>{discovery.issue}</p><button type="button" className="small-button" onClick={() => void observe()}>重新读取</button></div> : null}
          {discovery.pending.length ? <section className="agent-promotion__pending" aria-label="未完成的 Promotion"><strong>未完成的操作</strong>
            {discovery.pending.map(original => <button type="button" className="small-button" key={original.operationId} data-promotion-operation={original.operationId} onClick={() => resume(original)}>
              <span>继续{original.destination.kind === 'new-club' ? '新建 Club' : '加入 Club'} · {discovery.clubs.find(club => club.target.spaceId === original.moteSpaceId && club.target.zoneId === original.zoneId)?.title ?? original.title}</span>
              <small>{displayPath(original.directoryPath, original.destination.kind === 'existing-club' ? original.destination.target.expectedResource?.hostId : undefined)}</small><small>操作 {original.operationId}</small>
            </button>)}
          </section> : null}
          {discovery.nextCursor ? <button type="button" className="small-button" onClick={() => void observe(discovery.nextCursor!)}>继续读取操作</button> : null}
        </> : null}
        {frozen ? <div className="agent-promotion__frozen"><MoteIcon size={19} /><span>{joining ? '加入原目标 Club，成为 Thread' : '建立 Club，再加入原 Thread'}<small>{discovery?.clubs.find(club => selected?.kind === 'existing-club' && club.target.spaceId === selected.target.spaceId && club.target.zoneId === selected.target.zoneId)?.title ?? (selected?.kind === 'new-club' ? frozen.title : '这次操作的目标已保留。')}</small>
          {receipt ? <small>{displayPath(receipt.directoryPath, receipt.destination.kind === 'existing-club' ? receipt.destination.target.expectedResource?.hostId : undefined)}</small> : null}
          <details><summary>准确操作</summary><small>{frozen.operationId}</small>{selected?.kind === 'existing-club' ? <small>Club {selected.target.spaceId} · home {selected.target.zoneId}</small> : null}</details></span></div> : null}
        {blocked && !reading && phase !== 'unknown' ? <div className="topic-promotion__recovery" role="status"><strong>{allowed === false ? 'Promotion 已关闭' : '晋升设置待确认'}</strong><p>已有 Club、原工作与未完成操作仍然保留。</p>
          {settings ? <button type="button" className="small-button" onClick={() => { onClose(); settings.open('mote-promotion', undefined, 'promotion.enabled') }}>打开 Promotion 设置</button> : null}</div> : null}
        {!busy && (partial || error) ? <div className="topic-promotion__recovery" role="status"><strong>{partial ? '操作尚未完成' : '结果待确认'}</strong><p>原来的工作仍可继续。{partial ? '可以接着完成这次操作。' : '先查看原操作的结果。'}</p><details><summary>查看详情</summary><p>{error ?? receipt?.unavailable.map(issue => issue.message).join(' ')}</p></details></div> : null}
        <footer className="topic-promotion__actions"><button type="button" className="small-button topic-promotion__cancel" onClick={onClose}>{busy || partial || phase === 'unknown' ? '稍后查看' : '取消'}</button>
          {phase === 'unknown' ? <button type="button" className="primary-button topic-promotion__submit" onClick={() => void observe()}>查看结果</button>
            : <button type="button" className="primary-button topic-promotion__submit" disabled={busy || reading || blocked || !ready} onClick={() => void promote()}>
              {busy ? <Loading size={15} animation="spin" aria-hidden="true" /> : <Promotion size={17} />}{busy ? '正在保存…' : reading ? '正在读取…' : partial ? '继续操作' : joining ? '加入 Club' : selected?.kind === 'new-club' ? '新建 Club 并加入' : '选择加入方式'}</button>}
        </footer>
        {busy ? <p className="topic-promotion__progress" role="status">正在保存这次关联。关闭后仍可检查原操作。</p> : null}
      </div>
    </Dialog.Content>
  </DocumentOverlayPortal></Dialog.Root>
}
