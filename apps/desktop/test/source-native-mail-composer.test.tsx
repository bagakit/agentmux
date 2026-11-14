// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { SpaceMemberWorkface } from '../src/renderer/src/components/MountedSpaceAgent'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { MailboxA2A } from '../src/renderer/src/components/MailboxA2A'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { sourceMemberMail } from '../src/renderer/src/lib/source-member-tools'
import { originalSourceInputOwnerKey } from '../src/renderer/src/lib/original-space-navigation'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createSourceNativeMemberFixture } from './helpers/source-native-member-fixture'
import { AgentMuxCreationAuthority } from '../../../packages/core/src/agent-creation-authority'
import { messagePacketDigest } from '../../../packages/core/src/agent-message-federation'
import { DurableAgentMuxMessageQueue } from '../../../packages/core/src/agent-global-message-queue'
import type { SpaceMountReadingTarget, SpaceMountMemberTarget } from '../src/shared/space-mount'

const dom = composerDOM(), cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'notifyInputOccupation').mockResolvedValue(undefined)
})
const system = { notices: [], unread: [], acknowledge() {}, available: true } as never
async function fixture() {
  const f = await createSourceNativeMemberFixture(cleanup), source = await f.admit(false)
  const reading = (target: typeof f.selected.target): SpaceMountReadingTarget => ({ hostId: 'original-progress-source', target: { ...target, kind: 'conversation' } })
  const d = sourceMemberMail(f.main.api, reading(f.selected.target)), b = sourceMemberMail(f.main.api, reading(source.target))
  const seed = async (foreign: boolean) => {
    const selected = foreign ? f.selected : source, authority = foreign ? f.d.authority : f.b.authority
    const queue = new DurableAgentMuxMessageQueue(selected.owner.client.agentMessageQueuePath())
    const peer = new AgentMuxCreationAuthority({ stateDirectory: join(selected.owner.root, 'mail-peer'), runtimeId: 'mail-peer-runtime' })
    const mirror = new AgentMuxCreationAuthority({ stateDirectory: join(selected.owner.root, 'mail-mirror'), runtimeId: 'mail-mirror-runtime' })
    const receiver = await peer.identity()
    for (const [id, signer] of [['same-mail', authority], ['namesake-mail', mirror]] as const) {
      const envelope = { schema: 'agentmux.a2a.v1' as const, messageId: id, operationId: 'op-' + id, createdAt: 1,
        sender: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, recipient: { kind: 'agent-session' as const, agentSessionId: 'caller' },
        senderSessionId: 'recipient', senderRunId: 'run-recipient', senderRuntimeId: signer.runtimeId,
        recipientSessionId: 'caller', recipientRunId: 'run-caller', recipientRuntimeId: receiver.runtimeId,
        threadId: id, correlationId: id, replyTo: null, workspaceId: null,
        body: (id === 'same-mail' ? foreign ? 'Original D body' : 'Original B body' : 'Another Runtime body') + '\nPreserve this original tail' }
      const packet = { envelope, execution: 'default' as const, sourceChannel: 'cli' as const }
      const provenance = await signer.attestMessage({ agentSessionId: 'recipient', runId: 'run-recipient' },
        { runtimeId: receiver.runtimeId, agentSessionId: 'caller', runId: 'run-caller' }, messagePacketDigest(packet), receiver.fingerprint)
      await queue.append({ ...envelope, execution: packet.execution, sourceChannel: packet.sourceChannel }, { deliveryMode: 'outbox', provenance })
      await queue.openDispatch({ callerAgentSessionId: 'recipient', sourceMessageId: id }, async () => {})
    }
    const local = await authority.identity(), envelope = { schema: 'agentmux.a2a.v1' as const, messageId: 'incoming-mail', operationId: 'op-incoming-mail', createdAt: 1,
      sender: { kind: 'agent-session' as const, agentSessionId: 'caller' }, recipient: { kind: 'agent-session' as const, agentSessionId: 'recipient' },
      senderSessionId: 'caller', senderRunId: 'run-caller', senderRuntimeId: peer.runtimeId,
      recipientSessionId: 'recipient', recipientRunId: 'run-recipient', recipientRuntimeId: local.runtimeId,
      threadId: 'incoming-mail', correlationId: 'incoming-mail', replyTo: null, workspaceId: null, body: foreign ? 'Incoming original D body' : 'Incoming original B body' }
    const packet = { envelope, execution: 'default' as const, sourceChannel: 'cli' as const }
    const provenance = await peer.attestMessage({ agentSessionId: 'caller', runId: 'run-caller' },
      { runtimeId: local.runtimeId, agentSessionId: 'recipient', runId: 'run-recipient' }, messagePacketDigest(packet), local.fingerprint)
    await queue.append({ ...envelope, execution: packet.execution, sourceChannel: packet.sourceChannel }, { deliveryMode: 'reference', provenance })
    const sameSid = { ...envelope, messageId: 'same-sid-mail', operationId: 'op-same-sid-mail', threadId: 'same-sid-mail', correlationId: 'same-sid-mail',
      sender: { kind: 'agent-session' as const, agentSessionId: 'recipient' }, senderSessionId: 'recipient', senderRunId: 'run-recipient',
      body: 'Same SID other Runtime original body' }
    const sameSidPacket = { ...packet, envelope: sameSid }
    const sameSidProof = await peer.attestMessage({ agentSessionId: 'recipient', runId: 'run-recipient' },
      { runtimeId: local.runtimeId, agentSessionId: 'recipient', runId: 'run-recipient' }, messagePacketDigest(sameSidPacket), local.fingerprint)
    await queue.append({ ...sameSid, execution: packet.execution, sourceChannel: packet.sourceChannel }, { deliveryMode: 'reference', provenance: sameSidProof })
  }
  await seed(true); await seed(false)
  const original = (await f.selected.owner.store.readMetadata('recipient'))!, { kind: _kind, ...identity } = f.selected.target
  const target: SpaceMountMemberTarget = { hostId: 'original-progress-source', target: { ...identity, expectedRun: original.run } }
  const owner = originalSourceInputOwnerKey(target.target.runtimeId, 'recipient')
  useAppStore.setState({ config: composerConfig, sessions: [composerSession('recipient')], timelines: {}, noticeReadReceipts: {},
    agentNames: { recipient: 'Observer namesake', caller: 'Observer caller' }, agentComposerDrafts: { [owner]: 'Original unsent input', recipient: 'Observer unsent input' }, agentSteerQueues: {} })
  const ordinary = (['listMessages', 'readMessage', 'dispatches', 'dispatch', 'notifyMessage'] as const).map(method => vi.spyOn(api.sessions, method))
  return { ...f, d, b, source, reading, target, original, owner, ordinary }
}
async function openMailbox() {
  await act(async () => {
    for (const type of ['beforetoggle', 'toggle']) {
      const event = new Event(type); Object.defineProperty(event, 'newState', { value: 'open' })
      dom.container.querySelector('.composer-mailbox')!.dispatchEvent(event)
    }
  })
}
async function chooseSent() {
  await dom.click('[id$="-agents-tab"]')
  await dom.click('[id$="-outbox-tab"]')
}

