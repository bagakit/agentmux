import { memo, useMemo } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { mountedSpaceTarget, mountedSpaceInputs, sourceFolderProjectEntry } from '../lib/space-mount-view'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import { useAppStore } from '../store'
const FolderIcon = semanticIconComponent('object.folder')
const MountedSpaceNavigationRow = memo(function MountedSpaceNavigationRow({ mountKey, target, carrier, query }: { mountKey: string; target: SpaceMountRecord; carrier: string; query: string }) {
  const observed = useAppStore(state => state.mountedSpaceObservations[mountKey]), selected = useAppStore(state => state.selectedSpaceMount === mountKey)
  const name = observed?.snapshot?.scope.space?.name ?? observed?.lastPresentSnapshot?.scope.space?.name ?? 'Original Space'
  if (query.trim() && ![name, carrier, target.reference.runtimeId, target.reference.spaceId].some(text => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))) return null
  return <button type="button" className={`project-rail-row${selected ? ' project-rail-row--active' : ''}`} aria-current={selected ? 'page' : undefined}
    onClick={() => useAppStore.getState().selectSpaceMount(mountKey)} title={`${name} · via ${carrier}`} data-mounted-space-nav={mountKey}>
    <FolderIcon size={14} aria-hidden="true" /><span><strong>{name}</strong><small>Via {carrier}</small></span>
  </button>
})

/** Saved source locators, not another editable folder catalogue. */
export function MountedSpaceNavigation({ query }: { query: string }) {
  const inputs = useAppStore(state => state.mountedSpaceInputs), hosts = useAppStore(state => state.config?.hosts)
  const entries = useMemo(() => {
    const result: Array<{ key: string; target: SpaceMountRecord }> = []
    try { for (const key of Object.keys(mountedSpaceInputs(inputs))) {
      try { const target = mountedSpaceTarget(inputs, key); if (target && !sourceFolderProjectEntry(inputs,key)) result.push({ key, target }) } catch { /* Keep future and unreadable fragments with their original user-document owner. */ }
    } } catch { /* The ordinary rail stays available while the original input is retained. */ }
    return result
  }, [inputs])
  return entries.length ? <section className="mounted-space-navigation" aria-label="Mounted Spaces"><h3>Mounted Spaces</h3>{entries.map(entry =>
    <MountedSpaceNavigationRow key={entry.key} mountKey={entry.key} target={entry.target} carrier={hosts?.find(host => host.id === entry.target.hostId)?.label ?? entry.target.hostId} query={query} />)}</section> : null
}
