import * as ContextMenu from '@radix-ui/react-context-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { useSessionRestart } from './SessionRestart'
import { agentRegionExecution, useAppStore } from '../store'
import { agentSessionPresentationIndex } from '../lib/session-presentation'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { formatRegionAddress, formatSessionAddress } from '../lib/agent-address'
import type { RegionSwapMenuEntry, WorkbenchSplitMenuEntry } from '../lib/workbench-tab-actions'
import { WorkbenchLayoutMenuRows } from './WorkbenchLayoutMenuRows'
import { DocumentOverlayPortal } from './WindowOverlayHost'
import { WorkbenchMenuSubmenu } from './WorkbenchMenuSubmenu'
import { WorkbenchCopyLinkRow } from './WorkbenchCopyLinkRow'

const ThemeActionCopyIcon = semanticIconComponent('action.copy')
const ThemeActionCopyAddressIcon = semanticIconComponent('action.copy-address')
const ThemeActionReplaceIcon = semanticIconComponent('action.replace')
const ThemeActionRestartIcon = semanticIconComponent('action.restart-session')
const ThemeActionStopIcon = semanticIconComponent('action.stop')
const ThemeObjectConversationsIcon = semanticIconComponent('object.conversations')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const AgentIcon = semanticIconComponent('object.agent')
const RegionIcon = semanticIconComponent('object.region')
const InformationIcon = semanticIconComponent('status.info')


type RegionCopyAction = {
  label: 'Copy Region Link' | 'Copy Agent Link'
  onSelect(): Promise<void>
}

export type RegionMenuEntry =
  | { kind: 'action'; action: RegionCopyAction }
  | { kind: 'separator' }
  | { kind: 'connector-group'; group: ConnectorMenuGroup }
  | { kind: 'layout'; entries: readonly WorkbenchSplitMenuEntry[] }
  | { kind: 'swaps'; entries: readonly RegionSwapMenuEntry[] }
  | { kind: 'restart'; onSelect(): void }
  | { kind: 'stop'; onSelect(): void }
  | { kind: 'promote'; onSelect(): void }
  | { kind: 'window'; onSelect(): void }

type ConnectorMenuGroup = { label: string; entries: readonly { label: string; onSelect(): void }[]; issue: string }
export type RegionConnectorControls = { group: ConnectorMenuGroup | null; onOpen(open: boolean): void; dialogOpen: boolean }
const NO_CONNECTOR: RegionConnectorControls = { group: null, onOpen: () => {}, dialogOpen: false }

/** Links target the clicked Region and its stable semantic Agent separately. */
export type RegionCopyModel = {
  regionAddress: RegionCopyAction
  sessionAddress?: RegionCopyAction
  entries: readonly RegionMenuEntry[]
}

export function createRegionCopyModel({
  regionId,
  agentSessionId,
  writeClipboardText,
  splitMenu,
  swapMenu,
  promote
}: {
  regionId: string
  agentSessionId: string | null
  writeClipboardText(text: string): Promise<void>
  splitMenu?: readonly WorkbenchSplitMenuEntry[]
  swapMenu?: readonly RegionSwapMenuEntry[]
  promote?: (() => void) | undefined
}): RegionCopyModel {
  const copy = async (text: string, label: RegionCopyAction['label']): Promise<void> => {
    try {
      await writeClipboardText(text)
    } catch (error) {
      console.warn(`[region] failed to ${label.toLowerCase()}`, error)
    }
  }
  const actions: Omit<RegionCopyModel, 'entries'> = {
    regionAddress: {
      label: 'Copy Region Link',
      onSelect: async () => copy(formatRegionAddress(regionId), 'Copy Region Link')
    },
    ...(agentSessionId
      ? {
          sessionAddress: {
            label: 'Copy Agent Link' as const,
            onSelect: async () => copy(formatSessionAddress(agentSessionId), 'Copy Agent Link')
          }
        }
      : {})
  }
  return { ...actions, entries: regionMenuEntries(actions, splitMenu ?? [], swapMenu ?? [], promote) }
}

