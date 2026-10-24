import type { MobileAgentCreateTarget } from './MobileAgentCreate'
import { MobileNotice, MobileNoticeScope } from '../notices/MobileNotice'
import { NOTE_FILE_EXTENSION } from '@agentmux/client-ui/note/note-format'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TextInput } from '@agentmux/client-ui/input'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxAgentSession, AgentMuxRpcResult } from '@agentmux/core'
import type { AgentMuxSpaceAddress } from '@agentmux/core/control'
import type { OpenHttpLink } from '@agentmux/client-ui/components/AgentMarkdown'
import { AgentAvatarFace } from '@agentmux/client-ui/components/AgentAvatarFace'
import '@agentmux/client-ui/styles/agent-avatar-face.css'
import { FocusStateMark } from '@agentmux/client-ui/components/FocusStateMark'
import { MobileIdentity, type MobileObjectIdentity } from './MobileIdentity'
import { MobileRegionContent } from './MobileRegionContent'
import type { MobileHome } from './home-preference'
import { MobileSpaceDirectory } from './MobileSpaceDirectory'
import { MobileDirectoryNotice } from './MobileDirectoryNotice'
import { MobileAgentRow } from './MobileAgentRow'
import { useMobileWebCatalogObservation } from '../mobile-web/use-mobile-web-observation'
import './navigation.css'

type Catalog = AgentMuxRpcResult<'space.ls'>['catalog']
export type MobileSpatialContext = { spaceId: string | null; tabId: string | null; regionId: string | null }
export type MobileSpatialNavigationProps = { home: MobileHome; client: AgentMuxHostedClient | null; connected: boolean;
  recentMoteSpaceId?: string | null; onSelectMote?(spaceId: string): void;
  openMainAgent?(id: string, identity: MobileObjectIdentity, hostId: string): void;
  visible?: boolean; sessions?: AgentMuxAgentSession[]; openSession(id: string, identity: MobileObjectIdentity): void; openProfile?(identity: MobileObjectIdentity): void;
  openHttpLink?: OpenHttpLink; initialContext?: MobileSpatialContext; onContextChange?(context: MobileSpatialContext): void;
  onCreateAgent?(target: MobileAgentCreateTarget): void; onBackChange?(back: (() => void) | null): void }