it('the actual mounted Source workface reads original mail and collaboration through the shared Mailbox without a Native readiness fact', async () => {
  const f = await fixture()
  const native = vi.spyOn(f.selected.owner.client, 'runtimeSubject').mockRejectedValue(Error('Native is unavailable'))
  vi.spyOn(api.spaceMounts, 'member').mockImplementation(f.main.api.member.bind(f.main.api))
  vi.spyOn(api.spaceMounts, 'reading').mockImplementation(f.main.api.reading.bind(f.main.api))
  await dom.render(<SpaceMemberWorkface target={f.target} visible active={false}
    sessionMetadata={{ providerId: f.original.providerId, workspacePath: f.original.workspacePath, run: f.original.run }} />)
  await openMailbox(); await chooseSent()
  await vi.waitFor(() => expect(dom.container.querySelector('[data-record-key="a2a:same-mail"]')).not.toBeNull())
  expect(dom.container.textContent).not.toContain('Another Runtime body')
  await dom.click('[data-record-key="a2a:same-mail"]')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Preserve this original tail'))
  expect(dom.container.textContent).toContain('Original D body')
  await dom.click('[id$="-system-tab"]')
  expect(dom.container.textContent).not.toContain('Some message tools are unavailable on this connection')
  expect(dom.container.textContent).not.toContain('Observer caller')
  await dom.click('[id$="-agents-tab"]')
  await dom.click('[id$="-inbox-tab"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-record-key="a2a:same-sid-mail"]')).not.toBeNull())
  await dom.click('[data-record-key="a2a:same-sid-mail"]')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Same SID other Runtime original body'))
  expect(dom.container.textContent).not.toContain('Observer namesake')
  await dom.click('[id$="-collaboration-tab"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-source-message="same-mail"]')).not.toBeNull())
  expect(dom.container.querySelector('[data-source-message="namesake-mail"]')).toBeNull()
  await dom.click('[data-source-message="same-mail"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-dispatch-source="same-mail"]')).not.toBeNull())
  const body = dom.container.querySelector<HTMLDetailsElement>('[data-message-id="same-mail"]')!
  await act(async () => { body.open = true; body.dispatchEvent(new Event('toggle')) })
  expect(dom.container.textContent).toContain('Original D body')
  for (const ordinary of f.ordinary) expect(ordinary).not.toHaveBeenCalled()
  expect(native).not.toHaveBeenCalled(); expect(dom.draft(f.owner)).toBe('Original unsent input'); expect(dom.draft('recipient')).toBe('Observer unsent input')
  expect(f.selected.owner.inner.kernel.input).not.toHaveBeenCalled()
})

