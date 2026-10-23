import { activityReadingProps } from './helpers/activity-reading-props'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { inspectConversationConsumers } from '../src/renderer/src/lib/conversation-consumer-observation'
// @vitest-environment happy-dom
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxStoredAgentSession } from '@agentmux/core'
import { composeAgentLaunchPrompt, composeOutboundMessage } from '@agentmux/core/agent-outbound-message'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { ActivityView } from '../src/renderer/src/components/ActivityView'

import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'

const USER_TAIL = '**Read the original tail**\n\n    const indentation = "four spaces"  \n\n[Original documentation](https://example.test/reading)'
const NOTE = 'Original project context.\nKeep the caller\u00a0scope.'
const positive = composeAgentLaunchPrompt(USER_TAIL, true, NOTE)
const firstContext = composeOutboundMessage({ amux: 'First original context.' })
const contextOnly = composeAgentLaunchPrompt(firstContext, false, 'Second generated context.')
const INDENTED_LITERAL = '    <amux>This is an indented code example.</amux>'
const indentedContinuation = composeOutboundMessage({ amux: 'First original context.', user: INDENTED_LITERAL })
const DRAFT = 'Keep the original unsent draft.'
const inputs = resolve('apps/desktop/scripts/fixtures/conversation-leading-amux-context')
const initial = useAppStore.getState()
let host: HTMLDivElement, root: Root
const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
const closes: Array<() => unknown | Promise<unknown>> = []

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  useAppStore.setState({ agentComposerDrafts: { 'private-agent': DRAFT } })
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges()
  try {
    for (const close of closes.splice(0).reverse()) await close()
    expect(fixtures.length).toBeGreaterThan(0)
    for (const f of fixtures) {
      expect(f.controls.length).toBeGreaterThan(0)
      expect(f.controls.map(control => control.mock.calls.length)).toEqual(f.controls.map(() => 0))
      // The unified reader may initialize captured-history indexes in SQLite.
      // Native bytes and every original persisted Session fact must stay exact.
      expect((await f.bytes()).native).toEqual(f.before.native)
      expect(await f.store.load()).toEqual(f.originalSessions)
    }
    expect(useAppStore.getState().agentComposerDrafts['private-agent']).toBe(DRAFT)
  } finally {
    try {
      for (const f of fixtures.splice(0)) {
        await f.close()
        if (f.helperTrace) expect(f.helperTrace()).toEqual([])
      }
    } finally {
      vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true)
    }
  }
})

