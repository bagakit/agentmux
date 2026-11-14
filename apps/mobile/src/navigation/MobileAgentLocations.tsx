import { useEffect, useId, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxSpaceAddress, AgentMuxSpaceCatalog } from '@agentmux/core/control'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { IconButton } from '@agentmux/client-ui/components/IconButton'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { MobileSheetHandle } from './MobileSheetHandle'
import { confirmsAgentLocation, locationContextKey, type MobileAgentLocations as Locations } from './mobile-agent-locations'
import './agent-locations.css'

/** Two Mobile directory consumers share disclosure, not a navigation or execution owner. */
export function MobileAgentLocations({ client, catalog, locations, agentSessionId, name, visible, onChoose }: {
  client: AgentMuxHostedClient | null; catalog: AgentMuxSpaceCatalog | null; locations: Locations | undefined
  agentSessionId: string; name: string; visible: boolean; onChoose(place: AgentMuxSpaceAddress): void
}) {
  const [open, setOpen] = useState(false), [issue, setIssue] = useState(''), [pending, setPending] = useState(false)
  const description = useId(), mounted = useRef(false), request = useRef(0)
  const current = useRef({ client, agentSessionId, hostId: locations?.hostId, visible, open, onChoose })
  current.current = { client, agentSessionId, hostId: locations?.hostId, visible, open, onChoose }
  useEffect(() => {
    request.current++; setPending(false)
    if (current.current.open) setIssue('连接或目标已改变，这次没有打开；请在当前目录重新选择。')
  }, [client, agentSessionId, locations?.hostId, visible])
  // The callback ref also fences a late response after its row has unmounted.
  const anchor = (node: HTMLButtonElement | null) => { mounted.current = node !== null }
  const known = catalog !== null && Boolean(locations?.hostId)
  const label = known ? `${locations?.count ?? 0} 个位置` : '位置待确认'
  const entries = open ? (locations?.addresses ?? []).map(place => {
    const tab = catalog?.tabs.find(value => value.tabId === place.tabId), space = catalog?.spaces.find(value => value.spaceId === place.spaceId)
    const zone = catalog?.zones.find(value => value.zoneId === place.zoneId)
    const title = tab?.name && tab.name !== name && !['Tab', 'Agent', 'Untitled', '未命名'].includes(tab.name) ? tab.name : space?.name ?? '展示位置'
    const detail = [title !== space?.name ? space?.name : '', zone?.branch, locations?.hostId].filter(Boolean).join(' · ')
    return { place, title, detail, label: `${title}\n${detail}` }
  }) : []
  const labels = new Map<string, number>()
  for (const entry of entries) labels.set(entry.label, (labels.get(entry.label) ?? 0) + 1)
  async function choose(place: AgentMuxSpaceAddress) {
    const source = current.current, runtime = client?.runtimeOwnerIdentity(), operation = ++request.current
    if (!source.client?.forwardRpc || !source.hostId) { setIssue('此位置的来源或目录读取还没确认，原对话仍可打开。'); return }
    const stillCurrent = () => mounted.current && operation === request.current && current.current.client === source.client &&
      current.current.agentSessionId === source.agentSessionId && current.current.hostId === source.hostId && current.current.open && current.current.visible
    setPending(true); setIssue('')
    try {
      const { spaceId, zoneId, displayWorkspaceId, groupId, tabId, regionId } = place
      const value = await source.client.forwardRpc('space.inspect', { target: { ...(spaceId ? { spaceId } : {}), ...(zoneId ? { zoneId } : {}), displayWorkspaceId, groupId, tabId, regionId }, presentation: true })
      const now = current.current, owner = now.client?.runtimeOwnerIdentity()
      const sameOwner = Boolean(runtime && owner && runtime.runtimeId === owner.runtimeId && runtime.ownerInstanceId === owner.ownerInstanceId)
      if (!mounted.current) return
      if (operation !== request.current) return
      if (operation !== request.current || now.client !== source.client || now.agentSessionId !== source.agentSessionId || now.hostId !== source.hostId || !sameOwner || !now.visible || !now.open) {
        setIssue('读取期间连接或目标已改变，这次没有打开；请在当前目录重新选择。'); return
      }
      if (!confirmsAgentLocation(value.catalog, source.hostId, source.agentSessionId, place)) {
        setIssue('这个位置已变化或还没确认，这次没有打开；可重新读取此位置。'); return
      }
      now.onChoose(place); setOpen(false)
    } catch (error) {
      const owner = current.current.client?.runtimeOwnerIdentity()
      if (stillCurrent() && runtime?.runtimeId === owner?.runtimeId && runtime?.ownerInstanceId === owner?.ownerInstanceId)
        setIssue(`位置暂时读不到，原对话仍可打开。${error instanceof Error ? error.message : String(error)}`)
    }
    finally { if (stillCurrent()) setPending(false) }
  }
  return <Dialog.Root open={open} onOpenChange={value => { request.current++; setPending(false); setOpen(value); if (value) setIssue('') }}><Dialog.Trigger asChild>
    <button ref={anchor} type="button" className="mobile-agent-locations-entry" aria-label={`${name} · ${label}`} title="查看展示位置"><SemanticIcon name="object.region" size={15} /><span>{known ? locations?.count ?? 0 : '?'}</span></button>
  </Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="mobile-sheet-backdrop" /><Dialog.Content className="mobile-sheet mobile-agent-locations-sheet" aria-describedby={description}>
    <MobileSheetHandle onClose={() => setOpen(false)} /><div className="mobile-sheet-title"><Dialog.Title>{name}的位置</Dialog.Title>
      <Dialog.Close asChild><IconButton className="mobile-icon-button" aria-label="关闭位置选择"><SemanticIcon name="action.close" size={18} /></IconButton></Dialog.Close></div>
    <Dialog.Description id={description}>{label} · 选择要查看的工作面。</Dialog.Description>
    {issue && <p role="status" className="mobile-agent-locations-issue">{issue}</p>}
    {!locations?.addresses.length && <p>{known ? '当前目录没有已绑定的展示位置，原对话入口仍可使用。' : '位置事实还没确认，原对话入口仍可使用；可返回目录刷新。'}</p>}
    {open && <div className="mobile-agent-locations-list" aria-busy={pending}>{entries.map(({ place, title, detail, label: entryLabel }) => {
      const short = (value: string) => value.length > 8 ? value.slice(0, 8) : value
      const distinguish = labels.get(entryLabel)! > 1 ? [short(place.groupId), short(place.regionId), place.spaceId ? short(place.spaceId) : '未绑定空间'].join(' · ') : ''
      return <section key={locationContextKey(place)} className="mobile-agent-location">
        <button type="button" className="mobile-menu-row" onClick={() => void choose(place)}><span><strong>{title}</strong><small>{detail}</small>{distinguish && <small>{distinguish}</small>}</span><SemanticIcon name="navigation.disclosure" size={16} /></button>
        <details><summary>完整地址</summary><dl>{Object.entries(place).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value ?? '未绑定'}</dd></div>)}</dl></details>
      </section>
    })}</div>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}