it('a shared Mailbox window cannot present the previous same-SID Runtime while the new original list is pending', async () => {
  const f = await fixture()
  await dom.render(<SessionMailbox originalMail={f.d} control={null} system={system} queued={[]} />)
  await openMailbox()
  const dReceipt = 'mail:' + JSON.stringify([f.d.runtimeId, 'recipient']), bReceipt = 'mail:' + JSON.stringify([f.b.runtimeId, 'recipient'])
  await vi.waitFor(() => expect(useAppStore.getState().noticeReadReceipts[dReceipt]).toBeDefined())
  expect(useAppStore.getState().noticeReadReceipts['mail:recipient']).toBeUndefined()
  await chooseSent()
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original D body'))
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve }); cleanup.push(async () => release())
  f.afterReply(async method => { if (method === 'message.ls') { entered(); await gate } })
  await dom.render(<SessionMailbox originalMail={f.b} control={null} system={system} queued={[]} />)
  await ready
  expect(dom.container.textContent).not.toContain('Original D body')
  release()
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original B body'))
  expect(useAppStore.getState().noticeReadReceipts[bReceipt]).toBeUndefined()
  await dom.click('[id$="-inbox-tab"]')
  await vi.waitFor(() => expect(useAppStore.getState().noticeReadReceipts[bReceipt]).toBeDefined())
  expect(useAppStore.getState().noticeReadReceipts['mail:recipient']).toBeUndefined()
  for (const ordinary of f.ordinary) expect(ordinary).not.toHaveBeenCalled()
})

