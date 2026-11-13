import { fileViewReadingOwnerKey, type FileViewReadingOwner, type FileViewReadingPosition } from '../../../shared/workbench-user-state'
import { findWorkbenchRegion, type WorkbenchTab } from './workbench-tabs'
import type { WorkspaceFileSourceBinding } from './use-workspace-file-source'

export type FileViewReadingBinding = { owner: FileViewReadingOwner; current(): boolean; capture(): void }
export type FileViewReadingProjection = {
  owner: FileViewReadingOwner
  position: FileViewReadingPosition | null
  loaded: boolean
  phase: 'loading' | 'ready' | 'error'
  error: string | null
  token: number
  restoration: number
  input: number
  acknowledged: number
  pending: boolean
  binding: FileViewReadingBinding
}
export type FileViewReadings = Record<string, FileViewReadingProjection>
export const readingProjection = (values: FileViewReadings, owner: FileViewReadingOwner) => {
  const key = fileViewReadingOwnerKey(owner)
  return Object.hasOwn(values, key) ? values[key] : undefined
}
export const sameReadingPosition = (a: FileViewReadingPosition | null, b: FileViewReadingPosition) => a?.section === b.section && a.sectionId === b.sectionId && a.progress === b.progress

/** Tab is a live lookup hint only. Durable preference follows the original Region when promoted/moved. */
export function createFileViewReadingBinding(source: WorkspaceFileSourceBinding, tabId: string, regionId: string, path: string,
  get: () => { tabs: Record<string, WorkbenchTab> }, capture: () => void): FileViewReadingBinding {
  const owner = { ...source.resource, regionId, path }
  let hint = tabId, previousTabs: Record<string, WorkbenchTab> | undefined, target: ReturnType<typeof findWorkbenchRegion> = null
  return { owner, capture, current() {
    if (!source.current()) return false
    const { tabs } = get()
    if (tabs !== previousTabs) {
      previousTabs = tabs
      const tab = tabs[hint], surface = tab && Object.hasOwn(tab.regions, regionId) ? tab.regions[regionId] : undefined
      target = tab && surface ? { tab, surface } : findWorkbenchRegion(tabs, regionId)
      if (target) hint = target.tab.id
    }
    // A removed display can publish its last layout-cleanup value while its original source lease
    // is still alive. It creates no Tab/Region, and cannot target a replacement File binding.
    return !target || target.surface.kind === 'file' && target.surface.workspaceId === owner.workspaceId && target.surface.path === owner.path
  } }
}
