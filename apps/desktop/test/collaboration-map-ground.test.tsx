// @vitest-environment happy-dom
import { act, useLayoutEffect, type ReactNode } from 'react'
import type { Window as HappyDOMWindow } from 'happy-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactFlowProps, useStoreApi } from '@xyflow/react'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installCollaborationCanvasGeometry } from './helpers/collaboration-canvas-dom'
import { installCollaborationLayoutLoopback, settleCollaborationCanvas } from './helpers/collaboration-layout-loopback'
import { AgentCollaborationGraph } from '../src/renderer/src/components/AgentCollaborationGraph'
import { collaborationGroundLevels } from '../src/renderer/src/components/CollaborationMapGround'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { collaborationAgents, type CollaborationArea } from '../src/renderer/src/lib/agent-collaboration'
import { collaborationAgentNode, collaborationAreaNode } from '../src/renderer/src/lib/collaboration-presentation'
import { useAppStore } from '../src/renderer/src/store'
import baseCSS from '../src/renderer/src/styles/base.css?inline'
import collaborationCSS from '../src/renderer/src/styles/collaboration.css?inline'

/** Only observes the original camera store the real ReactFlow creates; nothing is replaced. */
const captured = vi.hoisted(() => ({ store: null as ReturnType<typeof useStoreApi> | null }))
vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  function ObserveOriginalStore() {
    const store = actual.useStoreApi()
    useLayoutEffect(() => { captured.store = store }, [store])
    return null
  }
  return { ...actual, ReactFlow: ({ children, ...props }: ReactFlowProps & { children?: ReactNode }) =>
    <actual.ReactFlow {...props}>{children}<ObserveOriginalStore /></actual.ReactFlow> }
})

const dom = composerDOM({ agentInformation: true })
const browser = window as unknown as HappyDOMWindow
let stylesheet: HTMLStyleElement
beforeEach(() => {
  captured.store = null
  installCollaborationCanvasGeometry()
  installCollaborationLayoutLoopback()
  browser.happyDOM.settings.device.prefersReducedMotion = 'reduce'
  stylesheet = document.createElement('style')
  // Both real sheets, including the global important reduction rule the Map preference must beat.
  stylesheet.textContent = collaborationCSS + '\n' + baseCSS
  document.head.append(stylesheet)
})
afterEach(() => {
  stylesheet.remove()
  browser.happyDOM.settings.device.prefersReducedMotion = 'no-preference'
})

type Drawn = ReadonlyMap<number, { screen: number; ink: number }>
/** Every level drawn at a zoom keyed by world spacing; an undrawn level has no ink. */
const drawn = (zoom: number): Drawn => {
  const { minor, major } = collaborationGroundLevels(zoom)
  return new Map([minor, major].map(level => [level.spacing, level]))
}
const inkOf = (levels: Drawn, spacing: number) => levels.get(spacing)?.ink ?? 0
/** The two former level thresholds, approached from each side. */
const THRESHOLDS = [.75, .15]
const sides = (threshold: number) => [threshold * (1 + 1e-9), threshold * (1 - 1e-9)] as const

it('hands each ground level over continuously through both former level thresholds', () => {
  for (const threshold of THRESHOLDS) {
    const [above, below] = sides(threshold).map(drawn) as [Drawn, Drawn]
    const spacings = new Set([...above.keys(), ...below.keys()])
    // A real handover: one level leaves, another enters, one stays and changes its role.
    expect(spacings.size).toBe(3)
    const kept = [...spacings].filter(spacing => above.has(spacing) && below.has(spacing))
    expect(kept).toHaveLength(1)
    const { minor, major } = collaborationGroundLevels(sides(threshold)[0])
    expect(major.spacing).toBe(kept[0])
    expect(collaborationGroundLevels(sides(threshold)[1]).minor.spacing).toBe(kept[0])
    expect(minor.spacing).not.toBe(kept[0])
    for (const spacing of spacings) expect(Math.abs(inkOf(above, spacing) - inkOf(below, spacing))).toBeLessThan(1e-6)
    // The kept level reads as the full grid on both sides and keeps its screen spacing.
    expect(inkOf(above, kept[0]!)).toBe(1)
    expect(Math.abs(above.get(kept[0]!)!.screen - below.get(kept[0]!)!.screen)).toBeLessThan(1e-6)
    // The leaving and entering levels are invisible at the switch: no full-ink level pops in.
    for (const spacing of spacings) if (spacing !== kept[0]) expect((above.get(spacing) ?? below.get(spacing))!.ink).toBeLessThan(1e-6)
  }
})

