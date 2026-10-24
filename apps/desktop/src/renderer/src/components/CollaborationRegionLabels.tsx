import { type CSSProperties, type RefObject, useContext, memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { SemanticIcon } from '@agentmux/client-ui/icons'
import type { CollaborationArea } from '../lib/agent-collaboration'
import type { CollaborationLayoutBox } from '../lib/collaboration-layout-engine'
import { CollaborationBoundsIndex, collaborationBoundsOverlap, type CollaborationBounds } from '../lib/collaboration-spatial-index'
import { CollaborationMapPreferences } from '../lib/collaboration-map-preferences'
import { collaborationVisibleHitBounds } from '../lib/collaboration-map-lod'
import { createCollaborationHierarchy } from '../lib/collaboration-hierarchy'
import { collaborationAreaNode } from '../lib/collaboration-presentation'
import { COLLABORATION_OVERVIEW_ZOOM } from '../lib/collaboration-map-camera'
import { hostIdentityProjection } from '../lib/region-execution-host'
import { useAppStore } from '../store'
import { HostBadge } from './HostBadge'
import { SpaceObjectIcon } from './SpaceObjectIcon'

export const COLLABORATION_AREA_KINDS = {
  project: { icon: 'object.project', label: 'Project' }, topic: { icon: 'object.topic', label: 'Topic' }, category: { icon: 'object.topic', label: 'Category' },
  mote: { icon: 'object.mote', label: 'Mote' }, unplaced: { icon: 'object.topology', label: 'Unplaced' }
} as const
type Region = { box: Extract<CollaborationLayoutBox, { kind: 'area' }>; area: CollaborationArea; folded: boolean; totalMembers: number; childCount: number; depth: number
  activity?: { pulse: { kind: 'communication' | 'supervision' } } | undefined
  internal: readonly unknown[]; onInspect(): void; onLocate(): void; onToggle(anchor?: { x: number; y: number }): void }
const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => value === b[index])

/** One screen-space identity layer. Natural text size is observed only when it
 * changes; camera movement projects the same boxes without measuring the world. */
