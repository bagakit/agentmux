import type { SplitDirection } from './workbench-layout'

export type TabCloseScope = 'others' | 'left' | 'right'

export const WORKBENCH_TAB_SPLIT_ACTIONS: ReadonlyArray<{
  direction: SplitDirection
  label: string
}> = [
  { direction: 'left', label: 'Split Left' },
  { direction: 'right', label: 'Split Right' },
  { direction: 'up', label: 'Split Up' },
  { direction: 'down', label: 'Split Down' }
]

export function tabIdsForCloseScope(
  tabOrder: readonly string[],
  targetTabId: string,
  scope: TabCloseScope
): string[] {
  const targetIndex = tabOrder.indexOf(targetTabId)
  if (targetIndex < 0) return []
  if (scope === 'left') return tabOrder.slice(0, targetIndex)
  if (scope === 'right') return tabOrder.slice(targetIndex + 1)
  return tabOrder.filter((tabId) => tabId !== targetTabId)
}
