import { afterAll, expect, it, vi } from 'vitest'
import { appendFile, stat } from 'node:fs/promises'
import { AGENTMUX_SESSION_NAMING_ENTRY, DurableAgentMuxMessageQueue } from '@agentmux/core'
import { moteChatJourneyFixture } from './fixtures/mote-chat-journey.js'
const roots: string[] = []
afterAll(async () => { for (const root of roots) {
  await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  if (process.env.GENERAL_NAMING_FACTS) await appendFile(process.env.GENERAL_NAMING_FACTS, JSON.stringify({ kind: 'cleanup', root, absent: true }) + '\n')
} })

it('the real dedicated chat receives shared Core naming discovery before its separate external task with the full guide off', async () => {
  const f = await moteChatJourneyFixture(4, 60_000, 'headless', false, 'grok', undefined, undefined, 'signed-room')
  roots.push(f.root)
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
  expect(f.prepare.mock.calls[0]![0].systemContext).not.toContain(AGENTMUX_SESSION_NAMING_ENTRY)
  const queue = new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath())
  expect((await queue.readByOperationId(input.operationId))?.envelope).toMatchObject({ body: message.text, sender: input.author })
  await f.restart()
  expect(await f.wire.post({ ...message, deliveryKey: 'same-task-redelivery' })).toBe(202)
  await new Promise(resolve => setImmediate(resolve))
  expect(f.start).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  const saved = await f.store.readMetadata(input.agentSessionId)
  expect(saved?.initialInput?.message.systemContext).toContain(AGENTMUX_SESSION_NAMING_ENTRY)
  if (process.env.GENERAL_NAMING_FACTS) await appendFile(process.env.GENERAL_NAMING_FACTS, JSON.stringify({ kind: 'dedicated-chat',
    agentSessionId: input.agentSessionId, run: input.expectedRun, messageId: input.messageId, originalUserBody: message.text,
    systemContext: saved!.initialInput!.message.systemContext, starts: f.start.mock.calls.length, inputs: f.inner.kernel.input.mock.calls.length,
    prepareHasNaming: f.prepare.mock.calls[0]![0].systemContext.includes(AGENTMUX_SESSION_NAMING_ENTRY) }) + '\n')
})
