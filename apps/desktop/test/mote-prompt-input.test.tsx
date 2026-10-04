const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MoteFirstCooperation } from '../src/renderer/src/components/MoteFirstCooperation'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import type { MoteWorkfaceScope } from '../src/renderer/src/lib/mote-workface'

const prepare = vi.hoisted(() => vi.fn())
vi.mock('../src/renderer/src/lib/mote-cooperation', async importOriginal => ({
  ...await importOriginal<typeof import('../src/renderer/src/lib/mote-cooperation')>(),
  prepareMoteCooperationDraft: prepare
}))
const scope = { workspace: { id: 'prompt-test', hostId: 'local', path: _hygiene_fixturePath("private/prompt-test"), name: 'Test', kind: 'folder' },
  topic: { id: 'mote', directoryPath: _hygiene_fixturePath("private/prompt-test/mote") }, rootPath: 'mote' } as MoteWorkfaceScope
let host: HTMLDivElement, root: ReturnType<typeof createRoot>
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  prepare.mockReset().mockResolvedValue({ sources: [] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<MoteFirstCooperation scope={scope} />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
const field = () => host.querySelector('textarea')!
const button = () => host.querySelector('button')!
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field(), value)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function key(options: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })
  await act(async () => { field().dispatchEvent(event) }); return event
}

it('keeps a stable action and the original Launcher draft while whitespace cannot prepare', async () => {
  const action = button()
  expect(action.disabled).toBe(true)
  await type('  '); await key({ metaKey: true }); expect(prepare).not.toHaveBeenCalled()
  await type('我的问题')
  expect(button()).toBe(action); expect(action.disabled).toBe(false)
  expect(Object.values(useLauncherState.getState().drafts).some(draft => draft.prompt === '我的问题')).toBe(true)
  await act(async () => action.click())
  expect(prepare).toHaveBeenCalledOnce()
  expect(prepare.mock.calls[0][2]).toEqual({ question: '我的问题' })
  expect(field().value).toBe('我的问题')
})

it('preserves normal Enter and IME-owned Enter, and admits Command/Control Enter', async () => {
  await type('正在组字')
  expect((await key({})).defaultPrevented).toBe(false)
  expect((await key({ metaKey: true, isComposing: true })).defaultPrevented).toBe(false)
  expect((await key({ ctrlKey: true, keyCode: 229 })).defaultPrevented).toBe(false)
  expect(prepare).not.toHaveBeenCalled()
  expect((await key({ metaKey: true })).defaultPrevented).toBe(true)
  expect(prepare).toHaveBeenCalledOnce()
  await key({ ctrlKey: true }); expect(prepare).toHaveBeenCalledTimes(2)
})

it('shows actual reading, prevents duplicate preparation and retains a failed question for retry', async () => {
  let reject!: (cause: Error) => void
  prepare.mockImplementationOnce(() => new Promise((_resolve, failure) => { reject = failure }))
  await type('Keep my question'); await key({ ctrlKey: true })
  expect(button().disabled).toBe(true); expect(button().getAttribute('aria-busy')).toBe('true')
  expect(host.textContent).toContain('Reading the saved profile')
  await key({ ctrlKey: true }); expect(prepare).toHaveBeenCalledOnce()
  await act(async () => reject(new Error('Material read is unconfirmed. Retry.')))
  expect(field().value).toBe('Keep my question'); expect(button().disabled).toBe(false)
  expect(host.textContent).toContain('Material read is unconfirmed')
  expect(host.querySelector('.ui-input-group')?.getAttribute('aria-invalid')).toBe('true')
  await key({ ctrlKey: true }); expect(prepare).toHaveBeenCalledTimes(2)
})