// Original saved Claude and Codex records feed the built-in readers, public
// Client/FileStore and projector. No Human DTO or indexed helper reply is authored.
async function fixture(provider: 'claude' | 'codex', bodies: readonly string[]) {
  const ids = bodies.map((_, index) => `original-${provider}-${index + 1}`)
  const native = provider === 'claude'
    ? { ...await nativeHistoryFixture('claude', jsonl(bodies.map((text, index) => ({ sessionId: 'native-main', uuid: ids[index], type: 'user', message: { role: 'user', content: text } })))), options: undefined, helperTrace: undefined }
    : await codexFixture(bodies, ids)
  const originalSessions = await native.store.load()
  expect(originalSessions).toEqual([native.session])
  const page = await native.client.sessionHistoryPage(native.session.agentSessionId, native.options)
  expect(page.items.map(item => [item.id, item.kind])).toEqual(ids.map(id => [id, 'user-message']))
  expect(page.items.map(item => item.contentParts)).toEqual(bodies.map(text => [{ kind: 'text', text, contentEligibility: 'unconfirmed' }]))
  const messages = projectSessionUserMessages({ agentSessionId: native.session.agentSessionId, historyPage: page })
  expect(messages.map(message => [message.rawId, message.author.kind, message.recordedAt])).toEqual(ids.map(id => [id, 'unknown', undefined]))
  expect(messages.map(message => message.content)).toEqual(bodies)
  const describeSpeaker = vi.fn(() => ({ name: 'You' }))
  const readOriginalPage = native.client['readSessionHistoryPage']
  const transport = native.options ? { commandOverride: native.options.commandOverride, args: native.options.args, env: native.options.env } : {}
  const read = vi.fn(async function (this: AgentMuxClient, ...args: Parameters<typeof readOriginalPage>) {
    expect(this).toBe(native.client); expect(args[0]).toBe(native.session.agentSessionId)
    if (args[2]) expect(args[2]).toEqual({ providerId: provider, nativeSessionId: 'native-main' })
    return readOriginalPage.call(this, args[0], { ...transport, ...args[1] }, args[2])
  })
  native.client['readSessionHistoryPage'] = read
  closes.push(() => { native.client['readSessionHistoryPage'] = readOriginalPage })
  await desktopConversationReadBridge(native, closes)
  const f = { ...native, ids, bodies, page, messages, describeSpeaker, read, originalSessions }
  return f
}
async function codexFixture(bodies: readonly string[], ids: readonly string[]) {
  const privateRoot = await mkdtemp(join(tmpdir(), 'leading-amux-codex-read-'))
  const path = join(privateRoot, 'native.jsonl'), storePath = join(privateRoot, 'sessions.json'), helper = join(privateRoot, 'native-read.mjs'), tracePath = join(privateRoot, 'read-requests.jsonl')
  await writeFile(path, jsonl([{ type: 'session_meta', payload: { id: 'native-main', cwd: privateRoot, history_mode: 'paginated' } },
    ...bodies.map((text, index) => ({ type: 'event_msg', payload: { type: 'item_completed', id: ids[index], thread_id: 'native-main',
      turn_id: `original-turn-${index + 1}`, item: { type: 'UserMessage', id: ids[index], content: [{ type: 'text', text }] } } }))]))
  await writeFile(tracePath, '')
  await writeFile(helper, `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.LEADING_AMUX_TRACE,JSON.stringify({kind:'helper',pid:process.pid,args:process.argv.slice(2)})+'\\n');
throw Error('An exact saved transcript must not launch an indexed helper');`)
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'private-agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: privateRoot,
    run: { runId: 'unchanged-private-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: 'private-binding', hookToken: 'private-token',
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'native-main', transcriptPath: path } }
  await store.compareAndSwap(null, session)
  const physicalReads: Promise<unknown>[] = [], load = store.load.bind(store)
  vi.spyOn(store, 'load').mockImplementation(() => { const reading = load(); physicalReads.push(reading); return reading })
  const client = new AgentMuxClient({ store }), kernel = Reflect.get(client, 'kernel')
  const controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw Error('Reading prohibits Runtime control ' + name) }))
  const before = { native: await readFile(path), store: await readFile(storePath) }
  let trace: { kind?: string; method?: string; pid: number; args: string[] }[] = []
  return { root: privateRoot, store, session, client, controls, before,
    options: { commandOverride: process.execPath, args: [helper], env: { LEADING_AMUX_INPUT: path, LEADING_AMUX_TRACE: tracePath }, limit: bodies.length },
    bytes: async () => ({ native: await readFile(path), store: await readFile(storePath) }),
    helperTrace: () => trace,
    close: async () => { await client.dispose(); await Promise.allSettled(physicalReads); trace = (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); await rm(privateRoot, { recursive: true }) }
  }
}
async function draw(f: Awaited<ReturnType<typeof fixture>>, state: 'done' | 'working' = 'done') {
  if (!fixtures.includes(f)) fixtures.push(f)
  await act(async () => root.render(<ActivityView {...activityReadingProps({ control: { hostId: 'local', agentSessionId: f.session.agentSessionId, run: f.session.run },
    visible: true, workspaceRoot: f.root, describeSpeaker: f.describeSpeaker })} displayState={state} />))
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve() })
    const consumer = inspectConversationConsumers({ hostId: 'local', agentSessionId: f.session.agentSessionId }).consumers[0]
    expect(consumer?.accepted).not.toBeNull()
    expect(consumer).toMatchObject({ loading: false, inFlight: false, watch: { binding: false } })
    expect([...host.querySelectorAll<HTMLElement>('.activity-feed [data-native-record-id]')].map(row => row.dataset.nativeRecordId)).toEqual(f.ids)
    expect(f.read.mock.calls.length).toBeGreaterThan(0)
  })
}
function turn(id: string) { const found = host.querySelector<HTMLElement>(`[data-native-record-id="${id}"] .log-turn`); expect(found).not.toBeNull(); return found! }
function disclosures(row: HTMLElement) { return [...row.querySelectorAll<HTMLDetailsElement>('details.log-turn__declared-context')] }
async function revealBody(row: HTMLElement) {
  const deferred = row.querySelector<HTMLButtonElement>('.conversation-progressive-body__placeholder button')
  if (deferred) await act(async () => deferred.click())
  expect(row.querySelector('[data-markdown-root]')).not.toBeNull()
}
async function copy(row: HTMLElement, expected: string) {
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const button = row.querySelector<HTMLButtonElement>('[aria-label="Copy message"]'); expect(button).not.toBeNull()
  await act(async () => button!.click()); expect(clipboard).toHaveBeenLastCalledWith(expected)
}