function regionMenuEntries(
  model: Omit<RegionCopyModel, 'entries'>,
  splitMenu: readonly WorkbenchSplitMenuEntry[],
  swapMenu: readonly RegionSwapMenuEntry[],
  promote: (() => void) | undefined
): readonly RegionMenuEntry[] {
  const addresses: RegionMenuEntry[] = [
    ...(model.sessionAddress ? [{ kind: 'action' as const, action: model.sessionAddress }] : []),
    { kind: 'action', action: model.regionAddress }
  ]
  const withSplit: RegionMenuEntry[] = splitMenu.length === 0
    ? addresses
    : [...addresses, { kind: 'separator' }, { kind: 'layout', entries: splitMenu }]
  const withSwap: RegionMenuEntry[] = swapMenu.length === 0
    ? withSplit
    : [
        ...withSplit,
        { kind: 'separator' },
        { kind: 'swaps', entries: swapMenu }
      ]
  if (!promote) return withSwap
  return [...withSwap, { kind: 'separator' }, { kind: 'promote', onSelect: promote }]
}

const REGION_MENU_ICONS: Record<RegionCopyAction['label'], typeof ThemeActionCopyIcon> = {
  'Copy Region Link': ThemeActionCopyAddressIcon,
  'Copy Agent Link': ThemeActionCopyIcon
}

export type RegionContextContribution = {
  tools: ReactNode
  /** An existing exact Agent-link callback, independent of spatial observation. */
  agentLink: RegionCopyAction | null
  onCloseAutoFocus?(event: Event): void
}
export type RegionContextSource = { read(): RegionContextContribution }
type ContextualMenu = { source: RegionContextSource; contribution: RegionContextContribution }

const RegionMenuContext = createContext<{
  entries: readonly RegionMenuEntry[]; onOpen(open: boolean): void; dialogOpen: boolean
  moreOpen?: boolean; setAgentMenuAvailable?: (available: boolean) => void
  contextualMenu?: RegionContextContribution | null; contextSource?: RegionContextSource | null
  setContextSource?(source: RegionContextSource | null): void
  refreshContextSource?(source: RegionContextSource): void
  clearContextSource?(source: RegionContextSource): void
  onContextCloseAutoFocus?(event: Event): void
}>({ entries: [], onOpen: () => {}, dialogOpen: false })

export function useRegionMenuEntries(): readonly RegionMenuEntry[] {
  return useContext(RegionMenuContext).entries
}
export const useRegionMenuObservation = () => useContext(RegionMenuContext)

export function RegionCopyLinkRow({ entries, ...primitives }: {
  entries: readonly RegionMenuEntry[]
  Item: typeof ContextMenu.Item
  Group?: typeof ContextMenu.Group
  Label?: typeof ContextMenu.Label
}) {
  return <WorkbenchCopyLinkRow {...primitives} actions={entries.flatMap(entry => entry.kind === 'action'
    ? [{ ...entry.action, icon: entry.action.label === 'Copy Agent Link' ? <AgentIcon size={16} /> : <RegionIcon size={16} /> }]
    : [])} />
}

