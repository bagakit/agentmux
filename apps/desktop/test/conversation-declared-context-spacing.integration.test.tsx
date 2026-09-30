// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { composeAgentLaunchPrompt, composeOutboundMessage } from '@agentmux/core/agent-outbound-message'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { AgentMarkdown } from '../src/renderer/src/components/AgentMarkdown'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'

const NOTE = 'Keep the original local context.'
const context = composeOutboundMessage({ amux: NOTE })
const plain = composeOutboundMessage({ amux: NOTE, user: 'Clarify goal' })
const contextOnly = composeAgentLaunchPrompt(undefined, false, NOTE)
const CODE_TAIL = '    const indentation = "four spaces"  \n\n**The original code remains readable.**'
const code = composeOutboundMessage({ amux: NOTE, user: CODE_TAIL })
const XML_TAIL = '    <amux from="amux">Original indented literal.</amux>  '
const literal = composeOutboundMessage({ amux: NOTE, user: XML_TAIL })
const DRAFT = 'Keep the original unsent spacing draft.'
const initial = useAppStore.getState()
let host: HTMLDivElement, root: Root
const natives: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
let controls: MockInstance<typeof api.sessions.stop>[]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  useAppStore.setState({ agentComposerDrafts: { 'private-agent': DRAFT } })
  controls = ['submitPrompt', 'write', 'resume', 'recover', 'stop'].map(name => vi.spyOn(api.sessions, name as 'stop').mockImplementation(() => { throw Error('Reading forbids UI Run control ' + name) }))
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges()
  expect(natives.length).toBeGreaterThan(0); expect(controls).toHaveLength(5); expect(controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0])
  for (const native of natives.splice(0)) {
    expect(native.controls).toHaveLength(6); expect(native.controls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0])
    expect(await native.bytes()).toEqual(native.before); await native.close()
  }
  expect(useAppStore.getState().agentComposerDrafts['private-agent']).toBe(DRAFT)
  vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true)
})

async function fixture(bodies: readonly string[]) {
  expect(bodies.length).toBeGreaterThan(0)
  const ids = bodies.map((_, index) => `spacing-original-${index + 1}`)
  const native = await nativeHistoryFixture('claude', jsonl(bodies.map((text, index) => ({ sessionId: 'native-main', uuid: ids[index], type: 'user', message: { role: 'user', content: text } }))))
  natives.push(native)
  const reads = vi.spyOn(native.client, 'sessionHistoryPage'), page = await native.client.sessionHistoryPage(native.session.agentSessionId, { limit: 30 })
  expect(page.items.map(item => [item.id, item.kind, item.startedAt])).toEqual(ids.map(id => [id, 'user-message', undefined]))
  expect(page.items.map(item => item.contentParts)).toEqual(bodies.map(text => [{ kind: 'text', text }]))
  const messages = projectSessionUserMessages({ agentSessionId: page.agentSessionId, historyPage: page })
  expect(messages.map(message => [message.rawId, message.author.kind, message.recordedAt])).toEqual(ids.map(id => [id, 'unknown', undefined]))
  expect(messages.map(message => message.content)).toEqual(bodies)
  return { ...native, ids, bodies, page, messages, reads }
}
function activity(f: Awaited<ReturnType<typeof fixture>>, state: 'done' | 'working' = 'done') {
  return <ActivityView sessionId={f.page.agentSessionId} capability="complete-events" displayState={state} items={[]} nativeHistoryPage={f.page} userMessages={f.messages} />
}
async function draw(f: Awaited<ReturnType<typeof fixture>>, state: 'done' | 'working' = 'done') {
  await act(async () => root.render(activity(f, state)))
  expect([...host.querySelectorAll<HTMLElement>('[data-native-record-id]')].map(row => row.dataset.nativeRecordId)).toEqual(f.ids)
}
function turn(id: string) { const row = host.querySelector<HTMLElement>(`[data-native-record-id="${id}"] .log-turn`); expect(row).not.toBeNull(); return row! }
function paragraph(row: HTMLElement) { const p = row.querySelector<HTMLElement>('.log-turn__text > p'); expect(p).not.toBeNull(); return p! }
async function copy(row: HTMLElement, original: string) {
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined), button = row.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')
  expect(button).not.toBeNull(); await act(async () => button!.click()); expect(clipboard).toHaveBeenLastCalledWith(original)
}