export const CollaborationRegionLabels = memo(function CollaborationRegionLabels({ areas, geometry, selectedAgent, locatedAreas, active, hud, contextControl, readingProxies }: {
  areas: readonly { data: Region }[]; geometry: ReadonlyMap<string, CollaborationLayoutBox>
  selectedAgent?: string | undefined; locatedAreas?: readonly string[] | undefined; active: boolean; hud: RefObject<HTMLDivElement | null>
  contextControl: RefObject<HTMLButtonElement | null> | null
  readingProxies: readonly HTMLElement[]
}) {
  const preferences = useContext(CollaborationMapPreferences)
  const camera = useStore(state => [...state.transform, state.width, state.height], same)
  const root = useRef<HTMLDivElement>(null)
  const [sizes, setSizes] = useState<ReadonlyMap<string, { budget: number; width: number; height: number; summaryHeight: number; inset: number }>>(new Map())
  const [occlusion, setOcclusion] = useState<readonly CollaborationBounds[]>([])
  const topology = useRef<readonly CollaborationArea[]>([]), original = areas.map(({ data }) => data.area)
  if (!same(topology.current, original)) topology.current = original
  const hierarchy = useMemo(() => createCollaborationHierarchy(topology.current), [topology.current])
  const originalAreaIds = useMemo(() => new Map(topology.current.map(area => [collaborationAreaNode(area.id), area.id])), [topology.current])
  const currentAreas = useMemo(() => new Set(selectedAgent
    ? [...hierarchy.members].flatMap(([id, members]) => members.includes(selectedAgent) ? [id] : [])
    : locatedAreas), [hierarchy, selectedAgent, locatedAreas])
  const obstacles = useMemo(() => new CollaborationBoundsIndex([...geometry.values()].flatMap(box => box.kind !== 'agent' ? [] : [{ box,
    x: box.x - box.width / 2, y: box.y - box.height / 2, width: box.width * 2, height: box.height * 2 }])), [geometry])
  const labels = useMemo(() => {
    const [panX = 0, panY = 0, zoom = 1, width = 0, height = 0] = camera
    if (width < 80 || height < 80) return []
    const overview = zoom < COLLABORATION_OVERVIEW_ZOOM
    const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high))
    const visible = (box: CollaborationBounds) => box.x * zoom + panX < width && (box.x + box.width) * zoom + panX > 0 && box.y * zoom + panY < height && (box.y + box.height) * zoom + panY > 0
    const visibleAreas = new Set(obstacles.query({ x: -panX / zoom, y: -panY / zoom, width: width / zoom, height: height / zoom }).flatMap(({ box }) => {
      if (!visible(box)) return []
      const id = originalAreaIds.get(box.areaId)
      return [box.areaId, ...(id ? hierarchy.ancestors.get(id) ?? [] : []).map(collaborationAreaNode)]
    }))
    const candidates = areas.flatMap(({ data }) => {
      const { box, area } = data
      if (!visible(box)) return []
      const left = (box.x + box.heading.x) * zoom + panX, top = (box.y + box.heading.y) * zoom + panY
      const headingVisible = left >= 8 && left + box.heading.width * zoom <= width - 8 && top >= 8 && top + box.heading.height * zoom <= height - 8
      if (!overview && !headingVisible && !visibleAreas.has(box.id) && !data.folded) return []
      const current = currentAreas.has(area.id)
      // A responsive text column, never a character-count approximation. The
      // browser wraps the complete name and supplies its actual block height.
      const budget = Math.min(width - 24, current || area.kind === 'project' && data.totalMembers ? 320 : 260)
      const measured = sizes.get(area.id), labelWidth = measured?.budget === budget ? measured.width : Math.min(180, budget)
      const labelHeight = measured?.budget === budget ? measured.height : 44
      const summaryHeight = measured?.budget === budget ? measured.summaryHeight : 44, inset = measured?.budget === budget ? measured.inset : 0
      const rowY = clamp(top + box.heading.height * zoom - summaryHeight - inset, 8, height - summaryHeight - inset - 8)
      const internalAbove = data.folded && data.internal.length > 0 && rowY + labelHeight > height - 8
      const summaryBottom = internalAbove ? labelHeight - inset : summaryHeight + inset
      return [{ data, budget, width: labelWidth, height: labelHeight, x: clamp(left, 12, width - labelWidth - 12),
        y: clamp(top + box.heading.height * zoom - summaryBottom, 8, height - labelHeight - 8), summaryBottom, summaryTop: summaryBottom - summaryHeight, internalAbove, current, context: !headingVisible }]
    }).sort((a, b) => Number(b.current) - Number(a.current) || Number(!a.data.totalMembers) - Number(!b.data.totalMembers) || b.data.totalMembers - a.data.totalMembers || a.data.depth - b.data.depth || a.y - b.y || a.x - b.x || a.data.area.id.localeCompare(b.data.area.id))
    const placed: typeof candidates = [], clearance = 6
    const blockingAgents = (label: CollaborationBounds) => {
      const padded = { x: label.x - clearance, y: label.y - clearance, width: label.width + clearance * 2, height: label.height + clearance * 2 }
      const nearby = obstacles.query({ x: (padded.x - panX) / zoom, y: (padded.y - panY) / zoom, width: padded.width / zoom, height: padded.height / zoom })
      return nearby.flatMap(({ box }) => {
        const hit = collaborationVisibleHitBounds(box, zoom, preferences)
        const screen = { x: hit.x * zoom + panX, y: hit.y * zoom + panY, width: hit.width * zoom, height: hit.height * zoom }
        return collaborationBoundsOverlap(padded, screen) ? [screen] : []
      })
    }
    for (const candidate of candidates) {
      const pending = [{ x: candidate.x, y: candidate.y }], seen = new Set<string>()
      let resolved = false
      for (let attempts = 0; pending.length && attempts < 64;) {
        pending.sort((a, b) => (a.x - candidate.x) ** 2 + (a.y - candidate.y) ** 2 - (b.x - candidate.x) ** 2 - (b.y - candidate.y) ** 2)
        const next = pending.shift()!, x = clamp(next.x, 12, width - candidate.width - 12), y = clamp(next.y, 8, height - candidate.height - 8)
        // Repeated obstacle moves can differ only by floating point roundoff.
        // Deduplicate their screen cells instead of exhausting the finite search.
        const key = `${Math.round(x * 2)},${Math.round(y * 2)}`
        if (seen.has(key)) continue
        seen.add(key); attempts++
        const label = { x, y, width: candidate.width, height: candidate.height }
        const padded = { x: x - clearance, y: y - clearance, width: label.width + clearance * 2, height: label.height + clearance * 2 }
        const blockers = [...placed.filter(other => collaborationBoundsOverlap(padded, other)), ...occlusion.filter(other => collaborationBoundsOverlap(padded, other)), ...blockingAgents(label)]
        if (!blockers.length) { placed.push({ ...candidate, x, y }); resolved = true; break }
        const left = Math.min(...blockers.map(box => box.x)), right = Math.max(...blockers.map(box => box.x + box.width))
        const top = Math.min(...blockers.map(box => box.y)), bottom = Math.max(...blockers.map(box => box.y + box.height))
        pending.push({ x: left - label.width - clearance, y }, { x: right + clearance, y },
          { x, y: top - label.height - clearance }, { x, y: bottom + clearance })
      }
      if (!resolved) {
        // A distant dense neighborhood can occupy every local candidate. Give
        // its real identity a bounded screen gutter instead of silently losing it.
        const rows = [candidate.y, 12, height - candidate.height - 12,
          ...placed.map(box => box.y + box.height + clearance * 2),
          ...occlusion.map(box => box.y + box.height + clearance * 2)]
        const gutters = [12, width - candidate.width - 12].flatMap(x => rows.map(y => ({ x, y: clamp(y, 12, height - candidate.height - 12) })))
          .sort((a, b) => (a.x - candidate.x) ** 2 + (a.y - candidate.y) ** 2 - (b.x - candidate.x) ** 2 - (b.y - candidate.y) ** 2)
        for (const point of gutters) {
          const label = { ...point, width: candidate.width, height: candidate.height }
          const padded = { x: label.x - clearance, y: label.y - clearance, width: label.width + clearance * 2, height: label.height + clearance * 2 }
          if ([...placed, ...occlusion].some(box => collaborationBoundsOverlap(padded, box)) || blockingAgents(label).length) continue
          placed.push({ ...candidate, ...point }); break
        }
      }
    }
    return placed
  }, [areas, camera, obstacles, sizes, occlusion, hierarchy, currentAreas, originalAreaIds, preferences])
  const mounted = labels.map(({ data, budget }) => `${data.area.id}:${budget}`).sort().join('\n')
  const readingCamera = readingProxies.length ? camera : null
  useLayoutEffect(() => {
    if (!active || !root.current) return
    const observer = new ResizeObserver(entries => setSizes(previous => {
      const next = new Map(previous)
      let changed = false
      for (const entry of entries) {
        const element = entry.target as HTMLElement, id = element.dataset.regionId!, size = entry.borderBoxSize[0]
        if (!size || !size.inlineSize || !size.blockSize) continue
        const budget = Number.parseFloat(element.style.maxWidth)
        const width = Math.ceil(size.inlineSize), height = Math.ceil(size.blockSize), old = previous.get(id)
        const summary = element.querySelector<HTMLElement>('.collaboration-area__summary')?.getBoundingClientRect()
        // Only the stable identity/action row anchors a fold. The complete
        // label still reserves room for its separately disclosed internal links.
        const summaryHeight = summary?.height ? Math.ceil(summary.height) : height
        const label = summary?.height ? element.getBoundingClientRect() : null
        const inset = label && summary ? Math.max(0, Math.round(element.dataset.internalAbove === 'true' ? label.bottom - summary.bottom : summary.top - label.top)) : 0
        if (old?.budget !== budget || old.width !== width || old.height !== height || old.summaryHeight !== summaryHeight || old.inset !== inset) { next.set(id, { budget, width, height, summaryHeight, inset }); changed = true }
      }
      return changed ? next : previous
    }))
    const window = root.current.ownerDocument.defaultView!
    const frame = window.requestAnimationFrame(() => { for (const element of root.current?.children ?? []) observer.observe(element) })
    return () => { window.cancelAnimationFrame(frame); observer.disconnect() }
  }, [mounted, active])
  useLayoutEffect(() => {
    const element = hud.current
    if (!active || !element) return
    const update = () => {
      const canvas = element.parentElement!.getBoundingClientRect()
      const surfaces = [...element.children].filter(child => child.classList.contains('collaboration-canvas__controls') || child.classList.contains('collaboration-canvas__legend'))
      if (contextControl?.current) surfaces.push(contextControl.current)
      surfaces.push(...readingProxies)
      const next = surfaces.map(child => {
        const box = child.getBoundingClientRect()
        return { x: box.x - canvas.x, y: box.y - canvas.y, width: box.width, height: box.height }
      })
      setOcclusion(previous => previous.length === next.length && previous.every((box, index) => {
        const other = next[index]!; return box.x === other.x && box.y === other.y && box.width === other.width && box.height === other.height
      }) ? previous : next)
    }
    // Only held readers add camera-dependent measurement. Their actual screen
    // footprints include the inverse-zoom transform and can change with text.
    if (readingProxies.length) update()
    const observer = new ResizeObserver(update), window = element.ownerDocument.defaultView!
    const frame = window.requestAnimationFrame(() => { update(); observer.observe(element.parentElement!); observer.observe(element); for (const child of element.children) observer.observe(child); if (contextControl?.current) observer.observe(contextControl.current); for (const proxy of readingProxies) observer.observe(proxy) })
    return () => { window.cancelAnimationFrame(frame); observer.disconnect() }
  }, [active, hud, contextControl, readingProxies, readingCamera])
  return <div ref={root} className="collaboration-region-labels">{labels.map(({ data, x, y, budget, width, height, summaryBottom, summaryTop, internalAbove, context, current }) => <div key={data.area.id} className="collaboration-area__overview-label" data-region-id={data.area.id} data-area-id={data.box.id} data-kind={data.area.kind} data-depth={data.depth} data-empty={!data.totalMembers && !data.childCount || undefined} data-context={context || undefined} data-current={current || undefined} data-internal-above={internalAbove || undefined} data-label-width={width} data-label-height={height} style={{ left: x, top: y, maxWidth: budget, '--collaboration-summary-bottom': `${summaryBottom}px`, '--collaboration-summary-top': `${summaryTop}px` } as CSSProperties}>
    <RegionIdentity data={data} hasChildren={data.childCount > 0} onToggle={() => data.onToggle({ x, y: y + summaryBottom })} />
  </div>)}</div>
})