it('never jumps a level ink across the zoom range and always keeps one full reference grid', () => {
  // The camera's own range (minZoom .05, maxZoom 1.4), stepped finer than any real wheel tick.
  const steps = 20000, from = Math.log(.05), to = Math.log(1.4)
  let previous = drawn(.05), worst = 0, weakest = 1, switches = 0
  for (let index = 1; index <= steps; index++) {
    const current = drawn(Math.exp(from + (to - from) * index / steps))
    if ([...current.keys()].join() !== [...previous.keys()].join()) switches++
    for (const spacing of new Set([...previous.keys(), ...current.keys()])) worst = Math.max(worst, Math.abs(inkOf(previous, spacing) - inkOf(current, spacing)))
    weakest = Math.min(weakest, Math.max(...[...current.values()].map(level => level.ink)))
    previous = current
  }
  expect(switches).toBe(2)
  expect(worst).toBeLessThan(.01)
  expect(weakest).toBe(1)
})

/** Top-level comma separated layers of one CSS value. */
const layers = (value: string) => {
  const result: string[] = []
  let depth = 0, start = 0
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '(') depth++
    else if (value[index] === ')') depth--
    else if (value[index] === ',' && depth === 0) { result.push(value.slice(start, index).trim()); start = index + 1 }
  }
  return [...result, value.slice(start).trim()]
}
const groundRule = () => {
  expect(collaborationCSS.length).toBeGreaterThan(0)
  const start = collaborationCSS.indexOf('.collaboration-map-ground {')
  expect(start).toBeGreaterThanOrEqual(0)
  const rule = collaborationCSS.slice(start, collaborationCSS.indexOf('}', start))
  const declaration = (name: string) => {
    const match = new RegExp(`(?:^|[;{\\s])${name}:\\s*([^;]+);`, 'u').exec(rule)
    expect(match).not.toBeNull()
    return match![1]!
  }
  return { rule, image: layers(declaration('background-image')), size: layers(declaration('background-size')) }
}

it('draws both ground layers with one dot and one ink token, each paired with its own spacing', () => {
  const { image, size } = groundRule()
  expect(image).toHaveLength(2)
  expect(size).toHaveLength(2)
  const roles = image.map(layer => /--map-grid-(\w+)-ink\b/u.exec(layer)?.[1])
  expect(new Set(roles)).toEqual(new Set(['minor', 'major']))
  roles.forEach((role, index) => {
    expect(size[index]).toContain(`--map-grid-${role}-spacing`)
    expect(size[index]).not.toContain(`--map-grid-${roles[1 - index]}-`)
  })
  // A level moving from one role to the other keeps its screen dot: the layers differ only by role.
  expect(image[0]!.replaceAll(roles[0]!, 'level')).toBe(image[1]!.replaceAll(roles[1]!, 'level'))
})

