import type { RegionGeometry } from '@agentmux/layout'
import type { WorkbenchTab } from '../lib/workbench-tabs'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ResolvedAgentAvatar } from './AgentAvatar'
import type { SelectorPresenceAgent } from './SelectorList'
import { getWindowOverlayHost } from './WindowOverlayHost'

const ThemeObjectTerminalIcon = semanticIconComponent('object.terminal')
const ThemeObjectBrowserIcon = semanticIconComponent('object.browser')
const ThemeFileCodeIcon = semanticIconComponent('file.code')
const ThemeGitCompareIcon = semanticIconComponent('git.compare')
const ThemeObjectLauncherIcon = semanticIconComponent('object.launcher')
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')
const ThemeLayoutDockIcon = semanticIconComponent('layout.dock')
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export type WorkbenchRegionDetail = RegionGeometry & {
  agentSessionId?: string
  surfaceKind?: WorkbenchTab['regions'][string]['kind']
  executorLabel: string
  activity: string
  agent?: Omit<SelectorPresenceAgent, 'key' | 'count' | 'onOpen'> & { hostId?: string }
}

export type WorkbenchTabDetail = {
  tabId: string
  /** Original display occurrence when one Tab is presented in more than one Group. */
  occurrenceKey?: string
  title: string
  active: boolean
  /** Exact subject Region supplied by the original occurrence owner; separate from active Tab. */
  highlightedRegionIds?: readonly string[] | undefined
  regions: readonly WorkbenchRegionDetail[]
}

/**
 * A Tab's collapsed preview is a miniature of its actual workbench. One
 * Region gets a single quiet tile; split Tabs retain each Region's bounds so
 * the shape can be read before opening the inspector.
 */
export function WorkbenchTabGlyph({ tab }: { tab: WorkbenchTabDetail }) {
  const singleRegion = tab.regions.length === 1
  const region = tab.regions[0]
  if (singleRegion && region) {
    return <span className="workbench-topology__tab-glyph workbench-topology__tab-glyph--single" data-region-count="1" data-region-kind={region.surfaceKind}>
      <WorkbenchRegionMark region={region} />
    </span>
  }
  return (
    <span
      className={`workbench-topology__tab-glyph${singleRegion ? ' workbench-topology__tab-glyph--single' : ''}`}
      data-region-count={tab.regions.length}
    >
      {tab.regions.map((region) => (
        <span
          className="workbench-topology__tab-glyph__cell"
          data-region-kind={region.surfaceKind}
          data-region-id={region.regionId}
          data-subject-region={tab.highlightedRegionIds?.includes(region.regionId) || undefined}
          key={region.regionId}
          style={singleRegion
            ? { left: '0%', top: '0%', width: '100%', height: '100%' }
            : {
                left: `${region.bounds.x * 100}%`,
                top: `${region.bounds.y * 100}%`,
                width: `${region.bounds.width * 100}%`,
                height: `${region.bounds.height * 100}%`
              }}
        >
          <WorkbenchRegionMark region={region} />
        </span>
      ))}
    </span>
  )
}

function WorkbenchRegionMark({ region }: { region: WorkbenchRegionDetail }) {
  if (region.agent) {
    return <ResolvedAgentAvatar
      label={[region.agent.label, region.agent.state].filter(Boolean).join(' · ')}
      providerId={region.agent.providerId}
      executorId={region.agent.executorId}
      appearance={region.agent.appearance}
      state={region.agent.state}
      size={16}
    />
  }
  switch (region.surfaceKind) {
    case 'terminal': return <ThemeObjectTerminalIcon size={14} aria-hidden="true" />
    case 'browser': return <ThemeObjectBrowserIcon size={14} aria-hidden="true" />
    case 'file': return <ThemeFileCodeIcon size={14} aria-hidden="true" />
    case 'git':
    case 'git-diff': return <ThemeGitCompareIcon size={14} aria-hidden="true" />
    case 'launcher': return <ThemeObjectLauncherIcon size={14} aria-hidden="true" />
    case 'agent': return <ThemeObjectAgentIcon size={14} aria-hidden="true" />
    default: return <ThemeLayoutDockIcon size={14} aria-hidden="true" />
  }
}

