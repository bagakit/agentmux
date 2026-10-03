import { useEffect, useState } from 'react'
import { ArrowLeft, ChevronRight, Layers, MessageSquare, RefreshCw, Search } from 'lucide-react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentMuxRpcResult } from '@agentmux/core'
import { MoteMark } from './MoteMark'
import type { MobileHome } from './home-preference'

type Catalog = AgentMuxRpcResult<'space.ls'>['catalog']
type Props = { home: MobileHome; client: AgentMuxHostedClient | null; connected: boolean;
  sessions: AgentMuxAgentSession[]; openSession(id: string, name: string): void }
const statusLabels: Readonly<Record<string, string>> = { working: '执行中', waiting: '等待输入', blocked: '需要处理',
  done: '已完成', error: '出错', exited: '已结束', starting: '启动中', running: '运行中', disconnected: '状态未知' }
export function MobileSpatialNavigation({ home, client, connected, sessions, openSession }: Props) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [issue, setIssue] = useState('')
  const [pending, setPending] = useState(false)
  const [query, setQuery] = useState('')
  const [spaceId, setSpaceId] = useState<string | null>(null)
  const [revision, refresh] = useState(0)
  useEffect(() => {
    if (!client || !connected) return
    let disposed = false, inFlight = false
    const read = async () => {
      if (inFlight || document.visibilityState === 'hidden') return
      inFlight = true; setPending(true)
      try {
        if (!client.forwardRpc) throw new Error('空间目录暂不可读；已有会话仍可在 Focus 中访问。')
        const value = await client.forwardRpc('space.ls', { target: {} })
        if (!disposed) { setCatalog(value.catalog); setIssue('') }
      } catch (error) { if (!disposed) setIssue(error instanceof Error ? error.message : '空间目录暂不可读，原记录保留。') }
      finally { inFlight = false; if (!disposed) setPending(false) }
    }
    void read()
    const timer = setInterval(() => { void read() }, 10000)
    const foreground = () => { if (document.visibilityState === 'visible') void read() }
    document.addEventListener('visibilitychange', foreground)
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', foreground) }
  }, [client, connected, revision])
  useEffect(() => { setSpaceId(null); setQuery('') }, [home])
  const sessionById = new Map(sessions.map(session => [session.agentSessionId, session]))
  const spaces = catalog?.spaces ?? []
  const space = spaces.find(item => item.spaceId === spaceId)
  const matching = (value: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const locations = (id: string) => catalog?.locations.filter(location =>
    catalog.regions.some(region => region.regionId === location.regionId && region.agentSessionId === id)) ?? []
  const name = (session: AgentMuxAgentSession) => {
    const place = locations(session.agentSessionId)
    const tab = catalog?.tabs.find(tab => place.some(location => location.tabId === tab.tabId))
    const owner = spaces.find(owner => place.some(location => location.spaceId === owner.spaceId))
    return tab?.name || owner?.name || `${session.providerId} Agent`
  }
  const agentCount = (id: string) => {
    const zones = new Set(catalog?.bindings.filter(binding => binding.spaceId === id).map(binding => binding.zoneId))
    const regionIds = new Set(catalog?.tabs.filter(tab => tab.zoneId !== null && zones.has(tab.zoneId)).flatMap(tab => tab.regionIds))
    return new Set(catalog?.regions.filter(region => regionIds.has(region.regionId) && region.agentSessionId).map(region => region.agentSessionId)).size
  }
  const sessionRow = (session: AgentMuxAgentSession, key = session.agentSessionId) => <li key={key}><button onClick={() => openSession(session.agentSessionId, name(session))}>
    <span className="mobile-session-icon"><MessageSquare size={19} /></span><span><strong>{name(session)}</strong>
    <small>{session.providerId} · {session.pendingInteraction ? '需要回应' : statusLabels[session.semanticStatus?.state ?? ''] ?? '状态未知'}</small></span><ChevronRight size={16} /></button></li>
  const active = sessions.filter(session => session.pendingInteraction || ['working', 'running', 'starting', 'blocked', 'waiting', 'error'].includes(session.semanticStatus?.state ?? ''))
  const attention = active.filter(session => session.pendingInteraction || ['blocked', 'waiting', 'error'].includes(session.semanticStatus?.state ?? ''))
  const recent = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  const visibleSpaces = spaces.filter(item => home === 'mote' ? item.kind === 'mote' : item.kind !== 'mote').filter(item => matching(item.name))
  const zoneIds = new Set(catalog?.bindings.filter(binding => binding.spaceId === spaceId).map(binding => binding.zoneId))
  const tabs = catalog?.tabs.filter(tab => tab.zoneId !== null && zoneIds.has(tab.zoneId)) ?? []
  const filteredSessions = (values: AgentMuxAgentSession[]) => values.filter(session => matching(name(session) + ' ' + session.providerId))
  return <section className="mobile-spatial-panel">
    <div className="mobile-section-heading"><div><h1>{home === 'mote' ? 'Mote' : home === 'focus' ? 'Focus' : 'Space'}</h1>
      <p>{home === 'mote' ? '与你的协调 Agent 继续讨论' : home === 'focus' ? '需要你处理的事项与最近执行' : '按 Mac 上的工作空间继续'}</p></div>
      <button className="mobile-icon-button" aria-label="刷新空间目录" onClick={() => refresh(value => value + 1)}><RefreshCw size={18} className={pending ? 'is-refreshing' : ''} /></button></div>
    {!connected && <p className="mobile-spatial-notice" role="status">连接暂不可用，原工作面与最近目录保留。</p>}
    {issue && <p className="mobile-spatial-notice" role="status">{issue}</p>}
    <label className="mobile-spatial-search"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={home === 'focus' ? '查找 Agent 或工作空间' : '查找工作空间'} aria-label="查找" /></label>
    {home === 'focus' ? <>
      <h2 className="mobile-spatial-subheading">需要处理 <span>{attention.length}</span></h2>
      {filteredSessions(attention).length ? <ul className="mobile-session-list">{filteredSessions(attention).map(session => sessionRow(session))}</ul> : <p className="mobile-spatial-empty">{connected ? '当前没有已确认的待处理事项。' : '待处理状态尚未核实。'}</p>}
      <h2 className="mobile-spatial-subheading">正在执行 <span>{active.filter(session => !attention.includes(session)).length}</span></h2>
      <ul className="mobile-session-list">{filteredSessions(active.filter(session => !attention.includes(session))).map(session => sessionRow(session))}</ul>
      <details className="mobile-spatial-recent"><summary>最近会话 · {sessions.length}</summary><ul className="mobile-session-list">{filteredSessions(recent).map(session => sessionRow(session))}</ul></details>
    </> : space ? <>
      <button className="mobile-text-button" onClick={() => setSpaceId(null)}><ArrowLeft size={16} />{home === 'mote' ? '所有 Mote' : '所有 Space'}</button>
      <h2 className="mobile-spatial-subheading">{space.name}</h2>
      {tabs.map(tab => <section className="mobile-spatial-tab" key={tab.tabId}><h3>{tab.name || '未命名 Tab'}</h3>
        <ul className="mobile-session-list">{tab.regionIds.map(id => catalog?.regions.find(region => region.regionId === id)).filter(region => region !== undefined).map(region => {
          const session = region.agentSessionId ? sessionById.get(region.agentSessionId) : undefined
          return session ? sessionRow(session, region.regionId) : <li key={region.regionId}><div className="mobile-spatial-resource"><Layers size={18} /><span>{region.kind === 'launcher' ? 'Launcher' : region.kind}<small>{region.agentSessionId ? '会话状态尚未核实' : '此内容在 Mac 上查看'}</small></span></div></li>
        })}</ul></section>)}
      {!tabs.length && <p className="mobile-spatial-empty">此空间暂无已绑定 Tab。原空间和资料仍保留。</p>}
    </> : <>
      <ul className="mobile-session-list">{visibleSpaces.map(item => <li key={item.spaceId}><button onClick={() => setSpaceId(item.spaceId)}>
        <span className="mobile-session-icon">{home === 'mote' ? <MoteMark size={19} /> : <Layers size={19} />}</span>
        <span><strong>{item.name}</strong><small>{item.kind === 'mote' ? '协调 Agent' : item.kind === 'folder' ? 'Folder' : item.kind === 'topic' ? 'Topic' : 'Space'} · {agentCount(item.spaceId)} Agent</small></span><ChevronRight size={16} /></button></li>)}</ul>
      {!visibleSpaces.length && <p className="mobile-spatial-empty">{pending && !catalog ? '正在读取 Mac 上的空间…' : query ? '没有匹配的空间。' : catalog ? `暂无 ${home === 'mote' ? 'Mote' : 'Space'}。可在 Mac 上管理。` : '空间目录尚未核实，可在 Focus 中继续原会话。'}</p>}
    </>}
  </section>
}
