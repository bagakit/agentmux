import { afterEach, expect, it, vi } from 'vitest'
import * as core from '../../core/dist/index.js'
import { DurableIngressHost } from '../src/durable-ingress.js'
import { ingressFixture } from './fixtures/ingress.js'

/**
 * The connector is the only owner of the adapter's typed conversation kind. It passes that kind
 * with the original input, and the Agent reads the matching reply note in the delivered bytes.
 */
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const NORM = 'Reply like a colleague in chat'
const notes = { direct: 'This message came from a direct chat with one person.', group: 'This message came from a group chat; everyone there can read your replies' }

it.each([['direct', 'group'], ['group', 'direct']] as const)('a %s chat input reaches the Agent with its reply note', async (kind, other) => {
  const f = await ingressFixture(true); cleanup.push(f.close)
  const submit = vi.spyOn(f.client, 'submitAgentMessage')
  const received = await f.receive({ conversationKind: kind })
  await new DurableIngressHost(f.options).dispatch(received.ingress.ingressId)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(submit.mock.calls[0]![0]).toMatchObject({ conversationKind: kind })
  const wire = (f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls[0]![1].data as string
  expect(wire).toContain(notes[kind]); expect(wire).toContain(NORM); expect(wire).not.toContain(notes[other])
  // The kind selects presentation only; the frozen original envelope carries no new field.
  const original = await new core.DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath()).readByOperationId(submit.mock.calls[0]![0].envelope.operationId)
  expect(original?.envelope).not.toHaveProperty('conversationKind')
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('an input whose adapter stated no conversation kind gets no reply note', async () => {
  const f = await ingressFixture(true); cleanup.push(f.close)
  const received = await f.receive()
  await new DurableIngressHost(f.options).dispatch(received.ingress.ingressId)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const wire = (f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls[0]![1].data as string
  expect(wire).not.toContain(NORM); expect(wire).not.toContain(notes.direct); expect(wire).not.toContain(notes.group)
})
