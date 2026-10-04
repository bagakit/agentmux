// @vitest-environment happy-dom
import { act, Profiler } from 'react'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SpaceObjectIcon } from '../src/renderer/src/components/SpaceObjectIcon'
import { LiquidSelectionSurface } from '../src/renderer/src/components/LiquidSelectionSurface'
import { MoteFaceEditor } from '../src/renderer/src/components/MoteFaceEditor'
import { DEFAULT_MOTE_FACE } from '../src/shared/mote-avatars'
import { PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { ConversationMessageAvatar } from '../src/renderer/src/components/ConversationMessageAvatar'
import { defaultAgent } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import * as expressionAuthority from '../src/renderer/src/lib/mote-expression'
let root: Root, container: HTMLDivElement, sheet: HTMLStyleElement, reduced = false, commits = 0
let intersections: Map<Element, (visible: boolean) => void>, changes: Set<() => void>, frames: Map<number, FrameRequestCallback>
const baseline = useAppStore.getState()
const require = createRequire(import.meta.url)
const cssSources = [
  ...['tokens', 'chrome'].map(name => resolve(import.meta.dirname, '../src/renderer/src/styles', name + '.css')),
  ...['conversation-avatar', 'conversation-input-details'].map(name => require.resolve('@agentmux/client-ui/styles/' + name + '.css')),
  ...['mote-workface', 'space-object-appearance'].map(name => resolve(import.meta.dirname, '../src/renderer/src/styles', name + '.css'))
]
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); reduced = false; commits = 0; intersections = new Map(); changes = new Set(); frames = new Map()
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private listener: IntersectionObserverCallback) {}
    observe(node: Element) { const emit = (visible: boolean) => this.listener([{ target: node, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], this as unknown as IntersectionObserver); intersections.set(node, emit); emit(true) }
    unobserve(node: Element) { intersections.delete(node) }
    disconnect() { intersections.clear() }
  })
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ media: query, get matches() { return reduced }, addEventListener(_type: string, callback: () => void) { changes.add(callback) }, removeEventListener(_type: string, callback: () => void) { changes.delete(callback) } } as MediaQueryList))
  let sequence = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++sequence; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  sheet = document.createElement('style'); sheet.textContent = cssSources.map(path => readFileSync(path, 'utf8')).join('\n'); document.head.append(sheet)
  vi.spyOn(api.scratch, 'readMoteAvatar').mockResolvedValue({ width: 256, height: 256, dataUrl: 'data:image/png;base64,ORIGINAL' })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); sheet.remove(); expect(frames.size).toBe(0); expect(changes.size).toBe(0); useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const rect = { x: 180, y: 180, left: 180, top: 180, right: 212, bottom: 212, width: 32, height: 32, toJSON() {} }
