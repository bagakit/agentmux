import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentMuxRpcResult } from '@agentmux/core'
import type { AgentMuxSpaceAddress } from '@agentmux/core/control'
import type { OpenHttpLink } from '@agentmux/client-ui/components/AgentMarkdown'
import { AgentAvatarBadgeIcon, type AgentAvatarBadge } from '@agentmux/client-ui/components/AgentAvatarBadgeIcon'
import { AgentEnamelFilter } from '@agentmux/client-ui/components/AgentEnamelFilter'
import { AgentProviderIcon } from '@agentmux/client-ui/components/AgentProviderIcon'
import { MobileIdentity, type MobileObjectIdentity } from './MobileIdentity'
import { MobileRegionContent } from './MobileRegionContent'
import type { MobileHome } from './home-preference'

type Catalog = AgentMuxRpcResult<'space.ls'>['catalog']
export type MobileSpatialContext = { spaceId: string | null; tabId: string | null; regionId: string | null }
export type MobileSpatialNavigationProps = { home: MobileHome; client: AgentMuxHostedClient | null; connected: boolean;
  visible?: boolean; sessions: AgentMuxAgentSession[]; openSession(id: string, identity: MobileObjectIdentity): void; openProfile?(identity: MobileObjectIdentity): void;
  openHttpLink?: OpenHttpLink; initialContext?: MobileSpatialContext; onContextChange?(context: MobileSpatialContext): void;
  onBackChange?(back: (() => void) | null): void }