it('actual Claude producer guide and note disclose original context while the untouched tail, code and full Copy stay readable', async () => {
  const f = await fixture('claude', [positive.text]); await draw(f)
  expect(positive.systemContext).toContain(NOTE); expect(positive.systemContext).toContain('AgentMux runtime guide:')
  const parsed = parseAgentMuxMessagePrefix(f.messages[0]!.content)!
  expect(parsed).toEqual({ kind: 'content', sourceLabel: '', declaredAgentSessionId: null, declaredContexts: [{ raw: composeOutboundMessage({ amux: positive.systemContext! }) }], body: '\n\n' + USER_TAIL })
  const row = turn(f.ids[0]!), contexts = disclosures(row); expect(contexts).toHaveLength(1); expect(contexts[0]!.open).toBe(false)
  expect(contexts[0]!.querySelector('summary')?.textContent).toBe('Declared context'); expect(contexts[0]!.querySelector('pre')?.textContent).toBe(parsed.declaredContexts![0]!.raw)
  expect(row.querySelector('.log-turn__who')?.textContent).toBe('You'); expect(row.querySelector('.log-turn__declared-source')).toBeNull()
  expect(row.querySelector('.log-turn__text strong')?.textContent).toBe('Read the original tail')
  expect(row.querySelector('code')?.textContent).toBe('const indentation = "four spaces"  ')
  const details = row.querySelector<HTMLButtonElement>('[aria-label="Message details"]')!; expect(details).not.toBeNull()
  const speakerReads = f.describeSpeaker.mock.calls.slice()
  expect(speakerReads).toContainEqual([{ role: 'unknown', id: 'unknown' }])
  await act(async () => details.click()); expect(row.querySelector('.conversation-input-details__sender')).toBeNull(); expect(row.textContent).toContain('Not recorded · shown as You')
  expect(f.describeSpeaker.mock.calls).toEqual(speakerReads); await copy(row, positive.text)
})

it('actual Codex reader preserves two consecutive public-composed context-only records without inventing a user tail or sender', async () => {
  const f = await fixture('codex', [contextOnly.text, contextOnly.text]); await draw(f)
  const parsed = parseAgentMuxMessagePrefix(contextOnly.text)!; expect(parsed.declaredContexts).toHaveLength(2); expect(parsed.body).toBe('')
  expect(parsed.sourceLabel).toBe(''); expect(parsed.declaredAgentSessionId).toBeNull(); expect(contextOnly.systemContext).not.toContain('First original context.')
  for (const id of f.ids) {
    const row = turn(id), contexts = disclosures(row); expect(contexts).toHaveLength(2)
    expect(contexts.map(context => context.querySelector('summary')?.textContent)).toEqual(['Declared context 1', 'Declared context 2'])
    expect(contexts.map(context => context.querySelector('pre')?.textContent)).toEqual(parsed.declaredContexts!.map(context => context.raw))
    expect(row.querySelector('.log-turn__text')!.children).toHaveLength(2); expect(row.querySelector('.log-turn__who')?.textContent).toBe('You')
    expect(row.querySelector('.log-turn__declared-source')).toBeNull(); await copy(row, contextOnly.text)
  }
  expect(f.ids).toEqual(['original-codex-1', 'original-codex-2'])
})

it('keeps historical argv carriers as literal original input without reviving retired context grammar', async () => {
  const source = JSON.parse(await readFile(join(inputs, 'actual-argv-inputs.json'), 'utf8')) as { inputs: { path: string }[] }
  expect(source.inputs).toHaveLength(2)
  const wires = await Promise.all(source.inputs.map(input => readFile(resolve(input.path), 'utf8')))
  const f = await fixture('claude', wires); await draw(f)
  for (const [index, wire] of wires.entries()) {
    expect(parseAgentMuxMessagePrefix(wire)).toBeNull()
    const row = turn(f.ids[index]!)
    await revealBody(row)
    expect(disclosures(row)).toHaveLength(0)
    expect(row.querySelector('.log-turn__text')?.textContent).toContain('<amux from="amux">')
    expect(row.querySelector('.log-turn__text')?.textContent).toContain('Clarify goal')
    expect(f.messages[index]!.content).toBe(wire); await copy(row, wire)
  }
})

