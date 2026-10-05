import { useCallback, useEffect, useId, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { ArrowLeft, ChevronRight, Layers, RefreshCw, Search } from 'lucide-react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentMuxRpcResult } from '@agentmux/core'
import type { AgentMuxSpaceAddress } from '@agentmux/core/control'
import { AgentAvatarBadgeIcon, type AgentAvatarBadge } from '@agentmux/client-ui/components/AgentAvatarBadgeIcon'
import { AgentEnamelFilter } from '@agentmux/client-ui/components/AgentEnamelFilter'
import { AgentProviderIcon } from '@agentmux/client-ui/components/AgentProviderIcon'
import { MobileIdentity, type MobileObjectIdentity } from './MobileIdentity'
import type { MobileHome } from './home-preference'

type Catalog = AgentMuxRpcResult<'space.ls'>['catalog']
type Props = { home: MobileHome; client: AgentMuxHostedClient | null; connected: boolean;
  visible?: boolean; sessions: AgentMuxAgentSession[]; openSession(id: string, identity: MobileObjectIdentity): void; openProfile?(identity: MobileObjectIdentity): void;
  onBackChange?(back: (() => void) | null): void }
export function MobileSpatialNavigation({ home, client, connected, sessions, openSession, openProfile, onBackChange, visible = true }: Props) {
  const avatarFilterId = useId().replace(/:/g, '')
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [issue, setIssue] = useState('')
  const [pending, setPending] = useState(false)
  const [query, setQuery] = useState('')
  const [spaceId, setSpaceId] = useState<string | null>(null)
  const [revision, refresh] = useState(0)
  useEffect(() => {
    if (!client || !connected || !visible) return
    let disposed = false, inFlight = false
    const read = async () => {
      if (inFlight || document.visibilityState === 'hidden') return
      inFlight = true; setPending(true)
      try {
        if (!client.forwardRpc) throw new Error('空间目录暂不可读；已有会话仍可在 Focus 中访问。')
        const value = await client.forwardRpc('space.ls', { target: {}, presentation: true })
        if (!disposed) { setCatalog(value.catalog); setIssue('') }
      } catch (error) { if (!disposed) setIssue(error instanceof Error ? error.message : '空间目录暂不可读，原记录保留。') }
      finally { inFlight = false; if (!disposed) setPending(false) }
    }
    void read()
    const timer = setInterval(() => { void read() }, 10000)
    const foreground = () => { if (document.visibilityState === 'visible') void read() }
    document.addEventListener('visibilitychange', foreground)
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', foreground) }
  }, [client, connected, visible, revision])
  useEffect(() => { setSpaceId(null); setQuery('') }, [home])
  const backToDirectory = useCallback(() => setSpaceId(null), [])
  useEffect(() => {
    if (!visible || !onBackChange) return
    onBackChange(home !== 'focus' && spaceId ? backToDirectory : null)
    return () => onBackChange(null)
  }, [visible, onBackChange, home, Boolean(spaceId), backToDirectory])
  const sessionById = new Map(sessions.map(session => [session.agentSessionId, session]))
  const spaces = catalog?.spaces ?? []
  const space = spaces.find(item => item.spaceId === spaceId)
  const matching = (value: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const locations = (id: string) => catalog?.locations.filter(location =>
    catalog.regions.some(region => region.tabId === location.tabId && region.regionId === location.regionId && region.agentSessionId === id)) ?? []
  const moteIdentity = (owner: Catalog['spaces'][number]): NonNullable<MobileObjectIdentity['mote']> => {
    const facts = catalog?.motePresentation?.find(value => value.spaceId === owner.spaceId)
    const main = facts?.quickMode.status === 'saved' ? facts.quickMode.defaults.conversation : undefined
    return { spaceId: owner.spaceId, name: owner.name, facts,
      conversationName: main ? catalog?.agentPresentation?.find(value => value.agentSessionId === main.sessionId)?.name : undefined,
      appearance: catalog?.appearance?.find(value => value.spaceId === owner.spaceId) }
  }
  const spaceIdentity = (owner: Catalog['spaces'][number]): MobileObjectIdentity => ({ name: owner.name, project: owner.name,
    ...(owner.kind === 'mote' ? { mote: moteIdentity(owner) } : {}) })
  const identity = (session: AgentMuxAgentSession, occurrence?: AgentMuxSpaceAddress | null): MobileObjectIdentity => {
    const candidates = locations(session.agentSessionId)
    const context = occurrence === null ? undefined : occurrence ?? (candidates.length === 1 ? candidates[0] : undefined)
    const owner = context?.spaceId ? spaces.find(owner => owner.spaceId === context.spaceId) : undefined
    const row = catalog?.agentPresentation?.find(value => value.agentSessionId === session.agentSessionId)
    return { name: row?.name ?? '名称未确认', project: row?.project ?? owner?.name ?? '项目未确认',
      ...(context ? { context } : {}), ...(owner?.kind === 'mote' ? { mote: moteIdentity(owner) } : {}) }
  }
  const name = (session: AgentMuxAgentSession) => identity(session).name
  const agentCount = (id: string) => {
    const zones = new Set(catalog?.bindings.filter(binding => binding.spaceId === id).map(binding => binding.zoneId))
    const regionIds = new Set(catalog?.tabs.filter(tab => tab.zoneId !== null && zones.has(tab.zoneId)).flatMap(tab => tab.regionIds))
    return new Set(catalog?.regions.filter(region => regionIds.has(region.regionId) && region.agentSessionId).map(region => region.agentSessionId)).size
  }
  const sessionRow = (session: AgentMuxAgentSession, key = session.agentSessionId, context?: AgentMuxSpaceAddress | null) => {
    const object = identity(session, context), row = catalog?.agentPresentation?.find(value => value.agentSessionId === session.agentSessionId), status = row?.state ?? 'unknown'
    const candidates = context === undefined ? locations(session.agentSessionId) : []
    return <li key={key}><button onClick={() => openSession(session.agentSessionId, object)}>
      <span className="mobile-executor-avatar">{row?.avatar?.tint ? <AgentEnamelFilter id={`${avatarFilterId}-${session.agentSessionId}`} tint={row.avatar.tint} className="mobile-executor-mark"><AgentProviderIcon providerId={session.providerId} size={22} /></AgentEnamelFilter> : <AgentProviderIcon providerId={session.providerId} size={22} />}{row?.avatar?.badge && ['spark', 'bolt', 'shield', 'flame'].includes(row.avatar.badge) && <small aria-label={row.avatar.badge}><AgentAvatarBadgeIcon badge={row.avatar.badge as AgentAvatarBadge} size={8} /></small>}</span>
      <span className="mobile-session-copy"><span className="mobile-session-project">{object.project}</span><strong>{object.name}</strong>{row && <small className="mobile-session-recap" title={row.recap ? `${row.recap.source} · ${row.recap.text}` : row.detail}>{row.recap?.text ?? '暂无已确认摘要'}</small>}{context && <small className="mobile-session-location" title={`${context.displayWorkspaceId} / ${context.groupId}`}>{context.displayWorkspaceId} · {context.groupId}</small>}</span>
      <span className="mobile-session-state" data-state={status}><span>{{ working: '执行中', waiting: '等待输入', blocked: '需要处理', done: '已完成', error: '出错', exited: '已结束', starting: '启动中', running: '状态未确认', disconnected: '断开' }[status] ?? '状态未确认'}</span><small>{session.providerId}</small></span>
    </button>{candidates.length > 1 && <details className="mobile-session-locations"><summary>{candidates.length} 个原展示位置</summary>{candidates.map(place => <button type="button" key={JSON.stringify(place)} onClick={() => openSession(session.agentSessionId, identity(session, place))}>
      {spaces.find(value => value.spaceId === place.spaceId)?.name ?? 'Space 未确认'} · {catalog?.tabs.find(value => value.tabId === place.tabId)?.name ?? 'Tab'} · {place.displayWorkspaceId} / {place.groupId}
    </button>)}</details>}</li>
  }
  const rows = catalog?.agentPresentation ?? []
  const presentationIssues = [...new Set([...(catalog?.spaces.map(value => value.issue) ?? []), ...(catalog?.appearance?.map(value => value.issue) ?? [])].filter(Boolean))]
  const visibleSpaces = spaces.filter(item => home === 'mote' ? item.kind === 'mote' : item.kind !== 'mote').filter(item => matching(item.name))
  const zoneIds = new Set(catalog?.bindings.filter(binding => binding.spaceId === spaceId).map(binding => binding.zoneId))
  const tabs = catalog?.tabs.filter(tab => tab.zoneId !== null && zoneIds.has(tab.zoneId)) ?? []
  const filteredSessions = (values: AgentMuxAgentSession[]) => values.filter(session => matching(name(session) + ' ' + identity(session).project + ' ' + session.providerId))
  return <section className="mobile-spatial-panel">
    <div className="mobile-section-heading"><div><h1>{home === 'mote' ? 'Mote' : home === 'focus' ? 'Focus' : 'Space'}</h1>
      <p>{home === 'mote' ? '与你的协调 Agent 继续讨论' : home === 'focus' ? '需要你处理的事项与最近执行' : '按 Mac 上的工作空间继续'}</p></div>
      <button className="mobile-icon-button" aria-label="刷新空间目录" onClick={() => refresh(value => value + 1)}><RefreshCw size={18} className={pending ? 'is-refreshing' : ''} /></button></div>
    {!connected && <p className="mobile-spatial-notice" role="status">连接暂不可用，原工作面与最近目录保留。</p>}
    {issue && <p className="mobile-spatial-notice" role="status">{issue}</p>}
    {presentationIssues.map(value => <p key={value} className="mobile-spatial-notice" role="status">{value} 原目录与工作面保留。<button type="button" onClick={() => refresh(count => count + 1)}>刷新原呈现</button></p>)}
    <label className="mobile-spatial-search"><Search size={16} /><TextInput value={query} onChange={event => setQuery(event.target.value)} placeholder={home === 'focus' ? '查找 Agent 或工作空间' : '查找工作空间'} aria-label="查找" /></label>
    {home === 'focus' ? <>
      {(['attention', 'working', 'results', 'idle', 'disconnected'] as const).map(group => {
        const values = rows.filter(row => row.group === group).flatMap(row => { const session = sessionById.get(row.agentSessionId); return session ? [session] : [] })
        const matchingValues = filteredSessions(values)
        if (!matchingValues.length) return null
        return <section key={group}><h2 className="mobile-spatial-subheading">{{ attention: '需要处理', working: '正在执行', results: '结果', idle: '空闲 / 未知', disconnected: '断开' }[group]} <span>{matchingValues.length}</span></h2><ul className="mobile-session-list">{matchingValues.map(session => sessionRow(session))}</ul></section>
      })}
      {!rows.length && <p className="mobile-spatial-empty">Focus 呈现尚未确认；原会话保留。</p>}
      {catalog?.agentPresentation === undefined && sessions.length > 0 && <details><summary>其他已有会话</summary><ul className="mobile-session-list">{filteredSessions(sessions.filter(session => !rows.some(row => row.agentSessionId === session.agentSessionId))).map(session => sessionRow(session))}</ul></details>}
    </> : space ? <>
      <button className="mobile-text-button" onClick={backToDirectory}><ArrowLeft size={16} />{home === 'mote' ? '所有 Mote' : '所有 Space'}</button>
      <h2 className="mobile-spatial-subheading">{space.name}</h2>
      {space.kind === 'mote' && <>
        {catalog?.motePresentation?.find(value => value.spaceId === space.spaceId)?.issue && <p className="mobile-spatial-notice" role="status">{catalog.motePresentation.find(value => value.spaceId === space.spaceId)!.issue}</p>}
        {openProfile && <button type="button" className="mobile-text-button" onClick={() => openProfile(spaceIdentity(space))}>查看 Mote 资料</button>}
      </>}
      {tabs.map(tab => <section className="mobile-spatial-tab" key={tab.tabId}><h3>{tab.name || '未命名 Tab'}</h3>
        <ul className="mobile-session-list">{tab.regionIds.map(id => catalog?.regions.find(region => region.regionId === id)).filter(region => region !== undefined).map(region => {
          const session = region.agentSessionId ? sessionById.get(region.agentSessionId) : undefined
          const occurrences = catalog?.locations.filter(value => value.spaceId === space.spaceId && value.tabId === tab.tabId && value.regionId === region.regionId) ?? []
          return session ? occurrences.length ? occurrences.map(place => sessionRow(session, JSON.stringify(place), place)) : sessionRow(session, region.regionId, null)
            : <li key={region.regionId}><div className="mobile-spatial-resource"><Layers size={18} /><span>{region.kind === 'launcher' ? 'Launcher' : region.kind}<small>{region.agentSessionId ? '会话状态尚未核实' : '此内容在 Mac 上查看'}</small></span></div></li>
        })}</ul></section>)}
      {!tabs.length && <p className="mobile-spatial-empty">此空间暂无已绑定 Tab。原空间和资料仍保留。</p>}
    </> : <>
      <ul className="mobile-session-list">{visibleSpaces.map(item => <li key={item.spaceId}><button onClick={() => {
        const main = catalog?.motePresentation?.find(value => value.spaceId === item.spaceId)?.conversation
        const occurrence = main ? catalog?.locations.filter(value => value.spaceId === item.spaceId &&
          value.displayWorkspaceId === main.displayWorkspaceId && value.groupId === main.groupId && value.tabId === main.tabId && value.regionId === main.regionId) : []
        const session = main ? sessionById.get(main.sessionId) : undefined
        if (home === 'mote' && main && session?.hostId === main.hostId && occurrence?.length === 1) openSession(main.sessionId, { ...spaceIdentity(item), context: occurrence[0]! })
        else setSpaceId(item.spaceId)
      }}>
        <MobileIdentity identity={spaceIdentity(item)} client={client} connected={connected} visible={visible} size={home === 'mote' ? 44 : 32} />
        <span><strong>{item.name}</strong><small>{item.kind === 'mote' ? '协调 Agent' : item.kind === 'folder' ? 'Folder' : item.kind === 'topic' ? 'Topic' : 'Space'} · {agentCount(item.spaceId)} Agent</small></span><ChevronRight size={16} /></button></li>)}</ul>
      {!visibleSpaces.length && <p className="mobile-spatial-empty">{pending && !catalog ? '正在读取 Mac 上的空间…' : query ? '没有匹配的空间。' : catalog ? `暂无 ${home === 'mote' ? 'Mote' : 'Space'}。可在 Mac 上管理。` : '空间目录尚未核实，可在 Focus 中继续原会话。'}</p>}
    </>}
  </section>
}