const sessions = ['reader', 'closed-selected', 'closed-resting', 'peer']
async function renderScene() {
  const contexts = sessions.map(id => agentContextForSession(composerSession(id), undefined, id, undefined, null))
  const original = collaborationAgents(contexts), ids = [...original.keys()]
  const agents = new Map([...original].map(([id, agent], index) => [id, index === 1 || index === 2 ? { ...agent, tier: 'closed' as const } : agent]))
  const areas: CollaborationArea[] = [
    { id: 'category', kind: 'category', name: 'Original category', members: [] },
    { id: 'topic', kind: 'topic', name: 'Original topic', parentId: 'category', members: [ids[0]!] },
    { id: 'mote', kind: 'mote', name: 'Original Mote', members: [ids[1]!, ids[2]!, ids[3]!] }]
  await dom.render(<AgentCollaborationGraph agents={agents} areas={areas} relations={[]} pulses={[]}
    selection={{ kind: 'agent', id: ids[1]! }} onSelect={vi.fn()} onOpen={vi.fn()} ready={false} />)
  await settleCollaborationCanvas(() => {
    expect(captured.store?.getState().nodeLookup.size).toBe(areas.length + sessions.length)
    expect(dom.container.querySelector('.collaboration-canvas__progress')).toBeNull()
  })
  const placed = [...captured.store!.getState().nodeLookup.values()].map(node => node.internals.positionAbsolute)
  await camera(1, 20 - Math.min(...placed.map(point => point.x)), 20 - Math.min(...placed.map(point => point.y)), 20000)
  await settleCollaborationCanvas(() => expect(dom.container.querySelectorAll('.react-flow__node')).toHaveLength(areas.length + sessions.length))
  return ids
}
async function camera(zoom: number, x = 37, y = -11, size?: number) {
  await act(async () => captured.store!.setState({ transform: [x, y, zoom], ...(size ? { width: size, height: size } : {}) }))
}
const nodeElement = (id: string) => [...dom.container.querySelectorAll<HTMLElement>('.react-flow__node')].find(element => element.getAttribute('data-id') === id)!

