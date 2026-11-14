// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryItem, ConversationTimelineReadInput, ConversationWindowAssembly } from '@agentmux/core'
import { consumeConversationWindowPage } from '@agentmux/core/conversation'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { projectConversationWindow } from '@agentmux/client-ui/conversation-records'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { grokUser, grokChunk, grokDone } from '../../../packages/core/test/fixtures/grok-updates'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli'
import { isolateCoreFixtureEnvironment } from './helpers/isolate-core-environment'
import { StaticActivityView } from './helpers/conversation-static-fixture'

const native = 'native-main', sid = 'synthetic-input-recipient'
const uiFrame = process.env.AGENTMUX_GROK_UI_FRAME
const notice = '<system-reminder>\nMonitor "original-task" ended.\nKeep the complete original notification.\n</system-reminder>'
const answer = 'Original public reply stays readable.'
const synthetic = (text = notice, meta: object = { syntheticPrompt: true, hideFromScrollback: true }) => {
  const row = grokUser(native, text)
  return { ...row, params: { ...row.params, update: { ...row.params.update, _meta: meta } } }
}
const cleanups: Array<() => unknown | Promise<unknown>> = []
let host: HTMLDivElement, root: Root
const copied = vi.fn(async (_text: string) => true)
const platform: ClientUiPlatform = { copyText: copied, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); copied.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  try { for (const close of cleanups.splice(0).reverse()) await close() }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() }
})
async function fixture(rows: object[]) {
  const isolated = await mkdtemp('/tmp/amx-grok-synthetic-'); cleanups.push(() => rm(isolated, { recursive: true, force: true })); isolateCoreFixtureEnvironment(isolated)
  const f = await nativeHistoryFixture('grok', jsonl(rows), { agentSessionId: sid, relativePath: 'updates.jsonl' }); cleanups.push(f.close)
  await writeFile(join(f.root, 'summary.json'), JSON.stringify({ info: { id: native, cwd: f.root } }))
  return f
}
async function rpcFixture(rows: object[]) {
  const f = await fixture(rows), server = new AgentMuxControlServer({ socketPath: join(f.root, 'private.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  const ref = { hostId: 'local', agentSessionId: sid }
  async function window(input: Omit<ConversationTimelineReadInput, 'hostId' | 'agentSessionId'> = {}) {
    let pending: ConversationWindowAssembly | undefined, cursor: string | undefined
    for (;;) {
      const page = await rpc.call('agent.conversation.inspect', { ...ref, limit: 100, maxBytes: 1048576, ...input, ...(cursor ? { cursor } : {}) })
      const result = consumeConversationWindowPage(page, pending)
      if (result.kind === 'complete') {
        const snapshot = result.snapshot
        cleanups.push(() => rpc.call('agent.conversation.release', { ...ref, view: snapshot.window.view! }))
        return snapshot
      }
      pending = result.pending; cursor = page.nextCursor!
    }
  }
  return { ...f, rpc, ref, window }
}
const draw = (node: ReactNode, level: 'simple' | 'system' = 'simple') => act(async () => root.render(<ClientUiProvider platform={{ ...platform, conversationDetailLevel: level }}>{node}</ClientUiProvider>))
const text = (item: AgentSessionHistoryItem) => item.contentParts.map(part => part.kind === 'text' ? part.text : '').join('')

it('uses only original boolean synthetic metadata and preserves native body, privacy and physical identities', async () => {
  const wrongContent = grokUser(native, notice), wrongParams = grokUser(native, notice)
  const cases = [
    { row: synthetic(), kind: 'activity', purpose: 'system-event', eligibility: 'unconfirmed' },
    { row: synthetic('Plain original event without any markup.', { syntheticPrompt: true }), kind: 'activity', purpose: 'system-event', eligibility: 'unconfirmed' },
    { row: grokUser(native, notice), kind: 'user-message', purpose: undefined, eligibility: 'unconfirmed' },
    ...[false, 'true', 1, null].map(value => ({ row: synthetic(notice, { syntheticPrompt: value, hideFromScrollback: true }), kind: 'user-message', purpose: undefined, eligibility: 'unconfirmed' })),
    { row: synthetic(notice, { hideFromScrollback: true }), kind: 'user-message', purpose: undefined, eligibility: 'unconfirmed' },
    { row: { ...wrongContent, params: { ...wrongContent.params, update: { ...wrongContent.params.update, content: { type: 'text', text: notice, _meta: { syntheticPrompt: true } } } } }, kind: 'user-message', purpose: undefined, eligibility: 'unconfirmed' },
    { row: { ...wrongParams, params: { ...wrongParams.params, _meta: { ...wrongParams.params._meta, syntheticPrompt: true } } }, kind: 'user-message', purpose: undefined, eligibility: 'unconfirmed' },
    { row: synthetic(notice, { syntheticPrompt: true, hostTurn: true }), kind: 'activity', purpose: 'system-event', eligibility: 'private' }
  ]
  const f = await fixture(cases.map(value => value.row)), page = await f.client.sessionHistoryPage(sid, { limit: 100 })
  expect(page.items).toHaveLength(cases.length)
  let offset = 0
  for (const [i, expected] of cases.entries()) {
    const item = page.items[i]!
    expect(item).toMatchObject({ id: `grok-update:${offset}`, kind: expected.kind })
    expect(item.recordPurpose).toBe(expected.purpose)
    expect(item.contentParts).toEqual([{ kind: 'text', text: expected.row.params.update.content.text, contentEligibility: expected.eligibility }])
    offset += Buffer.byteLength(jsonl([expected.row]))
  }
  expect(await readFile(f.path)).toEqual(f.before.native); expect(f.controls.flatMap(control => control.mock.calls)).toEqual([])
})

it('keeps the original system purpose through public RPC history, deferred exact detail, changes and actual source CLI', async () => {
  const rows = [grokUser(native, 'Ordinary original input.'), synthetic(), grokChunk(native, answer), grokDone(native)]
  const f = await rpcFixture(rows), history = await f.rpc.call('agent.history', { ...f.ref, source: 'native', limit: 100, maxBytes: 131072 })
  const items = history.items.flatMap(entry => entry.kind === 'item' ? [entry.item as AgentSessionHistoryItem] : [])
  expect(items).toHaveLength(3)
  const original = items.find(item => text(item) === notice)!
  expect(original).toMatchObject({ kind: 'activity', recordPurpose: 'system-event' })
  const full = await f.window(), deferred = await f.window({ processDetails: 'deferred' })
  const source = full.units.flatMap(unit => unit.records).find(record => record.reference?.source.recordId === original.id)!
  const summary = deferred.units.flatMap(unit => unit.records).find(record => record.id === source.id)!
  expect(full.units.find(unit => unit.records.includes(source))!.event).toMatchObject({ role: 'process', author: { kind: 'unknown' } })
  expect(summary.original).toMatchObject({ kind: 'deferred', item: { kind: 'native', item: { id: original.id, kind: 'activity', recordPurpose: 'system-event' } } })
  expect(summary.reference).toEqual(source.reference); expect(summary.revision).toBe(source.revision)
  const exact = await f.window({ anchor: { record: summary.reference!, revision: summary.revision, frontier: deferred.window.checkpoint } })
  expect(exact.units.flatMap(unit => unit.records).find(record => record.id === source.id)?.original).toEqual(source.original)
  const loader = pathToFileURL(join(process.cwd(), 'packages/core/test/fixtures/hook-delivery/source-loader.mjs'))
  const env = objectCliEnvironment(f.root)
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + join(f.root, 'private.sock'), 'agent', 'history', '--host', 'local', '--session', sid, '--source', 'native', '--limit', '100', '--max-bytes', '131072'], env, '', 15000, loader)
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.items.find((entry: { item?: AgentSessionHistoryItem }) => entry.item?.id === original.id).item).toEqual(original)
  const cliFrame = await runSourceObjectCli(['--endpoint', 'unix:' + join(f.root, 'private.sock'), 'agent', 'conversation', 'inspect', '--input', '-'], env,
    JSON.stringify({ ...f.ref, limit: 100, maxBytes: 1048576, processDetails: 'deferred' }), 15000, loader)
  expect(cliFrame.code, cliFrame.stderr).toBe(0)
  const cliPage = JSON.parse(cliFrame.stdout).result
  const accepted = consumeConversationWindowPage(cliPage)
  expect(accepted.kind).toBe('complete')
  cleanups.push(() => f.rpc.call('agent.conversation.release', { ...f.ref, view: cliPage.window.view }))
  expect(cliPage.items.flatMap((entry: { item: { records: typeof deferred.units[number]['records'] } }) => entry.item.records).find((record: typeof source) => record.id === source.id).original).toEqual(summary.original)
  const later = synthetic('Later original synthetic event.', { syntheticPrompt: true })
  await appendFile(f.path, jsonl([later]))
  const changed = await f.rpc.call('agent.conversation.changes', { ...f.ref, checkpoint: deferred.window.checkpoint, view: deferred.window.view!, limit: 100, maxBytes: 1048576, processDetails: 'deferred' })
  expect(changed.items.some(entry => entry.kind === 'item' && entry.item.records.some(record => record.original.kind === 'deferred' && record.original.item.kind === 'native' && record.original.item.item.recordPurpose === 'system-event' && record.original.item.item.id === `grok-update:${f.before.native.length}`))).toBe(true)
  expect(await readFile(f.path)).toEqual(Buffer.concat([f.before.native, Buffer.from(jsonl([later]))])); expect(f.controls.flatMap(control => control.mock.calls)).toEqual([])
})