it('actual Claude display removes only two complete declaration separator line breaks and preserves original body and Copy', async () => {
  const variants = [
    { wire: plain, body: '\n\nClarify goal', display: 'Clarify goal' },
    { wire: context + '\nClarify goal', body: '\nClarify goal', display: 'Clarify goal' },
    { wire: context + '\r\n\r\nClarify goal', body: '\r\n\r\nClarify goal', display: 'Clarify goal' },
    { wire: composeOutboundMessage({ amux: NOTE, user: '\nClarify goal' }), body: '\n\n\nClarify goal', display: '\nClarify goal' },
    { wire: context + ' \n\nClarify goal', body: ' \n\nClarify goal', display: ' \n\nClarify goal' },
    { wire: context + '\t\n\nClarify goal', body: '\t\n\nClarify goal', display: '\t\n\nClarify goal' },
    { wire: context + '\rClarify goal', body: '\rClarify goal', display: '\rClarify goal' }
  ]
  expect(variants).toHaveLength(7)
  const f = await fixture(variants.map(variant => variant.wire)); await draw(f)
  for (const [index, variant] of variants.entries()) {
    const parsed = parseAgentMuxMessagePrefix(f.messages[index]!.content)!; expect(parsed).not.toBeNull(); expect(parsed.declaredContexts).toEqual([{ raw: context }]); expect(parsed.body).toBe(variant.body)
    const row = turn(f.ids[index]!), p = paragraph(row); expect(p.textContent).toBe(variant.display); expect(p.classList.contains('md-paragraph')).toBe(true)
    expect(row.querySelectorAll('.log-turn__declared-context')).toHaveLength(1); await copy(row, variant.wire)
  }
  expect(f.reads).toHaveBeenCalledOnce()
})

it('ordinary undeclared text retains whitespace and production fallback custom class and file-reference behavior', async () => {
  const text = '\n\nOriginal plain line  \n  Keep spaces and src/task.ts', wire = composeOutboundMessage({ user: text })
  const f = await fixture([wire]); await draw(f)
  expect(parseAgentMuxMessagePrefix(f.messages[0]!.content)).toBeNull(); const row = turn(f.ids[0]!)
  expect(row.querySelectorAll('.log-turn__declared-context')).toHaveLength(0); expect(paragraph(row).textContent).toBe(text); expect(paragraph(row).classList.contains('md-paragraph')).toBe(true)
  await copy(row, wire)
  const open = vi.fn()
  await act(async () => root.render(<>{activity(f)}<AgentMarkdown content={f.messages[0]!.content} className="spacing-original-class" workspaceRoot={f.root} openWorkspaceFile={open} /></>))
  const custom = host.querySelector<HTMLElement>('p.spacing-original-class'); expect(custom).not.toBeNull(); expect(custom!.classList.contains('md-paragraph')).toBe(true); expect(custom!.textContent).toBe(text)
  const reference = custom!.querySelector<HTMLButtonElement>('button.md-link--file'); expect(reference).not.toBeNull()
  await act(async () => reference!.click()); expect(open).toHaveBeenCalledOnce(); expect(open.mock.calls[0]![0]).toBe('src/task.ts'); expect(f.reads).toHaveBeenCalledOnce()
})

