import { EventEmitter, getEventListeners } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { WebContents } from 'electron'
import { Window } from 'happy-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { RendererAnimationInspector, RENDERER_ANIMATIONS_PROGRAM } from '../src/main/renderer-animations.js'
import { createResourceMetricsPort } from '../src/main/resource-usage-control.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { agentMuxControlTimeoutMs } from '../../../packages/core/src/control.js'

const target = { windowId: 1, webContentsId: 2, generation: 3, pid: 4, creationTime: 1000 }
const disposers: Array<() => unknown> = []
class Animation {
  playState = 'running'
  pending = false
  currentTime: unknown = 0
  effect: { target: unknown; getTiming(): { duration: unknown; iterations: unknown } } | null
  readonly play = vi.fn(() => { throw new Error('Inspection must not play an animation') })
  readonly pause = vi.fn(() => { throw new Error('Inspection must not pause an animation') })
  readonly cancel = vi.fn(() => { throw new Error('Inspection must not cancel an animation') })
  constructor(element: unknown, duration: unknown, iterations: unknown) {
    this.effect = { target: element, getTiming: () => ({ duration, iterations }) }
  }
}
class CSSAnimation extends Animation { animationName = 'original-loop' }
class CSSTransition extends Animation { transitionProperty = 'opacity' }
function fixture() {
  const dom = new Window(), document = dom.document
  document.body.innerHTML = '<main class="outer"><section class="middle"><div class="inner"><span class="motion original" id="private-id" data-private="attribute-marker">private-text-marker</span></div></section></main><textarea>Original unsent draft</textarea><div contenteditable>Original selected content</div>'
  const element = document.querySelector('span')!
  const draft = document.querySelector('textarea')!
  draft.setSelectionRange(2, 7)
  const editor = document.querySelector('[contenteditable]')!
  const range = document.createRange(); range.setStart(editor.firstChild!, 3); range.setEnd(editor.firstChild!, 10)
  dom.getSelection()!.addRange(range)
  const animations = [new CSSAnimation(element, 900, Infinity), new CSSTransition(element, 0, 1), new Animation(null, 'auto', 0)]
  animations[1]!.playState = 'paused'
  animations[1]!.currentTime = -2
  animations[2]!.playState = 'finished'
  const getAnimations = vi.fn(() => animations)
  Object.defineProperty(document, 'getAnimations', { value: getAnimations })
  const evaluate = (source = RENDERER_ANIMATIONS_PROGRAM): unknown =>
    new Function('document', 'Element', 'CSSAnimation', 'CSSTransition', 'return ' + source)(document, dom.Element, CSSAnimation, CSSTransition)
  let current: typeof target | null = { ...target }
  const debuggerClient = { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn(), isAttached: vi.fn(() => true) }
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, isDevToolsOpened: vi.fn(() => true), debugger: debuggerClient,
    executeJavaScript: vi.fn(async (source: string, _userGesture?: boolean): Promise<unknown> => evaluate(source)) })
  const inspector = new RendererAnimationInspector(contents as unknown as WebContents, () => current)
  disposers.push(() => inspector.dispose(), () => dom.happyDOM.abort())
  const baseline = () => ({ html: document.body.innerHTML, draft: draft.value, start: draft.selectionStart, end: draft.selectionEnd,
    selected: dom.getSelection()!.toString(), activeElement: document.activeElement, animations: animations.map(a => ({ playState: a.playState, pending: a.pending, currentTime: a.currentTime })) })
  return { dom, document, element, animations, getAnimations, evaluate, contents, debuggerClient, inspector, baseline,
    setCurrent: (next: typeof current) => { current = next } }
}
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('executes the static native enumerator once and preserves nonempty states, timing and original DOM without debugger ownership', async () => {
  const f = fixture(), before = f.baseline()
  f.contents.executeJavaScript.mockImplementation(async source => {
    await new Promise(resolve => setTimeout(resolve, 3))
    return f.evaluate(source)
  })
  const result = await f.inspector.inspect({ target })
  expect(result).toMatchObject({ status: 'completed', sourceVerified: { before: true, after: true }, evaluation: { requested: true, settled: true },
    snapshot: { totalAnimations: 3, omittedAnimations: 0, animations: [
      { kind: 'css-animation', name: 'original-loop', playState: 'running', currentTime: 0, duration: 900, iterations: 'infinite',
        ancestry: ['span.motion.original', 'div.inner', 'section.middle'], targetTruncated: true, stringsTruncated: false },
      { kind: 'css-transition', name: 'opacity', playState: 'paused', currentTime: -2, duration: 0, iterations: 1 },
      { kind: 'web-animation', name: null, playState: 'finished', duration: 'auto', iterations: 0, ancestry: [] }
    ] }, issues: [] })
  expect(result.timing.sampledAt).toBeGreaterThanOrEqual(result.timing.requestedAt)
  expect(result.timing.finishedAt).toBeGreaterThanOrEqual(result.timing.sampledAt!)
  expect(f.contents.executeJavaScript).toHaveBeenCalledExactlyOnceWith(RENDERER_ANIMATIONS_PROGRAM, false)
  expect(f.getAnimations).toHaveBeenCalledOnce()
  expect(f.baseline()).toEqual(before)
  expect(JSON.stringify(result)).not.toMatch(/private-id|private-text-marker|attribute-marker/)
  for (const animation of f.animations) {
    expect(animation.play).not.toHaveBeenCalled(); expect(animation.pause).not.toHaveBeenCalled(); expect(animation.cancel).not.toHaveBeenCalled()
  }
  for (const method of Object.values(f.debuggerClient)) expect(method).not.toHaveBeenCalled()
  expect(f.contents.isDevToolsOpened).not.toHaveBeenCalled()
  expect(f.contents.eventNames()).toEqual([])
})

