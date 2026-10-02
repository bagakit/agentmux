// @vitest-environment happy-dom
import { act, StrictMode, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InlineRenameField } from '../src/components/InlineRenameField.js'

let container: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
type Props = Parameters<typeof InlineRenameField>[0]
function Controlled({ initial = 'a.test.ts', ...props }: Omit<Props, 'value' | 'onValueChange'> & { initial?: string }) {
  const [value, setValue] = useState(initial)
  return <><InlineRenameField {...props} value={value} onValueChange={setValue} /><button>Another control</button></>
}
async function render(node: ReactNode) { await act(async () => root.render(node)) }
function field() {
  const input = container.querySelector<HTMLInputElement>('input')
  expect(input, 'Mounted shared rename input').not.toBeNull()
  return input!
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), value)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function key(key: string, init: KeyboardEventInit = {}) {
  await act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })))
}
async function composition(kind: 'compositionstart' | 'compositionend') {
  await act(async () => field().dispatchEvent(new CompositionEvent(kind, { bubbles: true })))
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('controlled shared InlineRenameField', () => {
  it('selects the caller supplied stem once, preserves later caret choices, and initializes a new identity', async () => {
    const commit = vi.fn<Props['onCommit']>(async () => {}), cancel = vi.fn()
    await render(<Controlled key="first" label="Rename file" selectionEnd={6} onCommit={commit} onCancel={cancel} />)
    expect(document.activeElement).toBe(field())
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 6])
    await type('draft.test.ts')
    await act(async () => {
      field().setSelectionRange(3, 5)
      container.querySelector('button')!.focus()
      field().focus()
    })
    expect([field().selectionStart, field().selectionEnd]).toEqual([3, 5])
    expect(field().value).toBe('draft.test.ts')
    await render(<Controlled key="second" initial=".env" label="Rename dot file" onCommit={commit} onCancel={cancel} />)
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 4])
    expect(commit).toHaveBeenCalledExactlyOnceWith('draft.test.ts')
  })

  it('keeps both composing Enter and native 229 owned by IME, then commits the final controlled value', async () => {
    const commit = vi.fn<Props['onCommit']>(async () => {}), cancel = vi.fn()
    await render(<Controlled label="Rename file" onCommit={commit} onCancel={cancel} />)
    await key('Enter', { isComposing: true })
    await key('Enter', { keyCode: 229 })
    await key('Escape', { keyCode: 229 })
    await composition('compositionstart')
    await type('新名称.ts')
    await key('Enter')
    await key('Escape')
    expect(commit).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    await composition('compositionend')
    expect(commit).not.toHaveBeenCalled()
    await key('Enter')
    expect(commit).toHaveBeenCalledExactlyOnceWith('新名称.ts')
  })

  it('waits for composition end after blur and writes its final DOM value once', async () => {
    vi.useFakeTimers()
    const commit = vi.fn<Props['onCommit']>(async () => {})
    await render(<Controlled label="Rename file" onCommit={commit} onCancel={vi.fn()} />)
    await composition('compositionstart')
    await type('候选.ts')
    await act(async () => container.querySelector('button')!.focus())
    expect(commit).not.toHaveBeenCalled()
    // IME may finish the DOM value before React receives the final input event.
    await act(async () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), '最终.ts'))
    await composition('compositionend')
    expect(commit).not.toHaveBeenCalled()
    await act(async () => vi.runOnlyPendingTimers())
    expect(commit).toHaveBeenCalledExactlyOnceWith('最终.ts')
    expect(document.activeElement).toBe(container.querySelector('button'))
  })

  it('coalesces Enter followed by blur and exposes caller pending as read only without cancelling the write', async () => {
    const write = deferred(), commit = vi.fn<Props['onCommit']>(() => write.promise), cancel = vi.fn()
    const props = { label: 'Rename file', onCommit: commit, onCancel: cancel }
    await render(<Controlled {...props} />)
    await type('renamed.ts')
    await act(async () => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      container.querySelector('button')!.focus()
    })
    await render(<Controlled {...props} pending />)
    expect(field().readOnly).toBe(true)
    expect(field().getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('[aria-label="Saving name"]')).not.toBeNull()
    await key('Enter'); await key('Escape')
    expect(commit).toHaveBeenCalledExactlyOnceWith('renamed.ts')
    expect(cancel).not.toHaveBeenCalled()
    await act(async () => write.resolve())
    await render(<Controlled {...props} />)
    expect(field().readOnly).toBe(false)
    expect(field().getAttribute('aria-busy')).toBe('false')
  })

  it('cancels Escape before blur and also cancels a deferred composition-blur write', async () => {
    vi.useFakeTimers()
    const commit = vi.fn<Props['onCommit']>(async () => {}), cancel = vi.fn()
    await render(<Controlled key="first" label="Rename file" onCommit={commit} onCancel={cancel} />)
    await key('Escape')
    await act(async () => container.querySelector('button')!.focus())
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
    await render(<Controlled key="second" label="Rename file" onCommit={commit} onCancel={cancel} />)
    await composition('compositionstart')
    await act(async () => container.querySelector('button')!.focus())
    await composition('compositionend')
    await key('Escape')
    await act(async () => vi.runOnlyPendingTimers())
    expect(cancel).toHaveBeenCalledTimes(2)
    expect(commit).not.toHaveBeenCalled()
  })

  it('retains a failed draft, exposes the caller error accessibly, and does not steal focus or reset the retry caret', async () => {
    const write = deferred(), commit = vi.fn<Props['onCommit']>(() => write.promise), props = { label: 'Rename file', onCommit: commit, onCancel: vi.fn() }
    await render(<Controlled {...props} />)
    await type('retry.ts')
    await act(async () => { field().setSelectionRange(2, 4); container.querySelector('button')!.focus() })
    await act(async () => write.resolve())
    await render(<Controlled {...props} error="Destination already exists" />)
    const error = container.querySelector<HTMLElement>('[role="alert"]')
    expect(error).not.toBeNull()
    expect(field().getAttribute('aria-describedby')).toBe(error!.id)
    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(error!.textContent).toBe('Destination already exists')
    expect(field().value).toBe('retry.ts')
    expect(document.activeElement).toBe(container.querySelector('button'))
    await act(async () => field().focus())
    expect([field().selectionStart, field().selectionEnd]).toEqual([2, 4])
    await type('available.ts')
    await key('Enter')
    expect(commit.mock.calls.map(([value]) => value)).toEqual(['retry.ts', 'available.ts'])
  })

  it('retains the final IME DOM characters through caller failure feedback and retries that exact draft', async () => {
    vi.useFakeTimers()
    const write = deferred(), commit = vi.fn<Props['onCommit']>(() => write.promise)
    const props = { label: 'Rename file', onCommit: commit, onCancel: vi.fn() }
    await render(<Controlled {...props} />)
    await composition('compositionstart'); await type('候选.ts')
    await act(async () => container.querySelector('button')!.focus())
    await act(async () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), '最终.ts'))
    await composition('compositionend')
    await act(async () => vi.runOnlyPendingTimers())
    expect(commit).toHaveBeenCalledExactlyOnceWith('最终.ts')
    await act(async () => write.resolve())
    await render(<Controlled {...props} error="Destination already exists" />)
    expect(field().value).toBe('最终.ts')
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('Destination already exists')
    expect(document.activeElement).toBe(container.querySelector('button'))
    await act(async () => field().focus())
    await key('Enter')
    expect(commit.mock.calls.map(([value]) => value)).toEqual(['最终.ts', '最终.ts'])
  })

  it('survives StrictMode effect replay and discards queued writes when the field is removed', async () => {
    vi.useFakeTimers()
    const commit = vi.fn<Props['onCommit']>(async () => {}), props = { label: 'Rename file', onCommit: commit, onCancel: vi.fn() }
    await render(<StrictMode><Controlled {...props} /></StrictMode>)
    await key('Enter')
    expect(commit).toHaveBeenCalledExactlyOnceWith('a.test.ts')
    await render(<StrictMode><Controlled key="new" {...props} /></StrictMode>)
    await composition('compositionstart')
    await act(async () => container.querySelector('button')!.focus())
    await composition('compositionend')
    await render(<p>Field closed</p>)
    await act(async () => vi.runOnlyPendingTimers())
    expect(commit).toHaveBeenCalledTimes(1)
  })
})