export function WorkbenchRegionMap({
  regions,
  className,
  aspectRatio,
  highlightedRegionIds
}: {
  regions: readonly WorkbenchRegionDetail[]
  className: string
  aspectRatio: number
  highlightedRegionIds?: readonly string[] | undefined
}) {
  const regionLabel = `${regions.length} ${regions.length === 1 ? 'Region' : 'Regions'}`
  return (
    <span className={className} aria-label={regionLabel} style={{ aspectRatio }}>
      {regions.map((region) => (
        <span
          className={`${className}__region`}
          data-region-kind={region.surfaceKind}
          data-region-id={region.regionId}
          data-subject-region={highlightedRegionIds?.includes(region.regionId) || undefined}
          key={region.regionId}
          style={{
            left: `${region.bounds.x * 100}%`,
            top: `${region.bounds.y * 100}%`,
            width: `${region.bounds.width * 100}%`,
            height: `${region.bounds.height * 100}%`
          }}
          title={`${region.executorLabel}: ${region.activity}`}
        >
          <span className={`${className}__region-label`}>
            <WorkbenchRegionMark region={region} />
            <strong>{region.agent?.label ?? region.executorLabel}</strong>
            {highlightedRegionIds?.includes(region.regionId) ? <small className="workbench-topology__subject-label">Current Agent</small> : null}
            <small>{region.activity}</small>
          </span>
        </span>
      ))}
    </span>
  )
}

/**
 * Shared Tab identities inspect original Region geometry and held activity only.
 * Each Tab owns the hover/focus inspector for its own Region layout and recent activity.
 */
