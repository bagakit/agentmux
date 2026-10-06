import { NOTE_FILE_EXTENSION } from '@agentmux/client-ui/note/note-format'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { OpenHttpLink } from '@agentmux/client-ui/components/AgentMarkdown'
import type { MobileObjectIdentity } from '../navigation/MobileIdentity'
import { MobileRegionContent } from '../navigation/MobileRegionContent'
import './survey.css'

/** Device references only; names, content and resource facts retain their original owners. */
export type MobileSurveyContext = { zoneId: string | null; tabId: string | null; regionId: string | null }
export type MobileSurveyProps = {
  client: AgentMuxHostedClient | null; connected: boolean; visible?: boolean
  openSession(id: string, identity: MobileObjectIdentity): void
  openTopic?: (spaceId: string) => void; openHttpLink?: OpenHttpLink
  initialContext?: MobileSurveyContext; onContextChange?(context: MobileSurveyContext): void
  onBackChange?(back: (() => void) | null): void
}
type Region = AgentMuxSpaceCatalog['regions'][number]
type Target = { key: string; zoneId: string | null; tabId: string; region: Region; tabName: string; zoneName: string; zone?: AgentMuxSpaceCatalog['zones'][number] }
const EMPTY_CONTEXT: MobileSurveyContext = { zoneId: null, tabId: null, regionId: null }
const targetKey = (zoneId: string | null, region: Region) => JSON.stringify([zoneId, region.tabId, region.regionId, region.kind, region.browserId ?? null, region.file ?? null])
const kindName = (region: Region) => ({ agent: 'Agent', terminal: '终端', browser: '网页', file: region.file?.path.endsWith(NOTE_FILE_EXTENSION) ? '笔记' : '文件', git: 'Git 历史', 'git-diff': '变更', launcher: '启动入口' }[region.kind])

