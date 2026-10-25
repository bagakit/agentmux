// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { mkdir, writeFile } from 'node:fs/promises'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { quotedEnvelope } from '../../../packages/core/test/helpers/channel-quote-fixture.js'
import * as rendering from '../../../packages/core/src/agent-message-render.js'
import { AgentMuxError } from '../../../packages/core/src/errors.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { hostedTestOwner } from '../../../packages/core/test/helpers/hosted-runtime-port.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { DurableAgentMuxMessageQueue } from '../../../packages/core/src/agent-global-message-queue.js'
import { parseAgentInputMailboxPage } from '../../../packages/core/src/agent-input-mailbox-codec.js'
import type { AgentExternalInputIntent, AgentExternalMessageAuthor } from '../../../packages/core/src/external-author.js'
import type { AgentInputMailboxItem } from '../../../packages/core/src/agent-input-mailbox.js'
import { InputMailboxRecord } from '../../../packages/client-ui/src/components/InputMailboxRecords.js'
import { ClientUiProvider, type ClientUiPlatform } from '../../../packages/client-ui/src/platform.js'
import { createRpcExternalInputAuthority } from '../../../packages/connectors/test/helpers/rpc-external-input-authority.js'

const previewDirectory = process.env.AGENTMUX_QUOTE_PREVIEW_DIRECTORY
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

/** Additional contract consumer: actual Hosted transport, Core journal and common reader.
 * The task's default native ingress producer is verified separately in the native join. */
async function fixture(partial?: boolean, variant?: 'zero' | 'unavailable' | 'legacy') {
  const f = await rpcOwnerFixture(['recipient'], undefined, () => ({ providerId: 'claude', executorId: 'claude' }))
  cleanup.push(f.close)
  vi.spyOn(f.client, 'connect').mockResolvedValue()
  vi.spyOn(f.client.providers.get('claude'), 'planPromptInput').mockImplementation(text => ({ kind: 'single-phase', data: text + '\r' }))
  f.inner.connected = false; f.inner.kernel.isConnected = () => false
  if (quotedEnvelope.sender.kind !== 'external') throw Error('The fixture requires an original external author')
  const author = quotedEnvelope.sender, run = { runId: 'run-recipient' }
  let channelQuote = partial === undefined ? quotedEnvelope.channelQuote! : { ...quotedEnvelope.channelQuote!,
    coverage: partial ? 'partial' as const : 'complete' as const, gaps: partial ? [{ reason: 'thread-history-unavailable' }] : [],
    records: [{ ...quotedEnvelope.channelQuote!.records[0]!, content: 'The release notes are ready for review.\nPlease check the deployment steps.' },
      { ...quotedEnvelope.channelQuote!.records[1]!, content: 'Attached the original release notes.' }] }
  if (variant === 'zero' || variant === 'unavailable') channelQuote = { ...channelQuote, records: [], coverage: variant === 'zero' ? 'complete' : 'unavailable', gaps: variant === 'zero' ? [] : [{ reason: 'thread-history-unavailable' }] }
  const { channelQuote: _originalQuote, ...baseEnvelope } = quotedEnvelope
  const envelope = { ...baseEnvelope, sender: author, recipientRunId: run.runId, ...(variant === 'legacy' ? {} : { channelQuote }),
    ...(partial === undefined ? {} : { body: 'Current request: Please summarize the deployment steps and call out any risks.' }),
    channelProfile: { actor: author.actor, state: 'unknown' as const, profile: null, checkedAt: 12, freshness: 'unknown' as const, reason: 'not-observed' as const } }
  const admissionIntent = { kind: 'manual-actor' as const, expectedRun: run }
  const expected: AgentExternalInputIntent = { agentSessionId: 'recipient', expectedRun: run, operationId: envelope.operationId,
    messageId: envelope.messageId, body: envelope.body, ...(envelope.channelQuote ? { channelQuote: envelope.channelQuote } : {}), admissionIntent }
  const assertCurrent = vi.fn(async (actualAuthor: AgentExternalMessageAuthor, intent: AgentExternalInputIntent) => {
    if (!isDeepStrictEqual(author, actualAuthor) || !isDeepStrictEqual(expected, intent)) throw new AgentMuxError('Original fixture input authority mismatch.', 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED')
  })
  const service = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client), undefined, { assertCurrent })
  cleanup.push(() => service.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'quote-hosted.sock'), coreClients: f.coreClients, hostedRuntime: () => service })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc }); cleanup.push(() => hosted.dispose())
  const input = { agentSessionId: 'recipient', envelope, admissionIntent, execution: 'immediate' as const, sourceChannel: 'agent-message' as const }
  const wire = rendering.renderAgentMuxMessageEnvelope(envelope)
  return { ...f, hosted, input, expected, assertCurrent, wire }
}

