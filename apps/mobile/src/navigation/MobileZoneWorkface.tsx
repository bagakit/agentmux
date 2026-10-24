import { MobileNotice, MobileNoticeScope } from '../notices/MobileNotice'
import { useEffect, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { MobileRegionContent } from './MobileRegionContent'
import type { MobileObjectIdentity } from './MobileIdentity'
import { MobileAgentRow } from './MobileAgentRow'

/** Topic discussions and original content use the same public Zone and Region identities. */
export function MobileZoneWorkface({ client, zoneId, name, visible, openSession, tabId, regionId, expectedAgent, onCreateAgent }: {
  client: AgentMuxHostedClient | null; zoneId?: string | undefined; name: string; visible: boolean
  openSession(id: string, identity: MobileObjectIdentity): void
  tabId?: string | undefined; regionId?: string | undefined; expectedAgent?: { hostId: string; agentSessionId: string } | null; onCreateAgent?(target: { spaceId?: string; zoneId?: string }): void
}) {
  const [catalog, setCatalog] = useState<AgentMuxSpaceCatalog | null>(null)
  const [issue, setIssue] = useState('')
  const [revision, refresh] = useState(0)
  useEffect(() => {
    if (!visible || !client?.forwardRpc) return
    let live = true
    if (!zoneId && !tabId) { setIssue('原 Zone 或 Tab 身份尚未确认，原工作面保留。'); return }
    void client.forwardRpc(zoneId ? 'space.ls' : 'space.inspect', { target: zoneId ? { zoneId } : { tabId: tabId! }, presentation: true }).then(value => {
      if (live) { setCatalog(value.catalog); setIssue('') }
    }).catch(error => { if (live) setIssue(error instanceof Error ? error.message : String(error)) })
    return () => { live = false }
  }, [client, zoneId, tabId, visible, revision])
  return <MobileNoticeScope owner={client} identity={[zoneId,tabId,regionId]}><section className="mobile-zone-workface" aria-label={`${name} 的讨论与内容`}>
    {issue && <MobileNotice owner={client} identity={[zoneId,tabId,regionId,issue]} className="mobile-spatial-notice" role="status">{issue}</MobileNotice>}
    <div className="mobile-zone-tools">{zoneId && onCreateAgent && <button className="mobile-icon-button" aria-label="在此 Topic 新建 Agent" onClick={() => onCreateAgent({ zoneId })}><SemanticIcon name="action.create-agent" size={18} /></button>}<button className="mobile-icon-button" aria-label="刷新讨论" onClick={() => refresh(value => value + 1)}><SemanticIcon name="action.refresh" size={17} /></button></div>
    {catalog?.tabs.filter(tab => !tabId || tab.tabId === tabId).map(tab => <section key={tab.tabId}>
      <h2 className="mobile-spatial-subheading">{tab.name || '讨论'}</h2>
      {catalog.regions.filter(region => region.tabId === tab.tabId && (!regionId || region.regionId === regionId)).map(region => {
        if (expectedAgent !== undefined && (expectedAgent === null ? region.kind !== 'launcher' || region.agentSessionId !== null
          : region.kind !== 'agent' || region.agentSessionId !== expectedAgent.agentSessionId || region.execution?.hostId !== expectedAgent.hostId))
          return <p key={region.regionId} className="mobile-spatial-notice">原讨论 Region 当前未确认保存的执行 Host 与 Session；原关系保留，不替换收件人。</p>
        const agent = catalog.agentPresentation?.find(value => value.agentSessionId === region.agentSessionId)
        const occurrences = catalog.locations.filter(place => place.tabId === tab.tabId && place.regionId === region.regionId)
        const identity = (context?: typeof occurrences[number]): MobileObjectIdentity => ({ name: agent?.name ?? tab.name ?? name, project: agent?.project ?? name, ...(context ? { context } : {}) })
        return region.agentSessionId ? <div key={region.regionId} className="mobile-agent-row"><MobileAgentRow agentSessionId={region.agentSessionId} identity={identity(occurrences.length === 1 ? occurrences[0] : undefined)} className="mobile-menu-row" onOpen={() => openSession(region.agentSessionId!, identity(occurrences.length === 1 ? occurrences[0] : undefined))}>
          <span>{agent?.name ?? tab.name ?? name}<small>{agent?.recap?.text ?? agent?.detail ?? '打开原对话'}</small></span>
        </MobileAgentRow>{occurrences.length > 1 && <details className="mobile-session-locations"><summary>{occurrences.length} 个原展示位置</summary>{occurrences.map(place => <button type="button" key={JSON.stringify(place)} onClick={() => openSession(region.agentSessionId!, identity(place))}>{catalog.spaces.find(space => space.spaceId === place.spaceId)?.name ?? name} · {place.displayWorkspaceId} / {place.groupId}</button>)}</details>}</div> : region.kind === 'file' || region.kind === 'browser' ? <MobileRegionContent visible={visible} key={region.regionId} client={client} tabId={tab.tabId} regionId={region.regionId} kind={region.kind} browserId={region.browserId} file={region.file} zoneId={zoneId ?? tab.zoneId} />
          : <p key={region.regionId} className="mobile-spatial-notice">{region.kind === 'launcher' ? '此讨论尚未启动 Agent。' : '终端工作面'}</p>
      })}
    </section>)}
    {catalog && !catalog.tabs.length && <p className="mobile-spatial-empty">此 Topic 暂无讨论。</p>}
  </section></MobileNoticeScope>
}
