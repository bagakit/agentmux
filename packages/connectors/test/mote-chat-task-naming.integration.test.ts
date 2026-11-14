import { expect, it, vi } from 'vitest'
import { AGENTMUX_SESSION_NAMING_ENTRY, DurableAgentMuxMessageQueue } from '@agentmux/core'
import { moteChatJourneyFixture } from './fixtures/mote-chat-journey.js'

it('the real dedicated chat freezes name discovery before its separately retained first external task with full runtime guide off', async () => {
  const f = await moteChatJourneyFixture(4, 60_000, 'headless', false, 'grok', undefined, undefined, 'signed-room')
  expect(f.config.executors['saved-chat']!.injectAgentMuxGuide).toBe(false)
  expect(f.start).not.toHaveBeenCalled()
  const message = f.message('first-task-with-name')
  expect(await f.wire.post(message)).toBe(202)
  const original = await f.claimed('first-task-with-name'), input = original.input!
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const creation = await f.client.readAgentSession(input.agentSessionId)
  expect(creation?.creation).toMatchObject({ initialPrompt: 'not-requested', agentMuxContext: 'confirmed' })
  const launched = f.start.mock.calls[0]![0].args.join('\n')
  expect(launched).toContain(AGENTMUX_SESSION_NAMING_ENTRY)
  expect(launched.split(AGENTMUX_SESSION_NAMING_ENTRY)).toHaveLength(2)
  expect(launched).not.toContain('AgentMux runtime guide:')
  expect(launched).not.toContain(message.text)
  expect(f.prepare.mock.calls[0]![0].systemContext).toContain(AGENTMUX_SESSION_NAMING_ENTRY)
  const queue = new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath())
  expect((await queue.readByOperationId(input.operationId))?.envelope).toMatchObject({ body: message.text, sender: input.author })
  await f.restart()
  expect(await f.wire.post({ ...message, deliveryKey: 'same-task-redelivery' })).toBe(202)
  await new Promise(resolve => setImmediate(resolve))
  expect(f.start).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})
