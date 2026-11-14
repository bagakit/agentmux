import { mobileMemberSelection } from '../navigation/mobile-member-target'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { MobileHeaderMenu } from '../navigation/MobileHeaderMenu'
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
        if (!client.forwardRpc) throw new Error('连接暂不可用，暂时读不到研究列表。')
        const result = await client.forwardRpc('space.ls', { target: {}, presentation: true })
        if (!disposed) {
          if (result.catalog.survey) { setCatalog(result.catalog); setIssue('') }
          else setIssue('研究列表还没确认，可以刷新重试。')
        }
      } catch (error) {
        if (!disposed) setIssue(`研究列表读取未完成：${error instanceof Error ? error.message : String(error)}。可以刷新重试。`)
      } finally { inFlight = false }
    }
    void read()
    const timer = setInterval(() => { void read() }, 10000)
    const foreground = () => { if (document.visibilityState === 'visible') void read() }
    document.addEventListener('visibilitychange', foreground)
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', foreground) }
  }, [client, connected, visible, revision])
  return <MobileSurveyCatalog visible={visible} client={client} connected={connected} catalog={catalog} {...actions}
    issue={!connected ? '连接暂不可用，连上 Mac 后可以刷新研究。' : issue} refresh={() => refresh(value => value + 1)} />
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
  const zoneSelection = survey?.selection && 'zoneId' in survey.selection ? survey.selection : null
  const tabs = catalog?.tabs.filter(tab => tab.zoneId === context.zoneId) ?? []
  const held = zoneSelection?.zoneId === context.zoneId ? zoneSelection : null
  const relations = catalog?.bindings.filter(binding => binding.zoneId === context.zoneId) ?? []
  const topics = catalog?.spaces.filter(space => space.kind === 'topic' && relations.some(binding => binding.spaceId === space.spaceId)) ?? []
  const relationsUnknown = relations.some(binding => !catalog?.spaces.some(space => space.spaceId === binding.spaceId) || catalog.spaces.find(space => space.spaceId === binding.spaceId)?.issue)
  const openContent = (tab: AgentMuxSpaceCatalog['tabs'][number], region: Region) => {
    const key = targetKey(tab.zoneId, region)
    const zones = catalog?.zones.filter(zone => zone.zoneId === tab.zoneId) ?? []
    setVisited(values => values.some(value => value.key === key) ? values : [...values, { key, zoneId: tab.zoneId, tabId: tab.tabId, region: { ...region, ...(region.file ? { file: { ...region.file } } : {}) }, tabName: tab.name || '内容标签', zoneName: item?.name || '研究', ...(zones.length === 1 ? { zone: { ...zones[0]! } } : {}) }])
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
    const member = catalog && region.agentSessionId ? mobileMemberSelection(client, catalog, region.agentSessionId, address) : undefined
    if (region.agentSessionId) openSession(region.agentSessionId, { ...(member ? { member } : {}), name: row?.name ?? '名称未确认', project: row?.project ?? item?.name ?? '项目未确认', ...(address ? { context: address } : {}) })
  }
  return <MobileNoticeScope owner={client} identity={[context.zoneId,context.tabId,context.regionId]}><section className="mobile-survey" aria-label="Survey">
    <header className="mobile-page-header"><MobileHeaderMenu hidden={Boolean(activeBack)} />{activeBack && <button className="mobile-text-button" type="button" aria-label={context.regionId ? '返回研究内容' : '返回研究列表'} onClick={activeBack}><SemanticIcon name="navigation.back" size={16} /><span>{context.regionId ? '内容' : '研究'}</span></button>}
      <h1>{context.regionId ? selected?.region.kind === 'file' ? selected.region.file?.path.split('/').at(-1) ?? '文件' : selected?.region.kind === 'browser' ? '网页' : '内容' : context.zoneId ? item?.name ?? selected?.zoneName ?? '研究' : 'Survey'}</h1>
      {visible && <MobileAvatarNoticeOutlet header />}<button type="button" className="mobile-icon-button" aria-label="刷新研究" title="刷新研究" onClick={refresh}><SemanticIcon name="action.refresh" size={18} /></button></header>
    {[issue, survey?.issue].filter(Boolean).map((message, index) => <MobileNotice owner={client} identity={[context.zoneId,message]} className="mobile-survey-issue" key={index}>{message}</MobileNotice>)}
    {!context.zoneId ? <><p className="mobile-survey-intro">已收集的研究</p>
      {!survey ? <MobileNotice owner={client}>研究列表还没确认。</MobileNotice> : <nav aria-label="研究列表"><ul>{survey.items.map(value => <li key={value.zoneId}>
        <button className="mobile-menu-row" type="button" onClick={() => { setContext({ zoneId: value.zoneId, tabId: null, regionId: null }); setSelectedKey(null) }}>
          <span><strong>{value.name || '名称未确认'}</strong>{zoneSelection?.zoneId === value.zoneId && <small>当前选择</small>}{value.issue && <small>{value.issue}</small>}</span></button>
      </li>)}</ul>{!survey.items.length && <p>暂无明确收集的研究。</p>}</nav>}
    </> : <>
      {!catalog?.zones.some(zone => zone.zoneId === context.zoneId) && <MobileNotice>这项研究的位置还没确认，请刷新研究。</MobileNotice>}
      <details className="mobile-survey-provenance"><summary>来源与选择</summary><code>{context.zoneId}</code>
        {held && <ul>{held.selection.map(reference => <li key={JSON.stringify(reference)}><code>{reference.tabId} / {reference.regionId}</code>{held.active?.tabId === reference.tabId && held.active.regionId === reference.regionId ? ' · 当前选择' : ''}</li>)}</ul>}
      </details>
      {context.regionId ? <><p className="mobile-survey-context">{selected?.zoneName ?? item?.name ?? '研究'} · {selected?.tabName ?? '标签'}</p>
        {(selectionChanged || !selected) && <MobileNotice>这个位置的绑定还没重新确认，可以返回目录核对。</MobileNotice>}
        <details className="mobile-survey-provenance"><summary>工作面位置</summary><code>{context.tabId} / {context.regionId}</code>
          {catalog?.locations.filter(value => value.tabId === context.tabId && value.regionId === context.regionId).map(value => <code key={JSON.stringify(value)}>{value.displayWorkspaceId} / {value.groupId}{value.spaceId ? ` / ${value.spaceId}` : ''}</code>)}
        </details>
      </> : <section aria-label="研究工作面">
        {(topics.length > 0 || relationsUnknown) && <section className="mobile-survey-related" aria-label="关联 Topic"><h2>关联 Topic</h2>{topics.map(topic => <div key={topic.spaceId}>{openTopic ? <button className="mobile-menu-row" type="button" onClick={() => openTopic(topic.spaceId)}>{topic.name}</button> : <span>{topic.name}</span>}</div>)}
          {relationsUnknown ? <MobileNotice>部分关联空间还没确认，可以刷新重试。</MobileNotice> : null}
        </section>}
        <section aria-label="Tab 与 Region">{tabs.map(tab => <article className="mobile-survey-tab" key={tab.tabId}><h2>{tab.name || 'Tab 名称未确认'}</h2>{tab.issue && <MobileNotice identity={[tab.tabId,tab.issue]}>{tab.issue}</MobileNotice>}
          <ul>{tab.regionIds.map(regionId => {
            const regions = catalog?.regions.filter(value => value.tabId === tab.tabId && value.regionId === regionId) ?? [], region = regions.length === 1 ? regions[0] : undefined
            const row = catalog?.agentPresentation?.find(value => value.agentSessionId === region?.agentSessionId)
            const addresses = catalog?.locations.filter(value => value.tabId === tab.tabId && value.regionId === regionId) ?? []
            return <li key={regionId} className={region?.agentSessionId ? 'mobile-agent-row' : undefined}>
              {region?.kind === 'agent' && region.agentSessionId ? <MobileAgentRow agentSessionId={region.agentSessionId} identity={{ name: row?.name ?? '名称未确认', project: row?.project ?? item?.name ?? '项目未确认', ...(addresses.length === 1 ? { context: addresses[0] } : {}) }} className="mobile-menu-row" onOpen={() => openAgent(region, addresses.length === 1 ? addresses[0] : undefined)}><span><strong>{row?.name ?? '名称未确认'}</strong><small>{row?.recap?.text ?? row?.detail ?? '继续这个 Agent'}</small></span></MobileAgentRow>
                : region && ['file', 'browser'].includes(region.kind) ? <button className="mobile-menu-row" type="button" onClick={() => openContent(tab, region)}><span><strong>{region.kind === 'file' ? region.file?.path.split('/').at(-1) ?? '文件名称未确认' : '查看网页'}</strong><small>{kindName(region)}</small></span></button>
                  : <p>{region ? kindName(region) : 'Region 未确认'}<small>这项内容暂时不能在手机上操作。</small></p>}
              <details className="mobile-survey-provenance"><summary>位置信息</summary><code>{tab.tabId} / {regionId}</code>{addresses.map(address => <div key={JSON.stringify(address)}><code>{address.displayWorkspaceId} / {address.groupId}{address.spaceId ? ` / ${address.spaceId}` : ''}</code>
                {region?.kind === 'agent' && addresses.length > 1 && <button type="button" onClick={() => openAgent(region, address)}>从此原位置继续对话</button>}</div>)}</details>
            </li>
          })}</ul></article>)}</section>
        {!tabs.length && <MobileNotice>这个位置还没确认，请刷新研究。</MobileNotice>}
      </section>}
    </>}
    {visited.map(target => <div key={target.key} hidden={target.key !== selectedKey || !context.regionId}>
      {(target.region.kind === 'file' || target.region.kind === 'browser') && <MobileRegionContent client={client} connected={connected} showTitle={false} visible={visible && target.key === selectedKey && Boolean(context.regionId)}
        tabId={target.tabId} zoneId={target.zoneId} regionId={target.region.regionId} kind={target.region.kind} browserId={target.region.browserId} {...(target.region.file ? { file: target.region.file } : {})} {...(openHttpLink ? { openHttpLink } : {})} />}
    </div>)}
  </section></MobileNoticeScope>
}
import { MobileAvatarNoticeOutlet, MobileNotice, MobileNoticeScope } from '../notices/MobileNotice'
import { MobileAgentRow } from '../navigation/MobileAgentRow'