it('paints the same handover on the real Map ground through the camera store', async () => {
  await renderScene()
  const ground = dom.container.querySelector<HTMLElement>('.collaboration-canvas .collaboration-map-ground')!
  expect(ground).not.toBeNull()
  // Every token the ground rule reads is one the real component writes.
  const read = new Set([...groundRule().rule.matchAll(/var\((--map-grid-[\w-]+)/gu)].map(match => match[1]!).filter(name => name !== '--map-grid'))
  expect(read.size).toBe(4)
  for (const name of read) expect(ground.style.getPropertyValue(name)).not.toBe('')
  const painted = (zoom: number): Drawn => new Map(['minor', 'major'].map(role => {
    const screen = Number.parseFloat(ground.style.getPropertyValue(`--map-grid-${role}-spacing`))
    return [Math.round(screen / zoom), { screen, ink: Number(ground.style.getPropertyValue(`--map-grid-${role}-ink`)) }]
  }))
  for (const threshold of THRESHOLDS) {
    const [aboveZoom, belowZoom] = sides(threshold)
    await camera(aboveZoom)
    const above = painted(aboveZoom)
    expect([...above]).toEqual([...drawn(aboveZoom)].map(([spacing, { screen, ink }]) => [spacing, { screen, ink }]))
    expect(ground.style.backgroundPosition).toBe('37px -11px, 37px -11px')
    await camera(belowZoom, 5, 8)
    const below = painted(belowZoom)
    expect(ground.style.backgroundPosition).toBe('5px 8px, 5px 8px')
    const spacings = new Set([...above.keys(), ...below.keys()])
    expect(spacings.size).toBe(3)
    for (const spacing of spacings) expect(Math.abs(inkOf(above, spacing) - inkOf(below, spacing))).toBeLessThan(1e-6)
  }
  expect(dom.container.querySelector('.collaboration-canvas .collaboration-map-ground')).toBe(ground)
})

it('keeps closed members discless when selected, contour weight by depth, and recede on the Map motion switch', async () => {
  useAppStore.setState({ config: { ...useAppStore.getState().config!, focus: { recentActivityHours: 48, mapMotion: 'on' } } })
  const ids = await renderScene()
  const canvas = dom.container.querySelector<HTMLElement>('.collaboration-canvas')!
  expect(canvas.dataset.motion).toBe('on')
  const member = (index: number) => {
    const agent = nodeElement(collaborationAgentNode('mote', ids[index]!)).querySelector<HTMLElement>('.collaboration-agent')!
    return { agent, body: agent.querySelector<HTMLElement>('.collaboration-agent__body')! }
  }
  const selectedClosed = member(1), restingClosed = member(2), runnable = member(3)
  expect(selectedClosed.agent.classList.contains('collaboration-agent--closed')).toBe(true)
  expect(selectedClosed.body.dataset.selected).toBe('true')
  expect(restingClosed.agent.classList.contains('collaboration-agent--closed')).toBe(true)
  expect(restingClosed.body.dataset.selected).toBeUndefined()
  expect(runnable.agent.classList.contains('collaboration-agent--closed')).toBe(false)
  // A runnable member sits on a disc; a closed one has none, selected or not.
  expect(getComputedStyle(runnable.body).backgroundColor).not.toBe('transparent')
  expect(getComputedStyle(runnable.body).boxShadow).toContain('inset')
  expect(getComputedStyle(restingClosed.body).backgroundColor).toBe('transparent')
  expect(getComputedStyle(restingClosed.body).boxShadow).toBe('none')
  expect(getComputedStyle(selectedClosed.body).backgroundColor).toBe('transparent')
  // The selection ring stays: an outer 2px ring, not the default inset disc line.
  expect(getComputedStyle(selectedClosed.body).boxShadow).toContain('2px')
  expect(getComputedStyle(selectedClosed.body).boxShadow).not.toContain('inset')

  // Nesting depth decides contour weight; kind adds only its dash.
  const contour = (area: string) => {
    const node = nodeElement(collaborationAreaNode(area)).querySelector<HTMLElement>('.collaboration-area')!
    return { depth: node.dataset.depth, style: getComputedStyle(node.querySelector('.collaboration-area__envelope path')!) }
  }
  const category = contour('category'), topic = contour('topic'), mote = contour('mote')
  expect([category.depth, topic.depth, mote.depth]).toEqual(['0', '1', '0'])
  expect(Number.parseFloat(category.style.strokeWidth)).toBeGreaterThan(Number.parseFloat(topic.style.strokeWidth))
  expect(mote.style.strokeWidth).toBe(category.style.strokeWidth)
  expect(topic.style.strokeDasharray).toBe('2 3')
  expect(mote.style.strokeDasharray).toBe('8 3')
  expect(['', 'none']).toContain(category.style.strokeDasharray)

  // Recede rides the same Map motion switch, which keeps its duration under OS reduction.
  expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true)
  const identities = () => [...dom.container.querySelectorAll<HTMLElement>('.collaboration-area__overview-label .collaboration-area__identity')]
  expect(identities().length).toBe(3)
  expect(identities().some(identity => identity.closest<HTMLElement>('.collaboration-area__overview-label')!.dataset.recede === 'true')).toBe(true)
  for (const identity of identities()) expect(getComputedStyle(identity).transitionDuration).toBe('150ms')
})

it('drops the same recede transition when the Map motion switch is off', async () => {
  // A fresh render: happy-dom keeps stale selector matches for deep descendants when only an
  // ancestor attribute changes, so the off state is observed on its own original DOM. The OS
  // allows motion here, so only the Map switch can be what removes the transition.
  browser.happyDOM.settings.device.prefersReducedMotion = 'no-preference'
  useAppStore.setState({ config: { ...useAppStore.getState().config!, focus: { recentActivityHours: 48, mapMotion: 'off' } } })
  await renderScene()
  expect(matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false)
  expect(dom.container.querySelector<HTMLElement>('.collaboration-canvas')!.dataset.motion).toBe('off')
  const identities = [...dom.container.querySelectorAll<HTMLElement>('.collaboration-area__overview-label .collaboration-area__identity')]
  expect(identities.length).toBe(3)
  for (const identity of identities) expect(getComputedStyle(identity).transitionDuration).not.toBe('150ms')
})