type Region = Catalog['regions'][number]
type ContentTarget = { key: string; spaceId: string; spaceName: string; tabName: string; tabId: string; zoneId: string | null; region: Region; zone?: Catalog['zones'][number] }
const EMPTY_CONTEXT: MobileSpatialContext = { spaceId: null, tabId: null, regionId: null }
const contentKey = (spaceId: string, zoneId: string | null, region: Region) => JSON.stringify([spaceId, zoneId, region.tabId, region.regionId, region.kind, region.browserId ?? null, region.file ?? null])
export function MobileSpatialNavigation({ home, client, connected, sessions, openSession, openProfile, openHttpLink, initialContext, onContextChange, onBackChange, visible = true }: MobileSpatialNavigationProps) {
  const avatarFilterId = useId().replace(/:/g, '')
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [issue, setIssue] = useState('')
  const [pending, setPending] = useState(false)
  const [query, setQuery] = useState('')
  const [spaceContext, setSpaceContext] = useState<MobileSpatialContext>(initialContext ?? EMPTY_CONTEXT)
  const [moteContext, setMoteContext] = useState<MobileSpatialContext>(EMPTY_CONTEXT)
  const [visited, setVisited] = useState<ContentTarget[]>([])
  const [spaceSelectedKey, setSpaceSelectedKey] = useState<string | null>(null), [moteSelectedKey, setMoteSelectedKey] = useState<string | null>(null)
  const context = home === 'space' ? spaceContext : home === 'mote' ? moteContext : EMPTY_CONTEXT
  const selectedKey = home === 'space' ? spaceSelectedKey : home === 'mote' ? moteSelectedKey : null
  const setContext = useCallback((value: MobileSpatialContext | ((previous: MobileSpatialContext) => MobileSpatialContext)) => {
    if (home === 'mote') setMoteContext(value)
    else if (home === 'space') setSpaceContext(value)
  }, [home])
  const setSelectedKey = useCallback((value: string | null) => {
    if (home === 'mote') setMoteSelectedKey(value)
    else if (home === 'space') setSpaceSelectedKey(value)
  }, [home])
  const { spaceId } = context
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
  const previousHome = useRef(home), incoming = JSON.stringify(initialContext ?? null), previousIncoming = useRef(incoming)
  useEffect(() => {
    if (previousHome.current === home) return
    previousHome.current = home; setQuery('')
  }, [home])
  useEffect(() => {
    if (previousIncoming.current === incoming) return
    previousIncoming.current = incoming
    if (initialContext && JSON.stringify(spaceContext) !== incoming) { setSpaceContext(initialContext); setSpaceSelectedKey(null) }
  }, [incoming, initialContext, spaceContext])
  useEffect(() => { onContextChange?.(spaceContext) }, [spaceContext, onContextChange])
  const backToDirectory = useCallback(() => { setContext(EMPTY_CONTEXT); setSelectedKey(null) }, [setContext, setSelectedKey])
  const backToSpace = useCallback(() => { setContext(value => ({ spaceId: value.spaceId, tabId: null, regionId: null })); setSelectedKey(null) }, [setContext, setSelectedKey])
  const activeBack = home !== 'focus' && spaceId ? context.regionId ? backToSpace : backToDirectory : null
  useLayoutEffect(() => {
    if (!visible || !onBackChange) return
    onBackChange(activeBack)
    return () => onBackChange(null)
  }, [visible, onBackChange, activeBack])
  const sessionById = new Map(sessions.map(session => [session.agentSessionId, session]))
  const spaces = catalog?.spaces ?? []
  const matchingSpaces = spaces.filter(item => item.spaceId === spaceId)
  const space = matchingSpaces.length === 1 ? matchingSpaces[0] : undefined
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
  const openContent = (owner: Catalog['spaces'][number], tab: Catalog['tabs'][number], region: Region) => {
    const key = contentKey(owner.spaceId, tab.zoneId, region), zones = catalog?.zones.filter(zone => zone.zoneId === tab.zoneId) ?? []
    setVisited(values => values.some(value => value.key === key) ? values : [...values, { key, spaceId: owner.spaceId, spaceName: owner.name,
      tabId: tab.tabId, tabName: tab.name || '原标签', zoneId: tab.zoneId, region: { ...region, ...(region.file ? { file: { ...region.file } } : {}) },
      ...(zones.length === 1 ? { zone: { ...zones[0]! } } : {}) }])
    setSelectedKey(key); setContext({ spaceId: owner.spaceId, tabId: tab.tabId, regionId: region.regionId })
  }
  useEffect(() => {
    if (!visible || home === 'focus' || selectedKey || !space || !context.tabId || !context.regionId) return
    const matchingTabs = tabs.filter(tab => tab.tabId === context.tabId && tab.regionIds.includes(context.regionId!))
    const regions = catalog?.regions.filter(region => region.tabId === context.tabId && region.regionId === context.regionId) ?? []
    if (matchingTabs.length === 1 && regions.length === 1 && ['file', 'browser'].includes(regions[0]!.kind)) openContent(space, matchingTabs[0]!, regions[0]!)
  }, [catalog, context.spaceId, context.tabId, context.regionId, selectedKey, visible, home])
  const selected = visited.find(value => value.key === selectedKey)
  const current = catalog?.regions.find(value => value.tabId === context.tabId && value.regionId === context.regionId)
  const currentZone = catalog?.zones.find(value => value.zoneId === selected?.zoneId)
  const selectionChanged = Boolean(selected && (!space || !current || contentKey(selected.spaceId, selected.zoneId, current) !== selected.key
    || !tabs.some(tab => tab.tabId === selected.tabId && tab.zoneId === selected.zoneId && tab.regionIds.includes(selected.region.regionId))
    || selected.zone && (!currentZone || currentZone.hostId !== selected.zone.hostId || currentZone.workspaceId !== selected.zone.workspaceId || currentZone.directoryPath !== selected.zone.directoryPath)))
  const filteredSessions = (values: AgentMuxAgentSession[]) => values.filter(session => matching(name(session) + ' ' + identity(session).project + ' ' + session.providerId))
  return <section className="mobile-spatial-panel">
    <div className="mobile-section-heading"><div><h1>{home === 'mote' ? 'Mote' : home === 'focus' ? 'Focus' : 'Space'}</h1>
      <p>{home === 'mote' ? '与你的协调 Agent 继续讨论' : home === 'focus' ? '需要你处理的事项与最近执行' : '按 Mac 上的工作空间继续'}</p></div>
      <button className="mobile-icon-button" aria-label="刷新空间目录" onClick={() => refresh(value => value + 1)}><SemanticIcon name="action.refresh" size={18} className={pending ? 'is-refreshing' : ''} /></button></div>
    {!connected && <p className="mobile-spatial-notice" role="status">连接暂不可用，原工作面与最近目录保留。</p>}
    {issue && <p className="mobile-spatial-notice" role="status">{issue}</p>}
    {presentationIssues.map(value => <p key={value} className="mobile-spatial-notice" role="status">{value} 原目录与工作面保留。<button type="button" onClick={() => refresh(count => count + 1)}>刷新原呈现</button></p>)}
    <label className="mobile-spatial-search"><SemanticIcon name="action.search" size={16} /><TextInput value={query} onChange={event => setQuery(event.target.value)} placeholder={home === 'focus' ? '查找 Agent 或工作空间' : '查找工作空间'} aria-label="查找" /></label>
    {home === 'focus' ? <>
      {(['attention', 'working', 'results', 'idle', 'disconnected'] as const).map(group => {
        const values = rows.filter(row => row.group === group).flatMap(row => { const session = sessionById.get(row.agentSessionId); return session ? [session] : [] })
        const matchingValues = filteredSessions(values)
        if (!matchingValues.length) return null
        return <section key={group}><h2 className="mobile-spatial-subheading">{{ attention: '需要处理', working: '正在执行', results: '结果', idle: '空闲 / 未知', disconnected: '断开' }[group]} <span>{matchingValues.length}</span></h2><ul className="mobile-session-list">{matchingValues.map(session => sessionRow(session))}</ul></section>
      })}
      {!rows.length && <p className="mobile-spatial-empty">Focus 呈现尚未确认；原会话保留。</p>}
      {catalog?.agentPresentation === undefined && sessions.length > 0 && <details><summary>其他已有会话</summary><ul className="mobile-session-list">{filteredSessions(sessions.filter(session => !rows.some(row => row.agentSessionId === session.agentSessionId))).map(session => sessionRow(session))}</ul></details>}
    </> : context.regionId ? <>
      <button className="mobile-text-button" type="button" onClick={backToSpace}><SemanticIcon name="navigation.back" size={16} />返回空间内容</button>
      <h2 className="mobile-spatial-subheading">{selected?.region.kind === 'file' ? selected.region.file?.path.split('/').at(-1) ?? '原文件' : selected?.region.kind === 'browser' ? '原网页' : '原内容'}</h2>
      <p>{selected?.spaceName ?? space?.name ?? '原空间'} · {selected?.tabName ?? '原标签'}</p>
      {(selectionChanged || !selected) && <p role="status">原 Tab / Region 的当前绑定尚未重新确认；原引用、已有正文和草稿保留。可返回目录核对，不会改读别的内容。</p>}
      <details><summary>原工作面位置</summary><code>{context.spaceId} / {context.tabId} / {context.regionId}</code></details>
    </> : space ? <>
      <button className="mobile-text-button" onClick={backToDirectory}><SemanticIcon name="navigation.back" size={16} />{home === 'mote' ? '所有 Mote' : '所有 Space'}</button>
      <h2 className="mobile-spatial-subheading">{space.name}</h2>
      {space.kind === 'mote' && <>
        {catalog?.motePresentation?.find(value => value.spaceId === space.spaceId)?.issue && <p className="mobile-spatial-notice" role="status">{catalog.motePresentation.find(value => value.spaceId === space.spaceId)!.issue}</p>}
        {openProfile && <button type="button" className="mobile-text-button" onClick={() => openProfile(spaceIdentity(space))}>查看 Mote 资料</button>}
      </>}
      {tabs.map(tab => <section className="mobile-spatial-tab" key={tab.tabId}><h3>{tab.name || '未命名 Tab'}</h3>
        <ul className="mobile-session-list">{tab.regionIds.map(id => {
          const matches = catalog?.regions.filter(region => region.tabId === tab.tabId && region.regionId === id) ?? []
          return matches.length === 1 ? matches[0] : undefined
        }).filter(region => region !== undefined).map(region => {
          const session = region.agentSessionId ? sessionById.get(region.agentSessionId) : undefined
          const occurrences = catalog?.locations.filter(value => value.spaceId === space.spaceId && value.tabId === tab.tabId && value.regionId === region.regionId) ?? []
          return session ? occurrences.length ? occurrences.map(place => sessionRow(session, JSON.stringify(place), place)) : sessionRow(session, region.regionId, null)
            : <li key={region.regionId}>{['file', 'browser'].includes(region.kind) ? <button type="button" onClick={() => openContent(space, tab, region)}><SemanticIcon name="object.spaces" size={18} /><span><strong>{region.kind === 'file' ? region.file?.path.split('/').at(-1) ?? '文件名称未确认' : '查看原网页'}</strong><small>{region.kind === 'file' ? region.file?.path.endsWith('.note.json') ? '笔记' : '文件' : '网页'}</small></span><SemanticIcon name="navigation.disclosure" size={16} /></button>
              : <div className="mobile-spatial-resource"><SemanticIcon name="object.spaces" size={18} /><span>{region.kind === 'launcher' ? 'Launcher' : region.kind}<small>{region.agentSessionId ? '会话状态尚未核实' : '此内容在 Mac 上查看'}</small></span></div>}</li>
        })}</ul></section>)}
      {!tabs.length && <p className="mobile-spatial-empty">此空间暂无已绑定 Tab。原空间和资料仍保留。</p>}
    </> : spaceId ? <>
      <button className="mobile-text-button" type="button" onClick={backToDirectory}><SemanticIcon name="navigation.back" size={16} />{home === 'mote' ? '所有 Mote' : '所有 Space'}</button>
      <p role="status">原空间绑定尚未重新确认，原引用与工作面保留；可刷新原目录。</p>
    </> : <>
      <ul className="mobile-session-list">{visibleSpaces.map(item => <li key={item.spaceId}><button onClick={() => {
        const main = catalog?.motePresentation?.find(value => value.spaceId === item.spaceId)?.conversation
        const occurrence = main ? catalog?.locations.filter(value => value.spaceId === item.spaceId &&
          value.displayWorkspaceId === main.displayWorkspaceId && value.groupId === main.groupId && value.tabId === main.tabId && value.regionId === main.regionId) : []
        const session = main ? sessionById.get(main.sessionId) : undefined
        if (home === 'mote' && main && session?.hostId === main.hostId && occurrence?.length === 1) openSession(main.sessionId, { ...spaceIdentity(item), context: occurrence[0]! })
        else { setContext({ spaceId: item.spaceId, tabId: null, regionId: null }); setSelectedKey(null) }
      }}>
        <MobileIdentity identity={spaceIdentity(item)} client={client} connected={connected} visible={visible} size={home === 'mote' ? 44 : 32} />
        <span><strong>{item.name}</strong><small>{item.kind === 'mote' ? '协调 Agent' : item.kind === 'folder' ? 'Folder' : item.kind === 'topic' ? 'Topic' : 'Space'} · {agentCount(item.spaceId)} Agent</small></span><SemanticIcon name="navigation.disclosure" size={16} /></button></li>)}</ul>
      {!visibleSpaces.length && <p className="mobile-spatial-empty">{pending && !catalog ? '正在读取 Mac 上的空间…' : query ? '没有匹配的空间。' : catalog ? `暂无 ${home === 'mote' ? 'Mote' : 'Space'}。可在 Mac 上管理。` : '空间目录尚未核实，可在 Focus 中继续原会话。'}</p>}
    </>}
    {visited.map(target => <div key={target.key} hidden={home === 'focus' || target.key !== selectedKey || !context.regionId}>
      {(target.region.kind === 'file' || target.region.kind === 'browser') && <MobileRegionContent client={client} connected={connected} showTitle={false}
        visible={visible && home !== 'focus' && target.key === selectedKey && Boolean(context.regionId)} tabId={target.tabId} regionId={target.region.regionId} zoneId={target.zoneId}
        kind={target.region.kind} browserId={target.region.browserId} {...(target.region.file ? { file: target.region.file } : {})} {...(openHttpLink ? { openHttpLink } : {})} />}
    </div>)}
  </section>
}