async function mount(node: React.ReactNode) { await act(async () => root.render(<Profiler id="real-face" onRender={() => commits++}>{node}</Profiler>)); for (const svg of container.querySelectorAll<SVGSVGElement>('.mote-face')) vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(rect) }
function face() { const node = container.querySelector<HTMLElement>('[data-mote-expression]'); expect(node).not.toBeNull(); return node! }
function move(x: number, y = 196) { document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: x, clientY: y })); const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(10)) }
const image = { kind: 'image' as const, fileName: 'c'.repeat(64) + '.png' }
it('all static image, dragon, seed, manual and face consumers join one native owner without Session selectors or synchronized object phases', async () => {
  const expression = vi.spyOn(expressionAuthority, 'moteExpression')
  const choices = [image, null, null, 'book', DEFAULT_MOTE_FACE] as const
  await mount(<>{choices.map((choice, index) => <div key={index} data-static-asset={index}><SpaceObjectIcon kind="mote" name="Original identity" manualIcon={choice} avatarWorkspaceId="scratch" avatarTopicId={index === 1 ? PMO_TEAMS_TOPIC_ID : 'custom'} avatarObjectKey={'original-object-' + index} /></div>)}</>)
  const identities = [...container.querySelectorAll<HTMLElement>('[data-mote-expression]')]
  expect(identities).toHaveLength(choices.length); expect(intersections.size).toBe(choices.length); expect(changes.size).toBe(1)
  for (const identity of identities) { expect(identity.dataset.moteExpression).toBe('identity'); expect(identity.dataset.moteMotion).toBe('on') }
  expect(container.querySelectorAll('img')).toHaveLength(2)
  const phases = identities.map(node => parseFloat(node.style.getPropertyValue('--mote-ambient-delay')))
  expect(Math.max(...phases) - Math.min(...phases)).toBeGreaterThan(500)
  const count = commits; expression.mockClear()
  await act(async () => useAppStore.setState({ sessions: [{ ...defaultAgent, id: 'unrelated-original-session' }] }))
  expect(expression).not.toHaveBeenCalled(); expect(commits).toBe(count)
  const phase = identities[0]!.style.getPropertyValue('--mote-ambient-delay')
  await mount(<SpaceObjectIcon kind="mote" name="Renamed identity" manualIcon={image} avatarWorkspaceId="scratch" avatarTopicId="custom" avatarObjectKey="original-object-0" />)
  expect(face().style.getPropertyValue('--mote-ambient-delay')).toBe(phase)
})
it('ambient glyphs and images use native short gestures with a much longer unchanged rest', async () => {
  await mount(<><SpaceObjectIcon kind="mote" name="Seed" manualIcon={null} /><SpaceObjectIcon kind="mote" name="Manual" manualIcon="book" /><SpaceObjectIcon kind="mote" name="Image" manualIcon={null} avatarTopicId={PMO_TEAMS_TOPIC_ID} /><SpaceObjectIcon kind="topic" name="Topic" manualIcon="book" /></>)
  const paints = [...container.querySelectorAll('[data-mote-expression] svg, [data-mote-expression] img')]
  expect(paints).toHaveLength(3)
  for (const paint of paints) expect(getComputedStyle(paint).animation).toBe('mote-presence 14s ease-in-out infinite')
  expect(getComputedStyle(container.querySelector('[data-space-icon-kind="topic"] svg')!).animation).not.toContain('mote-presence')
  const rules = [...sheet.sheet!.cssRules] as CSSKeyframesRule[]
  const keyframes = rules.find(rule => rule.name === 'mote-presence')!
  expect(keyframes).toBeDefined()
  const points = [...keyframes.cssRules as unknown as CSSKeyframeRule[]].flatMap(rule => rule.keyText.split(',').map(key => ({ at: parseFloat(key) / 100, transform: rule.style.transform }))).sort((a, b) => a.at - b.at)
  expect(points.length).toBeGreaterThan(3)
  const neutral = points[0]!.transform
  const resting = points.slice(1).reduce((sum, point, index) => sum + (point.transform === neutral && points[index]!.transform === neutral ? point.at - points[index]!.at : 0), 0)
  expect(resting).toBeGreaterThanOrEqual(.75); expect(resting).toBeLessThan(1)
  expect(points.at(-1)!.transform).toBe(neutral)
  expect(points.some(point => point.transform !== neutral)).toBe(true)
})
it('neutral waiting and unknown blink while keeping brows and mouth, sleep keeps closed eyes and error/stopped retain pointer without ambient', async () => {
  for (const [state, expected] of [['waiting', 'waiting'], ['running', 'unknown'], ['error', 'error'], ['exited', 'stopped']] as const) {
    await mount(null)
    await act(async () => useAppStore.setState({ sessions: [{ ...defaultAgent, status: { state, source: 'run-process', observedAt: 20 } }] }))
    await mount(<SpaceObjectIcon kind="mote" name="Same identity" manualIcon={DEFAULT_MOTE_FACE} moteSessionId={defaultAgent.id} moteHostId="local" />)
    const identity = face(), allowed = expected === 'waiting' || expected === 'unknown'
    expect(identity.dataset.moteExpression).toBe(expected); expect(identity.dataset.moteMotion).toBe(allowed ? 'on' : 'off')
    expect(getComputedStyle(identity.querySelector('.mote-face__eyes')!).animation).toBe(allowed ? 'mote-blink 14s ease-in-out infinite' : '')
    expect(getComputedStyle(identity.querySelector('.mote-face__brows')!).animation).toBe('')
    expect(getComputedStyle(identity.querySelector('.mote-face__mouth')!).animation).toBe('')
    const svg = identity.querySelector('.mote-face')!.outerHTML; move(245)
    expect(identity.dataset.moteGaze).toBe('near'); expect(identity.querySelector('.mote-face')!.outerHTML).toBe(svg)
  }
  await mount(<SpaceObjectIcon kind="mote" name="Sleeping" manualIcon={DEFAULT_MOTE_FACE} moteAvailability="no-agent" />)
  move(700); expect(face().dataset.moteExpression).toBe('sleep')
  expect(getComputedStyle(face().querySelector('.mote-face__awake-eyes')!).display).toBe('none')
  expect(getComputedStyle(face().querySelector('.mote-face__head')!).animation).toContain('mote-breathe')
})
it('the native owner retains the original 16px Space, 24px input details and 32px historical author slots and author surface', async () => {
  await mount(<><div data-space-slot><SpaceObjectIcon kind="mote" name="Space" manualIcon="book" /></div><div className="conversation-input-details__identity"><SpaceObjectIcon kind="mote" name="Details" manualIcon={null} /></div><ConversationMessageAvatar speaker={{ role: 'agent', id: 'original-agent' }} name="Original Mote" mote={{ workspaceId: 'scratch', topicId: 'custom', objectKey: 'same-original', name: 'Original Mote', icon: image }} /></>)
  for (const [selector, size] of [['[data-space-slot]', '16px'], ['.conversation-input-details__identity', '24px'], ['[data-mote-author]', '32px']] as const) {
    const identity = container.querySelector(selector)!.querySelector<HTMLElement>('.project-rail-row__icon')!
    expect(identity.classList.contains('project-rail-row__icon')).toBe(true)
    expect(getComputedStyle(identity).width).toBe(size); expect(getComputedStyle(identity).height).toBe(size)
  }
  const author = container.querySelector('[data-mote-author] > .project-rail-row__icon')!
  expect(getComputedStyle(author).overflow).toBe('hidden'); expect(getComputedStyle(author).borderTopWidth).toBe('1px')
  expect(getComputedStyle(author).backgroundColor).toBeTruthy()
})
it('historical message identities and explicitly hidden assets remain static across all appearance sources', async () => {
  const expression = vi.spyOn(expressionAuthority, 'moteExpression')
  await mount(<>{([image, null, 'book', DEFAULT_MOTE_FACE] as const).map((choice, index) => <ConversationMessageAvatar key={index} speaker={{ role: 'agent', id: 'original-agent' }} name="Original Mote" mote={{ workspaceId: 'scratch', topicId: 'custom', objectKey: 'historical-' + index, name: 'Original Mote', icon: choice }} />)}</>)
  expect(container.querySelectorAll('[data-mote-author]')).toHaveLength(4); expect(intersections.size).toBe(0)
  expect(container.querySelectorAll('[data-space-icon-source]')).toHaveLength(4)
  expect(container.querySelectorAll('[data-mote-expression]')).toHaveLength(0); expect(changes.size).toBe(0)
  const count = commits; expression.mockClear()
  await act(async () => useAppStore.setState({ sessions: [{ ...defaultAgent, id: 'unrelated-original-session' }] }))
  expect(commits).toBe(count); expect(expression).not.toHaveBeenCalled()
  expect(frames.size).toBe(0); move(245); expect(frames.size).toBe(0)
})
it('the connected static face rig follows left/right and returns while keeping its authored face and zero React frame work', async () => {
  await mount(<SpaceObjectIcon kind="mote" name="Quiet identity" manualIcon={DEFAULT_MOTE_FACE} />)
  const identity = face(), svg = identity.querySelector('.mote-face')!, before = svg.outerHTML, count = commits
  expect(identity.dataset.moteExpression).toBe('identity'); expect(identity.dataset.moteMotion).toBe('on')
  expect(identity.querySelector('.mote-face__gaze-follow')).not.toBeNull(); expect(identity.querySelector('.mote-face__brow-follow')).not.toBeNull(); expect(identity.querySelector('.mote-face__mouth-follow')).not.toBeNull()
  move(145); expect(parseFloat(identity.style.getPropertyValue('--mote-gaze-x'))).toBeLessThan(0)
  expect(parseFloat(identity.style.getPropertyValue('--mote-head-turn'))).toBeLessThan(0); expect(parseFloat(identity.style.getPropertyValue('--mote-brow-lift'))).toBeLessThan(0)
  move(245); expect(parseFloat(identity.style.getPropertyValue('--mote-gaze-x'))).toBeGreaterThan(0)
  move(700); expect(identity.dataset.moteGaze).toBe('far'); expect(identity.style.getPropertyValue('--mote-gaze-x')).toBe('')
  expect(svg.outerHTML).toBe(before); expect(commits).toBe(count); expect(identity.dataset.moteExpression).toBe('identity')
})
it.each([undefined, 'static', 'no-agent', 'restoring'] as const)('identities without a Session (%s) consume no store selector on unrelated updates', async availability => {
  const expression = vi.spyOn(expressionAuthority,'moteExpression')
  await mount(<SpaceObjectIcon kind="mote" name="Original identity" manualIcon={DEFAULT_MOTE_FACE} moteAvailability={availability} />)
  const expected = availability === 'no-agent' ? 'sleep' : availability === 'restoring' ? 'unknown' : 'identity'
  expect(face().dataset.moteExpression).toBe(expected)
  const count=commits; expression.mockClear()
  await act(async()=>useAppStore.setState({sessions:[{...defaultAgent,id:'unrelated-original-session'}]}))
  expect(expression).not.toHaveBeenCalled(); expect(commits).toBe(count); expect(face().dataset.moteExpression).toBe(expected)
})
it('nearby sleeping, waiting and unknown faces keep their exact semantic facts while responding with their same bones', async () => {
  for (const [availability, expected] of [['no-agent', 'sleep'], ['restoring', 'unknown']] as const) {
    await mount(<SpaceObjectIcon kind="mote" name="Original Mote" manualIcon={DEFAULT_MOTE_FACE} moteAvailability={availability} />)
    move(245); expect(face().dataset.moteGaze).toBe('near'); expect(face().dataset.moteExpression).toBe(expected)
    expect(face().querySelector('.mote-face__awake-eyes')).not.toBeNull()
  }
  useAppStore.setState({ sessions: [{ ...defaultAgent, status: { state: 'waiting', source: 'native-hook', observedAt: 2 } }] })
  await mount(<SpaceObjectIcon kind="mote" name="Original Mote" manualIcon={DEFAULT_MOTE_FACE} moteSessionId={defaultAgent.id} moteHostId="local" />)
  move(145); expect(face().dataset.moteGaze).toBe('near'); expect(face().dataset.moteExpression).toBe('waiting')
  expect(useAppStore.getState().sessions[0]!.control).toEqual(defaultAgent.control)
})
it('a saved face joins the existing sleeping identity immediately and changing back to an icon releases its pointer work', async () => {
  await mount(<SpaceObjectIcon kind="mote" name="Original Mote" manualIcon={null} moteAvailability="no-agent" />)
  const original = face(); expect(original.querySelector('.mote-face')).toBeNull()
  await mount(<SpaceObjectIcon kind="mote" name="Original Mote" manualIcon={DEFAULT_MOTE_FACE} moteAvailability="no-agent" />)
  expect(face()).toBe(original); move(245)
  expect(original.dataset.moteGaze).toBe('near'); expect(original.dataset.moteExpression).toBe('sleep')
  await mount(<SpaceObjectIcon kind="mote" name="Original Mote" manualIcon="book" moteAvailability="no-agent" />)
  expect(face()).toBe(original); expect(original.querySelector('.mote-face')).toBeNull(); expect(original.dataset.moteGaze).toBe('far')
  move(145); expect(frames.size).toBe(0)
})
it('eighty hidden faces add no pointer or layout work and all visibility/reduced gates remove active work including a pending frame', async () => {
  const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener')
  await mount(<><SpaceObjectIcon kind="mote" name="Visible" manualIcon={DEFAULT_MOTE_FACE} />{Array.from({ length: 80 }, (_, index) => <SpaceObjectIcon key={index} kind="mote" name="Hidden" manualIcon={DEFAULT_MOTE_FACE} visible={false} />)}</>)
  const identities = [...container.querySelectorAll<HTMLElement>('[data-mote-expression]')]
  expect(identities).toHaveLength(1); expect(intersections.size).toBe(1); expect(changes.size).toBe(1)
  expect(add.mock.calls.filter(([event]) => event === 'pointermove')).toHaveLength(1)
  move(245)
  expect(identities[0]!.dataset.moteGaze).toBe('near')
  const hidden = [...container.querySelectorAll('.mote-face')].slice(1); expect(hidden).toHaveLength(80)
  for (const svg of hidden) { expect(svg.closest('[data-mote-expression]')).toBeNull(); expect(svg.getBoundingClientRect).not.toHaveBeenCalled() }
  document.dispatchEvent(new PointerEvent('pointermove', { clientX: 145, clientY: 196 })); expect(frames.size).toBe(1)
  intersections.get(identities[0]!)!(false); expect(frames.size).toBe(0); expect(face().dataset.moteMotion).toBe('off'); expect(remove.mock.calls.filter(([event]) => event === 'pointermove')).toHaveLength(1)
  intersections.get(identities[0]!)!(true); reduced = true; changes.forEach(change => change()); move(245)
  expect(face().dataset.moteMotion).toBe('off'); expect(face().dataset.moteGaze).toBe('far'); expect(frames.size).toBe(0)
  reduced = false; changes.forEach(change => change()); move(245); expect(face().dataset.moteGaze).toBe('near')
  const previous = Object.getOwnPropertyDescriptor(document, 'hidden')
  Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); move(145)
  expect(face().dataset.moteMotion).toBe('off'); expect(face().dataset.moteGaze).toBe('far'); expect(frames.size).toBe(0)
  if (previous) Object.defineProperty(document, 'hidden', previous); else delete (document as unknown as Record<string, unknown>).hidden
  document.dispatchEvent(new Event('visibilitychange'))
})
it('the actual editor preview uses the same native face rig without making its miniature choice samples consumers', async () => {
  await mount(<MoteFaceEditor face={DEFAULT_MOTE_FACE} disabled={false} onChange={vi.fn()} />)
  expect(container.querySelectorAll('.mote-face').length).toBeGreaterThan(10); expect(intersections.size).toBe(1)
  move(245); expect(face().dataset.moteGaze).toBe('near')
  expect(container.querySelector('.mote-face-editor__preview [data-mote-expression="identity"]')).not.toBeNull()
})