export function RegionMenuEntryView({ entry, index, Item, Separator, Group = ContextMenu.Group, Label = ContextMenu.Label,
  Sub = ContextMenu.Sub, SubTrigger = ContextMenu.SubTrigger, SubContent = ContextMenu.SubContent, Portal = ContextMenu.Portal }: {
  entry: RegionMenuEntry
  index: number
  Item: typeof ContextMenu.Item
  Separator: typeof ContextMenu.Separator
  Group?: typeof ContextMenu.Group
  Label?: typeof ContextMenu.Label
  Sub?: typeof ContextMenu.Sub
  SubTrigger?: typeof ContextMenu.SubTrigger
  SubContent?: typeof ContextMenu.SubContent
  Portal?: typeof ContextMenu.Portal
}) {
  if (entry.kind === 'connector-group') return <Group aria-label={entry.group.label} data-connector-menu-group="">
    <Separator className="tab-context-menu__separator" data-connector-menu-separator="" />
    {entry.group.entries.length > 0 ? <Label className="agent-connector-menu__label">{entry.group.label}</Label> : null}
    {entry.group.entries.map(action => <Item key={action.label} className="tab-context-menu__item" onSelect={action.onSelect}><ThemeObjectConversationsIcon size={14} /><span>{action.label}</span></Item>)}
    {entry.group.issue ? <WorkbenchMenuSubmenu label={`${entry.group.label} service notice`} icon={<InformationIcon size={14} />}
      Sub={Sub} SubTrigger={SubTrigger} SubContent={SubContent} Portal={Portal}>
      <Label className="agent-region-menu__context" role="status">{entry.group.issue}</Label>
    </WorkbenchMenuSubmenu> : null}
  </Group>
  if (entry.kind === 'separator') {
    return (
      <Separator
        key={`separator-${index}`}
        className="tab-context-menu__separator"
      />
    )
  }
  if (entry.kind === 'layout') return <WorkbenchLayoutMenuRows entries={entry.entries} Item={Item} Group={Group} Label={Label} />
  if (entry.kind === 'swaps') return <WorkbenchMenuSubmenu label="Swap Region…" icon={<ThemeActionReplaceIcon size={14} />}
    Sub={Sub} SubTrigger={SubTrigger} SubContent={SubContent} Portal={Portal} className="region-swap-menu">
        {entry.entries.map(target => <Item key={target.targetRegionId} className="tab-context-menu__item"
          textValue={target.label} title={target.label} onSelect={target.onSelect}>
          <span>{target.label}</span>
        </Item>)}
  </WorkbenchMenuSubmenu>
  if (entry.kind === 'stop') return <Item className="tab-context-menu__item" onSelect={entry.onSelect}><ThemeActionStopIcon size={14} /><span>Stop Agent</span></Item>
  if (entry.kind === 'restart') return <Item className="tab-context-menu__item" onSelect={entry.onSelect}><ThemeActionRestartIcon size={14} /><span>Restart Session…</span></Item>
  if (entry.kind === 'window') return <Item className="tab-context-menu__item" onSelect={entry.onSelect}><ThemeActionOpenExternalIcon size={14} /><span>Open original Region in window</span></Item>
  if (entry.kind === 'promote') {
    return (
      <Item
        key="promote"
        className="tab-context-menu__item"
        onSelect={entry.onSelect}
      >
        <ThemeActionOpenExternalIcon size={14} />
        <span>Move to New Tab</span>
      </Item>
    )
  }
  const Icon = REGION_MENU_ICONS[entry.action.label]
  return (
    <Item
      key={entry.action.label}
      className="tab-context-menu__item"
      onSelect={entry.action.onSelect}
    >
      <Icon size={14} />
      <span>{entry.action.label}</span>
    </Item>
  )
}

