// @vitest-environment happy-dom
import { act, useLayoutEffect, type ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ReactFlowProps, useStoreApi } from '@xyflow/react'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installCollaborationCanvasGeometry } from './helpers/collaboration-canvas-dom'
import { installCollaborationLayoutLoopback, settleCollaborationCanvas } from './helpers/collaboration-layout-loopback'
import { AgentCollaborationGraph } from '../src/renderer/src/components/AgentCollaborationGraph'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { collaborationAgents, type CollaborationArea } from '../src/renderer/src/lib/agent-collaboration'
import { collaborationBoundsOverlap } from '../src/renderer/src/lib/collaboration-spatial-index'
import { collaborationVisibleHitBounds } from '../src/renderer/src/lib/collaboration-map-lod'
import { DEFAULT_FOCUS_MAP_PREFERENCES } from '../src/shared/focus-map-preferences'
import * as engine from '../src/renderer/src/lib/collaboration-layout-engine'

const captured = vi.hoisted(() => ({ store: null as ReturnType<typeof useStoreApi> | null }))
vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  function ObserveOriginalStore() { const store = actual.useStoreApi(); useLayoutEffect(() => { captured.store = store }, [store]); return null }
  return { ...actual, ReactFlow: ({ children, ...props }: ReactFlowProps & { children?: ReactNode }) => <actual.ReactFlow {...props}>{children}<ObserveOriginalStore /></actual.ReactFlow> }
})
type Point = { key: string; x: number; y: number; distance: number; order: number }
type SearchCost = { comparisons: number; selectionBudget: number; mergeBudget: number; searches: Array<{ id: string; cells: Set<string>; attempts: number; events: Array<{ offer?: Point; picked?: Point }> }> }
const metrics = globalThis as typeof globalThis & { __labelSearchCost?: SearchCost }
const dom = composerDOM(), originalDispatch = engine.handleCollaborationLayoutRequest
let geometry: Map<string, engine.CollaborationLayoutBox>, requests: engine.CollaborationLayoutRequest[]
beforeEach(() => {
  installCollaborationCanvasGeometry(1440, 1000); captured.store = null; geometry = new Map(); delete metrics.__labelSearchCost
  requests = installCollaborationLayoutLoopback()
  vi.spyOn(engine, 'handleCollaborationLayoutRequest').mockImplementation((request, publish, signal) => originalDispatch(request, response => {
    if (response.type === 'boxes') geometry = new Map(response.boxes.map(box => [box.id, box]))
    publish(response)
  }, signal))
})

