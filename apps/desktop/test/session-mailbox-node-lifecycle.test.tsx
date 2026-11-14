// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { mailboxJournal } from './helpers/mailbox-journal-fixture'

const dom = composerDOM(), original = composerSession('original-mailbox-agent')
const system = { available: true, notices: [], unread: [], acknowledge: vi.fn() }
let attached = false, visible = false, control = original.control
let openNodes: WeakSet<HTMLElement>, shown: HTMLElement[]
const descriptors = new Map<string, PropertyDescriptor | undefined>()
function toggle(node: HTMLElement, state: 'open' | 'closed') {
  if (state === 'open') openNodes.add(node); else openNodes.delete(node)
  for (const name of ['beforetoggle', 'toggle']) {
    const event = new Event(name)
    Object.defineProperty(event, 'newState', { value: state })
    node.dispatchEvent(event)
  }
}
beforeEach(() => {
  attached = false; visible = false; control = original.control; openNodes = new WeakSet(); shown = []
  mailboxJournal()
  vi.spyOn(api.sessions, 'inputMailbox').mockImplementation(async (source, options) => ({ agentSessionId: source.agentSessionId,
    queueId: 'original-mailbox', cut: { incarnation: 'original', throughSequence: 0 }, items: [], nextCursor: null,
    budgetBytes: options?.maxBytes ?? 65536, coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } }))
  const matches = HTMLElement.prototype.matches
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (selector) {
    return selector === ':popover-open' ? openNodes.has(this) : matches.call(this, selector)
  })
  for (const name of ['showPopover', 'hidePopover']) descriptors.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))
  Object.defineProperties(HTMLElement.prototype, {
    showPopover: { configurable: true, value: function (this: HTMLElement) {
      if (!this.isConnected) throw new DOMException('The original node is detached', 'InvalidStateError')
      shown.push(this); toggle(this, 'open')
    } },
    hidePopover: { configurable: true, value: function (this: HTMLElement) { toggle(this, 'closed') } }
  })
  useAppStore.setState({ sessions: [original], agentComposerDrafts: { [original.id]: 'The original nonempty draft' } })
})
afterEach(() => {
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, name)
  }
})
const panel = () => dom.container.querySelector<HTMLDivElement>('.composer-mailbox')!
const render = () => dom.render(<SessionMailbox system={system} queued={[]} control={control} visible={visible}>
  {mailbox => <div className="composer">{attached ? mailbox : <span>Original Composer is preparing its toolbar</span>}</div>}
</SessionMailbox>)
const retained = () => {
  expect(useAppStore.getState().agentComposerDrafts[original.id]).toBe('The original nonempty draft')
  expect(useAppStore.getState().sessions[0]?.control).toEqual(original.control)
}
it('an optional mailbox slot can be absent and attach without taking down the original Composer', async () => {
  await expect(render()).resolves.toBeUndefined()
  expect(dom.container.textContent).toContain('Original Composer is preparing')
  expect(panel()).toBeNull()
  visible = true; await expect(render()).resolves.toBeUndefined()
  attached = true; await expect(render()).resolves.toBeUndefined()
  expect(panel()).not.toBeNull(); expect(panel().dataset.state).toBe('closed'); expect(shown).toEqual([]); retained()
})
it('the same original open intent resumes only after its actual mailbox node reattaches', async () => {
  attached = true; visible = true; await render()
  await act(async () => toggle(panel(), 'open'))
  expect(panel().dataset.state).toBe('open')
  visible = false; await render(); expect(openNodes.has(panel())).toBe(false)
  attached = false; await render(); expect(panel()).toBeNull()
  visible = true; await render(); expect(shown).toEqual([])
  const focused = document.activeElement
  attached = true; await render()
  expect(shown).toEqual([panel()]); expect(openNodes.has(panel())).toBe(true)
  expect(panel().dataset.state).toBe('open'); expect(document.activeElement).toBe(focused); retained()
})
it('a same-commit detach and reveal never reopens the detached native node', async () => {
  attached = true; visible = true; await render()
  const first = panel()
  await act(async () => toggle(first, 'open'))
  visible = false; await render()
  attached = false; visible = true; await expect(render()).resolves.toBeUndefined()
  expect(first.isConnected).toBe(false); expect(shown).toEqual([])
  attached = true; await render()
  expect(shown).toEqual([panel()]); retained()
})
it('a different original mailbox scope does not inherit the hidden source open intent', async () => {
  attached = true; visible = true; await render()
  await act(async () => toggle(panel(), 'open'))
  visible = false; await render()
  attached = false; await render()
  control = { ...original.control, agentSessionId: 'other-original-agent', run: { runId: 'other-original-run' } }
  visible = true; await render()
  attached = true; await render()
  expect(panel().dataset.state).toBe('closed'); expect(shown).toEqual([]); retained()
})