/** Reads original collected membership; never manufactures it from Zones or current focus. */
export function MobileSurveySurface({ client, connected, visible = true, ...actions }: MobileSurveyProps) {
  const [catalog, setCatalog] = useState<AgentMuxSpaceCatalog | null>(null), [issue, setIssue] = useState('')
  const [revision, refresh] = useState(0)
  useEffect(() => {
    if (!client || !connected || !visible) return
    let disposed = false, inFlight = false
    const read = async () => {
      if (inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      try {
        if (!client.forwardRpc) throw new Error('原 Survey 公共目录端口暂不可用。')
        const result = await client.forwardRpc('space.ls', { target: {}, presentation: true })
        if (!disposed) {
          if (result.catalog.survey) { setCatalog(result.catalog); setIssue('') }
          else setIssue('原 Survey 呈现尚未确认，保留上次研究与选择；可刷新重试。')
        }
      } catch (error) {
        if (!disposed) setIssue(`原研究目录查询尚未重新核实：${error instanceof Error ? error.message : String(error)}。原研究、工作面与草稿保留，可刷新查询。`)
      } finally { inFlight = false }
    }
    void read()
    const timer = setInterval(() => { void read() }, 10000)
    const foreground = () => { if (document.visibilityState === 'visible') void read() }
    document.addEventListener('visibilitychange', foreground)
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', foreground) }
  }, [client, connected, visible, revision])
  return <MobileSurveyCatalog visible={visible} client={client} connected={connected} catalog={catalog} {...actions}
    issue={!connected ? '连接暂不可用；原研究、工作面与草稿保留。' : issue} refresh={() => refresh(value => value + 1)} />
}

export function MobileSurveyCatalog({ client = null, connected = true, visible = true, catalog, openSession, openTopic, openHttpLink,
  initialContext, onContextChange, onBackChange, issue = '', refresh }: Omit<MobileSurveyProps, 'client' | 'connected'> & {
  client?: AgentMuxHostedClient | null; connected?: boolean; catalog: AgentMuxSpaceCatalog | null; issue?: string; refresh(): void
}) {
  const [context, setContext] = useState<MobileSurveyContext>(initialContext ?? EMPTY_CONTEXT)
  const [visited, setVisited] = useState<Target[]>([]), [selectedKey, setSelectedKey] = useState<string | null>(null)
  const incoming = JSON.stringify(initialContext ?? null), previousIncoming = useRef(incoming)
  useEffect(() => {
    if (previousIncoming.current === incoming) return
    previousIncoming.current = incoming
    if (initialContext && JSON.stringify(context) !== incoming) { setContext(initialContext); setSelectedKey(null) }
  }, [incoming, initialContext, context])
  useEffect(() => { onContextChange?.(context) }, [context, onContextChange])
  const backToList = useCallback(() => { setContext(EMPTY_CONTEXT); setSelectedKey(null) }, [])
  const backToZone = useCallback(() => { setContext(value => ({ zoneId: value.zoneId, tabId: null, regionId: null })); setSelectedKey(null) }, [])
  const activeBack = context.regionId ? backToZone : context.zoneId ? backToList : null
  useEffect(() => {
    if (!visible || !onBackChange) return
    onBackChange(activeBack)
    return () => onBackChange(null)
  }, [visible, onBackChange, activeBack])
  const survey = catalog?.survey, item = survey?.items.find(value => value.zoneId === context.zoneId)
  const tabs = catalog?.tabs.filter(tab => tab.zoneId === context.zoneId) ?? []
  const held = survey?.selection?.zoneId === context.zoneId ? survey.selection : null
  const relations = catalog?.bindings.filter(binding => binding.zoneId === context.zoneId) ?? []
  const topics = catalog?.spaces.filter(space => space.kind === 'topic' && relations.some(binding => binding.spaceId === space.spaceId)) ?? []
  const relationsUnknown = relations.some(binding => !catalog?.spaces.some(space => space.spaceId === binding.spaceId) || catalog.spaces.find(space => space.spaceId === binding.spaceId)?.issue)
  const openContent = (tab: AgentMuxSpaceCatalog['tabs'][number], region: Region) => {
    const key = targetKey(tab.zoneId, region)
    const zones = catalog?.zones.filter(zone => zone.zoneId === tab.zoneId) ?? []
    setVisited(values => values.some(value => value.key === key) ? values : [...values, { key, zoneId: tab.zoneId, tabId: tab.tabId, region: { ...region, ...(region.file ? { file: { ...region.file } } : {}) }, tabName: tab.name || '原内容标签', zoneName: item?.name || '原研究', ...(zones.length === 1 ? { zone: { ...zones[0]! } } : {}) }])
    setSelectedKey(key); setContext({ zoneId: tab.zoneId, tabId: tab.tabId, regionId: region.regionId })
  }
  // A restored reference must resolve uniquely to this exact original Tab and Region.
  useEffect(() => {
    if (selectedKey || !context.regionId || !context.tabId) return
    const matchingTabs = tabs.filter(tab => tab.tabId === context.tabId && tab.regionIds.includes(context.regionId!))
    const regions = catalog?.regions.filter(region => region.tabId === context.tabId && region.regionId === context.regionId) ?? []
    if (matchingTabs.length === 1 && regions.length === 1 && ['file', 'browser'].includes(regions[0]!.kind)) openContent(matchingTabs[0]!, regions[0]!)
  }, [catalog, context.zoneId, context.tabId, context.regionId, selectedKey])
  const selected = visited.find(value => value.key === selectedKey)
  const current = catalog?.regions.find(region => region.tabId === context.tabId && region.regionId === context.regionId)
  const currentZone = catalog?.zones.find(zone => zone.zoneId === context.zoneId)
  const selectionChanged = Boolean(selected && (!current || targetKey(context.zoneId, current) !== selected.key || !tabs.some(tab => tab.tabId === selected.tabId && tab.regionIds.includes(selected.region.regionId))
    || selected.zone && (!currentZone || currentZone.hostId !== selected.zone.hostId || currentZone.workspaceId !== selected.zone.workspaceId || currentZone.directoryPath !== selected.zone.directoryPath)))
  const openAgent = (region: Region, address?: AgentMuxSpaceCatalog['locations'][number]) => {
    const row = catalog?.agentPresentation?.find(value => value.agentSessionId === region.agentSessionId)
    if (region.agentSessionId) openSession(region.agentSessionId, { name: row?.name ?? '名称未确认', project: row?.project ?? item?.name ?? '项目未确认', ...(address ? { context: address } : {}) })
  }
  return <section className="mobile-survey" aria-label="Survey">
    <header>{activeBack && <button className="mobile-text-button" type="button" onClick={activeBack}>{context.regionId ? '返回研究内容' : '返回研究列表'}</button>}
      <h1>{context.regionId ? selected?.region.kind === 'file' ? selected.region.file?.path.split('/').at(-1) ?? '原文件' : selected?.region.kind === 'browser' ? '原网页' : '原内容' : context.zoneId ? item?.name ?? selected?.zoneName ?? '原选择的研究' : 'Survey'}</h1>
      <button className="mobile-text-button" type="button" onClick={refresh}>刷新原研究</button></header>
    {[issue, survey?.issue].filter(Boolean).map((message, index) => <p className="mobile-survey-issue" key={index} role="status">{message}</p>)}
    {!context.zoneId ? <><p className="mobile-survey-intro">已收集的研究与原内容</p>
      {!survey ? <p role="status">原研究列表尚未确认。</p> : <nav aria-label="原研究列表"><ul>{survey.items.map(value => <li key={value.zoneId}>
        <button className="mobile-menu-row" type="button" onClick={() => { setContext({ zoneId: value.zoneId, tabId: null, regionId: null }); setSelectedKey(null) }}>
          <span><strong>{value.name || '名称未确认'}</strong>{survey.selection?.zoneId === value.zoneId && <small>原研究选择</small>}{value.issue && <small>{value.issue}</small>}</span></button>
      </li>)}</ul>{!survey.items.length && <p>暂无明确收集的研究。</p>}</nav>}
    </> : <>
      {!catalog?.zones.some(zone => zone.zoneId === context.zoneId) && <p role="status">原 Zone 暂未确认；研究引用、选择与已有正文保留，请刷新原研究。</p>}
      <details className="mobile-survey-provenance"><summary>研究来源与原选择</summary><code>{context.zoneId}</code>
        {held && <ul>{held.selection.map(reference => <li key={JSON.stringify(reference)}><code>{reference.tabId} / {reference.regionId}</code>{held.active?.tabId === reference.tabId && held.active.regionId === reference.regionId ? ' · 原当前选择' : ''}</li>)}</ul>}
      </details>
      {context.regionId ? <><p className="mobile-survey-context">{selected?.zoneName ?? item?.name ?? '原研究'} · {selected?.tabName ?? '原标签'}</p>
        {(selectionChanged || !selected) && <p role="status">原 Tab / Region 的当前绑定尚未重新确认；原引用、已有正文和草稿保留。可返回目录核对，不会改读别的内容。</p>}
        <details className="mobile-survey-provenance"><summary>原工作面位置</summary><code>{context.tabId} / {context.regionId}</code>
          {catalog?.locations.filter(value => value.tabId === context.tabId && value.regionId === context.regionId).map(value => <code key={JSON.stringify(value)}>{value.displayWorkspaceId} / {value.groupId}{value.spaceId ? ` / ${value.spaceId}` : ''}</code>)}
        </details>
      </> : <section aria-label="研究工作面">
        <section className="mobile-survey-related" aria-label="关联 Topic"><h2>关联 Topic</h2>{topics.map(topic => <div key={topic.spaceId}>{openTopic ? <button className="mobile-menu-row" type="button" onClick={() => openTopic(topic.spaceId)}>{topic.name}</button> : <span>{topic.name}</span>}</div>)}
          {relationsUnknown ? <p role="status">部分关联空间未确认，保留原关系；可刷新重试。</p> : !topics.length && <p>暂无已确认关联 Topic。</p>}
        </section>
        <section aria-label="原 Tab 与 Region">{tabs.map(tab => <article className="mobile-survey-tab" key={tab.tabId}><h2>{tab.name || 'Tab 名称未确认'}</h2>{tab.issue && <p role="status">{tab.issue}</p>}
          <ul>{tab.regionIds.map(regionId => {
            const regions = catalog?.regions.filter(value => value.tabId === tab.tabId && value.regionId === regionId) ?? [], region = regions.length === 1 ? regions[0] : undefined
            const row = catalog?.agentPresentation?.find(value => value.agentSessionId === region?.agentSessionId)
            const addresses = catalog?.locations.filter(value => value.tabId === tab.tabId && value.regionId === regionId) ?? []
            return <li key={regionId}>
              {region?.kind === 'agent' && region.agentSessionId ? <button className="mobile-menu-row" type="button" onClick={() => openAgent(region, addresses.length === 1 ? addresses[0] : undefined)}><span><strong>继续对话 · {row?.name ?? '名称未确认'}</strong><small>{row?.recap?.text ?? row?.detail ?? '继续原 Agent'}</small></span></button>
                : region && ['file', 'browser'].includes(region.kind) ? <button className="mobile-menu-row" type="button" onClick={() => openContent(tab, region)}><span><strong>{region.kind === 'file' ? region.file?.path.split('/').at(-1) ?? '文件名称未确认' : '查看原网页'}</strong><small>{kindName(region)}</small></span></button>
                  : <p>{region ? kindName(region) : 'Region 未确认'}<small>原工作面保留，此内容尚未提供手机操作。</small></p>}
              <details className="mobile-survey-provenance"><summary>原位置与来源</summary><code>{tab.tabId} / {regionId}</code>{addresses.map(address => <div key={JSON.stringify(address)}><code>{address.displayWorkspaceId} / {address.groupId}{address.spaceId ? ` / ${address.spaceId}` : ''}</code>
                {region?.kind === 'agent' && addresses.length > 1 && <button type="button" onClick={() => openAgent(region, address)}>从此原位置继续对话</button>}</div>)}</details>
            </li>
          })}</ul></article>)}</section>
        {!tabs.length && <p role="status">原 Tab / Region 尚未确认，请刷新原研究。</p>}
      </section>}
    </>}
    {visited.map(target => <div key={target.key} hidden={target.key !== selectedKey || !context.regionId}>
      {(target.region.kind === 'file' || target.region.kind === 'browser') && <MobileRegionContent client={client} connected={connected} showTitle={false} visible={visible && target.key === selectedKey && Boolean(context.regionId)}
        tabId={target.tabId} zoneId={target.zoneId} regionId={target.region.regionId} kind={target.region.kind} browserId={target.region.browserId} {...(target.region.file ? { file: target.region.file } : {})} {...(openHttpLink ? { openHttpLink } : {})} />}
    </div>)}
  </section>
}