it('a shared selected mail detail cannot retain the previous same-SID Runtime body during a new exact read', async () => {
  const f = await fixture(), d = await f.d.list({ direction: 'outgoing' }), b = await f.b.list({ direction: 'outgoing' })
  const props = { reference: f.d.reference, direction: 'outgoing' as const, selectedKey: 'a2a:same-mail', active: true, loading: false,
    error: null, observationError: null, nextCursor: null, refresh() {}, loadEarlier() {}, onOpen: vi.fn() }
  await dom.render(<MailboxA2A {...props} items={d.messages} readingIdentity={f.d.identity} readMessage={async id => (await f.d.read(id)).message} />)
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original D body'))
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve }); cleanup.push(async () => release())
  f.afterReply(async method => { if (method === 'message.read') { entered(); await gate } })
  await dom.render(<MailboxA2A {...props} items={b.messages} readingIdentity={f.b.identity} readMessage={async id => (await f.b.read(id)).message} />)
  await ready
  expect(dom.container.textContent).not.toContain('Original D body')
  release()
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original B body'))
  for (const ordinary of f.ordinary) expect(ordinary).not.toHaveBeenCalled()
})

it('a changed original admission cannot publish an old mail detail as that newly selected source', async () => {
  const f = await fixture(), page = await f.d.list({ direction: 'outgoing' })
  const props = { reference: f.d.reference, direction: 'outgoing' as const, items: page.messages, selectedKey: 'a2a:same-mail', active: true, loading: false,
    error: null, observationError: null, nextCursor: null, refresh() {}, loadEarlier() {}, onOpen: vi.fn() }
  await dom.render(<MailboxA2A {...props} readingIdentity={f.d.identity} readMessage={async id => (await f.d.read(id)).message} />)
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original D body'))
  const old = f.reading(f.selected.target), changed = { ...old, target: { ...old.target, expectedAdmission: { kind: 'creation' as const, operationId: 'another-unconfirmed-admission' } } }
  const next = sourceMemberMail(f.main.api, changed)
  await dom.render(<MailboxA2A {...props} readingIdentity={next.identity} readMessage={async id => (await next.read(id)).message} />)
  expect(dom.container.textContent).not.toContain('Original D body')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('creation or association changed'))
  expect(dom.container.textContent).not.toContain('Original D body')
  for (const ordinary of f.ordinary) expect(ordinary).not.toHaveBeenCalled()
})

it('the product Mailbox remounts collaboration for a new Source and rejects a late old Dispatch body', async () => {
  const f = await fixture()
  await dom.render(<SessionMailbox originalMail={f.d} control={null} system={system} queued={[]} />)
  await openMailbox(); await dom.click('[id$="-agents-tab"]'); await dom.click('[id$="-collaboration-tab"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-source-message="same-mail"]')).not.toBeNull())
  await dom.click('[data-source-message="same-mail"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-dispatch-source="same-mail"]')).not.toBeNull())
  const body = dom.container.querySelector<HTMLDetailsElement>('[data-message-id="same-mail"]')!
  await act(async () => { body.open = true; body.dispatchEvent(new Event('toggle')) })
  expect(dom.container.textContent).toContain('Original D body')
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve }); cleanup.push(async () => release())
  f.afterReply(async method => { if (method === 'message.dispatch.read') { entered(); await gate } })
  await dom.click('[aria-label="Refresh records"]'); await ready
  await dom.render(<SessionMailbox originalMail={f.b} control={null} system={system} queued={[]} />)
  expect(dom.container.textContent).not.toContain('Original D body')
  release()
  await vi.waitFor(() => expect(dom.container.querySelector('[data-source-message="same-mail"]')).not.toBeNull())
  expect(dom.container.textContent).not.toContain('Original D body')
  await dom.click('[data-source-message="same-mail"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-dispatch-source="same-mail"]')).not.toBeNull())
  const next = dom.container.querySelector<HTMLDetailsElement>('[data-message-id="same-mail"]')!
  await act(async () => { next.open = true; next.dispatchEvent(new Event('toggle')) })
  expect(dom.container.textContent).toContain('Original B body')
  expect(dom.container.textContent).not.toContain('Original D body')
  for (const ordinary of f.ordinary) expect(ordinary).not.toHaveBeenCalled()
})
