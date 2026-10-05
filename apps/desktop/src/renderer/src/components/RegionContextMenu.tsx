import * as ContextMenu from '@radix-ui/react-context-menu'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { createContext, useContext, type ReactNode } from 'react'
import { formatRegionAddress, formatSessionAddress } from '../lib/agent-address'
import type { RegionSwapMenuEntry, WorkbenchSplitMenuEntry } from '../lib/workbench-tab-actions'
import { workbenchSplitMenuIcon, workbenchSplitMenuKey } from './workbench-split-menu-icons'
import { resolveOverlayContainer } from './WindowOverlayHost'

const ThemeActionCopyIcon = semanticIconComponent('action.copy')
const ThemeActionCopyAddressIcon = semanticIconComponent('action.copy-address')
const ThemeActionReplaceIcon = semanticIconComponent('action.replace')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')


type RegionCopyAction = {
  label: 'Copy Region Link' | 'Copy Agent Link'
  onSelect(): Promise<void>
}

export type RegionMenuEntry =
  | { kind: 'action'; action: RegionCopyAction }
  | { kind: 'separator' }
  | { kind: 'split'; entry: WorkbenchSplitMenuEntry }
  | { kind: 'swap'; entry: RegionSwapMenuEntry }
  | { kind: 'promote'; onSelect(): void }

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
    : [...addresses, { kind: 'separator' }, ...splitMenu.map((entry) => ({ kind: 'split' as const, entry }))]
  const withSwap: RegionMenuEntry[] = swapMenu.length === 0
    ? withSplit
    : [
        ...withSplit,
        { kind: 'separator' },
        ...swapMenu.map((entry) => ({ kind: 'swap' as const, entry }))
      ]
  if (!promote) return withSwap
  return [...withSwap, { kind: 'separator' }, { kind: 'promote', onSelect: promote }]
}

const REGION_MENU_ICONS: Record<RegionCopyAction['label'], typeof ThemeActionCopyIcon> = {
  'Copy Region Link': ThemeActionCopyAddressIcon,
  'Copy Agent Link': ThemeActionCopyIcon
}

const RegionMenuContext = createContext<readonly RegionMenuEntry[]>([])

export function useRegionMenuEntries(): readonly RegionMenuEntry[] {
  return useContext(RegionMenuContext)
}

export function RegionMenuEntryView({ entry, index, Item, Separator }: {
  entry: RegionMenuEntry
  index: number
  Item: typeof ContextMenu.Item
  Separator: typeof ContextMenu.Separator
}) {
  if (entry.kind === 'separator') {
    return (
      <Separator
        key={`separator-${index}`}
        className="tab-context-menu__separator"
      />
    )
  }
  if (entry.kind === 'split') {
    const key = workbenchSplitMenuKey(entry.entry, index)
    if (entry.entry.kind === 'separator') {
      return <Separator key={key} className="tab-context-menu__separator" />
    }
    const SplitIcon = workbenchSplitMenuIcon(entry.entry)
    return (
      <Item
        key={key}
        className="tab-context-menu__item"
        onSelect={entry.entry.onSelect}
      >
        <SplitIcon size={14} />
        <span>{entry.entry.label}</span>
      </Item>
    )
  }
  if (entry.kind === 'swap') {
    return (
      <Item
        key={`swap-${entry.entry.targetRegionId}`}
        className="tab-context-menu__item"
        title={entry.entry.label}
        onSelect={entry.entry.onSelect}
      >
        <ThemeActionReplaceIcon size={14} />
        <span>{entry.entry.label}</span>
      </Item>
    )
  }
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
  promote
}: {
  children: ReactNode
  regionId: string
  agentSessionId: string | null
  writeClipboardText(text: string): Promise<void>
    splitMenu: readonly WorkbenchSplitMenuEntry[]
    swapMenu: readonly RegionSwapMenuEntry[]
  promote?: (() => void) | undefined
}) {
  const model = createRegionCopyModel({
    regionId,
    agentSessionId,
    writeClipboardText,
    splitMenu,
    swapMenu,
    promote
  })
  // 让位不在这里接线：原生视图的让位由 App 的那一个 MutationObserver 按 Radix 的 DOM 协议
  // （portal 到 React 根之外 + data-state=open）统一观察，见 lib/native-surface-overlay.ts。
  // 这个菜单——#544 那个被浏览器盖住的——正是"逐个接线会漏"的证据本身。
  return (
    <RegionMenuContext.Provider value={model.entries}>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
        <ContextMenu.Portal container={resolveOverlayContainer() as HTMLElement | undefined}>
          <ContextMenu.Content className="tab-context-menu region-context-menu" collisionPadding={8}>
            {model.entries.map((entry, index) => <RegionMenuEntryView
              key={index} entry={entry} index={index}
              Item={ContextMenu.Item} Separator={ContextMenu.Separator}
            />)}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </RegionMenuContext.Provider>
  )
}
