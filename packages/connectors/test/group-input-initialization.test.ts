import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { captureExecutorInvocation } from '../../core/src/agent-executor-invocation.js'
import { DurableIngressHost } from '../src/durable-ingress.js'
import { ingressFixture } from './fixtures/ingress.js'
import { context } from './fixtures/room-binding.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

async function startingGroup(reason: 'directory-trust' | 'authentication') {
  const f = await ingressFixture(true); closes.push(f.close)
  const current = (await f.store.readMetadata(f.input.agentSessionId))!, inner = f.client as any
  const { nativeBinding: _readyBinding, ...starting } = current
  const invocation = captureExecutorInvocation(current.providerId, current.executorId, 'original-group-create', 'a'.repeat(64), {
    env: { HOME: f.root }, commandOverride: process.execPath })!
  await f.store.compareAndSwapMetadata(current, { ...starting,
    creation: { createOperationId: 'original-group-create', createdRun: current.run, initialPrompt: 'not-requested',
      intentDigest: 'a'.repeat(64), executorInvocationDigest: invocation.digest }, executorInvocation: invocation.value })
  await inner.registry.refresh(current.agentSessionId, current.run)
  inner.kernel.status = vi.fn(async (id: string) => ({ ...f.run(id), program: process.execPath, pid: 21011 }))
  const protocol = join(f.root, 'native-initialization.json')
  await writeFile(protocol, JSON.stringify(reason === 'directory-trust' ? { projectTrusted: false } : { account: { state: 'login-required' } }))
  const provider = f.client.providers.get(current.providerId)
  expect(provider.prepareNativeInput).toBeUndefined()
  f.client.providers.replace({ ...provider,
    // Two machine protocol forms are interpreted only in the Provider contribution.
    // Runtime bytes and native protocols are fixture ports; ingress/authority/Core are real.
    readInputInitialization: async value => {
      expect(value.agentSessionId).toBe(current.agentSessionId); expect(value.run).toEqual(current.run)
      expect(value.env?.HOME).toBe(f.root)
      const observed = JSON.parse(await readFile(protocol, 'utf8'))
      return observed.projectTrusted === false ? { state: 'pending', reason: 'directory-trust' }
        : observed.account?.state === 'login-required' ? { state: 'pending', reason: 'authentication' }
          : { state: 'unknown', reason: 'native-input-unconfirmed' }
    } })
  return { ...f, inner }
}

it.each(['directory-trust', 'authentication'] as const)('ordinary group input waits through native %s and dispatches the original body once', async reason => {
  const f = await startingGroup(reason), submit = vi.spyOn(f.client, 'submitAgentMessage')
  const received = await f.receive({ conversationKind: 'group' })
  const first = await f.ingress.dispatch(received.ingress.ingressId)
  const original = first.ingress!.input!, key = first.inputReceipt!.key
  await f.inner.inputWaitingRecipients.get(f.input.agentSessionId)?.pending
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.rawInput).not.toHaveBeenCalled()
  expect(original.admissionIntent).toEqual({ kind: 'session-conversation', expectedRun: f.session.run })
  await vi.waitFor(async () => expect((await f.ingress.inspect({ ingressId: received.ingress.ingressId })).inputReceipt?.control.waiting?.failure?.message)
    .toContain(`pending (${reason})`))
  const reopened = new DurableIngressHost(f.options)
  expect((await reopened.dispatch(received.ingress.ingressId)).ingress!.input).toEqual(original)
  expect(submit).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  const current = (await f.store.readMetadata(f.input.agentSessionId))!, at = current.updatedAt + 1
  await f.store.compareAndSwapMetadata(current, { ...current,
    nativeBinding: { source: 'native-hook', run: current.run, observedAt: at }, updatedAt: at })
  await f.inner.registry.refresh(current.agentSessionId, current.run); f.inner.publishSession(f.inner.registry.get(current.agentSessionId))
  await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key }))?.status).toBe('terminal-confirmed'))
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect(f.inner.kernel.input.mock.calls[0]![1].data).toContain(first.ingress!.body)
  await reopened.dispatch(received.ingress.ingressId)
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(submit).toHaveBeenCalledOnce()
  expect((await reopened.inspect({ ingressId: received.ingress.ingressId })).inputReceipt!.key).toEqual(key)
})

