import type { TopicRegionCell } from '../lib/scratch-topic-layout'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, FileCode2, Globe2, PanelTop, Sparkles, SquareTerminal } from 'lucide-react'
import { AgentAvatar } from './AgentAvatar'
import { SelectorPresence, type SelectorPresenceAgent } from './SelectorList'

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export type TopicRegionDetail = TopicRegionCell & {
  executorLabel: string
  activity: string
  agent?: Omit<SelectorPresenceAgent, 'key' | 'count' | 'onOpen'>
}

export type TopicTabDetail = {
  tabId: string
  title: string
  active: boolean
  regions: readonly TopicRegionDetail[]
}

/** Agent identity belongs inside its Region; unmounted background Agents retain their own entry. */
export function TopicPresence({ cells, agents, tabs = [], onSelectTab }: {
  cells?: readonly TopicRegionCell[] | undefined
  agents: readonly SelectorPresenceAgent[]
  tabs?: readonly TopicTabDetail[]
  onSelectTab?: (tabId: string) => void
}) {
  // A Session already represented by any Tab has an identity slot in that Tab. Keep the
  // separate roster for healthy background Agents that have no open Region only.
  const mounted = new Set(
    tabs.length > 0
      ? tabs.flatMap((tab) => tab.regions.flatMap((region) => {
        const sessionId = region.agent?.sessionId ?? region.agentSessionId
        return sessionId ? [sessionId] : []
      }))
      : (cells ?? []).flatMap((cell) => cell.agentSessionId ? [cell.agentSessionId] : [])
  )
  return <span className="topic-presence">
    {tabs.length > 0 ? <TopicWorkbenchTopology tabs={tabs} onSelectTab={onSelectTab} /> : cells ? <RegionMosaic cells={cells} agents={agents} /> : null}
    <SelectorPresence agents={agents.filter((agent) => !mounted.has(agent.key))} />
  </span>
}

/**
 * A Tab's collapsed preview is a miniature of its actual workbench. One
 * Region gets a single quiet tile; split Tabs retain each Region's bounds so
 * the shape can be read before opening the inspector.
 */
function TopicTabGlyph({ tab }: { tab: TopicTabDetail }) {
  const singleRegion = tab.regions.length === 1
  const region = tab.regions[0]
  if (singleRegion && region) {
    return <span className="topic-workbench-topology__tab-glyph topic-workbench-topology__tab-glyph--single" data-region-count="1" data-region-kind={region.surfaceKind}>
      <TopicRegionMark region={region} />
    </span>
  }
  return (
    <span
      className={`topic-workbench-topology__tab-glyph${singleRegion ? ' topic-workbench-topology__tab-glyph--single' : ''}`}
      data-region-count={tab.regions.length}
      aria-hidden="true"
    >
      {tab.regions.map((region) => (
        <span
          className="topic-workbench-topology__tab-glyph__cell"
          data-region-kind={region.surfaceKind}
          key={region.regionId}
          style={singleRegion
            ? { left: '0%', top: '0%', width: '100%', height: '100%' }
            : {
                left: `${region.bounds.x * 100}%`,
                top: `${region.bounds.y * 100}%`,
                width: `${region.bounds.width * 100}%`,
                height: `${region.bounds.height * 100}%`
              }}
        />
      ))}
    </span>
  )
}

function TopicRegionMark({ region }: { region: TopicRegionDetail }) {
  if (region.agent) {
    return <AgentAvatar
      label={region.agent.label}
      providerId={region.agent.providerId}
      executorId={region.agent.executorId}
      sessionId={region.agent.sessionId}
      appearance={region.agent.appearance}
      state={region.agent.state}
      size={16}
    />
  }
  switch (region.surfaceKind) {
    case 'terminal': return <SquareTerminal size={14} aria-hidden="true" />
    case 'browser': return <Globe2 size={14} aria-hidden="true" />
    case 'file': return <FileCode2 size={14} aria-hidden="true" />
    case 'launcher': return <Sparkles size={14} aria-hidden="true" />
    case 'agent': return <Bot size={14} aria-hidden="true" />
    default: return <PanelTop size={14} aria-hidden="true" />
  }
}

function RegionLayout({
  regions,
  className,
  aspectRatio
}: {
  regions: readonly TopicRegionDetail[]
  className: string
  aspectRatio: number
}) {
  const regionLabel = `${regions.length} ${regions.length === 1 ? 'Region' : 'Regions'}`
  return (
    <span className={className} aria-label={regionLabel} style={{ aspectRatio }}>
      {regions.map((region) => (
        <span
          className={`${className}__region`}
          data-region-kind={region.surfaceKind}
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
            <TopicRegionMark region={region} />
            <strong>{region.agent?.label ?? region.executorLabel}</strong>
            <small>{region.activity}</small>
          </span>
        </span>
      ))}
    </span>
  )
}

