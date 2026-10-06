// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientUiRoot } from './helpers/client-ui-render'
import { AnnotationToolbar } from '../src/renderer/src/components/image-annotation/AnnotationToolbar'

let host: HTMLDivElement, root: ReturnType<typeof createClientUiRoot>
const select = vi.fn(), undo = vi.fn(), redo = vi.fn(), remove = vi.fn(), clear = vi.fn()
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks(); host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
async function mount(busy = false) { await act(async () => root.render(<AnnotationToolbar tool="pen" busy={busy} undoable redoable={false} selected={false} clearable onTool={select} onUndo={undo} onRedo={redo} onDelete={remove} onClear={clear} />)) }
const toolbar = () => host.querySelector<HTMLElement>('[role="toolbar"]')!
const button = (name: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!
async function key(key: string) { await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); await new Promise(done => setTimeout(done, 0)) }) }
it('keeps selected tools distinct from roving focus and skips unavailable history controls', async () => {
  await mount()
  expect([...toolbar().querySelectorAll('button')].filter(button => button.tabIndex === 0)).toHaveLength(0)
  await act(async () => toolbar().focus())
  expect(document.activeElement).toBe(button('Pen'))
  expect([...toolbar().querySelectorAll('button')].filter(button => button.tabIndex === 0)).toEqual([button('Pen')])
  await key('End')
  expect(document.activeElement).toBe(button('Clear all'))
  await key('ArrowLeft')
  expect(document.activeElement).toBe(button('Undo'))
  expect(button('Pen').getAttribute('aria-pressed')).toBe('true')
  expect(select).not.toHaveBeenCalled(); expect(undo).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled()
  await act(async () => button('Undo').click())
  expect(undo).toHaveBeenCalledOnce()
})
it('retains the original selected tool while only Pan is reachable during an actual busy projection', async () => {
  await mount(true)
  await act(async () => toolbar().focus())
  expect(document.activeElement).toBe(button('Pan'))
  await key('ArrowRight'); await key('Home'); await key('End')
  expect(document.activeElement).toBe(button('Pan'))
  const enabled = [...toolbar().querySelectorAll<HTMLButtonElement>('button')].filter(control => !control.disabled)
  expect(enabled).toEqual([button('Pan')])
  expect(button('Pen').getAttribute('aria-pressed')).toBe('true')
  expect(select).not.toHaveBeenCalled()
  await act(async () => button('Pan').click())
  expect(select).toHaveBeenCalledExactlyOnceWith('pan')
})