it('keeps exact dense-world labels and hit clearance while each unique candidate is compared at most once per nearest selection', async () => {
  const contexts = Array.from({ length: 240 }, (_, index) => agentContextForSession(composerSession('label-cost-' + index), undefined, 'Original member ' + index, undefined, null))
  const agents = new Map([...collaborationAgents(contexts)].map(([id, agent]) => [id, { ...agent, tier: 'idle' as const }]))
  const ids = [...agents.keys()]
  const areas: CollaborationArea[] = Array.from({ length: 84 }, (_, index) => ({ id: 'label-area-' + index, kind: 'project', name: 'Original complete project ' + index,
    members: index < 24 ? ids.slice(index * 10, index * 10 + 10) : [] }))
  await dom.render(<AgentCollaborationGraph agents={agents} areas={areas} relations={[]} pulses={[]} selection={null} onSelect={() => {}} onOpen={() => {}} ready={false} />)
  await settleCollaborationCanvas(() => {
    expect(geometry.size).toBe(324); expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull()
  })
  const world = [...geometry.values()], left = Math.min(...world.map(box => box.x)), right = Math.max(...world.map(box => box.x + box.width)), top = Math.min(...world.map(box => box.y)), bottom = Math.max(...world.map(box => box.y + box.height))
  const zoom = Math.min(1240 / (right - left), 800 / (bottom - top), .28), initial = [100 - left * zoom, 80 - top * zoom, zoom] as const
  await act(async () => captured.store!.setState({ width: 1440, height: 1000, transform: [...initial] }))
  await act(async () => new Promise(resolve => setTimeout(resolve, 40)))
  const originalGeometry = geometry, jobs = requests.length, names = new Map(areas.map(area => [area.id, area.name]))
  metrics.__labelSearchCost = { comparisons: 0, selectionBudget: 0, mergeBudget: 0, searches: [] }
  try {
    for (let step = 1; step <= 4; step++) {
      const panX = initial[0] - step * 8, panY = initial[1] + step * 3
      await act(async () => captured.store!.setState({ transform: [panX, panY, zoom] }))
      const labels = [...dom.container.querySelectorAll<HTMLElement>('.collaboration-area__overview-label')].map(label => ({ id: label.dataset.regionId!, name: label.querySelector('strong')?.textContent,
        x: Number.parseFloat(label.style.left), y: Number.parseFloat(label.style.top), width: Number(label.dataset.labelWidth), height: Number(label.dataset.labelHeight) }))
      expect(labels.length).toBeGreaterThan(30); expect(new Set(labels.map(label => label.id)).size).toBe(labels.length)
      for (const [index, label] of labels.entries()) {
        expect(label.name).toBe(names.get(label.id)); expect(label.width).toBeGreaterThan(100); expect(label.height).toBeGreaterThanOrEqual(40)
        expect(label.x).toBeGreaterThanOrEqual(0); expect(label.y).toBeGreaterThanOrEqual(0); expect(label.x + label.width).toBeLessThanOrEqual(1440); expect(label.y + label.height).toBeLessThanOrEqual(1000)
        for (const other of labels.slice(index + 1)) expect(collaborationBoundsOverlap(label, other), label.id + ' / ' + other.id).toBe(false)
        for (const box of world) if (box.kind === 'agent') {
          const hit = collaborationVisibleHitBounds(box, zoom, DEFAULT_FOCUS_MAP_PREFERENCES)
          expect(collaborationBoundsOverlap(label, { x: hit.x * zoom + panX, y: hit.y * zoom + panY, width: hit.width * zoom, height: hit.height * zoom }), label.id + ' / ' + box.id).toBe(false)
        }
      }
    }
    const cost = metrics.__labelSearchCost
    expect(cost.searches.length).toBeGreaterThan(100); expect(cost.comparisons).toBeGreaterThan(1000)
    let improvedCells = 0
    for (const search of cost.searches) {
      expect(search.attempts).toBe(search.cells.size); expect(search.attempts).toBeLessThanOrEqual(64)
      const offered: Point[] = [], visited = new Set<string>()
      for (const event of search.events) {
        if (event.offer) {
          const prior = offered.filter(point => point.key === event.offer!.key)
          if (!visited.has(event.offer.key) && prior.length && event.offer.distance < Math.min(...prior.map(point => point.distance))) improvedCells++
          offered.push(event.offer)
        } else {
          const actual = event.picked!
          expect(visited.has(actual.key), search.id + ' revisits an actual tested screen cell').toBe(false)
          // Independent event facts establish the minimum original proposal;
          // this oracle does not call the production queue or comparator.
          const eligible = offered.filter(point => !visited.has(point.key))
          const nearest = eligible.reduce((best, point) => point.distance < best.distance || point.distance === best.distance && point.order < best.order ? point : best)
          expect(actual, search.id + ' keeps the best original priority and stable tie for a clamped cell').toEqual(nearest)
          visited.add(actual.key)
        }
      }
    }
    expect(improvedCells).toBeGreaterThan(100)
    expect(Math.max(...cost.searches.map(search => search.attempts))).toBe(64)
    // A minimum selection needs no repeated ordering of the remaining frontier;
    // same-cell replacement has its own single-comparison allowance.
    expect(cost.comparisons).toBeLessThanOrEqual(cost.selectionBudget + cost.mergeBudget)
    expect(geometry).toBe(originalGeometry); expect(requests).toHaveLength(jobs)
    expect(captured.store!.getState().transform).toEqual([initial[0] - 32, initial[1] + 12, zoom])
    console.info(JSON.stringify({ originalLabelConsumerCost: { comparisons: cost.comparisons, selectionBudget: cost.selectionBudget, mergeBudget: cost.mergeBudget, searches: cost.searches.length, improvedCells, maxUniqueAttempts: Math.max(...cost.searches.map(search => search.attempts)) }, world: { agents: 240, areas: 84, zoom } }))
  } finally { delete metrics.__labelSearchCost }
})