function RegionIdentity({ data, hasChildren, onToggle }: { data: Region; hasChildren: boolean; onToggle(): void }) {
  const { area } = data, target = area.iconTarget
  const { manualIcon, configuredHost } = useAppStore(useShallow(state => ({
    manualIcon: target ? state.spaceObjectIcons[target.key] ?? null : null,
    configuredHost: state.config?.hosts.find(host => host.id === area.hostId)
  })))
  const host = hostIdentityProjection(area.hostId, configuredHost)
  return <>
    <button type="button" className="collaboration-area__summary nodrag nopan" aria-label={`Locate ${area.name} · ${data.totalMembers} Agents${hasChildren ? ' including subspaces' : ''}`} onClick={data.onLocate} title={area.issue ?? `${COLLABORATION_AREA_KINDS[area.kind].label} · ${area.name}`}>
      <span className="collaboration-area__identity" aria-hidden="true">{target ? <SpaceObjectIcon kind={target.kind} name={target.name} manualIcon={manualIcon}
        {...(area.workspaceId ? { workspaceId: area.workspaceId } : {})} folderIdentityKey={target.kind === 'folder' ? target.key : undefined}
        avatarWorkspaceId={target.avatarTarget?.workspaceId} avatarTopicId={target.avatarTarget?.topicId} avatarObjectKey={target.avatarTarget?.objectKey}
        imageTarget={target.imageTarget} visible={false} /> : <SemanticIcon name={COLLABORATION_AREA_KINDS[area.kind].icon} size={18} />}</span>
      <span className="collaboration-area__name"><strong>{area.name}</strong><span className="collaboration-area__meta"><em>{COLLABORATION_AREA_KINDS[area.kind].label}</em><small>{data.totalMembers} {data.totalMembers === 1 ? 'Agent' : 'Agents'}{hasChildren ? ' incl. subspaces' : ''}</small>{host.kind !== 'local' ? <HostBadge host={host} context="Host" /> : null}</span></span>
      <i className="collaboration-area__activity" data-kind={data.activity?.pulse.kind} aria-hidden={!data.activity || undefined} aria-label={data.activity ? data.activity.pulse.kind === 'communication' ? 'Recent message activity' : 'Recent dispatch update' : undefined} />
    </button>
    {data.folded && data.internal.length ? <button type="button" className="collaboration-area__internal nodrag nopan" aria-label={`${area.name}: ${data.internal.length} internal connections`} onClick={data.onInspect}>{data.internal.length} internal connections<SemanticIcon name="navigation.next" size={11} /></button> : null}
    {data.totalMembers || hasChildren ? <button type="button" className="collaboration-area__fold nodrag nopan" aria-label={`${data.folded ? 'Expand' : 'Collapse'} ${area.name}`} aria-expanded={!data.folded} onClick={onToggle}><SemanticIcon name={data.folded ? 'navigation.next' : 'navigation.down'} size={12} /></button> : null}
  </>
}