export function RegionContextMenu({
  children,
  regionId,
  tabId,
  agentSessionId,
  writeClipboardText,
  splitMenu,
  swapMenu,
  promote,
  onOpenWindow,
  connector = NO_CONNECTOR
}: {
  children: ReactNode
  connector?: RegionConnectorControls
  onOpenWindow?: (() => void) | undefined
  regionId: string
  tabId: string
  agentSessionId: string | null
  writeClipboardText(text: string): Promise<void>
    splitMenu: readonly WorkbenchSplitMenuEntry[]
    swapMenu: readonly RegionSwapMenuEntry[]
  promote?: (() => void) | undefined
}) {
  const active = useWorkbenchPresentationActive()
  const [agentMenuAvailable, setAgentMenuAvailable] = useState(false)
  const [contextOpen, setContextOpen] = useState(false), [moreOpen, setMoreOpen] = useState(false)
  const [contextualMenu, setContextualMenu] = useState<ContextualMenu | null>(null)
  const contextSource = useRef<RegionContextSource | null>(null), closingContext = useRef<ContextualMenu | null>(null)
  const contextOpenRef = useRef(false)
  // Keep cancellation ownership until Content unmounts, even if its source disappears.
  const contextOwnsAutoFocus = useRef(false)
  const setContextSource = useCallback((source: RegionContextSource | null) => { contextSource.current = source }, [])
  const refreshContextSource = useCallback((source: RegionContextSource) => {
    if (!contextOpenRef.current || contextSource.current !== source) return
    const contribution = source.read()
    setContextualMenu(current => current?.source === source ? { source, contribution } : current)
  }, [])
  const clearContextSource = useCallback((source: RegionContextSource) => {
    if (closingContext.current?.source === source) closingContext.current = null
    if (contextSource.current !== source) return
    contextSource.current = null
    if (contextOpenRef.current) setContextualMenu(null)
  }, [])
  const onContextCloseAutoFocus = useCallback((event: Event) => {
    const closing = closingContext.current
    const alreadyPrevented = event.defaultPrevented
    closingContext.current = null
    if (contextOwnsAutoFocus.current) event.preventDefault()
    contextOwnsAutoFocus.current = false
    if (!alreadyPrevented) closing?.contribution.onCloseAutoFocus?.(event)
  }, [])
  function openMore(open: boolean) {
    setMoreOpen(open)
    if (open) {
      contextOpenRef.current = false; contextSource.current = null; closingContext.current = null
      setContextOpen(false); setContextualMenu(null)
    }
    connector.onOpen(open || contextOpen)
  }
  function openContext(open: boolean) {
    contextOpenRef.current = open
    setContextOpen(open)
    if (open) {
      const source = contextSource.current
      contextOwnsAutoFocus.current ||= source !== null
      closingContext.current = null
      setContextualMenu(source ? { source, contribution: source.read() } : null)
      setMoreOpen(false)
    } else {
      closingContext.current = contextualMenu
      contextSource.current = null
      setContextualMenu(null)
    }
    connector.onOpen(open || moreOpen)
  }
  const restart = useSessionRestart(active)
  const origin = useRef<HTMLElement | null>(null)
  const target = useAppStore(state => {
    if ((!contextOpen && !moreOpen) || !agentSessionId) return undefined
    const execution = agentRegionExecution({ tabId, regionId, agentSessionId })
    if (!execution) return undefined
    const matches = (agentSessionPresentationIndex(state.sessions).get(agentSessionId) ?? []).filter(session =>
      session.control.agentSessionId === agentSessionId && session.hostId === execution.hostId && session.control.hostId === execution.hostId)
    return matches.length === 1 ? matches[0] : undefined
  })
  const name = target?.label ?? agentSessionId
  const base = createRegionCopyModel({
    regionId,
    agentSessionId: target?.control.agentSessionId ?? null,
    writeClipboardText,
    splitMenu,
    swapMenu,
    promote
  })
  const model = { ...base, entries: [...base.entries, ...(agentSessionId ? [{ kind: 'separator' as const }, { kind: 'restart' as const, onSelect: () => restart.requestRestart(target, name ?? agentSessionId, origin.current) }] : []), ...(onOpenWindow ? [{ kind: 'window' as const, onSelect: onOpenWindow }] : []), ...(connector.group ? [{ kind: 'connector-group' as const, group: connector.group }] : [])] }
  const contribution = contextualMenu ? { ...contextualMenu.contribution,
    agentLink: base.sessionAddress ? null : contextualMenu.contribution.agentLink } : null
  const contextEntries: readonly RegionMenuEntry[] = contribution?.agentLink
    ? [{ kind: 'action', action: contribution.agentLink }, ...model.entries] : model.entries
  // 让位不在这里接线：原生视图的让位由 App 的那一个 MutationObserver 按 Radix 的 DOM 协议
  // （portal 到 React 根之外 + data-state=open）统一观察，见 lib/native-overlay-regions.ts。
  // 这个菜单——#544 那个被浏览器盖住的——正是"逐个接线会漏"的证据本身。
  return (
    <RegionMenuContext.Provider value={{ entries: model.entries, onOpen: openMore, moreOpen, setAgentMenuAvailable,
      contextualMenu: contribution, contextSource: contextualMenu?.source ?? null, setContextSource, refreshContextSource,
      clearContextSource, onContextCloseAutoFocus, dialogOpen: connector.dialogOpen || restart.dialog !== null }}>
      <ContextMenu.Root open={contextOpen} onOpenChange={openContext}>
        <ContextMenu.Trigger asChild onPointerDownCapture={event => {
          if (event.currentTarget.contains(event.target as Node)) contextSource.current = null
        }} onContextMenuCapture={event => {
          if (event.currentTarget.contains(event.target as Node)) contextSource.current = null
        }} onContextMenu={event => { origin.current = event.currentTarget }}>{children}</ContextMenu.Trigger>
        {!agentMenuAvailable ? <DocumentOverlayPortal component={ContextMenu.Portal}>
          <ContextMenu.Content className="tab-context-menu region-context-menu" collisionPadding={8} onCloseAutoFocus={event => {
            if (connector.dialogOpen || restart.dialog !== null) event.preventDefault()
            onContextCloseAutoFocus(event)
          }}>
            {contribution?.tools}
            {contribution?.tools ? <ContextMenu.Separator className="tab-context-menu__separator" /> : null}
            <RegionCopyLinkRow entries={contextEntries} Item={ContextMenu.Item} />
            {contextEntries.filter(entry => entry.kind !== 'action').map((entry, index) => <RegionMenuEntryView
              key={index} entry={entry} index={index}
              Item={ContextMenu.Item} Separator={ContextMenu.Separator}
            />)}
          </ContextMenu.Content>
        </DocumentOverlayPortal> : null}
      </ContextMenu.Root>
      {active ? restart.dialog : null}
    </RegionMenuContext.Provider>
  )
}