it('new semantic group input still checks the current author grant before native start', async () => {
  const f = await startingGroup('authentication'), received = await f.receive({ conversationKind: 'group' })
  const first = await f.ingress.dispatch(received.ingress.ingressId), original = first.ingress!.input!
  await f.inner.inputWaitingRecipients.get(f.input.agentSessionId)?.pending
  await f.bindings.grant({ ...f.grant, operationId: 'revoke-waiting-group-author', expectedRevision: 1, state: 'revoked' }, context)
  const current = (await f.store.readMetadata(f.input.agentSessionId))!, at = current.updatedAt + 1
  await f.store.compareAndSwapMetadata(current, { ...current, nativeBinding: { source: 'native-hook', run: current.run, observedAt: at }, updatedAt: at })
  await f.inner.registry.refresh(current.agentSessionId, current.run); f.inner.publishSession(f.inner.registry.get(current.agentSessionId))
  await vi.waitFor(async () => expect((await f.ingress.inspect({ ingressId: received.ingress.ingressId })).inputReceipt?.control.waiting)
    .toMatchObject({ phase: 'authorization', reason: 'author-authorization-needed', wake: 'explicit-rejoin' }))
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect((await f.ingress.inspect({ ingressId: received.ingress.ingressId })).ingress!.input).toEqual(original)
})

it('a frozen terminal group input keeps its original intent when a later receiver uses semantic defaults', async () => {
  const f = await ingressFixture(); closes.push(f.close)
  const previous = new DurableIngressHost({ ...f.options, inputTarget: () => ({ kind: 'manual-actor' }) })
  const received = await previous.receive({ connectionId: f.input.connectionId,
    raw: JSON.stringify({ proof: 'adapter-private-witness', event: f.event({ conversationKind: 'group' }) }) }, vi.fn())
  const first = await previous.dispatch(received.ingress.ingressId), original = first.ingress!.input!
  expect(original.admissionIntent).toEqual({ kind: 'manual-actor', expectedRun: f.session.run })
  const current = new DurableIngressHost(f.options)
  expect((await current.dispatch(received.ingress.ingressId)).ingress!.input).toEqual(original)
  const later = await f.receive({ conversationKind: 'group', eventId: 'new-semantic-event', messageId: 'new-semantic-message' })
  const next = await current.dispatch(later.ingress.ingressId)
  expect(next.ingress!.input!.admissionIntent).toEqual({ kind: 'session-conversation', expectedRun: f.session.run })
  expect(next.ingress!.input!.operationId).not.toBe(original.operationId)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('an explicitly bound native target keeps its original source when that native input is unavailable', async () => {
  const f = await ingressFixture(true); closes.push(f.close)
  const inputTarget = { kind: 'native-conversation' as const, source: { ...f.input.expectedSource } }
  expect(await f.bindings.relink({ ...f.input, operationId: 'select-native-group-target', expectedRevision: 1, inputTarget }, context))
    .toMatchObject({ state: 'applied', binding: { inputTarget, revision: 2 } })
  await f.bindings.grant({ ...f.grant, operationId: 'grant-native-group-target', expectedBindingRevision: 2, expectedRevision: 1 }, context)
  const received = await f.receive({ conversationKind: 'group' }), first = await f.ingress.dispatch(received.ingress.ingressId)
  expect(first.ingress!.input!.admissionIntent).toEqual({ ...inputTarget, expectedRun: f.session.run })
  await (f.client as any).inputWaitingRecipients.get(f.input.agentSessionId)?.pending
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.rawInput).not.toHaveBeenCalled()
  const original = first.ingress!.input!
  const reopened = new DurableIngressHost(f.options)
  expect((await reopened.dispatch(received.ingress.ingressId)).ingress!.input).toEqual(original)
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
