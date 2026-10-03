import { useEffect, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { MobileRegionContent } from './MobileRegionContent'
import type { MobileObjectIdentity } from './MobileIdentity'

/** Topic discussions and original content use the same public Zone and Region identities. */
export function MobileZoneWorkface({ client, zoneId, name, visible, openSession, tabId, regionId }: {
  client: AgentMuxHostedClient | null; zoneId?: string | undefined; name: string; visible: boolean
  openSession(id: string, identity: MobileObjectIdentity): void
  tabId?: string | undefined; regionId?: string | undefined
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
  return <section className="mobile-zone-workface" aria-label={`${name} 的讨论与内容`}>
    {issue && <p className="mobile-spatial-notice" role="status">{issue}</p>}
    <button className="mobile-text-button" onClick={() => refresh(value => value + 1)}>刷新讨论</button>
    {catalog?.tabs.filter(tab => !tabId || tab.tabId === tabId).map(tab => <section key={tab.tabId}>
      <h2 className="mobile-spatial-subheading">{tab.name || '讨论'}</h2>
      {catalog.regions.filter(region => region.tabId === tab.tabId && (!regionId || region.regionId === regionId)).map(region => {
        const agent = catalog.agentPresentation?.find(value => value.agentSessionId === region.agentSessionId)
        return region.agentSessionId ? <button key={region.regionId} className="mobile-menu-row" onClick={() => openSession(region.agentSessionId!, { name: agent?.name ?? tab.name ?? name, project: name })}>
          <span>{agent?.name ?? tab.name ?? name}<small>{agent?.recap?.text ?? agent?.detail ?? '打开原对话'}</small></span>
        </button> : region.kind === 'file' || region.kind === 'browser' ? <MobileRegionContent visible={visible} key={region.regionId} client={client} tabId={tab.tabId} regionId={region.regionId} kind={region.kind} browserId={region.browserId} file={region.file} zoneId={zoneId ?? tab.zoneId} />
          : <p key={region.regionId} className="mobile-spatial-notice">{region.kind === 'launcher' ? '此讨论尚未启动 Agent。' : '终端工作面'}</p>
      })}
    </section>)}
    {catalog && !catalog.tabs.length && <p className="mobile-spatial-empty">此 Topic 暂无讨论。</p>}
  </section>
}