it('actual Claude partial second declarations, unknown attributes and nested structures stay whole authored input', async () => {
  const wires = [firstContext.slice(0, -7), firstContext + '\n\n' + firstContext.slice(0, -7), firstContext + '\n\n' + firstContext.replace('<amux>', '<amux from="unknown">'),
    firstContext.replace('First original context.', '<unknown>First original context.</unknown>')]
  expect(wires).toHaveLength(4)
  // Markdown paragraph boundaries omit separator/trailing newlines; Copy retains the wire.
  const partial = '<amux>\nFirst original context.'
  const paragraphs = [[partial], [firstContext, partial], [firstContext, firstContext.replace('<amux>', '<amux from="unknown">')], [wires[3]!]]
  const f = await fixture('claude', wires); await draw(f)
  for (const [index, wire] of wires.entries()) {
    expect(parseAgentMuxMessagePrefix(wire)).toBeNull(); const row = turn(f.ids[index]!)
    expect(disclosures(row)).toHaveLength(0)
    expect([...row.querySelectorAll('.log-turn__text [data-markdown-root] > .md-paragraph')].map(block => block.textContent)).toEqual(paragraphs[index])
    expect(f.messages[index]!.content).toBe(wire); await copy(row, wire)
  }
})

it('actual Claude quote, fenced and inline code, indentation and nonleading literals never become declaration disclosure', async () => {
  const wires = ['> ' + firstContext.replaceAll('\n', '\n> '), '```xml\n' + firstContext + '\n```', '`' + firstContext + '`', '    ' + firstContext,
    '\u00a0' + firstContext, 'Read this literal.\n\n' + firstContext]
  expect(wires).toHaveLength(6)
  const f = await fixture('claude', [...wires, indentedContinuation]); await draw(f)
  for (const [index, wire] of wires.entries()) {
    expect(parseAgentMuxMessagePrefix(wire)).toBeNull(); const row = turn(f.ids[index]!)
    await revealBody(row)
    expect(disclosures(row)).toHaveLength(0); expect(row.querySelector('.log-turn__text')?.textContent).toContain('<amux>'); await copy(row, wire)
  }
  const continuation = parseAgentMuxMessagePrefix(indentedContinuation)!
  expect(continuation.declaredContexts).toHaveLength(1); expect(continuation.body).toBe('\n\n' + INDENTED_LITERAL)
  const row = turn(f.ids[6]!); expect(disclosures(row)).toHaveLength(1)
  expect(row.querySelector('.log-turn__text [data-markdown-root] code')?.textContent?.trimEnd()).toBe(INDENTED_LITERAL.trimStart()); await copy(row, indentedContinuation)
})

it('the accepted Activity retains original declarations, tail Range, DOM, scroll and stored draft without another native read on rerender', async () => {
  const negative = indentedContinuation
  const f = await fixture('claude', [positive.text, contextOnly.text, negative]); await draw(f)
  const row = turn(f.ids[0]!), body = row.querySelector('.log-turn__text')!, context = disclosures(row)[0]!
  await act(async () => { context.open = true; context.dispatchEvent(new Event('toggle')) })
  const selectedElement = body.querySelector('strong'); expect(selectedElement).not.toBeNull()
  const selected = selectedElement!.firstChild!, range = document.createRange(); range.selectNodeContents(selected); window.getSelection()!.addRange(range)
  const feed = host.querySelector<HTMLElement>('.activity-feed')!; feed.scrollTop = 137
  await draw(f, 'working'); expect(turn(f.ids[0]!)).toBe(row); expect(row.querySelector('.log-turn__text')).toBe(body)
  expect(disclosures(row)[0]).toBe(context); expect(context.open).toBe(true); expect(range.startContainer).toBe(selected); expect(window.getSelection()!.toString()).toBe('Read the original tail'); expect(feed.scrollTop).toBe(137)
  await copy(row, positive.text)
  if (process.env.AGENTMUX_LEADING_AMUX_SCENE_OUTPUT) {
    const output = resolve(process.env.AGENTMUX_LEADING_AMUX_SCENE_OUTPUT); await mkdir(resolve(output, '..'), { recursive: true })
    await writeFile(output, JSON.stringify({ schema: 'agentmux.conversation-leading-amux-public-scene.v1', page: f.page, messages: f.messages, draft: DRAFT,
      producer: { positive, contextOnly, originalUserTail: USER_TAIL }, controlCalls: f.controls.map(control => control.mock.calls.length),
      provenance: 'Existing public producer → private FileStore → built-in Claude reader → public projector; unknown authors and original IDs/parts/times preserved.' }, null, 2))
  }
  const reads = f.read.mock.calls.length
  await draw(f)
  expect([...host.querySelectorAll<HTMLElement>('.activity-feed [data-native-record-id]')].map(item => item.dataset.nativeRecordId)).toEqual(f.ids)
  expect(host.querySelectorAll('.log-turn__declared-context')).toHaveLength(4); expect(host.querySelector('strong')?.textContent).toBe('Read the original tail'); expect(f.read).toHaveBeenCalledTimes(reads)
  expect(turn(f.ids[0]!)).toBe(row); expect(range.startContainer).toBe(selected); expect(window.getSelection()!.toString()).toBe('Read the original tail')
})