export function WorkbenchTopology({ tabs, onSelectTab, interactive = true, enabled = true }: {
  tabs: readonly WorkbenchTabDetail[]
  onSelectTab?: ((tabId: string) => void) | undefined
  /** Readonly embedding inside an existing control adds no nested control or keyboard stop. */
  interactive?: boolean
  /** The parent may suspend this preview while its own menu or editor is open. */
  enabled?: boolean
}) {
  const TabEntry = interactive ? 'button' : 'span'

  const popoverId = useId()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const inspectorRef = useRef<HTMLSpanElement>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [inspectorPosition, setInspectorPosition] = useState<{ left: number; top: number } | null>(null)
  const active = tabs.find((tab) => tab.active) ?? tabs[0]
  const entryKey = (tab: WorkbenchTabDetail, index: number) => tab.occurrenceKey ?? JSON.stringify([tab.tabId, index])
  const [inspectedKey, setInspectedKey] = useState(active ? entryKey(active, tabs.indexOf(active)) : '')
  const inspected = tabs.find((tab, index) => entryKey(tab, index) === inspectedKey) ?? active
  const [aspectRatio, setAspectRatio] = useState(16 / 10)
  const label = `${tabs.length} ${tabs.length === 1 ? 'Tab' : 'Tabs'}. Hover or focus a Tab to inspect its Regions and recent activity.`
  const overlayHost = getWindowOverlayHost()
  const inspectorInPortal = enabled && inspectorOpen && overlayHost !== null

  const inspectTab = (key: string) => {
    setInspectedKey(key)
    if (enabled) setInspectorOpen(true)
  }

  useEffect(() => {
    if (!enabled) setInspectorOpen(false)
  }, [enabled])
  useEffect(() => {
    if (!inspectorInPortal) return
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setInspectorOpen(false)
    }
    document.addEventListener('keydown', dismiss, true)
    return () => document.removeEventListener('keydown', dismiss, true)
  }, [inspectorInPortal])

  useIsomorphicLayoutEffect(() => {
    if (!inspectorInPortal) {
      setInspectorPosition(null)
      return
    }
    const anchor = anchorRef.current
    const inspector = inspectorRef.current
    if (!anchor || !inspector) return
    const viewportGap = 8
    const updatePosition = () => {
      // Hidden Tabs stay mounted with their geometry. Read the actual Tab body, not
      // the individual Region's aspect ratio (which already lives in its bounds).
      const regionIds = new Set(inspected?.regions.map((region) => region.regionId))
      const regionElement = Array.from(document.querySelectorAll<HTMLElement>('[data-workbench-region-id]'))
        .find((element) => regionIds.has(element.dataset.workbenchRegionId!))
      const body = regionElement?.closest('.pane-body__region')?.getBoundingClientRect()
      if (body && body.width > 0 && body.height > 0) setAspectRatio(body.width / body.height)
      const anchorBounds = anchor.getBoundingClientRect()
      const inspectorBounds = inspector.getBoundingClientRect()
      const maxLeft = Math.max(viewportGap, window.innerWidth - inspectorBounds.width - viewportGap)
      const left = Math.min(Math.max(viewportGap, anchorBounds.right - inspectorBounds.width), maxLeft)
      const aboveTop = anchorBounds.top - inspectorBounds.height - viewportGap
      const belowTop = anchorBounds.bottom + viewportGap
      const fitsAbove = aboveTop >= viewportGap
      const fitsBelow = belowTop + inspectorBounds.height <= window.innerHeight - viewportGap
      const top = fitsAbove
        ? aboveTop
        : fitsBelow
          ? belowTop
          : Math.max(viewportGap, Math.min(belowTop, window.innerHeight - inspectorBounds.height - viewportGap))
      setInspectorPosition({ left, top })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [inspected, inspectorInPortal, aspectRatio])

  const inspectorClassName = `workbench-topology__inspector${inspectorInPortal ? ' workbench-topology__inspector--portal' : ''}`
  const inspector = (
    <span
      ref={inspectorRef}
      id={popoverId}
      className={inspectorClassName}
      role="tooltip"
      style={inspectorInPortal
        ? {
            left: inspectorPosition?.left ?? 0,
            top: inspectorPosition?.top ?? 0,
            visibility: inspectorPosition ? 'visible' : 'hidden'
          }
        : undefined}
    >
      <span className="workbench-topology__inspector-head">
        <span><ThemeLayoutDockIcon size={13} /><strong>{inspected?.title ?? 'Workbench'}</strong></span>
      </span>
      {inspected ? <WorkbenchRegionMap regions={inspected.regions} aspectRatio={aspectRatio} highlightedRegionIds={inspected.highlightedRegionIds} className="workbench-topology__inspector-regions" /> : null}
    </span>
  )

  return (
    <span
      ref={anchorRef}
      className="workbench-topology"
      tabIndex={interactive ? 0 : undefined}
      role="group"
      aria-label={label}
      aria-describedby={inspectorInPortal ? popoverId : undefined}
      title={label}
      onMouseEnter={() => { if (enabled) setInspectorOpen(true) }}
      onMouseLeave={() => setInspectorOpen(false)}
      onFocus={() => { if (enabled) setInspectorOpen(true) }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInspectorOpen(false)
      }}
    >
      <span className="workbench-topology__tab-rail" role="group" aria-label="Tabs">
        {tabs.map((tab, index) => (
          <TabEntry
            {...(interactive ? { type: 'button' as const } : {})}
            className={`workbench-topology__tab-chip${tab.active ? ' active' : ''}${inspectorOpen && tab === inspected ? ' inspected' : ''}`}
            key={entryKey(tab, index)}
            style={{ zIndex: index + 1 }}
            data-topic-tab-id={tab.tabId}
            aria-pressed={interactive ? tab.active : undefined}
            aria-label={`T${index + 1}: ${tab.title}, ${tab.regions.length} ${tab.regions.length === 1 ? 'Region' : 'Regions'}${tab.regions.some(region => tab.highlightedRegionIds?.includes(region.regionId)) ? '. Current Agent Region highlighted' : ''}`}
            title={`${tab.title} · ${tab.regions.length} ${tab.regions.length === 1 ? 'Region' : 'Regions'}`}
            onMouseEnter={() => inspectTab(entryKey(tab, index))}
            onFocus={() => inspectTab(entryKey(tab, index))}
            onPointerDown={interactive ? (event) => event.stopPropagation() : undefined}
            onKeyDown={interactive ? (event) => event.stopPropagation() : undefined}
            onClick={(event) => {
              setInspectorOpen(false)
              if (interactive) { event.stopPropagation(); onSelectTab?.(tab.tabId) }
            }}
          >
            <WorkbenchTabGlyph tab={tab} />
          </TabEntry>
        ))}
      </span>
      {inspectorInPortal ? createPortal(inspector, overlayHost) : null}
    </span>
  )
}