it('reports omitted entries and bounded names/classes/ancestry while retaining infinite/auto and unsupported values honestly', async () => {
  const f = fixture()
  f.element.className = Array.from({ length: 10 }, (_, i) => 'class' + i).join(' ')
  f.animations[0]!.effect = { target: f.element, getTiming: () => ({ duration: Infinity, iterations: Infinity }) }
  ;(f.animations[0] as CSSAnimation).animationName = 'name'.repeat(40)
  f.animations[0]!.currentTime = { value: 20, unit: 'percent' }
  f.animations[2]!.effect = { target: { unsupported: true }, getTiming: () => ({ duration: 'auto', iterations: 0 }) }
  const longLabel = f.document.createElement('div')
  longLabel.className = 'class'.repeat(40)
  f.animations.push(new Animation(longLabel, 0, 0))
  while (f.animations.length < 129) f.animations.push(new Animation(null, 0, 0))
  const result = await f.inspector.inspect({ target })
  expect(result.status).toBe('completed')
  expect(result.snapshot).toMatchObject({ totalAnimations: 129, omittedAnimations: 1 })
  expect(result.snapshot!.animations).toHaveLength(128)
  expect(result.snapshot!.animations[0]).toMatchObject({ name: 'name'.repeat(32), stringsTruncated: true, targetTruncated: true,
    duration: 'infinite', iterations: 'infinite', currentTime: null, ancestry: ['span.class0.class1.class2.class3.class4.class5.class6.class7', 'div.inner', 'section.middle'] })
  expect(result.snapshot!.animations[2]!.ancestry).toBeNull()
  expect(result.snapshot!.animations[3]).toMatchObject({ ancestry: [('div.' + 'class'.repeat(40)).slice(0, 128)], stringsTruncated: true })
  expect(result.snapshot!.animations.every(row => row.ancestry === null || row.ancestry.length <= 3 && row.ancestry.every(label => label.length <= 128))).toBe(true)
})