async function originalItem(f: Awaited<ReturnType<typeof fixture>>) {
  const read = { agentSessionId: 'recipient', maxBytes: 128 * 1024 }
  const reading = f.hosted.readAgentInputMailbox(read)
  await expect(reading).resolves.toMatchObject({ agentSessionId: 'recipient' })
  const page = parseAgentInputMailboxPage(await reading, read)
  const entry = page.items[0]
  expect(entry?.kind).toBe('item')
  if (entry?.kind !== 'item' || entry.item.kind !== 'controlled') throw Error('The original journal input was not returned')
  expect(entry.item.message?.channelQuote).toEqual(f.input.envelope.channelQuote)
  return entry.item
}

async function mount(item: AgentInputMailboxItem, compact = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const container = document.createElement('div'); document.body.append(container)
  const root: Root = createRoot(container), copy = vi.fn(async () => true)
  cleanup.push(async () => { await act(async () => root.unmount()); container.remove() })
  const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
    renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  await act(async () => root.render(<ClientUiProvider platform={platform}><InputMailboxRecord item={item} hostId="local" compact={compact} expanded onCopy={copy} /></ClientUiProvider>))
  return { container, root, copy }
}

it.each([false, true])('firstsaves quoted external input through real Hosted Core and reads/copies its exact wire while admission is absent (partial=%s)', async partial => {
  const f = await fixture(partial), pending = f.hosted.submitAgentMessage(f.input)
  await expect(pending).resolves.toMatchObject({ persistence: 'confirmed', status: 'waiting', admission: null })
  const saved = await pending
  const item = await originalItem(f)
  if (previewDirectory) { await mkdir(previewDirectory, { recursive: true }); await writeFile(join(previewDirectory, partial ? 'partial.json' : 'complete.json'), JSON.stringify(item)) }
  expect(item.intent.source).toMatchObject({ kind: 'message', promptWire: f.wire })
  expect(item.receipt?.admission).toBeNull(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const view = await mount(item), history = view.container.querySelector<HTMLDetailsElement>('[data-channel-quote]')
  expect(history).not.toBeNull()
  expect(view.container.querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('external')
  expect(view.container.textContent).toContain('Current request')
  await act(async () => { history!.open = true; history!.dispatchEvent(new Event('toggle')) })
  expect(view.container.querySelector('.conversation-channel-quote__records pre')?.textContent).toBe(f.input.envelope.channelQuote!.records[0]!.content)
  expect(view.container.textContent).toContain('Original.txt')
  const resource = view.container.querySelector<HTMLDetailsElement>('[data-quote-resource]')
  expect(resource?.open).toBe(false)
  expect(JSON.parse(resource!.querySelector('pre')!.textContent!)).toEqual(f.input.envelope.channelQuote!.records[1]!.resources![0])
  expect(Array.from(view.container.querySelectorAll('*')).filter(node => ['amux:channel', 'script'].includes(node.localName))).toHaveLength(0)
  const copy = view.container.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')
  expect(copy).not.toBeNull(); await act(async () => copy!.click())
  expect(view.copy).toHaveBeenCalledExactlyOnceWith(f.wire)
  expect(f.assertCurrent).toHaveBeenCalledWith(f.input.envelope.sender, f.expected)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('reopens and rejoins the original quote wire without invoking a new formatter or replacing the original operation', async () => {
  const f = await fixture(), saved = await f.hosted.submitAgentMessage(f.input)
  if (!saved) throw Error('Original waiting receipt missing')
  const queue = new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath())
  const original = await queue.inspectInput({ key: saved.key })
  expect(original?.intent.source).toMatchObject({ promptWire: f.wire })
  const formatter = vi.spyOn(rendering, 'renderAgentMuxMessageEnvelope').mockImplementation(() => { throw Error('A newer formatter must not reconstruct the saved wire') })
  f.inner.connected = true; f.inner.kernel.isConnected = () => true
  await expect(f.hosted.rejoinAgentInputWaiting({ ref: saved.ref })).resolves.toMatchObject({ key: saved.key })
  await vi.waitFor(async () => expect((await f.hosted.inspectAgentInput({ key: saved.key }))?.status).toBe('terminal-confirmed'))
  expect(formatter).not.toHaveBeenCalled()
  expect((f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls[0]?.[1].data).toBe(f.wire + '\r')
  expect((await originalItem(f)).message?.operationId).toBe(f.input.envelope.operationId)
  const timeline = await f.client.sessionTimeline('recipient')
  expect(timeline.items.filter(item => item.authorExternal).map(item => item.content)).toEqual([f.input.envelope.body])
  expect(timeline.items.filter(item => item.authorExternal).some(item => item.content?.includes('Original.txt'))).toBe(false)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('the original Desktop authority seam rejects edited quotes and admission targets without granting another operation', async () => {
  const f = await fixture(), sender = f.input.envelope.sender
  const ingress = { ingressId: 'original-ingress', connectionId: sender.connectionId, application: sender.actor.application,
    eventId: 'event', externalMessageId: sender.externalMessageId, externalConversationId: sender.externalConversationId, actor: sender.actor,
    body: f.input.envelope.body, state: 'claimed' as const, input: { hostId: 'local', agentSessionId: 'recipient', expectedRun: f.input.admissionIntent.expectedRun,
      operationId: f.input.envelope.operationId, messageId: f.input.envelope.messageId, author: sender, admissionIntent: f.input.admissionIntent, channelQuote: f.input.envelope.channelQuote } }
  // Control only the installed original-claim read port; the real RPC codec and
  // Desktop resolver still validate every returned original and current intent.
  const unexpected = async (): Promise<never> => { throw Error('Unexpected connection operation in original quote authority consumer') }
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'quote-authority.sock'), coreClients: f.coreClients,
    connections: { list: unexpected, inspect: unexpected, configure: unexpected, test: unexpected,
      ingress: { inspect: unexpected, list: unexpected, recordAuthority: unexpected,
        authority: async () => ({ ingress, authority: 'current' as const }) } } })
  await server.start(); cleanup.push(() => server.stop())
  const authority = createRpcExternalInputAuthority({ socketPath: server.path, executionHostId: 'local' })
  await expect(authority.assertCurrent(sender, f.expected)).resolves.toBeUndefined()
  await expect(authority.assertCurrent(sender, { ...f.expected, channelQuote: { ...f.expected.channelQuote!, records: [] } })).rejects.toMatchObject({ code: 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED' })
  await expect(authority.assertCurrent(sender, { ...f.expected, admissionIntent: { kind: 'manual-actor', expectedRun: { runId: 'another-run' } } })).rejects.toMatchObject({ code: 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED' })
  await expect(authority.assertCurrent(sender, { ...f.expected, body: 'changed request' })).rejects.toMatchObject({ code: 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})


it.each(['zero', 'unavailable', 'legacy'] as const)('original Hosted input summary distinguishes %s quote evidence without treating absence as zero', async variant => {
  const f = await fixture(false, variant)
  await expect(f.hosted.submitAgentMessage(f.input)).resolves.toMatchObject({ persistence: 'confirmed', status: 'waiting' })
  const item = await originalItem(f), view = await mount(item, true)
  const toggle = view.container.querySelector<HTMLButtonElement>('.conversation-input-details__toggle')!
  await act(async () => toggle.click())
  const summary = view.container.querySelector('[data-input-quote]')
  expect(summary).not.toBeNull()
  expect(summary!.textContent).toBe(variant === 'zero' ? '0 quoted messages' : variant === 'unavailable' ? 'Quote unavailable' : 'Quote not recorded')
  expect(summary!.getAttribute('data-input-quote')).toBe(variant === 'zero' ? 'complete' : variant === 'unavailable' ? 'unavailable' : 'unknown')
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
