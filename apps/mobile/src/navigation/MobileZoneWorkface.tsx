import { mobileMemberSelection } from './mobile-member-target'
import { MobileNoticeScope } from '../notices/MobileNotice'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { MobileDirectoryNotice } from './MobileDirectoryNotice'
import { MobileRegionContent } from './MobileRegionContent'
import type { MobileObjectIdentity } from './MobileIdentity'
import { MobileAgentRow, MobileAgentRowContent } from './MobileAgentRow'
import { agentLocationKey, mobileAgentLocations, type MobileAgentLocationChoice } from './mobile-agent-locations'

/** Topic discussions and original content use the same public Zone and Region identities. */
export function MobileZoneWorkface({ client, zoneId, name, visible, openSession, tabId, regionId, expectedAgent, onCreateAgent }: {
  client: AgentMuxHostedClient | null; zoneId?: string | undefined; name: string; visible: boolean
  openSession(id: string, identity: MobileObjectIdentity): void
  tabId?: string | undefined; regionId?: string | undefined; expectedAgent?: { hostId: string; agentSessionId: string } | null; onCreateAgent?(target: { spaceId?: string; zoneId?: string }): void
}) {
  const key = JSON.stringify([zoneId, tabId, regionId, expectedAgent])
  const [accepted, setAccepted] = useState<{ client: AgentMuxHostedClient; key: string; contentOwner: number; catalog: AgentMuxSpaceCatalog;
    zoneId: typeof zoneId; tabId: typeof tabId; regionId: typeof regionId; expectedAgent: typeof expectedAgent; name: string } | null>(null)
  const [observation, setObservation] = useState<{ client: typeof client; key: string; issue: string } | null>(null)
  const [revision, refresh] = useState(0)
  const current = useRef({ client, key, visible, accepted }); current.current = { client, key, visible, accepted }
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const catalog = accepted?.catalog ?? null
  const locationIndex = useMemo(() => mobileAgentLocations(catalog), [catalog])
  const currentAccepted = accepted?.client === client && accepted.key === key
  const isCurrent = () => mounted.current && current.current.visible && accepted === current.current.accepted && accepted?.client === current.current.client && accepted.key === current.current.key
  const beforeAction = () => {
    if (isCurrent()) return true
    if (mounted.current) setObservation({ client: current.current.client, key: current.current.key, issue: '显示的是原来源已读内容；请重新读取当前目录后再打开 Agent。原文件和草稿保持原来源。' })
    return false
  }
  const issue = observation?.client === client && observation.key === key ? observation.issue : ''
  const pendingIssue = accepted && !currentAccepted ? '当前来源或位置尚未确认，仍显示原来源已读内容；原文件和草稿保持原来源。' : ''
  useEffect(() => {
    if (!visible) return
    setObservation({ client, key, issue: '' })
    if (!client?.forwardRpc || !zoneId && !tabId) {
      setObservation({ client, key, issue: !client?.forwardRpc ? '当前来源连接尚未确认，原已读内容和草稿仍保留。' : '这个 Zone 或 Tab 还没确认，请刷新目录。' }); return
    }
    let live = true
    const controller = new AbortController()
    void client.forwardRpc(zoneId ? 'space.ls' : 'space.inspect', { target: zoneId ? { zoneId } : { tabId: tabId! }, presentation: 'status' }, { signal: controller.signal }).then(value => {
      if (live) { setAccepted(previous => ({ client, key, contentOwner: previous?.client === client ? previous.contentOwner : (previous?.contentOwner ?? 0) + 1, catalog: value.catalog, zoneId, tabId, regionId, expectedAgent, name })); setObservation({ client, key, issue: '' }) }
    }).catch(error => { if (live) setObservation({ client, key, issue: error instanceof Error ? error.message : String(error) }) })
    return () => { live = false; controller.abort() }
  }, [client, key, visible, revision])
  return <MobileNoticeScope owner={client} identity={[zoneId,tabId,regionId]}><section className="mobile-zone-workface" aria-label={`${name} 的讨论与内容`}>
    <div className="mobile-zone-tools"><MobileDirectoryNotice issues={issue || pendingIssue ? [{ source: name, message: issue || pendingIssue }] : []} retry={() => refresh(value => value + 1)} />{zoneId && onCreateAgent && <button className="mobile-icon-button" aria-label="在此 Topic 新建 Agent" onClick={() => onCreateAgent({ zoneId })}><SemanticIcon name="action.create-agent" size={18} /></button>}<button className="mobile-icon-button" aria-label="刷新讨论" onClick={() => refresh(value => value + 1)}><SemanticIcon name="action.refresh" size={17} /></button></div>
    {catalog?.tabs.filter(tab => !accepted!.tabId || tab.tabId === accepted!.tabId).map(tab => <section key={tab.tabId}>
      <h2 className="mobile-spatial-subheading">{tab.name || '讨论'}</h2>
      {catalog.regions.filter(region => region.tabId === tab.tabId && (!accepted!.regionId || region.regionId === accepted!.regionId)).map(region => {
        if (accepted!.expectedAgent !== undefined && (accepted!.expectedAgent === null ? region.kind !== 'launcher' || region.agentSessionId !== null
          : region.kind !== 'agent' || region.agentSessionId !== accepted!.expectedAgent.agentSessionId || region.execution?.hostId !== accepted!.expectedAgent.hostId))
          return <p key={region.regionId} className="mobile-spatial-notice">这个讨论还没确认对应的 Mac 与对话，收件人不变。</p>
        const agent = catalog.agentPresentation?.find(value => value.agentSessionId === region.agentSessionId)
        const occurrences = catalog.locations.filter(place => place.tabId === tab.tabId && place.regionId === region.regionId)
        const identity = (occurrence?: typeof occurrences[number], choice?: MobileAgentLocationChoice): MobileObjectIdentity => {
          const context = choice?.place ?? occurrence
          const member = choice ? choice.member : mobileMemberSelection(accepted!.client, catalog, region.agentSessionId!, context)
          return { name: agent?.name ?? tab.name ?? accepted!.name, project: agent?.project ?? accepted!.name, ...(context ? { context } : {}), ...(member ? { member } : {}) }
        }
        return region.agentSessionId ? <div key={region.regionId} className="mobile-agent-row"><MobileAgentRow agentSessionId={region.agentSessionId} beforeMenu={beforeAction} identity={identity(occurrences.length === 1 ? occurrences[0] : undefined)} presentation={agent} location={{ catalog, current: isCurrent, group: locationIndex.byAgent.get(agentLocationKey(region.execution?.hostId ?? null, region.agentSessionId)), onChoose: choice => { if (beforeAction()) openSession(region.agentSessionId!, identity(undefined, choice)) } }} onOpen={() => { if (beforeAction()) openSession(region.agentSessionId!, identity(occurrences.length === 1 ? occurrences[0] : undefined)) }}>
          <MobileAgentRowContent title={agent?.name ?? tab.name ?? accepted!.name} presentation={agent} providerId={agent?.providerId} />
        </MobileAgentRow></div> : region.kind === 'file' || region.kind === 'browser' ? <MobileRegionContent visible={visible} key={JSON.stringify([accepted!.contentOwner, region.regionId])} client={accepted!.client} tabId={tab.tabId} regionId={region.regionId} kind={region.kind} browserId={region.browserId} file={region.file} zoneId={accepted!.zoneId ?? tab.zoneId} />
          : <p key={region.regionId} className="mobile-spatial-notice">{region.kind === 'launcher' ? '此讨论尚未启动 Agent。' : '终端工作面'}</p>
      })}
    </section>)}
    {catalog && !catalog.tabs.length && <p className="mobile-spatial-empty">此 Topic 暂无讨论。</p>}
  </section></MobileNoticeScope>
}
