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
  const groups = new Map<string, { title: string; path: string; regionId: string; entries: { place: AgentMuxSpaceAddress; title: string; detail: string }[] }>()
  if (open) for (const place of locations?.addresses ?? []) {
    const tab = catalog?.tabs.find(value => value.tabId === place.tabId), space = catalog?.spaces.find(value => value.spaceId === place.spaceId)
    const zone = catalog?.zones.find(value => value.zoneId === place.zoneId)
    const positionKey = JSON.stringify([place.displayWorkspaceId, place.groupId, place.tabId, place.regionId])
    const sourcePath = zone?.directoryPath ?? space?.directoryPath ?? ''
    const path = sourcePath.split('/').filter(Boolean).slice(-2).join('/')
    const title = tab?.name && !['Tab', 'Agent', 'Untitled', '未命名'].includes(tab.name) ? tab.name : '工作面'
    const group = groups.get(positionKey) ?? { title, path, regionId: place.regionId, entries: [] }
    const kind = space?.kind === 'mote' ? 'Mote' : space?.kind === 'folder' ? '文件夹' : '空间'
    group.entries.push({ place, title: space?.name ?? '未绑定空间', detail: [kind, zone?.branch].filter(Boolean).join(' · ') })
    groups.set(positionKey, group)
  }
  const headings = new Map<string, number>()
  for (const group of groups.values()) { const key = `${group.title}\n${group.path}`; headings.set(key, (headings.get(key) ?? 0) + 1) }
  async function choose(place: AgentMuxSpaceAddress) {
    const source = current.current, runtime = client?.runtimeOwnerIdentity(), operation = ++request.current
    if (!source.client?.forwardRpc || !source.hostId) { setIssue('这个位置还没确认，对话仍可打开。'); return }
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
      if (stillCurrent()) setIssue(runtime?.runtimeId !== owner?.runtimeId || runtime?.ownerInstanceId !== owner?.ownerInstanceId
        ? '读取期间连接已改变，这次没有打开；请在当前目录重新选择。'
        : `位置暂时读不到，对话仍可打开。${error instanceof Error ? error.message : String(error)}`)
    }
    finally { if (stillCurrent()) setPending(false) }
  }
  return <Dialog.Root open={open} onOpenChange={value => { request.current++; setPending(false); setOpen(value); if (value) setIssue('') }}><Dialog.Trigger asChild>
    <button ref={anchor} type="button" className="mobile-agent-locations-entry" aria-label={`${name} · ${label}`} title="查看展示位置"><SemanticIcon name="object.region" size={15} /><span>{known ? locations?.count ?? 0 : '?'}</span></button>
  </Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="mobile-sheet-backdrop" /><Dialog.Content className="mobile-sheet mobile-agent-locations-sheet" aria-describedby={description}>
    <MobileSheetHandle onClose={() => setOpen(false)} /><div className="mobile-sheet-title"><Dialog.Title>{name}的位置</Dialog.Title>
      <Dialog.Close asChild><IconButton className="mobile-icon-button" aria-label="关闭位置选择"><SemanticIcon name="action.close" size={18} /></IconButton></Dialog.Close></div>
    <Dialog.Description id={description}>{label}{locations && locations.addresses.length > locations.count ? `，${locations.addresses.length} 个空间入口。` : ' · 选择要查看的工作面。'}</Dialog.Description>
    {issue && <p role="status" className="mobile-agent-locations-issue">{issue}</p>}
    {!locations?.addresses.length && <p>{known ? '当前目录没有展示位置，对话入口仍可使用。' : '位置还没确认，对话入口仍可使用；请返回目录刷新。'}</p>}
    {open && <div className="mobile-agent-locations-list" aria-busy={pending}>{[...groups].map(([key, group]) => <section key={key} className="mobile-agent-location-group" aria-label={`${group.title}的位置`}>
      <header><strong>{group.title}</strong>{group.path && <small>{group.path}</small>}{headings.get(`${group.title}\n${group.path}`)! > 1 && <small>区域 {group.regionId}</small>}</header>
      {group.entries.map(({ place, title, detail }) => <section key={locationContextKey(place)} className="mobile-agent-location">
        <button type="button" className="mobile-menu-row" onClick={() => void choose(place)}><span><strong>{title}</strong><small>{detail}</small></span><SemanticIcon name="navigation.disclosure" size={16} /></button>
        <details><summary aria-label={`${title}的完整地址`}>地址</summary><dl>{Object.entries(place).map(([field, value]) => <div key={field}><dt>{field}</dt><dd>{value ?? '未绑定'}</dd></div>)}</dl></details>
      </section>)}
    </section>)}</div>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}
