import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentMuxSpaceCatalog, AgentMuxSpaceFact } from '@agentmux/core/control'
import { projectRailTree, projectGroupKey, railGroupAddress } from '@agentmux/client-ui/project-rail-tree'
import { SemanticIcon } from '@agentmux/client-ui/icons'

/** One shared Desktop tree algorithm; all members retain their original public identities. */
export function MobileSpaceDirectory({ catalog, home, query, selectedSpaceId, onSelect, renderIdentity, renderContents }: {
  catalog: AgentMuxSpaceCatalog; home: 'mote' | 'space'; query: string; selectedSpaceId: string | null
  onSelect(space: AgentMuxSpaceFact | null): void
  renderIdentity(space: AgentMuxSpaceFact): ReactNode; renderContents(space: AgentMuxSpaceFact): ReactNode
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(selectedSpaceId ? [selectedSpaceId] : []))
  const previousSelection = useRef(selectedSpaceId)
  useEffect(() => {
    if (previousSelection.current === selectedSpaceId) return
    previousSelection.current = selectedSpaceId
    setExpanded(previous => selectedSpaceId ? new Set([...previous, selectedSpaceId]) : new Set())
  }, [selectedSpaceId])
  const matching = (space: AgentMuxSpaceFact) => `${space.name} ${space.directoryPath} ${space.hostId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  const filtering = query.trim().length > 0
  const spaces = catalog.spaces.filter(space => home === 'mote' ? space.kind === 'mote' : space.kind !== 'mote')
  const folders = useMemo(() => home === 'space' ? projectRailTree(catalog.spaces.filter(space => space.kind === 'folder').map(space => ({
    id: space.spaceId, hostId: space.hostId, repoPath: space.directoryPath, space
  }))) : [], [catalog.spaces, home])
  const folderParents = useMemo(() => new Map(folders.flatMap(group => group.nodes.map(node => [node.project.id, node.parentId] as const))), [folders])
  const folderBranches = useMemo(() => new Set([...folderParents.values()].filter((id): id is string => id !== null)), [folderParents])
  const matchingFolders = new Set(filtering && home === 'space' ? folders.flatMap(group => group.nodes.filter(node => matching(node.project.space)).map(node => node.project.id)) : [])
  if (filtering) for (const id of [...matchingFolders]) {
    for (let parent = folderParents.get(id); parent; parent = folderParents.get(parent)) matchingFolders.add(parent)
  }
  const tabCounts = useMemo(() => {
    const members = new Map<string, string[]>()
    for (const binding of catalog.bindings) members.set(binding.zoneId, [...(members.get(binding.zoneId) ?? []), binding.spaceId])
    const counts = new Map<string, number>()
    for (const tab of catalog.tabs) for (const id of tab.zoneId ? members.get(tab.zoneId) ?? [] : []) counts.set(id, (counts.get(id) ?? 0) + 1)
    return counts
  }, [catalog.bindings, catalog.tabs])
  const row = (space: AgentMuxSpaceFact, depth = 0) => {
    const open = expanded.has(space.spaceId)
    const hasChildren = (tabCounts.get(space.spaceId) ?? 0) > 0 || space.kind === 'mote' || folderBranches.has(space.spaceId)
    return <li key={space.spaceId} className="mobile-space-node" data-space-id={space.spaceId} style={{ '--tree-depth': depth } as import('react').CSSProperties}>
      <button type="button" className="mobile-space-row" aria-expanded={hasChildren ? open : undefined} onClick={() => {
        setExpanded(previous => { const next = new Set(previous); open ? next.delete(space.spaceId) : next.add(space.spaceId); return next })
        previousSelection.current = open ? null : space.spaceId
        onSelect(open ? null : space)
      }}>
        {hasChildren && <SemanticIcon name="navigation.disclosure" size={14} className="mobile-tree-chevron" />}{renderIdentity(space)}
        <strong>{space.name}</strong><small>{tabCounts.get(space.spaceId) ?? 0}</small>
      </button>
      {open && <div role="group" aria-label={`${space.name} 的 Tabs`} className="mobile-space-children">{renderContents(space)}</div>}
    </li>
  }
  if (home === 'mote') return <ul className="mobile-space-tree mobile-session-list" aria-label="Mote 目录">{spaces.filter(matching).map(space => row(space))}</ul>
  const hosts = [...new Set(folders.map(group => group.hostId))]
  return <div className="mobile-space-directory">
    {(catalog.projectGroups ?? []).map(group => {
      const members = group.projectIds.map(id => spaces.find(space => space.projectId === id))
      if (filtering && !group.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && !members.some(space => space && matching(space))) return null
      return <details className="mobile-tree-section" key={group.groupId} open><summary><SemanticIcon name="object.link" size={14} /><strong>{group.name}</strong><small>{group.projectIds.length}</small></summary>
        <ul className="mobile-space-tree mobile-session-list">{members.map((space, index) => space ? row(space) : <li className="mobile-tree-unconfirmed" key={group.projectIds[index]}>项目暂未确认 <code>{group.projectIds[index]}</code></li>)}</ul>
      </details>
    })}
    {hosts.map(host => <details className="mobile-tree-section" key={host} open>
      <summary><SemanticIcon name="object.folders" size={14} /><strong>{host === 'local' ? 'Folders' : host}</strong></summary>
      {folders.filter(group => group.hostId === host).map((group, index) => {
        const nodes = group.nodes.filter(node => !filtering || matchingFolders.has(node.project.id))
        const shownNodes = new Map<string, boolean>()
        const entries = nodes.map(node => {
          const shown = filtering || node.parentId === null || (shownNodes.get(node.parentId) === true && expanded.has(node.parentId))
          shownNodes.set(node.project.id, shown)
          return shown ? row(node.project.space, node.depth) : null
        })
        if (!nodes.length) return null
        return group.groupPath ? <details key={projectGroupKey(group)} className="mobile-tree-folder-group" open><summary title={group.groupPath}><SemanticIcon name="navigation.disclosure" size={13} /><span>{group.label}</span><small>{railGroupAddress(group.groupPath)}</small></summary><ul className="mobile-space-tree mobile-session-list">{entries}</ul></details>
          : <ul className="mobile-space-tree mobile-session-list" key={index}>{entries}</ul>
      })}
    </details>)}
    {spaces.some(space => space.kind !== 'folder' && matching(space)) && <details className="mobile-tree-section" open><summary><SemanticIcon name="object.note" size={14} /><strong>Topics / 其他空间</strong></summary>
      <ul className="mobile-space-tree mobile-session-list">{spaces.filter(space => space.kind !== 'folder' && matching(space)).map(space => row(space))}</ul></details>}
    {filtering && !spaces.some(matching) && <p className="mobile-spatial-empty">没有匹配的空间。</p>}
  </div>
}
