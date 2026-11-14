// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import type { ConversationReadApi } from '../src/shared/conversation-read'
import { readSourceConversationRecap } from '../src/renderer/src/lib/focus-source-conversation'
import { isolateCoreFixtureEnvironment } from './helpers/isolate-core-environment'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it.each(['failure', 'cancel'] as const)('releases the original partial Focus recap after a later %s', async failure => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-focus-recap-'))
  isolateCoreFixtureEnvironment(directory)
  const fixture = await nativeHistoryFixture('claude', jsonl(Array.from({ length: 4 }, (_, index) => ({
    type: 'assistant', uuid: `original-${index}`, sessionId: 'native-main',
    message: { role: 'assistant', content: `Original recap ${index}.` }
  }))))
  await fixture.store.applyTimelineMutation({ type: 'append', agentSessionId: fixture.session.agentSessionId,
    item: { id: 'original-captured', agentSessionId: fixture.session.agentSessionId, kind: 'assistant_message',
      source: 'native-hook', status: 'complete', title: 'Original captured recap', content: 'Another original recap source.',
      createdAt: 1, updatedAt: 1 } })
  const controller = new AbortController()
  const originalError = new Error(`The original recap continuation ${failure}.`)
  const releases: string[] = []
  let first: Awaited<ReturnType<ConversationReadApi['readAgentConversation']>> | undefined, reads = 0
  const port: ConversationReadApi = {
    readAgentConversation: async (input, options) => {
      if (++reads === 1) {
        // A one-unit transport fragment makes the real native+captured window partial.
        first = await fixture.client.readAgentConversation({ ...input, limit: 1 }, options)
        expect(first.window.complete).toBe(false)
        expect(first.window.view).toBeNull()
        expect(first.window.replay).toEqual(expect.any(String))
        expect(first.nextCursor).toEqual(expect.any(String))
        return first
      }
      if (failure === 'cancel') {
        controller.abort(originalError)
        options?.signal?.throwIfAborted()
      }
      throw originalError
    },
    readConversationChanges: fixture.client.readConversationChanges.bind(fixture.client),
    observeConversation: fixture.client.observeConversation.bind(fixture.client),
    releaseConversationView: async input => {
      releases.push(input.view)
      return fixture.client.releaseConversationView(input)
    }
  }
  try {
    await expect(readSourceConversationRecap(port, fixture.session.agentSessionId, controller.signal)).rejects.toBe(originalError)
    expect(reads).toBe(2)
    expect(first).toBeDefined()
    expect(releases).toEqual([first!.window.replay])
    // The real Core owner confirms the consumer already released this exact candidate.
    await expect(fixture.client.releaseConversationView({ hostId: 'local', agentSessionId: fixture.session.agentSessionId,
      view: first!.window.replay })).resolves.toMatchObject({ released: false })
    expect(fixture.controls.flatMap(control => control.mock.calls)).toEqual([])
  } finally {
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
})
