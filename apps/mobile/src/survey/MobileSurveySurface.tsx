import { useEffect, useState } from 'react'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { MobileObjectIdentity } from '../navigation/MobileIdentity'
import './survey.css'
import { MobileRegionContent } from '../navigation/MobileRegionContent'

export type MobileSurveyProps = {
  client: AgentMuxHostedClient | null
  connected: boolean
  visible?: boolean
  openSession(id: string, identity: MobileObjectIdentity): void
  openTopic?: (spaceId: string) => void
}

/** Reads the original presentation owner; never manufactures membership from Zones. */
export function MobileSurveySurface({ client, connected, visible = true, ...actions }: MobileSurveyProps) {
  const [catalog, setCatalog] = useState<AgentMuxSpaceCatalog | null>(null)
  const [issue, setIssue] = useState('')
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
        if (!disposed) setIssue(`读取原 Survey 失败：${error instanceof Error ? error.message : String(error)}。原研究与 Agent 保留，可刷新重试。`)
      } finally { inFlight = false }
    }
    void read()
    const timer = setInterval(() => { void read() }, 10000)
    const foreground = () => { if (document.visibilityState === 'visible') void read() }
    document.addEventListener('visibilitychange', foreground)
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', foreground) }
  }, [client, connected, visible, revision])
  return <MobileSurveyCatalog visible={visible} client={client} catalog={catalog} {...actions} issue={!connected ? '连接暂不可用；原研究、选择与会话保留。' : issue} refresh={() => refresh(value => value + 1)} />
}

export function MobileSurveyCatalog({ client = null, visible = true, catalog, openSession, openTopic, issue = '', refresh }: {
  visible?: boolean
  client?: AgentMuxHostedClient | null
  catalog: AgentMuxSpaceCatalog | null
  openSession: MobileSurveyProps['openSession']
  openTopic?: MobileSurveyProps['openTopic']
  issue?: string
  refresh(): void
}) {
  const [chosen, choose] = useState<string | null>(null)
  const survey = catalog?.survey
  const selectedId = chosen ?? survey?.selection?.zoneId ?? null
  const item = survey?.items.find(value => value.zoneId === selectedId)
  const tabs = catalog?.tabs.filter(tab => tab.zoneId === selectedId) ?? []
  const relations = catalog?.bindings.filter(binding => binding.zoneId === selectedId) ?? []
  const topics = catalog?.spaces.filter(space => space.kind === 'topic' && relations.some(binding => binding.spaceId === space.spaceId)) ?? []
  const relationsUnknown = relations.some(binding => !catalog?.spaces.some(space => space.spaceId === binding.spaceId) || catalog.spaces.find(space => space.spaceId === binding.spaceId)?.issue)
  const held = survey?.selection?.zoneId === selectedId ? survey.selection : null
  return <section className="mobile-survey" aria-label="Survey">
    <header><h1>Survey</h1><button type="button" onClick={refresh}>刷新原研究</button></header>
    {[issue, survey?.issue].filter(Boolean).map((message, index) => <p key={index} role="status">{message}</p>)}
    {!survey ? <p role="status">原研究列表尚未确认。</p> : <>
      <nav aria-label="原研究列表"><ul>{survey.items.map(value => <li key={value.zoneId}>
        <button type="button" aria-pressed={selectedId === value.zoneId} onClick={() => choose(value.zoneId)}>{value.name || '名称未确认'}</button>
        {value.issue && <p role="status">{value.issue}</p>}
      </li>)}</ul></nav>
      {!survey.items.length && <p>暂无明确收集的研究。</p>}
      {selectedId && <section aria-label="研究工作面">
        <h2>{item?.name || '原选择的研究'}</h2><details><summary>研究来源</summary><code>{selectedId}</code></details>
        {!catalog?.zones.some(zone => zone.zoneId === selectedId) && <p role="status">原 Zone 暂未确认；研究引用与选择保留，请刷新原研究。</p>}
        {held && <details><summary>原 Tab / Region 选择</summary><ul>{held.selection.map(reference => <li key={JSON.stringify(reference)}><code>{reference.tabId} / {reference.regionId}</code>{held.active?.tabId === reference.tabId && held.active.regionId === reference.regionId ? ' · 当前' : ''}
          {!catalog?.regions.some(region => region.tabId === reference.tabId && region.regionId === reference.regionId) && ' · 原位置暂未确认'}
        </li>)}</ul></details>}
        <section aria-label="关联 Topic"><h3>关联 Topic</h3>{topics.map(topic => <div key={topic.spaceId}>{openTopic ? <button type="button" onClick={() => openTopic(topic.spaceId)}>{topic.name}</button> : <span>{topic.name}</span>}<details><summary>Topic 来源</summary><code>{topic.spaceId}</code></details></div>)}
          {relationsUnknown ? <p role="status">部分关联空间未确认，保留原关系；可刷新重试。</p> : !topics.length && <p>暂无已确认关联 Topic。</p>}
        </section>
        <section aria-label="原 Tab 与 Region">{tabs.map(tab => <article key={tab.tabId}><h3>{tab.name || 'Tab 名称未确认'}</h3><details><summary>标签来源</summary><code>{tab.tabId}</code></details>{tab.issue && <p role="status">{tab.issue}</p>}
          <ul>{tab.regionIds.map(regionId => {
            const region = catalog?.regions.find(value => value.tabId === tab.tabId && value.regionId === regionId)
            const row = catalog?.agentPresentation?.find(value => value.agentSessionId === region?.agentSessionId)
            const addresses = catalog?.locations.filter(value => value.tabId === tab.tabId && value.regionId === regionId) ?? []
            return <li key={regionId}><strong>{region ? ({ agent: 'Agent', terminal: 'Terminal', browser: '网页', file: '文件与笔记', git: 'Git 历史', 'git-diff': '变更', launcher: '启动入口' }[region.kind]) : 'Region 未确认'}</strong><details><summary>原位置</summary><code>{regionId}</code>
              {addresses.map(address => <small key={JSON.stringify(address)}>位置：{address.displayWorkspaceId} / {address.groupId}{address.spaceId ? ` / ${address.spaceId}` : ''}</small>)}</details>
              {region?.kind === 'agent' && region.agentSessionId && <button type="button" onClick={() => openSession(region.agentSessionId!, { name: row?.name ?? '名称未确认', project: row?.project ?? '项目未确认' })}>继续对话 · {row?.name ?? region.agentSessionId}</button>}
              {region?.kind === 'browser' && <MobileRegionContent key={regionId} client={client} visible={visible} tabId={tab.tabId} zoneId={tab.zoneId} regionId={regionId} browserId={region.browserId} kind="browser" />}
              {region?.kind === 'file' && <MobileRegionContent key={regionId} client={client} visible={visible} tabId={tab.tabId} zoneId={tab.zoneId} regionId={regionId} file={region.file} kind="file" />}
            </li>
          })}</ul></article>)}</section>
        {!tabs.length && <p role="status">原 Tab / Region 尚未确认，请刷新原研究。</p>}
      </section>}
    </>}
  </section>
}