it('actual Claude declaration tails preserve genuine four-space Markdown code and indented XML literal paragraph including line-end spaces', async () => {
  const f = await fixture([code, literal]); await draw(f)
  expect(f.ids).toHaveLength(2)
  expect(parseAgentMuxMessagePrefix(f.messages[0]!.content)?.body).toBe('\n\n' + CODE_TAIL)
  const codeRow = turn(f.ids[0]!), codeElement = codeRow.querySelector('code'); expect(codeElement).not.toBeNull(); expect(codeElement!.textContent).toBe('const indentation = "four spaces"  ')
  expect(codeRow.querySelector('strong')?.textContent).toBe('The original code remains readable.'); await copy(codeRow, code)
  expect(parseAgentMuxMessagePrefix(f.messages[1]!.content)?.body).toBe('\n\n' + XML_TAIL)
  const literalRow = turn(f.ids[1]!); expect(literalRow.querySelectorAll('.log-turn__declared-context')).toHaveLength(1); expect(paragraph(literalRow).textContent).toBe(XML_TAIL); await copy(literalRow, literal)
  expect(f.reads).toHaveBeenCalledOnce()
})

it('actual three-record reading keeps IDs, unknown facts, paragraph DOM and Range, disclosure, scroll, stored draft and complete raw Copy across rerender', async () => {
  const f = await fixture([plain, contextOnly.text, code]); await draw(f)
  expect(f.ids).toEqual(['spacing-original-1', 'spacing-original-2', 'spacing-original-3'])
  const row = turn(f.ids[0]!), p = paragraph(row), body = row.querySelector('.log-turn__text')!, disclosure = row.querySelector<HTMLDetailsElement>('details.log-turn__declared-context')!
  expect(p.textContent).toBe('Clarify goal'); expect(disclosure).not.toBeNull(); await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')) })
  const text = p.firstChild; expect(text).not.toBeNull(); expect(text!.nodeType).toBe(Node.TEXT_NODE)
  const range = document.createRange(); range.setStart(text!, 0); range.setEnd(text!, 7); window.getSelection()!.addRange(range)
  const feed = host.querySelector<HTMLElement>('.activity-feed'); expect(feed).not.toBeNull(); feed!.scrollTop = 167
  await draw(f, 'working'); expect(turn(f.ids[0]!)).toBe(row); expect(paragraph(row)).toBe(p); expect(row.querySelector('.log-turn__text')).toBe(body)
  expect(row.querySelector('details.log-turn__declared-context')).toBe(disclosure); expect(disclosure.open).toBe(true); expect(range.startContainer).toBe(text); expect(window.getSelection()!.toString()).toBe('Clarify'); expect(feed!.scrollTop).toBe(167)
  const noTail = turn(f.ids[1]!); expect(parseAgentMuxMessagePrefix(contextOnly.text)?.body).toBe(''); expect(noTail.querySelectorAll('.log-turn__text > p')).toHaveLength(0); expect(noTail.querySelectorAll('.log-turn__declared-context')).toHaveLength(1)
  expect(row.querySelector('.log-turn__who')?.textContent).toBe('You'); expect(row.querySelector('.log-turn__declared-source')).toBeNull(); await copy(row, plain); expect(f.reads).toHaveBeenCalledOnce()
  if (process.env.AGENTMUX_CONTEXT_SPACING_SCENE_OUTPUT) {
    const output = resolve(process.env.AGENTMUX_CONTEXT_SPACING_SCENE_OUTPUT); await mkdir(resolve(output, '..'), { recursive: true })
    await writeFile(output, JSON.stringify({ schema: 'agentmux.conversation-declared-context-spacing-public-scene.v1', page: f.page, messages: f.messages, draft: DRAFT,
      producer: { plain, contextOnly, code, originalCodeTail: CODE_TAIL }, kernelControls: f.controls.map(control => control.mock.calls.length), uiControls: controls.map(control => control.mock.calls.length), readerCalls: f.reads.mock.calls.length,
      provenance: 'Actual public compose → private FileStore and built-in Claude reader → public projector → actual Activity/NativeThread/Message. Original unknown authors, IDs, parts and absent recorded time retained.' }, null, 2))
  }
})
