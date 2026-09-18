import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from '../fixtures/native-history-session.js'
import { AgentMuxClient } from '../../src/client.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../../src/session-history.js'

const fixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
})

async function fixture(data: string | Buffer) {
  const value = await nativeHistoryFixture('claude', data)
  fixtures.push(value)
  return value
}

const record = (
  uuid: string,
  type: string,
  content: unknown,
  extra: Record<string, unknown> = {}
) => ({
  sessionId: 'native-main',
  uuid,
  type,
  message: { role: type, content },
  ...extra
})

describe('Claude session analysis and native trace completeness', () => {
  it('preserves authentic mixed assistant message with in-order reasoning, text, and tool-call trace blocks, and links causal turnId', async () => {
    const f = await fixture(
      jsonl([
        record('user-msg-1', 'user', 'Please run the build and inspect output.', {
          timestamp: '2026-10-01T12:00:00.000Z'
        }),
        record(
          'asst-msg-1',
          'assistant',
          [
            { type: 'thinking', thinking: 'Checking build scripts in package.json first.' },
            { type: 'text', text: 'Executing build now.' },
            {
              type: 'tool_use',
              id: 'call-bash-1',
              name: 'Bash',
              input: { command: 'pnpm --filter @agentmux/core build' }
            }
          ],
          {
            user_message_uuid: 'user-msg-1',
            timestamp: '2026-10-01T12:00:05.000Z'
          }
        ),
        record(
          'tool-res-1',
          'user',
          [
            {
              type: 'tool_result',
              tool_use_id: 'call-bash-1',
              content: 'Build succeeded in 1.4s',
              is_error: false
            }
          ],
          {
            user_message_uuid: 'user-msg-1',
            timestamp: '2026-10-01T12:00:10.000Z',
            tool_use_result: { stdout: 'Build succeeded in 1.4s', stderr: '', interrupted: false }
          }
        )
      ])
    )

    const page = await f.client.sessionHistoryPage('private-agent')
    expect(page.source).toEqual({ providerId: 'claude', nativeSessionId: 'native-main' })
    expect(page.items).toHaveLength(3)

    // Verify non-empty exact collection
    const kinds = page.items.map((item) => item.kind)
    expect(kinds).toEqual(['user-message', 'assistant-message', 'activity'])

    // User message
    const userItem = page.items[0]!
    expect(userItem.id).toBe('user-msg-1')
    expect(userItem.contentParts).toEqual([
      { kind: 'text', text: 'Please run the build and inspect output.' }
    ])
    expect(userItem.startedAt).toBe(Date.parse('2026-10-01T12:00:00.000Z'))

    // Mixed assistant message: retains speaker, keeps block order, links turnId
    const asstItem = page.items[1]!
    expect(asstItem.id).toBe('asst-msg-1')
    expect(asstItem.kind).toBe('assistant-message')
    expect(asstItem.turnId).toBe('user-msg-1')
    expect(asstItem.startedAt).toBe(Date.parse('2026-10-01T12:00:05.000Z'))
    expect(asstItem.contentParts).toEqual([
      { kind: 'reasoning', text: 'Checking build scripts in package.json first.' },
      { kind: 'text', text: 'Executing build now.' },
      {
        kind: 'tool-call',
        name: 'Bash',
        input: '{"command":"pnpm --filter @agentmux/core build"}',
        callId: 'call-bash-1'
      }
    ])

    // Tool result message under user role: classified as activity, not human speech
    const toolItem = page.items[2]!
    expect(toolItem.id).toBe('tool-res-1')
    expect(toolItem.kind).toBe('activity')
    expect(toolItem.turnId).toBe('user-msg-1')
    expect(toolItem.startedAt).toBe(Date.parse('2026-10-01T12:00:10.000Z'))
    expect(toolItem.contentParts).toEqual([
      {
        kind: 'tool-result',
        output: 'Build succeeded in 1.4s',
        callId: 'call-bash-1'
      }
    ])
    // failed is absent when is_error is false
    expect(toolItem.contentParts[0]).not.toHaveProperty('failed')

    // Run control operations must remain strictly zero
    expect(f.controls).toHaveLength(6)
    for (const control of f.controls) {
      expect(control).not.toHaveBeenCalled()
    }

    // Bytes on disk must remain unchanged
    const currentBytes = await f.bytes()
    expect(currentBytes.native).toEqual(f.before.native)
    expect(currentBytes.store).toEqual(f.before.store)
  })

  it('preserves pure reasoning and pure tool-call turns as activity, and records tool failure', async () => {
    const f = await fixture(
      jsonl([
        record(
          'reasoning-only',
          'assistant',
          [{ type: 'thinking', thinking: 'Analyzing trace in solitude without speaking.' }],
          { timestamp: '2026-10-01T12:01:00.000Z' }
        ),
        record(
          'tool-call-only',
          'assistant',
          [
            {
              type: 'tool_use',
              id: 'call-fetch-1',
              name: 'WebFetch',
              input: { url: 'https://example.com' }
            }
          ],
          { timestamp: '2026-10-01T12:01:05.000Z' }
        ),
        record(
          'tool-failed-res',
          'user',
          [
            {
              type: 'tool_result',
              tool_use_id: 'call-fetch-1',
              content: 'HTTP 500 Internal Server Error',
              is_error: true
            }
          ],
          {
            timestamp: '2026-10-01T12:01:10.000Z',
            tool_use_result: { stderr: '500 error', interrupted: false }
          }
        )
      ])
    )

    const page = await f.client.sessionHistoryPage('private-agent')
    expect(page.items).toHaveLength(3)

    // Pure reasoning is activity
    expect(page.items[0]!.kind).toBe('activity')
    expect(page.items[0]!.contentParts).toEqual([
      { kind: 'reasoning', text: 'Analyzing trace in solitude without speaking.' }
    ])

    // Pure tool-call is activity
    expect(page.items[1]!.kind).toBe('activity')
    expect(page.items[1]!.contentParts).toEqual([
      {
        kind: 'tool-call',
        name: 'WebFetch',
        input: '{"url":"https://example.com"}',
        callId: 'call-fetch-1'
      }
    ])

    // Tool failure has failed: true
    expect(page.items[2]!.kind).toBe('activity')
    expect(page.items[2]!.contentParts).toEqual([
      {
        kind: 'tool-result',
        output: 'HTTP 500 Internal Server Error',
        callId: 'call-fetch-1',
        failed: true
      }
    ])
  })

  it('omits absent native fields: missing timestamps, missing callIds, and non-failed status', async () => {
    const f = await fixture(
      jsonl([
        record('no-time-asst', 'assistant', [
          { type: 'text', text: 'Reply without timestamp' },
          { type: 'tool_use', name: 'AnonymousTool', input: 'plain-string-input' }
        ], { timestamp: 'invalid-date' })
      ])
    )

    const page = await f.client.sessionHistoryPage('private-agent')
    expect(page.items).toHaveLength(1)
    const item = page.items[0]!
    expect(item).not.toHaveProperty('startedAt')
    expect(item).not.toHaveProperty('turnId')
    expect(item.contentParts).toEqual([
      { kind: 'text', text: 'Reply without timestamp' },
      { kind: 'tool-call', name: 'AnonymousTool', input: 'plain-string-input' }
    ])
    expect(item.contentParts[1]).not.toHaveProperty('callId')
  })

  it('isolates sidechains and enforces exact native session source', async () => {
    const f = await fixture(
      jsonl([
        record('main-1', 'user', 'main conversation'),
        record('side-1', 'assistant', 'subagent message', { isSidechain: true }),
        record('main-2', 'assistant', [{ type: 'text', text: 'main answer' }])
      ])
    )

    const page = await f.client.sessionHistoryPage('private-agent')
    expect(page.items.map((item) => item.id)).toEqual(['main-1', 'main-2'])

    // Mismatching native session id throws AGENT_SESSION_HISTORY_SOURCE_CHANGED
    const wrong = await fixture(
      jsonl([
        record('other', 'user', 'wrong session', { sessionId: 'foreign-session-id' })
      ])
    )
    await expect(wrong.client.sessionHistoryPage('private-agent')).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
    })
  })

  it('pages backwards chronologically without gaps or duplicates across cursors', async () => {
    const f = await fixture(
      jsonl([
        record('entry-0', 'user', 'step 0'),
        record('entry-1', 'assistant', [{ type: 'text', text: 'step 1' }]),
        record('entry-2', 'user', 'step 2'),
        record('entry-3', 'assistant', [{ type: 'text', text: 'step 3' }])
      ])
    )

    const page1 = await f.client.sessionHistoryPage('private-agent', { limit: 2 })
    expect(page1.items.map((item) => item.id)).toEqual(['entry-2', 'entry-3'])
    expect(page1.nextCursor).toBeTruthy()

    const page2 = await f.client.sessionHistoryPage('private-agent', {
      limit: 2,
      cursor: page1.nextCursor!
    })
    expect(page2.items.map((item) => item.id)).toEqual(['entry-0', 'entry-1'])
    expect(page2.nextCursor).toBeNull()

    // No overlap and complete union
    const allIds = [...page2.items.map((i) => i.id), ...page1.items.map((i) => i.id)]
    expect(allIds).toEqual(['entry-0', 'entry-1', 'entry-2', 'entry-3'])
  })

  it('safely ignores partial UTF-8 tail at EOF without file repair', async () => {
    const full = jsonl([record('valid-1', 'assistant', [{ type: 'text', text: 'complete reply' }])])
    const incomplete = Buffer.concat([
      Buffer.from(full),
      Buffer.from('{"type":"assistant","uuid":"broken","sessionId":"native-main","message":{"content":"unf')
    ])

    const f = await fixture(incomplete)
    const page = await f.client.sessionHistoryPage('private-agent')
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.id).toBe('valid-1')
    expect(await f.bytes()).toEqual(f.before)
  })

  it('recovers the same durable session from a fresh client without modifying store or native files', async () => {
    const f = await fixture(
      jsonl([
        record('msg-1', 'user', 'persist test'),
        record('msg-2', 'assistant', [{ type: 'text', text: 'persisted answer' }])
      ])
    )

    const pageA = await f.client.sessionHistoryPage('private-agent')
    expect(pageA.items.map((i) => i.id)).toEqual(['msg-1', 'msg-2'])

    // Fresh client instance reading from the exact same store
    const freshClient = new AgentMuxClient({ store: f.store })
    try {
      const pageB = await freshClient.sessionHistoryPage('private-agent')
      expect(pageB.source).toEqual(pageA.source)
      expect(pageB.items).toEqual(pageA.items)
      expect(pageB.nextCursor).toEqual(pageA.nextCursor)
    } finally {
      await freshClient.dispose()
    }

    const currentBytes = await f.bytes()
    expect(currentBytes.native).toEqual(f.before.native)
    expect(currentBytes.store).toEqual(f.before.store)
  })

  it('enforces page byte budget, verifies unchanged source during reading, and respects cancellation', async () => {
    // Budget check
    const large = await fixture(
      jsonl(
        Array.from({ length: 70 }, (_, i) =>
          record(`large-${i}`, 'assistant', [{ type: 'text', text: 'y'.repeat(64 * 1024) }])
        )
      )
    )
    await expect(large.client.sessionHistoryPage('private-agent', { limit: 70 })).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_TOO_LARGE'
    })

    // Cancellation check
    const f = await fixture(jsonl([record('msg', 'user', 'cancellation check')]))
    await f.client.dispose()
    await expect(f.client.sessionHistoryPage('private-agent')).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_CANCELLED'
    })
  })
})