it('the same connected liquid surface follows horizontal avatar buttons and retains vertical settings geometry', async () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([rect] as unknown as DOMRectList)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const x = this.dataset.avatarSource === 'alternative' ? 190 : 0, y = this.dataset.settingsTarget === 'prompts' ? 80 : 0
    return { ...rect, x, y, left: x, top: y, right: x + 180, bottom: y + 36, width: 180, height: 36 }
  })
  const oldHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
  const animate = vi.spyOn(HTMLElement.prototype, 'animate').mockImplementation(() => ({ cancel: vi.fn() }) as unknown as Animation)
  const avatar = (selected: string) => <div><LiquidSelectionSurface selected={selected} active={true} targetAttribute="data-avatar-source" /><button data-avatar-source="face">Make a face</button><button data-avatar-source="alternative">Icon or image</button></div>
  const settings = (selected: string) => <div><LiquidSelectionSurface selected={selected} active={true} targetAttribute="data-settings-target" /><button data-settings-target="general">General</button><button data-settings-target="prompts">Prompts</button></div>
  try {
    await mount(avatar('face')); await mount(avatar('alternative'))
    const lens = container.querySelector<HTMLElement>('.liquid-selection')!
    expect(lens.dataset.liquidAxis).toBe('x'); expect(lens.style.transform).toContain('190px, 0px'); expect(animate).toHaveBeenCalled()
    const horizontal = animate.mock.calls.at(-1)![0] as Keyframe[]
    expect(horizontal).toHaveLength(4); expect(horizontal[1]!.transform).toContain('scale(1.45, 0.93)')
    expect(horizontal[2]!.transform).toContain('192px, 0px')
    await mount(settings('general')); await mount(settings('prompts'))
    expect(lens.dataset.liquidAxis).toBe('y'); expect(lens.style.transform).toContain('0px, 80px')
    const vertical = animate.mock.calls.at(-1)![0] as Keyframe[]
    expect(vertical).toHaveLength(4); expect(vertical[1]!.transform).toContain('scale(0.93, 1.45)'); expect(vertical[2]!.transform).toContain('0px, 82px')
    reduced = true; changes.forEach(change => change()); await mount(settings('general')); expect(lens.dataset.liquidPaused).toBe('true')
  } finally { if (oldHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', oldHeight); else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight }
})