it('checks every original source field before evaluation and refuses only the mismatched read', async () => {
  for (const field of ['windowId', 'webContentsId', 'generation', 'pid', 'creationTime'] as const) {
    const f = fixture()
    await expect(f.inspector.inspect({ target: { ...target, [field]: target[field] + 1 } })).rejects.toMatchObject({ code: 'CONTROL_OWNER_LOST' })
    expect(f.contents.executeJavaScript).not.toHaveBeenCalled()
    expect((await f.inspector.inspect({ target })).status).toBe('completed')
  }
})

it('fences every changed source field after the actual static read without publishing another source snapshot', async () => {
  for (const field of ['windowId', 'webContentsId', 'generation', 'pid', 'creationTime'] as const) {
    const f = fixture()
    f.contents.executeJavaScript.mockImplementation(async source => { const value = f.evaluate(source); f.setCurrent({ ...target, [field]: target[field] + 1 }); return value })
    expect(await f.inspector.inspect({ target })).toMatchObject({ status: 'unknown', target, sourceVerified: { before: true, after: false },
      evaluation: { requested: true, settled: true }, snapshot: null, issues: [{ stage: 'source', code: 'CONTROL_OWNER_LOST' }] })
    expect(f.contents.eventNames()).toEqual([])
  }
})

it('treats document navigation and process/destruction loss as unknown even before the five-field owner changes', async () => {
  for (const event of ['did-start-navigation', 'render-process-gone', 'destroyed']) {
    const f = fixture(); let reply!: (value: unknown) => void
    f.contents.executeJavaScript.mockImplementation(() => new Promise(resolve => { reply = resolve }))
    const pending = f.inspector.inspect({ target })
    f.contents.emit(event, { isMainFrame: true, isSameDocument: false })
    const result = await pending, original = JSON.stringify(result)
    expect(result).toMatchObject({ status: 'unknown', snapshot: null, evaluation: { requested: true, settled: false }, issues: [{ code: 'CONTROL_OWNER_LOST' }] })
    f.contents.executeJavaScript.mockImplementation(async source => f.evaluate(source))
    expect((await f.inspector.inspect({ target })).status).toBe('completed')
    reply(f.evaluate()); await Promise.resolve(); await Promise.resolve()
    expect(JSON.stringify(result)).toBe(original)
    expect(f.contents.eventNames()).toEqual([])
  }
})

it('keeps same-document and subframe navigation outside this document read cancellation', async () => {
  const f = fixture(); let reply!: (value: unknown) => void
  f.contents.executeJavaScript.mockImplementation(() => new Promise(resolve => { reply = resolve }))
  const pending = f.inspector.inspect({ target })
  f.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  f.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  reply(f.evaluate())
  expect((await pending).status).toBe('completed')
})