/**
 * A horizontal Tab strip is the first visual answer to "what is open in this Topic?".
 * Each Tab owns the hover/focus inspector for its own Region layout and recent activity.
 */
export function TopicWorkbenchTopology({ tabs, onSelectTab }: { tabs: readonly TopicTabDetail[]; onSelectTab?: ((tabId: string) => void) | undefined }) {
  const popoverId = useId()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const inspectorRef = useRef<HTMLSpanElement>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [inspectorPosition, setInspectorPosition] = useState<{ left: number; top: number } | null>(null)
  const active = tabs.find((tab) => tab.active) ?? tabs[0]
  const [inspectedTabId, setInspectedTabId] = useState(active?.tabId ?? '')
  const inspected = tabs.find((tab) => tab.tabId === inspectedTabId) ?? active
  const [aspectRatio, setAspectRatio] = useState(16 / 10)
  const label = `${tabs.length} ${tabs.length === 1 ? 'Tab' : 'Tabs'}. Hover or focus a Tab to inspect its Regions and recent activity.`
  const portalHost = typeof document === 'undefined' ? null : document.body
  const inspectorInPortal = inspectorOpen && portalHost !== null

  const inspectTab = (tabId: string) => {
    setInspectedTabId(tabId)
    setInspectorOpen(true)
  }

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

  const inspectorClassName = `topic-workbench-topology__inspector${inspectorInPortal ? ' topic-workbench-topology__inspector--portal' : ''}`
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
      <span className="topic-workbench-topology__inspector-head">
        <span><PanelTop size={13} /><strong>{inspected?.title ?? 'Topic workbench'}</strong></span>
      </span>
      {inspected ? <RegionLayout regions={inspected.regions} aspectRatio={aspectRatio} className="topic-workbench-topology__inspector-regions" /> : null}
    </span>
  )

  return (
    <span
      ref={anchorRef}
      className="topic-workbench-topology"
      tabIndex={0}
      role="group"
      aria-label={label}
      aria-describedby={popoverId}
      title={label}
      onMouseEnter={() => setInspectorOpen(true)}
      onMouseLeave={() => setInspectorOpen(false)}
      onFocus={() => setInspectorOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInspectorOpen(false)
      }}
    >
      <span className="topic-workbench-topology__tab-rail" role="group" aria-label="Topic Tabs">
        {tabs.map((tab, index) => (
          <button
            type="button"
            className={`topic-workbench-topology__tab-chip${tab.active ? ' active' : ''}${inspectorOpen && tab.tabId === inspected?.tabId ? ' inspected' : ''}`}
            key={tab.tabId}
            style={{ zIndex: index + 1 }}
            data-topic-tab-id={tab.tabId}
            aria-pressed={tab.active}
            aria-label={`T${index + 1}: ${tab.title}, ${tab.regions.length} ${tab.regions.length === 1 ? 'Region' : 'Regions'}`}
            title={`${tab.title} · ${tab.regions.length} ${tab.regions.length === 1 ? 'Region' : 'Regions'}`}
            onMouseEnter={() => inspectTab(tab.tabId)}
            onFocus={() => inspectTab(tab.tabId)}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              setInspectorOpen(false)
              onSelectTab?.(tab.tabId)
            }}
          >
            <TopicTabGlyph tab={tab} />
          </button>
        ))}
      </span>
      {inspectorInPortal ? createPortal(inspector, portalHost) : inspector}
    </span>
  )
}

export function RegionMosaic({ cells, agents = [] }: {
  cells: readonly TopicRegionCell[]
  agents?: readonly SelectorPresenceAgent[]
}) {
  return (
    <span className="topic-region-mosaic">
      {cells.map((cell) => {
        const agent = agents.find((entry) => entry.key === cell.agentSessionId)
        return <span
          key={cell.regionId}
          className="topic-region-mosaic__cell"
          data-region-id={cell.regionId}
          style={{
            left: `${cell.bounds.x * 100}%`,
            top: `${cell.bounds.y * 100}%`,
            width: `${cell.bounds.width * 100}%`,
            height: `${cell.bounds.height * 100}%`
          }}
        >{agent ? <AgentAvatar executorId={agent.executorId} sessionId={agent.sessionId} label={agent.label} providerId={agent.providerId} state={agent.state} appearance={agent.appearance} count={agent.count} onOpen={agent.onOpen} /> : null}</span>
      })}
    </span>
  )
}
