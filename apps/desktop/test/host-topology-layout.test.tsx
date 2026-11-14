// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { HostTopology, type HostTopologyItem } from '../src/renderer/src/components/settings/HostTopology'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM()
class LayoutWorker {
  static all: LayoutWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  terminated = false
  request!: { id: string; input: { nodes: { id: string }[] } }
  constructor() { LayoutWorker.all.push(this) }
  postMessage(request: LayoutWorker['request']) { this.request = request }
  terminate() { this.terminated = true }
  reply(offset = 0) { this.onmessage?.({ data: { id: this.request.id, positions: Object.fromEntries(this.request.input.nodes.map((node, index) => [node.id, { x: offset + index * 240, y: index * 140 }])) } } as MessageEvent) }
}
const first: HostTopologyItem = { host: { id: 'first', kind: 'local', label: 'My Mac' }, check: undefined, projectCount: 1, sessionCount: 2 }
const second: HostTopologyItem = { host: { id: 'second', kind: 'ssh', label: 'Worker', hostname: 'worker.invalid' }, check: undefined, projectCount: 0, sessionCount: 0 }
let items: HostTopologyItem[], selected: string, onSelect: ReturnType<typeof vi.fn>
const node = (id: string) => dom.container.querySelector<HTMLElement>(`[data-host-node="${id}"]`)!
const position = (id: string) => node(id).closest<HTMLElement>('.react-flow__node')!.style.transform
const show = (active = true) => dom.render(<HostTopology items={items} selectedId={selected} onSelect={onSelect} active={active} linkView={<p>Original selected link</p>} />)
beforeEach(() => {
  installNoteCanvasGeometry(); LayoutWorker.all = []; vi.stubGlobal('Worker', LayoutWorker)
  items = [first, second]; selected = 'first'; onSelect = vi.fn()
})

it('settles one finite layout and keeps real nodes, positions and viewport mounted on status and selection changes', async () => {
  await show(); expect(LayoutWorker.all).toHaveLength(1)
  const worker = LayoutWorker.all[0]!
  await act(async () => worker.reply())
  expect(worker.terminated).toBe(true)
  expect(position('first')).toBe('translate(240px,140px)')
  const flow = dom.container.querySelector('.react-flow'), original = node('first')
  items = [{ ...first, check: { state: 'checking' }, sessionCount: 22 }, second]; selected = 'second'
  await show()
  expect(LayoutWorker.all).toHaveLength(1)
  expect(node('first')).toBe(original)
  expect(position('first')).toBe('translate(240px,140px)')
  expect(node('first').dataset.checkState).toBe('checking')
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Selected link"]')!.click())
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Fleet map"]')!.click())
  expect(dom.container.querySelector('.react-flow')).toBe(flow)
  expect(LayoutWorker.all).toHaveLength(1)
  await act(async () => node('second').click())
  expect(onSelect).toHaveBeenCalledWith('second')
})

it('cancels hidden layout and ignores an old result after an explicit newer arrangement', async () => {
  await show(); const original = LayoutWorker.all[0]!
  await show(false); expect(original.terminated).toBe(true); expect(LayoutWorker.all).toHaveLength(1)
  const held = position('first')
  await act(async () => original.reply(9000))
  expect(position('first')).toBe(held)
  await show(); const next = LayoutWorker.all.at(-1)!
  expect(next).not.toBe(original)
  await act(async () => next.reply())
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Arrange hosts"]')!.click())
  const explicit = LayoutWorker.all.at(-1)!
  expect(explicit).not.toBe(next)
  await act(async () => original.reply(9000))
  expect(position('first')).toBe('translate(240px,140px)')
  await act(async () => explicit.reply(80))
  expect(position('first')).toBe('translate(320px,140px)')
})

it('retains arranged positions through filtering and gives a new node space without moving existing hosts', async () => {
  await show(); await act(async () => LayoutWorker.all[0]!.reply())
  const held = position('first')
  items = [first]; await show()
  expect(LayoutWorker.all).toHaveLength(1)
  items = [first, second]; await show()
  expect(position('first')).toBe(held)
  expect(LayoutWorker.all).toHaveLength(1)
  items = [first, second, { ...second, host: { ...second.host, id: 'third', label: 'New worker' } }]; await show()
  expect(LayoutWorker.all).toHaveLength(2)
  await act(async () => LayoutWorker.all[1]!.reply())
  expect(position('first')).toBe(held)
  expect(position('third')).not.toBe(position('second'))
})

it('keeps selection and the original nodes usable when automatic geometry fails', async () => {
  await show()
  await act(async () => LayoutWorker.all[0]!.onerror?.())
  expect(dom.container.querySelector('[role="status"]')?.textContent).toContain('Move hosts freely')
  await act(async () => node('first').click())
  expect(onSelect).toHaveBeenCalledWith('first')
  expect(node('second').textContent).toContain('Worker')
  expect(LayoutWorker.all[0]!.terminated).toBe(true)
})

it('releases the original name tooltip when the graph hides or switches to the selected link', async () => {
  await show(); await act(async () => LayoutWorker.all[0]!.reply())
  const focus = async () => act(async () => node('first').dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
  await focus(); expect(document.querySelector('[role="tooltip"]')).not.toBeNull()
  await show(false); expect(document.querySelector('[role="tooltip"]')).toBeNull()
  await show(); await focus(); expect(document.querySelector('[role="tooltip"]')).not.toBeNull()
  await act(async () => dom.container.querySelector<HTMLButtonElement>('[aria-label="Selected link"]')!.click())
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
})