it.each(['shared', 'desktop'])('the %s product reader keeps synthetic notifications out of user speech and makes original process text and Copy reachable', async surface => {
  const rows = [grokUser(native, 'Ordinary original input.'), synthetic(), grokChunk(native, answer), grokDone(native)]
  const f = await rpcFixture(rows), snapshot = await f.window(), value = projectConversationWindow(snapshot)
  const record = value.records.find(row => row.original.kind === 'native' && text(row.original.item) === notice)!
  expect(record).toBeDefined()
  const node = surface === 'shared' ? <ConversationView sessionId={sid} executionHostId="local" records={value.records} originalRecords={value.originalRecords} page={value.historyPage ?? null} timeline={value.captured} />
    : <StaticActivityView sessionId={sid} executionHostId="local" nativeHistoryPage={value.historyPage} timelineSnapshot={value.captured} items={value.captured.items} capability="complete-events" />
  await draw(node)
  expect(host.textContent).toContain('Ordinary original input.'); expect(host.textContent).toContain(answer)
  expect(host.querySelectorAll('.log-turn[data-speaker-role="human"]')).toHaveLength(1)
  expect(host.querySelector('.native-process-observation')?.getAttribute('data-no-visible-process')).toBe('true')
  expect(host.querySelector('.wf-native-process')).toBeNull()
  await draw(node, 'system')
  const toggle = host.querySelector<HTMLButtonElement>('.wf-observation__header > button.log-fold')!
  expect(toggle).not.toBeNull(); expect(toggle.getAttribute('aria-expanded')).toBe('false')
  await act(async () => toggle.click())
  const step = host.querySelector<HTMLElement>('.wf-native-process')!
  expect(step).not.toBeNull(); expect(step.closest('.log-turn')).toBeNull()
  const stepToggle = step.querySelector<HTMLElement>('[aria-expanded="false"]')!
  await act(async () => stepToggle.click())
  expect(step.textContent).toContain('Keep the complete original notification.')
  const copy = [...step.querySelectorAll<HTMLButtonElement>('button')].find(button => /copy/iu.test(button.getAttribute('aria-label') ?? ''))!
  expect(copy).toBeDefined(); await act(async () => copy.click())
  expect(copied.mock.calls.some(([value]) => value === notice)).toBe(true)
  expect(host.querySelectorAll('.log-turn[data-speaker-role="human"]')).toHaveLength(1)
  expect(await readFile(f.path)).toEqual(f.before.native); expect(f.controls.flatMap(control => control.mock.calls)).toEqual([])
  if (surface === 'shared' && uiFrame) {
    const owner = 'packages/providers/src/grok/native-history.ts'
    await writeFile(uiFrame, JSON.stringify({ snapshot, provider: { path: owner, sha256: createHash('sha256').update(await readFile(owner)).digest('hex') },
      originals: { nativeSessionId: native, notificationId: record.original.item.id, notice, input: 'Ordinary original input.', answer }, qualification: 'Actual Grok Provider → FileStore Core public Unix RPC → complete window. Original bytes and runtime controls unchanged; illustrative native records, not a vendor process.' }, null, 2))
  }
})
