import * as ContextMenu from '@radix-ui/react-context-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { createContext, useContext, useId, type ReactNode } from 'react'
import { formatRegionAddress, formatSessionAddress } from '../lib/agent-address'
import type { RegionSwapMenuEntry, WorkbenchSplitMenuEntry } from '../lib/workbench-tab-actions'
import { WorkbenchLayoutMenuRows } from './WorkbenchLayoutMenuRows'
import { DocumentOverlayPortal } from './WindowOverlayHost'

const ThemeActionCopyIcon = semanticIconComponent('action.copy')
const ThemeActionCopyAddressIcon = semanticIconComponent('action.copy-address')
const ThemeActionReplaceIcon = semanticIconComponent('action.replace')
const ThemeObjectConversationsIcon = semanticIconComponent('object.conversations')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const ThemeNavigationSubmenuIcon = semanticIconComponent('navigation.submenu')


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

const RegionMenuContext = createContext<{ entries: readonly RegionMenuEntry[]; onOpen(open: boolean): void; dialogOpen: boolean }>({ entries: [], onOpen: () => {}, dialogOpen: false })

export function useRegionMenuEntries(): readonly RegionMenuEntry[] {
  return useContext(RegionMenuContext).entries
}
export const useRegionMenuObservation = () => useContext(RegionMenuContext)

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
  const labelId = useId()
  if (entry.kind === 'connector-group') return <Group aria-labelledby={labelId} data-connector-menu-group="">
    <Separator className="tab-context-menu__separator" data-connector-menu-separator="" />
    <Label id={labelId} className="agent-connector-menu__label">{entry.group.label}</Label>
    {entry.group.entries.map(action => <Item key={action.label} className="tab-context-menu__item" onSelect={action.onSelect}><ThemeObjectConversationsIcon size={14} /><span>{action.label}</span></Item>)}
    {entry.group.issue ? <Label className="agent-region-menu__context" role="status">{entry.group.issue}</Label> : null}
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
  if (entry.kind === 'swaps') return <Sub>
    <SubTrigger className="tab-context-menu__item">
      <ThemeActionReplaceIcon size={14} /><span>Swap Region…</span>
      <span className="tab-context-menu__chevron"><ThemeNavigationSubmenuIcon size={12} /></span>
    </SubTrigger>
    <DocumentOverlayPortal component={Portal}>
      <SubContent className="tab-context-menu region-swap-menu" collisionPadding={8} sideOffset={4}>
        {entry.entries.map(target => <Item key={target.targetRegionId} className="tab-context-menu__item"
          textValue={target.label} title={target.label} onSelect={target.onSelect}>
          <span>{target.label}</span>
        </Item>)}
      </SubContent>
    </DocumentOverlayPortal>
  </Sub>
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
  agentSessionId: string | null
  writeClipboardText(text: string): Promise<void>
    splitMenu: readonly WorkbenchSplitMenuEntry[]
    swapMenu: readonly RegionSwapMenuEntry[]
  promote?: (() => void) | undefined
}) {
  const base = createRegionCopyModel({
    regionId,
    agentSessionId,
    writeClipboardText,
    splitMenu,
    swapMenu,
    promote
  })
  const model = { ...base, entries: [...base.entries, ...(onOpenWindow ? [{ kind: 'window' as const, onSelect: onOpenWindow }] : []), ...(connector.group ? [{ kind: 'connector-group' as const, group: connector.group }] : [])] }
  // 让位不在这里接线：原生视图的让位由 App 的那一个 MutationObserver 按 Radix 的 DOM 协议
  // （portal 到 React 根之外 + data-state=open）统一观察，见 lib/native-surface-overlay.ts。
  // 这个菜单——#544 那个被浏览器盖住的——正是"逐个接线会漏"的证据本身。
  return (
    <RegionMenuContext.Provider value={{ entries: model.entries, onOpen: connector.onOpen, dialogOpen: connector.dialogOpen }}>
      <ContextMenu.Root onOpenChange={connector.onOpen}>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <DocumentOverlayPortal component={ContextMenu.Portal}>
          <ContextMenu.Content className="tab-context-menu region-context-menu" collisionPadding={8} onCloseAutoFocus={event => { if (connector.dialogOpen) event.preventDefault() }}>
            {model.entries.map((entry, index) => <RegionMenuEntryView
              key={index} entry={entry} index={index}
              Item={ContextMenu.Item} Separator={ContextMenu.Separator}
            />)}
          </ContextMenu.Content>
        </DocumentOverlayPortal>
      </ContextMenu.Root>
    </RegionMenuContext.Provider>
  )
}
