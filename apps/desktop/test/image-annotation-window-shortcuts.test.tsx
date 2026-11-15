// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { ImageAnnotationEditor } from '../src/renderer/src/components/image-annotation/ImageAnnotationEditor'
import type { RectShape, ScreenshotShape } from '@agentmux/client-ui/image-annotation'
import { routeWindowShortcut, SHORTCUT_BINDINGS } from '../src/renderer/src/lib/shortcut-registry'
import { isEditableChordTarget } from '../src/renderer/src/lib/workbench-shortcuts'
import { surfaceOwnsChord } from '../src/renderer/src/lib/surface-chord-owners'

const raster = vi.hoisted(() => ({ committed: vi.fn(), scene: vi.fn() }))
// Component state, keys and outputs are production code; only raster drawing is replaced.
vi.mock('@agentmux/client-ui/image-annotation', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/client-ui/image-annotation')>(), renderCommittedLayer: raster.committed, renderScreenshotScene: raster.scene }))
let root: ReturnType<typeof createClientUiRoot>, node: HTMLDivElement, outside: HTMLButtonElement
let frames: Map<number, FrameRequestCallback>, nextFrame: number
// Every window binding records its id and consumes the key, as the workbench handlers do when they act.
let ran: string[], isMac: boolean
const handlers = Object.fromEntries(SHORTCUT_BINDINGS.filter(binding => binding.scope === 'window').map(binding => [binding.id, () => { ran.push(binding.id); return true }]))
// App's window router shell: the same capture-phase listener, editable fact and route.
function windowRouter(event: KeyboardEvent) {
  const element = event.target && (event.target as Node).nodeType === 1 ? event.target as HTMLElement : null
  const editableTarget = element !== null && isEditableChordTarget({ tagName: element.tagName, isContentEditable: element.isContentEditable,
    insideTerminal: element.closest('.xterm') !== null, surfaceOwnsChord: surfaceOwnsChord(element, event) })
  if (routeWindowShortcut(event, isMac, editableTarget, handlers)) event.preventDefault()
}
const image = { dataUrl: 'data:image/png;base64,AA==', width: 400, height: 300 }
function rect(): DOMRect { return { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON() {} } }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  frames = new Map(); nextFrame = 0; ran = []; isMac = true
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(rect)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  document.addEventListener('keydown', windowRouter, true)
  outside = document.createElement('button'); document.body.append(outside)
  node = document.createElement('div'); document.body.append(node); root = createClientUiRoot(node)
})
afterEach(async () => {
  await act(async () => root.unmount()); node.remove(); outside.remove()
  document.removeEventListener('keydown', windowRouter, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function frame() { await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16)) }) }
const box = (id: string, x: number, y: number): RectShape => ({ id, kind: 'rect', color: '#ef4444', width: 2, from: { x, y }, to: { x: x + 40, y: y + 30 } })
const row = (): ScreenshotShape[] => [box('a', 20, 40), box('b', 120, 80), box('c', 260, 60)]

async function mount() {
  const props = { image, busy: false, initialTool: 'select' as const, initialState: { shapes: row(), crop: null }, onCancel: vi.fn(), onComplete: vi.fn() }
  const render = (active: boolean) => act(async () => root.render(<ImageAnnotationEditor key="editor" {...props} active={active} />))
  await render(true); await frame()
  const editor = node.querySelector<HTMLElement>('[aria-label="Screenshot editor"]')!, canvas = editor.querySelector('canvas')!
  canvas.setPointerCapture = vi.fn()
  await act(async () => editor.querySelector('img')!.dispatchEvent(new Event('load'))); await frame()
  const pointer = (type: string) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: 20, clientY: 40 }))
  await act(async () => { pointer('pointerdown'); pointer('pointerup') }); await frame()
  const key = async (target: HTMLElement, value: string, init: KeyboardEventInit) => {
    await act(async () => { target.focus(); target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init })) }); await frame()
  }
  const output = async (): Promise<string[]> => {
    await act(async () => [...editor.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Copy PNG')!.click()); await frame()
    return props.onComplete.mock.lastCall![0].shapes.map((shape: ScreenshotShape) => shape.id)
  }
  return { canvas, key, output, render }
}

describe('the window shortcut router and a focused annotation editor', () => {
  it('a focused editor keeps its object chords and the workbench commands do not run', async () => {
    const { canvas, key, output } = await mount()
    await key(canvas, 'd', { metaKey: true })
    expect(ran, 'Command-D reaches no workbench command').toEqual([])
    const duplicated = await output(), copy = duplicated[3]!
    expect(duplicated.slice(0, 3), 'Command-D adds one copy of the selected mark on top').toEqual(['a', 'b', 'c'])
    expect(copy, 'the copy has its own id').not.toBe('a')
    await key(canvas, '[', { metaKey: true })
    expect(ran, 'Command-[ switches no tab').toEqual([])
    expect(await output(), 'Command-[ moves the selected copy one step down').toEqual(['a', 'b', copy, 'c'])
    await key(canvas, ']', { metaKey: true })
    expect(ran, 'Command-] switches no tab').toEqual([])
    expect(await output(), 'Command-] moves it one step up again').toEqual(['a', 'b', 'c', copy])
  })

  it('off mac Control-Shift brackets reorder in the editor instead of switching tabs', async () => {
    const { canvas, key, output } = await mount()
    isMac = false
    await key(canvas, '}', { ctrlKey: true, shiftKey: true })
    expect(ran, 'Control-Shift-] switches no tab').toEqual([])
    expect(await output(), 'Control-Shift-] brings a to the front').toEqual(['b', 'c', 'a'])
    await key(canvas, '{', { ctrlKey: true, shiftKey: true })
    expect(ran, 'Control-Shift-[ switches no tab').toEqual([])
    expect(await output(), 'Control-Shift-[ sends a to the back').toEqual(['a', 'b', 'c'])
  })

  it('outside the editor, and for chords it does not name, the workbench commands still run', async () => {
    const { canvas, key, output, render } = await mount()
    await key(canvas, 't', { metaKey: true })
    expect(ran, 'Command-T inside the editor still opens a tab').toEqual(['workbench.new-tab'])
    await key(outside, 'd', { metaKey: true })
    await key(outside, ']', { metaKey: true })
    await key(outside, '[', { metaKey: true })
    expect(ran.slice(1), 'outside the editor the chords split and switch tabs').toEqual(['workbench.split.right', 'workbench.next-tab', 'workbench.previous-tab'])
    expect(await output(), 'no key outside the editor changed its marks').toEqual(['a', 'b', 'c'])
    await render(false)
    ran = []
    await key(canvas, 'd', { metaKey: true })
    expect(ran, 'a hidden editor gives its chords back').toEqual(['workbench.split.right'])
  })
})
