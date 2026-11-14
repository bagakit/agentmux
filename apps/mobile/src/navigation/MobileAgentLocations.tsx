import { useEffect, useId, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxSpaceAddress, AgentMuxSpaceCatalog } from '@agentmux/core/control'
import * as Dialog from '@agentmux/client-ui/components/Modal'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import { describeAgentWorkLocationChoices, type AgentWorkLocationAddressField } from '@agentmux/client-ui/patterns/agent-work-location'
import { MobileSheetHeader } from './MobileSheetHeader'
import { mobileMemberSelection } from './mobile-member-target'
import { confirmsAgentLocation, locationContextKey, locationPositionKey, type MobileAgentLocationChoice, type MobileAgentLocations as Locations } from './mobile-agent-locations'
import './agent-locations.css'

/** Two Mobile directory consumers share disclosure, not a navigation or execution owner. */
export function MobileAgentLocations({ client, catalog, locations, agentSessionId, name, visible, onChoose, beforeChoose, open, onOpenChange }: {
  client: AgentMuxHostedClient | null; catalog: AgentMuxSpaceCatalog | null; locations: Locations | undefined
  agentSessionId: string; name: string; visible: boolean; open: boolean; onOpenChange(open: boolean): void; beforeChoose?(): boolean; onChoose(choice: MobileAgentLocationChoice): void
}) {
  const [issue, setIssue] = useState(''), [pending, setPending] = useState(false)
  const reading = useRef<AbortController | undefined>(undefined)
  const description = useId(), mounted = useRef(false), request = useRef(0)
  const current = useRef({ client, agentSessionId, hostId: locations?.hostId, visible, open, onChoose, beforeChoose })
  current.current = { client, agentSessionId, hostId: locations?.hostId, visible, open, onChoose, beforeChoose }
  useEffect(() => {
    request.current++; reading.current?.abort(); setPending(false)
    if (current.current.open) setIssue('连接或目标已改变，这次没有打开；请在当前目录重新选择。')
    return () => reading.current?.abort()
  }, [client, agentSessionId, locations?.hostId, visible])
  useEffect(() => { if (!open) { request.current++; reading.current?.abort(); setPending(false) } }, [open])
  // The callback ref also fences a late response after its row has unmounted.
  const anchor = (node: HTMLButtonElement | null) => { mounted.current = node !== null }
  const summary = catalog ? locations?.summary : undefined
  const known = summary?.state === 'confirmed'
  const label = known ? `${summary.count} 个位置` : '位置待确认'
  const groups = new Map<string, { key: string; title: string; detail: string; address: AgentWorkLocationAddressField[]; entries: {
    place: AgentMuxSpaceAddress; title: string; detail: string; address: AgentWorkLocationAddressField[]
  }[] }>()
  if (open) for (const place of locations?.addresses ?? []) {
    const tab = catalog?.tabs.find(value => value.tabId === place.tabId)
    const space = catalog?.spaces.find(value => value.spaceId === place.spaceId)
    const zone = catalog?.zones.find(value => value.zoneId === place.zoneId)
    const key = locationPositionKey(place)
    const title = tab?.name && !['Tab', 'Agent', 'Untitled', '未命名'].includes(tab.name) ? tab.name : '工作面'
    const group = groups.get(key) ?? { key, title, detail: '', address: [
      { label: '区域', value: place.regionId }, { label: '标签', value: place.tabId },
      { label: '分组', value: place.groupId }, { label: '显示工作区', value: place.displayWorkspaceId }
    ], entries: [] }
    const kind = space?.kind === 'mote' ? 'Mote' : space?.kind === 'folder' ? '文件夹' : '空间'
    const path = (zone?.directoryPath ?? space?.directoryPath ?? '').split('/').filter(Boolean).slice(-2).join('/')
    const resourceHost = zone?.hostId ?? space?.hostId
    group.entries.push({
      place, title: space?.name ?? '未绑定空间',
      detail: [kind, zone?.branch, path, resourceHost && resourceHost !== locations?.hostId ? `资源端 ${resourceHost}` : undefined].filter(Boolean).join(' · '),
      address: [{ label: '空间', value: place.spaceId ?? '未绑定' }, { label: '区域容器', value: place.zoneId ?? '未绑定' },
        { label: '资源工作区', value: place.workspaceId }]
    })
    groups.set(key, group)
  }
  const choices = describeAgentWorkLocationChoices([...groups.values()])
  async function choose(place: AgentMuxSpaceAddress) {
    const source = current.current, runtime = source.client?.runtimeOwnerIdentity(), operation = ++request.current
    if (source.beforeChoose && !source.beforeChoose()) { setIssue('原菜单或位置已改变，请重新打开。'); return }
    if (!source.client?.forwardRpc || !source.hostId || !catalog) { setIssue('这个位置还没确认，对话仍可打开。'); return }
    const stillCurrent = () => mounted.current && operation === request.current && current.current.client === source.client &&
      current.current.agentSessionId === source.agentSessionId && current.current.hostId === source.hostId && current.current.open && current.current.visible
    reading.current?.abort()
    const controller = new AbortController(); reading.current = controller
    setPending(true); setIssue('')
    try {
      const { spaceId, zoneId, displayWorkspaceId, groupId, tabId, regionId } = place
      const value = await source.client.forwardRpc('space.inspect', { target: { ...(spaceId ? { spaceId } : {}), ...(zoneId ? { zoneId } : {}), displayWorkspaceId, groupId, tabId, regionId }, presentation: 'status' }, { signal: controller.signal })
      const now = current.current, owner = now.client?.runtimeOwnerIdentity()
      const sameOwner = Boolean(runtime && owner && runtime.runtimeId === owner.runtimeId && runtime.ownerInstanceId === owner.ownerInstanceId)
      if (!mounted.current || operation !== request.current) return
      if (!stillCurrent() || !sameOwner || now.beforeChoose && !now.beforeChoose()) {
        setIssue('读取期间连接或目标已改变，这次没有打开；请在当前目录重新选择。'); return
      }
      if (!confirmsAgentLocation(value.catalog, source.hostId, source.agentSessionId, place, catalog)) {
        setIssue('这个位置已变化或还没确认，这次没有打开；可重新读取此位置。'); return
      }
      const member = mobileMemberSelection(source.client, value.catalog, source.agentSessionId, place, source.hostId)
      if (member?.issue) { setIssue(member.issue); return }
      now.onChoose({ place, member })
      changeOpen(false)
    } catch (error) {
      const owner = current.current.client?.runtimeOwnerIdentity()
      if (stillCurrent()) setIssue(runtime?.runtimeId !== owner?.runtimeId || runtime?.ownerInstanceId !== owner?.ownerInstanceId
        ? '读取期间连接已改变，这次没有打开；请在当前目录重新选择。'
        : `位置暂时读不到，对话仍可打开。${error instanceof Error ? error.message : String(error)}`)
    }
    finally { if (reading.current === controller) reading.current = undefined; if (stillCurrent()) setPending(false) }
  }
  const changeOpen = (value: boolean) => { request.current++; reading.current?.abort(); setPending(false); if (value) setIssue(''); onOpenChange(value) }
  return <Dialog.Root open={open} onOpenChange={changeOpen}><Dialog.Trigger asChild>
    <button ref={anchor} type="button" className="mobile-menu-row mobile-agent-locations-entry" aria-label={`${name} · ${label}`} title="查看展示位置"><SemanticIcon name="object.region" size={15} /><span>查看展示位置<small>{label}</small></span><SemanticIcon name="navigation.disclosure" size={16} /></button>
  </Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="mobile-sheet-backdrop" /><Dialog.Content className="mobile-sheet mobile-agent-locations-sheet" aria-describedby={description}>
    <MobileSheetHeader onClose={() => changeOpen(false)} title={`${name}的位置`} closeLabel="关闭位置选择" />
    <Dialog.Description id={description}>{label}{known && locations && locations.addresses.length > summary.count ? `，${locations.addresses.length} 个空间入口` : ''}{locations?.hostId ? ` · 执行端 ${locations.hostId}` : ''}</Dialog.Description>
    {(issue || pending) && <p role="status" className="mobile-agent-locations-issue">{pending ? '正在核对这个位置…' : issue}</p>}
    {!locations?.addresses.length && <p>{known ? '当前目录没有展示位置，对话入口仍可使用。' : '位置还没确认，对话入口仍可使用；请返回目录刷新。'}</p>}
    {open && <div className="mobile-agent-locations-list" aria-busy={pending}>{choices.map(group => <section key={group.key} className="mobile-agent-location-group" aria-label={`${group.title} ${group.detail}`.trim()}>
      <header><strong>{group.title}</strong>{group.detail && <small>{group.detail}</small>}</header>
      {describeAgentWorkLocationChoices(group.entries).map(({ place, title, detail }) => <section key={locationContextKey(place)} className="mobile-agent-location">
        <button type="button" className="mobile-menu-row" onClick={() => void choose(place)}><span><strong>{title}</strong><small>{detail}</small></span><SemanticIcon name="navigation.disclosure" size={16} /></button>
        <details><summary aria-label={`完整地址 · ${title} · ${detail}`}>地址</summary><dl>{Object.entries(place).map(([field, value]) => <div key={field}><dt>{field}</dt><dd>{value ?? '未绑定'}</dd></div>)}</dl></details>
      </section>)}
    </section>)}</div>}
  </Dialog.Content></Dialog.Portal></Dialog.Root>
}