it('retains actual evaluation facts on cancellation, timeout and disposal and ignores their late native promises', async () => {
  vi.useFakeTimers()
  for (const action of ['cancel', 'timeout', 'dispose']) {
    const f = fixture(), signal = new AbortController(); let reply!: (value: unknown) => void
    f.contents.executeJavaScript.mockImplementation(() => new Promise(resolve => { reply = resolve }))
    const pending = f.inspector.inspect({ target }, signal.signal)
    if (action === 'cancel') signal.abort()
    if (action === 'dispose') f.inspector.dispose()
    if (action === 'timeout') await vi.advanceTimersByTimeAsync(agentMuxControlTimeoutMs('metrics.animations.inspect'))
    const result = await pending, original = JSON.stringify(result)
    expect(result).toMatchObject({ status: 'unknown', evaluation: { requested: true, settled: false }, snapshot: null })
    expect(result.issues[0]!.code).toBe(action === 'cancel' ? 'CONTROL_CANCELLED' : action === 'dispose' ? 'CONTROL_OWNER_LOST' : 'CONTROL_TIMEOUT')
    reply(f.evaluate()); await vi.advanceTimersByTimeAsync(0)
    expect(JSON.stringify(result)).toBe(original)
    expect(getEventListeners(signal.signal, 'abort')).toEqual([])
    expect(f.contents.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  }
})

it('does not evaluate an already-cancelled read and keeps independent concurrent reads available', async () => {
  const f = fixture(), signal = new AbortController(); signal.abort()
  expect(await f.inspector.inspect({ target }, signal.signal)).toMatchObject({ status: 'unknown', evaluation: { requested: false, settled: false } })
  expect(f.contents.executeJavaScript).not.toHaveBeenCalled()
  const replies: Array<(value: unknown) => void> = []
  f.contents.executeJavaScript.mockImplementation(() => new Promise(resolve => replies.push(resolve)))
  const first = f.inspector.inspect({ target }), second = f.inspector.inspect({ target })
  expect(f.contents.executeJavaScript).toHaveBeenCalledTimes(2)
  replies[1]!(f.evaluate()); replies[0]!(f.evaluate())
  expect((await first).status).toBe('completed'); expect((await second).status).toBe('completed')
})

it('retains a settled failed evaluation and allows the next query without changing the document', async () => {
  const f = fixture(), before = f.baseline()
  f.contents.executeJavaScript.mockRejectedValueOnce(new Error('Static document read unavailable'))
  expect(await f.inspector.inspect({ target })).toMatchObject({ status: 'failed', snapshot: null,
    evaluation: { requested: true, settled: true }, issues: [{ stage: 'evaluate' }] })
  expect((await f.inspector.inspect({ target })).status).toBe('completed')
  expect(f.baseline()).toEqual(before)
})

it('delivers the nonempty original static document read through metrics, Unix and the compiled public CLI', async () => {
  const f = fixture(), before = f.baseline(), cli = process.env.ANIMATION_UNIT_CLI
  // The isolated parent supplies and verifies an actual compiled public CLI.
  expect(cli).toBeTypeOf('string')
  expect(cli!.length).toBeGreaterThan(0)
  const metrics = createResourceMetricsPort({ sampler: {} as never, currentWindow: () => target, animations: f.inspector })
  disposers.push(() => metrics.dispose())
  const socket = join(process.env.ANIMATION_UNIT_NAMESPACE!, 'a.sock'), server = new AgentMuxControlServer({ coreClients: () => [], metrics }, socket)
  await server.start(); disposers.push(() => server.stop())
  const argv = ['--import', process.env.ANIMATION_UNIT_PRE_IMPORT!, cli!, '--endpoint', 'unix://' + socket, 'system', 'metrics', 'animations', 'inspect',
    ...Object.entries(target).flatMap(([key, value]) => ['--' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), String(value)])]
  const child = spawn(process.execPath, argv, { env: { ...process.env, ANIMATION_UNIT_CHILD_LABEL: 'public-cli' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)) })
  await writeFile(join(process.env.ANIMATION_UNIT_OUTPUT!, 'public-cli.json'), JSON.stringify({ pid: child.pid, argv, exit, stdout, stderr }, null, 2) + '\n')
  expect(exit, stderr).toBe(0)
  const body = JSON.parse(stdout)
  expect(body).toMatchObject({ ok: true, result: { observation: { status: 'completed', target, evaluation: { requested: true, settled: true },
    snapshot: { totalAnimations: 3, omittedAnimations: 0, animations: [{ kind: 'css-animation', iterations: 'infinite' }, { playState: 'paused' }, { duration: 'auto' }] } } } })
  expect(f.contents.executeJavaScript).toHaveBeenCalledExactlyOnceWith(RENDERER_ANIMATIONS_PROGRAM, false)
  expect(f.getAnimations).toHaveBeenCalledOnce()
  expect(f.baseline()).toEqual(before)
  metrics.dispose()
  await expect(metrics.inspectAnimations!({ target })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
}, 30000)
