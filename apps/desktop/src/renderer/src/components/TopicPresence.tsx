import type { TopicRegionCell } from '../lib/scratch-topic-layout'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PanelTop, SplitSquareVertical } from 'lucide-react'
import { AgentAvatar } from './AgentAvatar'
import { SelectorPresence, type SelectorPresenceAgent } from './SelectorList'

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export type TopicRegionDetail = TopicRegionCell & {
  executorLabel: string
  activity: string
}

export type TopicTabDetail = {
  tabId: string
  title: string
  active: boolean
  regions: readonly TopicRegionDetail[]
}

/** Agent identity belongs inside its Region; unmounted background Agents retain their own entry. */
export function TopicPresence({ cells, agents, tabs = [] }: {
  cells?: readonly TopicRegionCell[] | undefined
  agents: readonly SelectorPresenceAgent[]
  tabs?: readonly TopicTabDetail[]
}) {
  const mounted = new Set(cells?.map((cell) => cell.agentSessionId))
  return <span className="topic-presence">
    {tabs.length > 0 ? <TopicWorkbenchTopology tabs={tabs} /> : cells ? <RegionMosaic cells={cells} agents={agents} /> : null}
    <SelectorPresence agents={agents.filter((agent) => !mounted.has(agent.key))} />
  </span>
}

function compactExecutorLabel(label: string): string {
  const firstWord = label.split(/[·/]/u)[0]?.trim() ?? label
  return firstWord.length > 7 ? `${firstWord.slice(0, 6)}…` : firstWord
}

function surfaceLabel(kind: TopicRegionDetail['surfaceKind']): string {
  switch (kind) {
    case 'agent': return 'Agent'
    case 'terminal': return 'Terminal'
    case 'browser': return 'Browser'
    case 'file': return 'File'
    case 'launcher': return 'Launcher'
    default: return 'Region'
  }
}

/**
 * A Tab's collapsed preview is a miniature of its actual workbench. One
 * Region gets a single quiet tile; split Tabs retain each Region's bounds so
 * the shape can be read before opening the inspector.
 */
function TopicTabGlyph({ tab }: { tab: TopicTabDetail }) {
  const singleRegion = tab.regions.length === 1
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

function RegionLayout({
  regions,
  className
}: {
  regions: readonly TopicRegionDetail[]
  className: string
}) {
  const regionLabel = `${regions.length} ${regions.length === 1 ? 'Region' : 'Regions'}`
  return (
    <span className={className} aria-label={regionLabel}>
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
            <strong>{compactExecutorLabel(region.executorLabel)}</strong>
            <small>{surfaceLabel(region.surfaceKind)}</small>
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
export function TopicWorkbenchTopology({ tabs }: { tabs: readonly TopicTabDetail[] }) {
  const popoverId = useId()
  const anchorRef = useRef<HTMLSpanElement>(null)
  const inspectorRef = useRef<HTMLSpanElement>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [inspectorPosition, setInspectorPosition] = useState<{ left: number; top: number } | null>(null)
  const active = tabs.find((tab) => tab.active) ?? tabs[0]
  const [inspectedTabId, setInspectedTabId] = useState(active?.tabId ?? '')
  const inspected = tabs.find((tab) => tab.tabId === inspectedTabId) ?? active
  const inspectedIndex = inspected ? tabs.findIndex((tab) => tab.tabId === inspected.tabId) : -1
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
  }, [inspectedTabId, inspectorInPortal])

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
        {inspected ? <em>T{inspectedIndex + 1} · {inspected.regions.length} {inspected.regions.length === 1 ? 'Region' : 'Regions'}</em> : null}
      </span>
      {inspected ? <>
        <RegionLayout regions={inspected.regions} className="topic-workbench-topology__inspector-regions" />
        <span className="topic-workbench-topology__activity">
          {inspected.regions.map((region) => (
            <span className="topic-workbench-topology__activity-item" key={`${inspected.tabId}:${region.regionId}`}>
              <span><SplitSquareVertical size={10} /><strong>{region.executorLabel}</strong></span>
              <small>{region.activity}</small>
            </span>
          ))}
        </span>
      </> : null}
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
      <span className="topic-workbench-topology__tab-rail" role="list" aria-label="Topic Tabs">
        {tabs.map((tab, index) => (
          <span
            className={`topic-workbench-topology__tab-chip${tab.active ? ' active' : ''}${tab.tabId === inspected?.tabId ? ' inspected' : ''}`}
            key={tab.tabId}
            role="listitem"
            tabIndex={0}
            aria-label={`T${index + 1}: ${tab.title}, ${tab.regions.length} ${tab.regions.length === 1 ? 'Region' : 'Regions'}`}
            title={`${tab.title} · ${tab.regions.length} ${tab.regions.length === 1 ? 'Region' : 'Regions'}`}
            onMouseEnter={() => inspectTab(tab.tabId)}
            onFocus={() => inspectTab(tab.tabId)}
          >
            <TopicTabGlyph tab={tab} />
          </span>
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