type Region = Catalog['regions'][number]
/** A discovered SID is navigable even before the SDK has hydrated its metadata. */
type SessionReference = Pick<AgentMuxAgentSession, 'agentSessionId'> & Partial<Pick<AgentMuxAgentSession, 'providerId'>>
type ContentTarget = { key: string; spaceId: string; spaceName: string; tabName: string; tabId: string; zoneId: string | null; region: Region; zone?: Catalog['zones'][number] }
const EMPTY_CONTEXT: MobileSpatialContext = { spaceId: null, tabId: null, regionId: null }
const contentKey = (spaceId: string, zoneId: string | null, region: Region) => JSON.stringify([spaceId, zoneId, region.tabId, region.regionId, region.kind, region.browserId ?? null, region.file ?? null])
export const MobileSpatialNavigation = memo(function MobileSpatialNavigation({ home, client, connected, sessions, openSession, openMainAgent, openProfile, openHttpLink, initialContext, onContextChange, onBackChange, onCreateAgent, recentMoteSpaceId, onSelectMote, visible = true }: MobileSpatialNavigationProps) {
  const observeCatalog = useMobileWebCatalogObservation()
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [issue, setIssue] = useState('')
  const [pending, setPending] = useState(false)
  const [query, setQuery] = useState('')
  const [spaceContext, setSpaceContext] = useState<MobileSpatialContext>(initialContext ?? EMPTY_CONTEXT)
  const [moteContext, setMoteContext] = useState<MobileSpatialContext>({ ...EMPTY_CONTEXT, spaceId: recentMoteSpaceId ?? null })
  useEffect(() => { if (recentMoteSpaceId) setMoteContext(value => value.spaceId === recentMoteSpaceId ? value : { ...EMPTY_CONTEXT, spaceId: recentMoteSpaceId }) }, [recentMoteSpaceId])
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
      let observed: Catalog | null = null
      try {
        if (!client.forwardRpc) throw new Error('空间目录暂不可读；已有会话仍可在 Focus 中访问。')
        const value = await client.forwardRpc('space.ls', { target: {}, presentation: true })
        if (!disposed) { setCatalog(value.catalog); setIssue(''); observed = value.catalog }
      } catch (error) { if (!disposed) setIssue(error instanceof Error ? error.message : '空间目录暂不可读，原记录保留。') }
      finally { inFlight = false; if (!disposed) setPending(false) }
      if (observed) observeCatalog?.(observed)
    }
    void read()
    const timer = setInterval(() => { void read() }, 10000)
    const foreground = () => { if (document.visibilityState === 'visible') void read() }
    document.addEventListener('visibilitychange', foreground)
    return () => { disposed = true; setPending(false); clearInterval(timer); document.removeEventListener('visibilitychange', foreground) }
  }, [client, connected, visible, revision, observeCatalog])
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
  const activeBack = spaceId && context.regionId ? backToSpace : home === 'space' && spaceId ? backToDirectory : null
  useLayoutEffect(() => {
    if (!visible || !onBackChange) return
    onBackChange(activeBack)
    return () => onBackChange(null)
  }, [visible, onBackChange, activeBack])
  const [metadataRevision, refreshMetadata] = useState(0)
  const missingMetadata = useMemo(() => catalog?.agentPresentation === undefined ? null : new Set(catalog.agentPresentation.filter(row => !row.providerId).map(row => row.agentSessionId)), [catalog])
  const memberReferences = useMemo(() => new Map<string, SessionReference>(), [client, catalog])
  const metadataScope = missingMetadata === null ? '*' : JSON.stringify([...missingMetadata])
  const needsMetadataDirectory = visible && home === 'focus' && (missingMetadata === null || missingMetadata.size > 0) && sessions === undefined
  const metadataEpoch = useRef(0)
  useEffect(() => {
    if (sessions !== undefined) return
    return client?.onEvent(event => {
      if (event.type === 'agent-session' && (missingMetadata === null || missingMetadata.has(event.session.agentSessionId) || memberReferences.has(event.session.agentSessionId)) ||
        event.type === 'run-removed' && (!event.agentSessionId || missingMetadata === null || missingMetadata.has(event.agentSessionId) || memberReferences.has(event.agentSessionId)) || event.type === 'connection-state') {
        metadataEpoch.current += 1
        const memberChanged = event.type === 'agent-session' ? memberReferences.delete(event.session.agentSessionId)
          : event.type === 'run-removed' && event.agentSessionId ? memberReferences.delete(event.agentSessionId)
            : memberReferences.size > 0
        if (event.type === 'connection-state' || event.type === 'run-removed' && !event.agentSessionId) memberReferences.clear()
        if (needsMetadataDirectory || visible && home !== 'focus' && memberChanged) refreshMetadata(value => value + 1)
      }
    })
  }, [client, sessions, missingMetadata, needsMetadataDirectory, memberReferences, visible, home])
  const retainedMetadata = useRef<{ client: typeof client; epoch: number; scope: string; revision: number; value: { sessions: AgentMuxAgentSession[]; issue: string } } | null>(null)
  const metadata = useMemo(() => {
    if (sessions !== undefined) return { sessions, issue: '' }
    const previous = retainedMetadata.current && retainedMetadata.current.client === client ? retainedMetadata.current.value : { sessions: [], issue: '' }
    if (!needsMetadataDirectory) return previous
    if (retainedMetadata.current && retainedMetadata.current.client === client && retainedMetadata.current.epoch === metadataEpoch.current && retainedMetadata.current.scope === metadataScope && retainedMetadata.current.revision === revision) return previous
    let value
    try { value = { sessions: client?.agentSessions() ?? [], issue: '' } }
    catch { value = { sessions: previous.sessions, issue: '原会话元信息目录暂不可读；原空间与已有会话引用保留，可刷新核对。' } }
    retainedMetadata.current = { client, epoch: metadataEpoch.current, scope: metadataScope, revision, value }
    return value
  }, [client, sessions, needsMetadataDirectory, metadataRevision, metadataScope, revision])
  const sessionById = useMemo(() => new Map(metadata.sessions.map(session => [session.agentSessionId, session])), [metadata.sessions])
  const spaces = catalog?.spaces ?? []
  const directory = useMemo(() => {
    const rows = new Map<string, NonNullable<Catalog['agentPresentation']>[number]>()
    const owners = new Map<string, Catalog['spaces'][number]>()
    const motes = new Map<string, NonNullable<Catalog['motePresentation']>[number]>()
    const appearances = new Map<string, NonNullable<Catalog['appearance']>[number]>()
    const zonesByOwner = new Map<string, Set<string>>()
    const ownersByZone = new Map<string, Set<string>>()
    const tabsByOwner = new Map<string, Catalog['tabs']>()
    const tabsById = new Map<string, Catalog['tabs'][number]>()
    const regionsByTab = new Map<string, Region[]>()
    const bindings = new Map<string, Set<string>>()
    const places = new Map<string, AgentMuxSpaceAddress[]>()
    const occurrences = new Map<string, AgentMuxSpaceAddress[]>()
    for (const row of catalog?.agentPresentation ?? []) if (!rows.has(row.agentSessionId)) rows.set(row.agentSessionId, row)
    for (const owner of catalog?.spaces ?? []) if (!owners.has(owner.spaceId)) owners.set(owner.spaceId, owner)
    for (const mote of catalog?.motePresentation ?? []) if (!motes.has(mote.spaceId)) motes.set(mote.spaceId, mote)
    for (const appearance of catalog?.appearance ?? []) if (!appearances.has(appearance.spaceId)) appearances.set(appearance.spaceId, appearance)
    for (const binding of catalog?.bindings ?? []) {
      const zones = zonesByOwner.get(binding.spaceId) ?? new Set<string>(); zones.add(binding.zoneId); zonesByOwner.set(binding.spaceId, zones)
      const spaces = ownersByZone.get(binding.zoneId) ?? new Set<string>(); spaces.add(binding.spaceId); ownersByZone.set(binding.zoneId, spaces)
    }
    for (const tab of catalog?.tabs ?? []) {
      if (!tabsById.has(tab.tabId)) tabsById.set(tab.tabId, tab)
      if (tab.zoneId !== null) for (const owner of ownersByZone.get(tab.zoneId) ?? []) {
        const values = tabsByOwner.get(owner) ?? []; values.push(tab); tabsByOwner.set(owner, values)
      }
    }
    for (const region of catalog?.regions ?? []) {
      const values = regionsByTab.get(region.tabId) ?? []; values.push(region); regionsByTab.set(region.tabId, values)
    }
    for (const region of catalog?.regions ?? []) if (region.agentSessionId) {
      const key = JSON.stringify([region.tabId, region.regionId]), ids = bindings.get(key) ?? new Set<string>()
      ids.add(region.agentSessionId); bindings.set(key, ids)
    }
    for (const location of catalog?.locations ?? []) {
      const key = JSON.stringify([location.spaceId, location.tabId, location.regionId]), addresses = occurrences.get(key) ?? []
      addresses.push(location); occurrences.set(key, addresses)
      for (const id of bindings.get(JSON.stringify([location.tabId, location.regionId])) ?? []) {
        const values = places.get(id) ?? []; values.push(location); places.set(id, values)
      }
    }
    const issues = (catalog?.spaces ?? []).flatMap(owner => {
      const tabIssues = owner.kind === 'mote' ? (tabsByOwner.get(owner.spaceId) ?? []).map(tab => tab.issue) : []
      return [...new Set([owner.issue, motes.get(owner.spaceId)?.issue, appearances.get(owner.spaceId)?.issue, ...tabIssues].filter((value): value is string => Boolean(value)))].map(message => ({ source: owner.name, message, kind: owner.kind }))
    })
    return { rows, owners, motes, appearances, zonesByOwner, tabsByOwner, tabsById, regionsByTab, places, occurrences, issues }
  }, [catalog])
  const reference = (id: string): SessionReference => {
    const known = sessionById.get(id), row = directory.rows.get(id)
    if (sessions !== undefined && known) return known
    if (row?.providerId) return { agentSessionId: id, providerId: row.providerId }
    if (home !== 'focus') {
      const previous = memberReferences.get(id)
      if (previous) return previous
      if (visible && client) {
        let value: SessionReference = { agentSessionId: id, ...(known?.providerId ? { providerId: known.providerId } : {}) }
        try {
          const member = client.agentSession(id)
          if (member.agentSessionId === id) value = { agentSessionId: id, providerId: member.providerId }
        } catch { /* Missing metadata keeps the original spatial reference navigable. */ }
        memberReferences.set(id, value)
        return value
      }
    }
    if (known) return known
    return { agentSessionId: id }
  }
  const matchingSpaces = spaces.filter(item => item.spaceId === spaceId)
  const space = matchingSpaces.length === 1 ? matchingSpaces[0] : undefined
  const matching = (value: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const locations = (id: string) => directory.places.get(id) ?? []
  const moteIdentity = (owner: Catalog['spaces'][number]): NonNullable<MobileObjectIdentity['mote']> => {
    const facts = directory.motes.get(owner.spaceId)
    const main = facts?.quickMode.status === 'saved' ? facts.quickMode.defaults.conversation : undefined
    return { spaceId: owner.spaceId, name: owner.name, facts,
      conversationName: main ? directory.rows.get(main.sessionId)?.name : undefined,
      appearance: directory.appearances.get(owner.spaceId) }
  }
  const spaceIdentity = (owner: Catalog['spaces'][number]): MobileObjectIdentity => ({ name: owner.name, project: owner.name,
    ...(owner.kind === 'mote' ? { mote: moteIdentity(owner) } : {}) })
  const identity = (session: SessionReference, occurrence?: AgentMuxSpaceAddress | null): MobileObjectIdentity => {
    const candidates = locations(session.agentSessionId)
    const context = occurrence === null ? undefined : occurrence ?? (candidates.length === 1 ? candidates[0] : undefined)
    const owner = context?.spaceId ? directory.owners.get(context.spaceId) : undefined
    const row = directory.rows.get(session.agentSessionId)
    return { name: row?.name ?? '名称未确认', project: row?.project ?? owner?.name ?? '项目未确认',
      ...(context ? { context } : {}), ...(owner?.kind === 'mote' ? { mote: moteIdentity(owner) } : {}) }
  }
  const name = (session: SessionReference) => identity(session).name
  const sessionRow = (session: SessionReference, key = session.agentSessionId, context?: AgentMuxSpaceAddress | null, tabName?: string | null, places?: AgentMuxSpaceAddress[]) => {
    const object = identity(session, context), row = directory.rows.get(session.agentSessionId), status = row?.state ?? 'unknown'
    const candidates = places ?? (context === undefined ? locations(session.agentSessionId) : [])
    const providerId = row?.providerId || session.providerId
    const stateLabel = row?.stateLabel ?? { working: '执行中', waiting: '等待输入', blocked: '需要处理', done: '已完成', error: '出错', exited: '已结束', starting: '启动中', running: '状态未确认', disconnected: '断开' }[status] ?? '状态未确认'
    return <li key={key} className="mobile-agent-row"><MobileAgentRow agentSessionId={session.agentSessionId} identity={object} onOpen={() => openSession(session.agentSessionId, object)}>
      <span className="mobile-executor-avatar"><AgentAvatarFace providerId={providerId} appearance={row?.avatar} /></span>
      <span className="mobile-session-copy"><span className="mobile-session-project">{object.project}</span><strong>{object.name !== '名称未确认' ? object.name : tabName || object.name}</strong>{tabName && tabName !== object.name && object.name !== '名称未确认' && <small className="mobile-session-location">{tabName}</small>}{row && <small className="mobile-session-recap" title={row.recap ? `${row.recap.source} · ${row.recap.text}` : row.detail}>{row.recap?.text ?? '暂无已确认摘要'}</small>}{context && <small className="mobile-session-location" title={`${context.displayWorkspaceId} / ${context.groupId}`}>{context.displayWorkspaceId} · {context.groupId}</small>}</span>
      <span className="mobile-session-state" data-state={status}>{row?.stateMark && <FocusStateMark kind={row.stateMark} presenceUnknown={row.presenceUnknown} />}<span title={stateLabel}>{stateLabel}</span><small>{row?.providerId ?? session.providerId ?? '元信息未确认'}</small></span>
    </MobileAgentRow>{candidates.length > 1 && <details className="mobile-session-locations"><summary>{candidates.length} 个原展示位置</summary>{candidates.map(place => <button type="button" key={JSON.stringify(place)} onClick={() => openSession(session.agentSessionId, identity(session, place))}>
      {(place.spaceId ? directory.owners.get(place.spaceId)?.name : undefined) ?? 'Space 未确认'} · {directory.tabsById.get(place.tabId)?.name ?? 'Tab'} · {place.displayWorkspaceId} / {place.groupId}
    </button>)}</details>}</li>
  }
  const rows = catalog?.agentPresentation ?? []
  const projectRows = useMemo(() => {
    const groups = new Map<string, { project: NonNullable<Catalog['agentPresentation']>[number]['projectGroup']; values: SessionReference[] }>()
    if (home !== 'focus') return groups
    for (const row of catalog?.agentPresentation ?? []) {
      const key = row.projectGroup?.key ?? 'unconfirmed-projects'
      let entry = groups.get(key)
      if (!entry) { entry = { project: row.projectGroup, values: [] }; groups.set(key, entry) }
      entry.values.push(sessionById.get(row.agentSessionId) ?? { agentSessionId: row.agentSessionId, providerId: row.providerId })
    }
    return groups
  }, [home, catalog, sessionById])
  const presentationIssues = directory.issues.filter(owner => home === 'mote' ? owner.kind === 'mote' : home === 'space' ? owner.kind !== 'mote' : true)
  const tabs = directory.tabsByOwner.get(spaceId ?? '') ?? []
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
  const mainAction = (owner: Catalog['spaces'][number]) => {
    const facts = directory.motes.get(owner.spaceId)
    const main = facts?.quickMode.status === 'saved' ? facts.quickMode.defaults.conversation : undefined
    const configure = () => openProfile?.(spaceIdentity(owner))
    return <button type="button" className="mobile-mote-quick-open" aria-label={`${main ? '继续主对话' : facts?.quickMode.status === 'unconfirmed' ? '核对主 Agent' : '设置主 Agent'} · ${owner.name}`}
      onClick={() => {
        if (!main) { configure(); return }
        const places = facts?.conversation ? directory.occurrences.get(JSON.stringify([owner.spaceId, main.tabId, main.regionId]))?.filter(place =>
          place.displayWorkspaceId === main.displayWorkspaceId && place.groupId === main.groupId && place.tabId === main.tabId && place.regionId === main.regionId) ?? [] : []
        const session = reference(main.sessionId)
        const object = { ...identity(session, places.length === 1 ? places[0] : null), project: owner.name, mote: moteIdentity(owner) }
        if (openMainAgent) openMainAgent(main.sessionId, object, main.hostId)
        else openSession(main.sessionId, object)
      }}><SemanticIcon name="object.conversation" size={16} /><span>主 Agent</span></button>
  }
  const renderSpaceContents = (owner: Catalog['spaces'][number]) => {
    const ownerZones = directory.zonesByOwner.get(owner.spaceId) ?? new Set<string>()
    const ownerTabs = directory.tabsByOwner.get(owner.spaceId) ?? []
    if (owner.kind === 'mote') {
      const facts = directory.motes.get(owner.spaceId)
      const members = new Map<string, { session: SessionReference; places: AgentMuxSpaceAddress[] }>()
      let unconfirmedAgent = false
      for (const tab of ownerTabs) for (const region of directory.regionsByTab.get(tab.tabId) ?? []) {
        if (region.kind !== 'agent' || !tab.regionIds.includes(region.regionId)) continue
        if (!region.agentSessionId) { unconfirmedAgent = true; continue }
        const id = region.agentSessionId, member = members.get(id) ?? { session: reference(id), places: [] }
        member.places.push(...directory.occurrences.get(JSON.stringify([owner.spaceId, region.tabId, region.regionId])) ?? [])
        members.set(id, member)
      }
      return <div className="mobile-mote-contents">
        <div className="mobile-mote-agents-heading"><h3>Agents</h3>{onCreateAgent && <button type="button" className="mobile-icon-button" aria-label={`在 ${owner.name} 新建 Agent`} onClick={() => onCreateAgent({ spaceId: owner.spaceId, ...(facts?.content && ownerZones.has(facts.content.zoneId) ? { zoneId: facts.content.zoneId } : {}) })}><SemanticIcon name="action.create-agent" size={16} /></button>}</div>
        <ul className="mobile-session-list mobile-mote-agents" aria-label={`${owner.name} 的 Agents`}>{[...members].map(([id, member]) => sessionRow(member.session, id, member.places.length === 1 ? member.places[0] : null, undefined, member.places))}</ul>
        {!members.size && <p className="mobile-spatial-empty">{unconfirmedAgent ? '原 Agent 绑定尚未确认；主 Agent 入口与原工作面保留。' : '尚无已绑定 Agent；可从主 Agent 入口设置，或明确新建。'}</p>}
        {facts?.issue && <MobileNotice identity={[owner.spaceId,facts.issue]} className="mobile-spatial-notice" role="status">{facts.issue}</MobileNotice>}
      </div>
    }
    return <>
      {[...ownerZones].map(zoneId => <section className="mobile-spatial-zone" key={zoneId} data-zone-id={zoneId}>
        {catalog?.zones.find(zone => zone.zoneId === zoneId)?.kind === 'worktree' && <h3 className="mobile-spatial-zone-name">{catalog.zones.find(zone => zone.zoneId === zoneId)?.branch ?? 'Worktree'}</h3>}
        {ownerTabs.filter(tab => tab.zoneId === zoneId).map(tab => {
          const singleMatches = tab.regionIds.length === 1 ? catalog?.regions.filter(region => region.tabId === tab.tabId && region.regionId === tab.regionIds[0]) ?? [] : []
          const sole = singleMatches.length === 1 ? singleMatches[0] : undefined
          const repeatedName = sole?.agentSessionId || sole?.kind === 'file' && tab.name === sole.file?.path.split('/').at(-1)
          const heading = sole ? !repeatedName && tab.name || null : tab.name || (tab.regionIds.length > 1 ? '多个工作面' : '内容待确认')
          return <section className="mobile-spatial-tab" key={tab.tabId}>{heading && <h3>{heading}</h3>}
        <ul className="mobile-session-list">{tab.regionIds.map(id => {
          const matches = catalog?.regions.filter(region => region.tabId === tab.tabId && region.regionId === id) ?? []
          return matches.length === 1 ? matches[0] : undefined
        }).filter(region => region !== undefined).map(region => {
          const session = region.agentSessionId ? reference(region.agentSessionId) : undefined
          const occurrences = catalog?.locations.filter(value => value.spaceId === owner.spaceId && value.tabId === tab.tabId && value.regionId === region.regionId) ?? []
          return session ? occurrences.length ? occurrences.map(place => sessionRow(session, JSON.stringify(place), place, tab.regionIds.length === 1 ? tab.name : undefined)) : sessionRow(session, region.regionId, null, tab.regionIds.length === 1 ? tab.name : undefined)
            : <li key={region.regionId}>{region.kind === 'launcher' && onCreateAgent ? <button type="button" aria-label="在此启动位新建 Agent" onClick={() => onCreateAgent({ spaceId: owner.spaceId, zoneId, tabId: tab.tabId, regionId: region.regionId })}>
              <SemanticIcon name="object.launcher" size={18} /><span><strong>新建 Agent</strong><small>在此启动位开始</small></span><SemanticIcon name="navigation.disclosure" size={16} /></button>
              : ['file', 'browser'].includes(region.kind) ? <button type="button" onClick={() => openContent(owner, tab, region)}><SemanticIcon name={region.kind === 'file' ? 'object.file' : 'object.browser'} size={18} /><span><strong>{region.kind === 'file' ? region.file?.path.split('/').at(-1) ?? '文件名称未确认' : '查看原网页'}</strong><small>{region.kind === 'file' ? region.file?.path.endsWith(NOTE_FILE_EXTENSION) ? '笔记' : '文件' : '网页'}</small></span><SemanticIcon name="navigation.disclosure" size={16} /></button>
              : <div className="mobile-spatial-resource"><SemanticIcon name={region.kind === 'launcher' ? 'object.launcher' : 'object.region'} size={18} /><span>{region.kind === 'launcher' ? 'Launcher' : region.kind}<small>{region.agentSessionId ? '会话状态尚未核实' : '此内容在 Mac 上查看'}</small></span></div>}</li>
        })}</ul></section>})}</section>)}
      {!ownerTabs.length && <p className="mobile-spatial-empty">此空间暂无已绑定 Tab。原空间和资料仍保留。</p>}
    </>
  }
  const filteredSessions = (values: SessionReference[]) => values.filter(session => matching(name(session) + ' ' + identity(session).project + ' ' + session.providerId))
  return <MobileNoticeScope owner={client} identity={[home,spaceId,context.tabId,context.regionId]}><section className="mobile-spatial-panel">
    <div className="mobile-section-heading mobile-page-header"><div><h1>{home === 'mote' ? 'Mote' : home === 'focus' ? 'Focus' : 'Space'}</h1>
      <p>{home === 'mote' ? '与你的协调 Agent 继续讨论' : home === 'focus' ? '需要你处理的事项与最近执行' : '按 Mac 上的工作空间继续'}</p></div>
      <div className="mobile-section-actions">{onCreateAgent && <button className="mobile-icon-button" aria-label="新建 Agent" onClick={() => onCreateAgent(spaceId ? { spaceId } : {})}><SemanticIcon name="action.create-agent" size={18} /></button>}<button className="mobile-icon-button" aria-label="刷新空间目录" onClick={() => refresh(value => value + 1)}><SemanticIcon name="action.refresh" size={18} animation={pending ? 'spin' : 'none'} /></button></div></div>
    {!connected && <MobileNotice owner={client} identity={[connected]} className="mobile-spatial-notice" role="status">连接暂不可用，原工作面与最近目录保留。</MobileNotice>}
    <MobileDirectoryNotice issues={[...(issue ? [{ source: '空间目录', message: issue }] : []), ...(metadata.issue ? [{ source: '会话目录', message: metadata.issue }] : []), ...presentationIssues]} retry={() => refresh(count => count + 1)} />
    <label className="mobile-spatial-search"><SemanticIcon name="action.search" size={16} /><TextInput value={query} onChange={event => setQuery(event.target.value)} placeholder={home === 'focus' ? '查找 Agent 或工作空间' : '查找工作空间'} aria-label="查找" /></label>
    {home === 'focus' ? <>
      {[...projectRows].map(([key, { project, values }]) => {
        const matchingValues = filteredSessions(values)
        if (!matchingValues.length) return null
        return <section className="mobile-focus-project" key={key} data-project-key={key} data-project-confirmed={Boolean(project)}><h2 className="mobile-spatial-subheading">{project?.spaceId && <MobileIdentity appearanceRevision={revision} objectSpaceId={project.spaceId} appearance={directory.appearances.get(project.spaceId)} identity={{ name: project.name, project: project.name, ...(directory.owners.get(project.spaceId)?.kind === 'mote' ? { mote: moteIdentity(directory.owners.get(project.spaceId)!) } : {}) }} client={client} connected={connected} visible={visible} size={20} />}<strong>{project?.name ?? '项目未确认'}</strong>{project?.hostId && project.hostId !== 'local' && <small>{project.hostId}</small>}<span>{matchingValues.length}</span></h2><ul className="mobile-session-list">{matchingValues.map(session => sessionRow(session))}</ul></section>
      })}
      {!rows.length && <p className="mobile-spatial-empty">Focus 呈现尚未确认；原会话保留。</p>}
      {catalog?.agentPresentation === undefined && metadata.sessions.length > 0 && <details><summary>其他已有会话</summary><ul className="mobile-session-list">{filteredSessions(metadata.sessions.filter(session => !directory.rows.has(session.agentSessionId))).map(session => sessionRow(session))}</ul></details>}
    </> : context.regionId ? <>
      <button className="mobile-text-button" type="button" onClick={backToSpace}><SemanticIcon name="navigation.back" size={16} />返回空间内容</button>
      <h2 className="mobile-spatial-subheading">{selected?.region.kind === 'file' ? selected.region.file?.path.split('/').at(-1) ?? '原文件' : selected?.region.kind === 'browser' ? '原网页' : '原内容'}</h2>
      <p>{selected?.spaceName ?? space?.name ?? '原空间'} · {selected?.tabName ?? '原标签'}</p>
      {(selectionChanged || !selected) && <MobileNotice identity={[spaceId,context.tabId,context.regionId,selectionChanged]} role="status">原 Tab / Region 的当前绑定尚未重新确认；原引用、已有正文和草稿保留。可返回目录核对，不会改读别的内容。</MobileNotice>}
      <details><summary>原工作面位置</summary><code>{context.spaceId} / {context.tabId} / {context.regionId}</code></details>
    </> : <>
      {spaceId && !space && <MobileNotice identity={[spaceId]} className="mobile-spatial-notice" role="status">原空间绑定尚未重新确认，原引用与工作面保留；可刷新原目录。</MobileNotice>}
      {catalog ? <MobileSpaceDirectory key={home} catalog={catalog} home={home === 'mote' ? 'mote' : 'space'} query={query} selectedSpaceId={spaceId}
        onSelect={owner => { setContext(owner ? { spaceId: owner.spaceId, tabId: null, regionId: null } : EMPTY_CONTEXT); setSelectedKey(null); if (owner?.kind === 'mote') onSelectMote?.(owner.spaceId) }}
        renderIdentity={owner => <MobileIdentity appearanceRevision={revision} objectSpaceId={owner.spaceId} appearance={directory.appearances.get(owner.spaceId)} identity={spaceIdentity(owner)} client={client} connected={connected} visible={visible} size={28} />}
        {...(home === 'mote' ? { renderPrimary: mainAction, renderProfile: owner => openProfile && <button type="button" className="mobile-mote-profile-action"
          aria-label={`查看 Mote 资料 · ${owner.name}`} onClick={() => openProfile(spaceIdentity(owner))}><SemanticIcon name="status.info" size={16} /><span>Profile</span></button> } : {})} renderContents={renderSpaceContents} /> : <p className="mobile-spatial-empty">{pending ? '正在读取 Mac 上的空间…' : '空间目录尚未核实，可在 Focus 中继续原会话。'}</p>}
    </>}
    {visited.map(target => <div key={target.key} hidden={home === 'focus' || target.key !== selectedKey || !context.regionId}>
      {(target.region.kind === 'file' || target.region.kind === 'browser') && <MobileRegionContent client={client} connected={connected} showTitle={false}
        visible={visible && home !== 'focus' && target.key === selectedKey && Boolean(context.regionId)} tabId={target.tabId} regionId={target.region.regionId} zoneId={target.zoneId}
        kind={target.region.kind} browserId={target.region.browserId} {...(target.region.file ? { file: target.region.file } : {})} {...(openHttpLink ? { openHttpLink } : {})} />}
    </div>)}
  </section></MobileNoticeScope>
})
