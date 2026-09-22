import { mkdtemp, readFile, rm, writeFile, mkdir, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { readAntigravitySessionHistoryPage } from '../../src/providers/antigravity-native-history.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import type { CtxmuxRunAdapter } from '../../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession, AgentNativeSessionHandle } from '../../src/types.js'

const roots: string[] = []
const clients: AgentMuxClient[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const NATIVE_CONVERSATION_ID = 'c9d6486c-0e26-4447-9292-62287f897101'

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n'
}

async function writeTranscriptFile(filePath: string, records: unknown[], partialTail = false): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  let content = jsonLines(records)
  if (partialTail) {
    // Add incomplete trailing line without newline
    content += '{"step_index":99,"source":"USER_EXPLICIT","type":"PARTIAL'
  }
  await writeFile(filePath, content, 'utf8')
}

const SAMPLE_RECORDS = [
  {
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: '2026-07-15T11:39:10.000Z',
    content: '<USER_REQUEST>\nImplement native history for Antigravity\n</USER_REQUEST>\n<ADDITIONAL_METADATA>untrusted-context</ADDITIONAL_METADATA>'
  },
  {
    step_index: 1,
    source: 'SYSTEM',
    type: 'CONVERSATION_HISTORY',
    status: 'DONE',
    created_at: '2026-07-15T11:39:11.000Z',
    content: 'Loaded system instructions and workspace context'
  },
  {
    step_index: 2,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-07-15T11:39:12.000Z',
    content: 'I will inspect the transcript and implement the reader.'
  },
  {
    step_index: 3,
    source: 'SYSTEM',
    type: 'CHECKPOINT',
    status: 'DONE',
    created_at: '2026-07-15T11:39:14.000Z',
    content: 'Checkpoint saved'
  },
  {
    step_index: 4,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: '2026-07-15T11:40:00.000Z',
    content: '<USER_REQUEST>Proceed with implementation</USER_REQUEST>'
  },
  {
    step_index: 5,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-07-15T11:40:05.000Z',
    content: 'Implementation is complete and verified.'
  }
]

async function createHarness(
  records: unknown[] = SAMPLE_RECORDS,
  customTranscriptPath?: string,
  partialTail = false
) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-antigravity-history-'))
  roots.push(root)
  const storePath = join(root, 'sessions.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const transcriptPath =
    customTranscriptPath ??
    join(
      root,
      '.gemini',
      'antigravity-cli',
      'brain',
      NATIVE_CONVERSATION_ID,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    )
  await writeTranscriptFile(transcriptPath, records, partialTail)

  const providers = new AgentProviderRegistry()
  const antigravity = providers.get('antigravity')

  // Real production identity path: start from real normalized Hook as required by owner
  const normalizedHook = antigravity.normalizeHook({
    receiptId: 'receipt-hook-init',
    agentSessionId: 'antigravity-agent-session-1',
    runId: 'healthy-run-antigravity',
    providerId: 'antigravity',
    eventName: 'SessionStart',
    payload: {
      conversationId: NATIVE_CONVERSATION_ID,
      transcriptPath
    }
  })

  // Genuinely narrow normalizedHook.nativeHandle before storing (no ! casts or silent omissions)
  if (!normalizedHook.nativeHandle || normalizedHook.nativeHandle.kind !== 'provider') {
    throw new Error('Expected Antigravity normalizedHook to produce a provider nativeHandle')
  }
  const nativeHandle: Extract<AgentNativeSessionHandle, { kind: 'provider' }> = normalizedHook.nativeHandle

  expect(nativeHandle).toEqual({
    kind: 'provider',
    providerId: 'antigravity',
    sessionId: NATIVE_CONVERSATION_ID,
    transcriptPath
  })

  const session: AgentMuxStoredAgentSession = {
    kind: 'agent',
    agentSessionId: 'antigravity-agent-session-1',
    providerId: 'antigravity',
    executorId: 'antigravity',
    hostId: 'local',
    workspacePath: root,
    run: { runId: 'healthy-run-antigravity' },
    retiredRuns: [],
    createdAt: 1000,
    updatedAt: 1000,
    hookBindingId: 'private-binding-antigravity',
    hookToken: 'private-token-antigravity',
    nativeHandle
  }

  await store.compareAndSwap(null, session)
  const client = new AgentMuxClient({ store, providers: [antigravity] })
  clients.push(client)

  return { client, store, storePath, transcriptPath, session, root }
}

describe('Antigravity session analysis and native history', () => {
  it('reads authentic user, assistant and activity trace records through public client without controlling Run or mutating store', async () => {
    const { client, storePath, transcriptPath, session } = await createHarness()
    const storeBefore = await readFile(storePath)
    const transcriptBefore = await readFile(transcriptPath)

    const kernel = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
    const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map((name) =>
      vi.spyOn(kernel, name as 'start')
    )

    const page = await client.sessionHistoryPage(session.agentSessionId)

    // Verify Run controls were not touched
    for (const control of controls) {
      expect(control).not.toHaveBeenCalled()
    }
    // Verify store and transcript files were not mutated
    expect(await readFile(storePath)).toEqual(storeBefore)
    expect(await readFile(transcriptPath)).toEqual(transcriptBefore)

    // Assert exact nonempty collection without vacuous predicates
    expect(page.items).toHaveLength(6)
    expect(page.source).toEqual({
      providerId: 'antigravity',
      nativeSessionId: NATIVE_CONVERSATION_ID
    })

    expect(page.items[0]).toEqual({
      id: `${NATIVE_CONVERSATION_ID}:0`,
      kind: 'user-message',
      contentParts: [{ kind: 'text', text: 'Implement native history for Antigravity' }],
      startedAt: Date.parse('2026-07-15T11:39:10.000Z')
    })
    expect(page.items[1]).toEqual({
      id: `${NATIVE_CONVERSATION_ID}:1`,
      kind: 'activity',
      title: 'Antigravity CONVERSATION_HISTORY',
      contentParts: [{ kind: 'text', text: 'Loaded system instructions and workspace context' }],
      startedAt: Date.parse('2026-07-15T11:39:11.000Z')
    })
    expect(page.items[2]).toEqual({
      id: `${NATIVE_CONVERSATION_ID}:2`,
      kind: 'assistant-message',
      contentParts: [{ kind: 'text', text: 'I will inspect the transcript and implement the reader.' }],
      startedAt: Date.parse('2026-07-15T11:39:12.000Z')
    })
    expect(page.items[3]).toEqual({
      id: `${NATIVE_CONVERSATION_ID}:3`,
      kind: 'activity',
      title: 'Antigravity CHECKPOINT',
      contentParts: [{ kind: 'text', text: 'Checkpoint saved' }],
      startedAt: Date.parse('2026-07-15T11:39:14.000Z')
    })
    expect(page.items[4]).toEqual({
      id: `${NATIVE_CONVERSATION_ID}:4`,
      kind: 'user-message',
      contentParts: [{ kind: 'text', text: 'Proceed with implementation' }],
      startedAt: Date.parse('2026-07-15T11:40:00.000Z')
    })
    expect(page.items[5]).toEqual({
      id: `${NATIVE_CONVERSATION_ID}:5`,
      kind: 'assistant-message',
      contentParts: [{ kind: 'text', text: 'Implementation is complete and verified.' }],
      startedAt: Date.parse('2026-07-15T11:40:05.000Z')
    })
  })

  it('preserves rich MODEL/PLANNER_RESPONSE fields (thinking, content, tool_calls, media) on a single step', async () => {
    // Verified against embedded agy binary file format specification at byte 51683604:
    // MODEL PLANNER_RESPONSE carries content, thinking, tool_calls with args, and media with mime_type/uri.
    const richRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T12:00:00.000Z',
        content: '<USER_REQUEST>Fix the test and verify with snapshot</USER_REQUEST>'
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T12:00:02.000Z',
        thinking: 'I need to check the test file and inspect the image.',
        content: 'I will run the command and inspect the visual snapshot.',
        tool_calls: [
          {
            name: 'run_command',
            args: { CommandLine: 'pnpm test' },
            id: 'call_cmd_101'
          }
        ],
        media: [
          {
            mime_type: 'image/png',
            uri: '/workspace/artifacts/snapshot.png'
          }
        ]
      }
    ]

    const { client, session } = await createHarness(richRecords)
    const page = await client.sessionHistoryPage(session.agentSessionId)

    expect(page.items).toHaveLength(2)
    const assistantItem = page.items[1]!
    expect(assistantItem.kind).toBe('assistant-message')
    expect(assistantItem.contentParts).toEqual([
      { kind: 'reasoning', text: 'I need to check the test file and inspect the image.' },
      { kind: 'text', text: 'I will run the command and inspect the visual snapshot.' },
      { kind: 'tool-call', name: 'run_command', input: JSON.stringify({ CommandLine: 'pnpm test' }), callId: 'call_cmd_101' },
      { kind: 'resource', resourceType: 'image', reference: '/workspace/artifacts/snapshot.png' }
    ])
  })

  it('keeps pure thinking and tool_calls without assistant text as activity', async () => {
    const pureTraceRecords = [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T12:05:00.000Z',
        thinking: 'Silently calculating diff...',
        tool_calls: [
          {
            name: 'compute_diff',
            args: 'src/main.ts'
          }
        ]
      }
    ]

    const { client, session } = await createHarness(pureTraceRecords)
    const page = await client.sessionHistoryPage(session.agentSessionId)

    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.kind).toBe('activity')
    expect(page.items[0]!.title).toBe('Antigravity PLANNER_RESPONSE')
    expect(page.items[0]!.contentParts).toEqual([
      { kind: 'reasoning', text: 'Silently calculating diff...' },
      { kind: 'tool-call', name: 'compute_diff', input: 'src/main.ts' }
    ])
  })

  it('preserves native absent ID, failure and status without inventing failed:false', async () => {
    const recordsWithoutFailure = [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'INTERNAL_EVENT',
        created_at: '2026-07-15T12:10:00.000Z',
        content: 'System observation'
      }
    ]

    const { client, session } = await createHarness(recordsWithoutFailure)
    const page = await client.sessionHistoryPage(session.agentSessionId)

    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.kind).toBe('activity')
    expect(page.items[0]!.contentParts).toEqual([
      { kind: 'text', text: 'System observation' }
    ])
  })

  it('preserves native MODEL/PLANNER_RESPONSE with status ERROR in assistant message content parts', async () => {
    const errorRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T12:00:00.000Z',
        content: '<USER_REQUEST>Run broken command</USER_REQUEST>'
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'ERROR',
        error: 'Model generation failed mid-stream',
        created_at: '2026-07-15T12:00:05.000Z',
        content: 'Partial assistant text before failure.'
      }
    ]

    const { client, session } = await createHarness(errorRecords)
    const page = await client.sessionHistoryPage(session.agentSessionId)

    expect(page.items).toHaveLength(2)
    const assistantItem = page.items[1]!
    expect(assistantItem.kind).toBe('assistant-message')
    expect(assistantItem.contentParts).toEqual([
      { kind: 'text', text: 'Partial assistant text before failure.' },
      { kind: 'text', text: '[Antigravity error: Model generation failed mid-stream]' }
    ])
  })

  it('keeps total FileHandle.read bytes across compact and full transcript strictly within shared page budget', async () => {
    // Exact shared-physical-budget scenario from Root acceptance:
    // Compact log is read first, then full log has a 5.2 MiB step exceeding the 4 MiB budget.
    // Both readers MUST share the same physical page budget so total read bytes across both files <= 4,194,304 B.
    const compactRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-10-02T00:00:00.000Z',
        content: 'user'
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-10-02T00:00:01.000Z',
        content: 'cut',
        truncated_fields: ['content']
      }
    ]

    const { client, storePath, transcriptPath, session } = await createHarness(compactRecords)
    const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl')

    const hugeContent = 'X'.repeat(5_240_000)
    const fullRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-10-02T00:00:00.000Z',
        content: 'user'
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-10-02T00:00:01.000Z',
        content: hugeContent
      }
    ]
    await writeTranscriptFile(fullPath, fullRecords)

    const storeBefore = await readFile(storePath)
    const compactBefore = await readFile(transcriptPath)
    const fullBefore = await readFile(fullPath)

    const kernel = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
    const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map((name) =>
      vi.spyOn(kernel, name as 'start')
    )

    let totalReturnedBytes = 0
    let totalRequestedBytes = 0
    const probeHandle = await open(transcriptPath, 'r')
    const fileHandleProto = Object.getPrototypeOf(probeHandle) as {
      read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>
    }
    await probeHandle.close()

    const originalRead = fileHandleProto.read
    const readSpy = vi.spyOn(fileHandleProto, 'read')
      .mockImplementation(async function (this: unknown, buffer: Buffer, offset: number, length: number, position: number) {
        totalRequestedBytes += length
        const result = await originalRead.call(this, buffer, offset, length, position)
        totalReturnedBytes += result.bytesRead
        return result
      })

    try {
      const page = await client.sessionHistoryPage(session.agentSessionId)

      // Zero Run controls
      for (const control of controls) {
        expect(control).not.toHaveBeenCalled()
      }

      // Native and store files immutable
      expect(await readFile(storePath)).toEqual(storeBefore)
      expect(await readFile(transcriptPath)).toEqual(compactBefore)
      expect(await readFile(fullPath)).toEqual(fullBefore)

      // Exact non-empty items with honest omission notice
      expect(page.items).toHaveLength(2)
      expect(page.items[0]!.kind).toBe('user-message')
      expect(page.items[0]!.contentParts).toEqual([
        { kind: 'text', text: 'user' }
      ])
      expect(page.items[1]!.kind).toBe('assistant-message')
      expect(page.items[1]!.contentParts).toEqual([
        { kind: 'text', text: 'cut' },
        { kind: 'text', text: '[Antigravity full transcript budget exceeded: omitted fields content]' }
      ])

      expect(totalReturnedBytes).toBeGreaterThan(0)
      // Total bytes requested and returned across compact and full files must NOT exceed 4 MiB (4,194,304 B)
      expect(totalRequestedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
      expect(totalReturnedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    } finally {
      readSpy.mockRestore()
    }
  }, 15_000)

  it('recovers full data from transcript_full.jsonl for rows with truncated_fields', async () => {
    const compactRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:00:00.000Z',
        content: '<USER_REQUEST>Truncated prompt prefix...</USER_REQUEST>',
        truncated_fields: ['content']
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:00:05.000Z',
        thinking: 'Short thought...',
        content: 'Short content prefix...',
        truncated_fields: ['content', 'thinking']
      }
    ]

    const fullRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:00:00.000Z',
        content: '<USER_REQUEST>Complete full prompt with all extensive instructions</USER_REQUEST>'
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:00:05.000Z',
        thinking: 'Complete in-depth chain of thought explaining the complete architecture',
        content: 'Complete full response body with comprehensive solution details.'
      }
    ]

    const { client, transcriptPath, session } = await createHarness(compactRecords)
    const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl')
    await writeTranscriptFile(fullPath, fullRecords)

    const page = await client.sessionHistoryPage(session.agentSessionId)

    expect(page.items).toHaveLength(2)
    expect(page.items[0]!.contentParts).toEqual([
      { kind: 'text', text: 'Complete full prompt with all extensive instructions' }
    ])
    expect(page.items[1]!.contentParts).toEqual([
      { kind: 'reasoning', text: 'Complete in-depth chain of thought explaining the complete architecture' },
      { kind: 'text', text: 'Complete full response body with comprehensive solution details.' }
    ])
  })

  it('retains explicit durable omission notice when transcript_full.jsonl is missing', async () => {
    const compactRecords = [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:10:00.000Z',
        content: 'Compact prefix',
        truncated_fields: ['content', 'tool_calls']
      }
    ]

    const { client, session } = await createHarness(compactRecords)
    const page = await client.sessionHistoryPage(session.agentSessionId)

    expect(page.items).toHaveLength(1)
    const parts = page.items[0]!.contentParts
    expect(parts.some((p) => p.kind === 'text' && p.text.includes('Compact prefix'))).toBe(true)
    expect(parts.some((p) => p.kind === 'text' && p.text.includes('[Antigravity full transcript unavailable: omitted fields content, tool_calls]'))).toBe(true)
  })

  it('paginates across multiple pages where each page has truncated fields without false SOURCE_CHANGED on untouched source', async () => {
    // Defect 1: When Page 1 stops in the middle of transcript_full.jsonl,
    // anchor.cut must not confuse stopped scan position with snapshot high-watermark.
    // Both Page 1 and Page 2 must resolve full content across pages without falsely raising SOURCE_CHANGED.
    const compactRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:30:00.000Z',
        content: '<USER_REQUEST>Prompt 0 truncated...</USER_REQUEST>',
        truncated_fields: ['content']
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:30:05.000Z',
        content: 'Response 1 truncated...',
        truncated_fields: ['content']
      },
      {
        step_index: 2,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:30:10.000Z',
        content: '<USER_REQUEST>Prompt 2 truncated...</USER_REQUEST>',
        truncated_fields: ['content']
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:30:15.000Z',
        content: 'Response 3 truncated...',
        truncated_fields: ['content']
      }
    ]

    const fullRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:30:00.000Z',
        content: '<USER_REQUEST>Complete full prompt 0</USER_REQUEST>'
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:30:05.000Z',
        content: 'Complete full response 1'
      },
      {
        step_index: 2,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:30:10.000Z',
        content: '<USER_REQUEST>Complete full prompt 2</USER_REQUEST>'
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:30:15.000Z',
        content: 'Complete full response 3'
      }
    ]

    const { client, transcriptPath, session } = await createHarness(compactRecords)
    const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl')
    await writeTranscriptFile(fullPath, fullRecords)

    // Page 1: newest 2 items (steps 2 and 3)
    const page1 = await client.sessionHistoryPage(session.agentSessionId, { limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.items[0]!.contentParts).toEqual([
      { kind: 'text', text: 'Complete full prompt 2' }
    ])
    expect(page1.items[1]!.contentParts).toEqual([
      { kind: 'text', text: 'Complete full response 3' }
    ])
    expect(page1.nextCursor).not.toBeNull()

    // Page 2: older 2 items (steps 0 and 1)
    const page2 = await client.sessionHistoryPage(session.agentSessionId, {
      limit: 2,
      cursor: page1.nextCursor!
    })
    expect(page2.items).toHaveLength(2)
    expect(page2.items[0]!.contentParts).toEqual([
      { kind: 'text', text: 'Complete full prompt 0' }
    ])
    expect(page2.items[1]!.contentParts).toEqual([
      { kind: 'text', text: 'Complete full response 1' }
    ])
    expect(page2.nextCursor).toBeNull()
  })

  it('mixed-page-continuation: correctly isolates outer cursor so page 2 can open transcript_full.jsonl when page 1 had untruncated steps', async () => {
    // Owner Finding 2: When page 1 contains only untruncated records, fullReader is not invoked and
    // no full continuation is produced. On page 2, which requires full records, fullContext must explicitly
    // strip the outer compact cursor so that NativeJsonlHistoryReader opens transcript_full.jsonl cleanly
    // without throwing SOURCE_CHANGED.
    const compactRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:30:00.000Z',
        content: '<USER_REQUEST>Truncated prompt 0...</USER_REQUEST>',
        truncated_fields: ['content']
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:30:05.000Z',
        content: 'Truncated response 1...',
        truncated_fields: ['content']
      },
      {
        step_index: 2,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:30:10.000Z',
        content: '<USER_REQUEST>Complete prompt 2 without truncation</USER_REQUEST>'
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:30:15.000Z',
        content: 'Complete response 3 without truncation'
      }
    ]

    const fullRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:30:00.000Z',
        content: '<USER_REQUEST>Full expanded prompt 0</USER_REQUEST>'
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:30:05.000Z',
        content: 'Full expanded response 1'
      },
      {
        step_index: 2,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:30:10.000Z',
        content: '<USER_REQUEST>Complete prompt 2 without truncation</USER_REQUEST>'
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:30:15.000Z',
        content: 'Complete response 3 without truncation'
      }
    ]

    const { client, transcriptPath, session } = await createHarness(compactRecords)
    const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl')
    await writeTranscriptFile(fullPath, fullRecords)

    // Page 1: newest 2 items (steps 2 and 3, both untruncated)
    const page1 = await client.sessionHistoryPage(session.agentSessionId, { limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.items[0]!.contentParts).toEqual([
      { kind: 'text', text: 'Complete prompt 2 without truncation' }
    ])
    expect(page1.items[1]!.contentParts).toEqual([
      { kind: 'text', text: 'Complete response 3 without truncation' }
    ])
    expect(page1.nextCursor).not.toBeNull()

    // Page 2: older 2 items (steps 0 and 1, both truncated) - outer compact cursor MUST NOT leak into fullReader
    const page2 = await client.sessionHistoryPage(session.agentSessionId, {
      limit: 2,
      cursor: page1.nextCursor!
    })
    expect(page2.items).toHaveLength(2)
    expect(page2.items[0]!.contentParts).toEqual([
      { kind: 'text', text: 'Full expanded prompt 0' }
    ])
    expect(page2.items[1]!.contentParts).toEqual([
      { kind: 'text', text: 'Full expanded response 1' }
    ])
    expect(page2.nextCursor).toBeNull()
  })

  it('preserves earlier snapshot and allows normal EOF appends between page requests without false SOURCE_CHANGED or leaking new records', async () => {
    // Defect 2: Active native sessions receive EOF appends between user page requests.
    // Strict mtime equality must not reject healthy active appends.
    // Paging older pages must read from earlier snapshot, neither failing nor leaking newly appended steps.
    const compactRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:35:00.000Z',
        content: '<USER_REQUEST>Prompt 0 truncated...</USER_REQUEST>',
        truncated_fields: ['content']
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:35:05.000Z',
        content: 'Response 1 truncated...',
        truncated_fields: ['content']
      },
      {
        step_index: 2,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:35:10.000Z',
        content: '<USER_REQUEST>Prompt 2 truncated...</USER_REQUEST>',
        truncated_fields: ['content']
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:35:15.000Z',
        content: 'Response 3 truncated...',
        truncated_fields: ['content']
      }
    ]

    const fullRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:35:00.000Z',
        content: '<USER_REQUEST>Complete full prompt 0</USER_REQUEST>'
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:35:05.000Z',
        content: 'Complete full response 1'
      },
      {
        step_index: 2,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:35:10.000Z',
        content: '<USER_REQUEST>Complete full prompt 2</USER_REQUEST>'
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:35:15.000Z',
        content: 'Complete full response 3'
      }
    ]

    const { client, transcriptPath, session } = await createHarness(compactRecords)
    const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl')
    await writeTranscriptFile(fullPath, fullRecords)

    // Page 1: newest 2 items (steps 2 and 3)
    const page1 = await client.sessionHistoryPage(session.agentSessionId, { limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).not.toBeNull()

    // Simulate active session receiving new turn (steps 4 and 5) appended to both files
    const newCompactAppend = [
      {
        step_index: 4,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:36:00.000Z',
        content: '<USER_REQUEST>New prompt 4</USER_REQUEST>'
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:36:05.000Z',
        content: 'New response 5'
      }
    ]
    const newFullAppend = [
      {
        step_index: 4,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T13:36:00.000Z',
        content: '<USER_REQUEST>Complete new prompt 4</USER_REQUEST>'
      },
      {
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T13:36:05.000Z',
        content: 'Complete new response 5'
      }
    ]

    const compactHandle = await open(transcriptPath, 'a')
    await compactHandle.writeFile(jsonLines(newCompactAppend), 'utf8')
    await compactHandle.close()

    const fullHandle = await open(fullPath, 'a')
    await fullHandle.writeFile(jsonLines(newFullAppend), 'utf8')
    await fullHandle.close()

    // Page 2: must continue from earlier snapshot without false SOURCE_CHANGED
    const page2 = await client.sessionHistoryPage(session.agentSessionId, {
      limit: 2,
      cursor: page1.nextCursor!
    })

    // Exactly steps 0 and 1, no newly appended step 4/5 leaking into older pages!
    expect(page2.items).toHaveLength(2)
    expect(page2.items[0]!.id).toBe(`${NATIVE_CONVERSATION_ID}:0`)
    expect(page2.items[0]!.contentParts).toEqual([
      { kind: 'text', text: 'Complete full prompt 0' }
    ])
    expect(page2.items[1]!.id).toBe(`${NATIVE_CONVERSATION_ID}:1`)
    expect(page2.items[1]!.contentParts).toEqual([
      { kind: 'text', text: 'Complete full response 1' }
    ])
    expect(page2.nextCursor).toBeNull()
  })

  it('recovers truncated row after >=4MiB unrelated full prefix by reading backwards without scanning entire prefix', async () => {
    const compactRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T14:00:00.000Z',
        content: '<USER_REQUEST>Initial prompt</USER_REQUEST>'
      },
      {
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T14:00:05.000Z',
        content: 'Compact prefix...',
        truncated_fields: ['content']
      }
    ]

    const { client, transcriptPath, session } = await createHarness(compactRecords)
    const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl')

    // Create >= 4.5 MiB of unrelated prefix lines for older steps
    const largeDummyLine = JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'A'.repeat(64 * 1024)
    }) + '\n'
    const repeatCount = 75 // 75 * 64KB ≈ 4.8 MiB
    let largeContent = largeDummyLine.repeat(repeatCount)
    // Sibling full row for step 1 is placed at the end
    largeContent += JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Full response recovered immediately from reverse cut'
    }) + '\n'

    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, largeContent, 'utf8')

    const page = await client.sessionHistoryPage(session.agentSessionId)
    expect(page.items).toHaveLength(2)
    expect(page.items[1]!.contentParts).toEqual([
      { kind: 'text', text: 'Full response recovered immediately from reverse cut' }
    ])
  })

  it('properly decodes multi-byte UTF-8 split across read block boundaries without corruption', async () => {
    const compactRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T15:00:00.000Z',
        content: '<USER_REQUEST>Multi-byte test</USER_REQUEST>',
        truncated_fields: ['content']
      }
    ]

    const { client, transcriptPath, session } = await createHarness(compactRecords)
    const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl')

    // Create a long line containing 3-byte and 4-byte UTF-8 characters that crosses 64KB
    const prefixPadding = 'P'.repeat(65530)
    const multiByteString = '【中文测试】🚀🌟'
    const fullRecord = {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: `<USER_REQUEST>${prefixPadding}${multiByteString}</USER_REQUEST>`
    }

    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, JSON.stringify(fullRecord) + '\n', 'utf8')

    const page = await client.sessionHistoryPage(session.agentSessionId)
    expect(page.items).toHaveLength(1)
    const textPart = page.items[0]!.contentParts[0]!
    expect(textPart.kind).toBe('text')
    if (textPart.kind === 'text') {
      expect(textPart.text).toContain(multiByteString)
    }
  })

  it('rejects next cursor when sibling transcript_full.jsonl is replaced or rewritten with same inode', async () => {
    const compactRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T16:00:00.000Z',
        content: '<USER_REQUEST>Step 0</USER_REQUEST>',
        truncated_fields: ['content']
      },
      {
        step_index: 1,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T16:01:00.000Z',
        content: '<USER_REQUEST>Step 1</USER_REQUEST>',
        truncated_fields: ['content']
      }
    ]

    const fullRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        content: '<USER_REQUEST>Full Step 0</USER_REQUEST>'
      },
      {
        step_index: 1,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        content: '<USER_REQUEST>Full Step 1</USER_REQUEST>'
      }
    ]

    const { client, transcriptPath, session } = await createHarness(compactRecords)
    const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl')
    await writeTranscriptFile(fullPath, fullRecords)

    const firstPage = await client.sessionHistoryPage(session.agentSessionId, { limit: 1 })
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.nextCursor).not.toBeNull()

    // Same-inode rewrite: open with 'r+', truncate and write altered contents keeping same inode
    const handle = await open(fullPath, 'r+')
    await handle.truncate(0)
    await handle.writeFile(JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>TAMPERED Step 0</USER_REQUEST>'
    }) + '\n', 'utf8')
    await handle.close()

    // Next cursor must detect file rewrite and reject with AGENT_SESSION_HISTORY_SOURCE_CHANGED
    await expect(
      client.sessionHistoryPage(session.agentSessionId, {
        limit: 1,
        cursor: firstPage.nextCursor!
      })
    ).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
    })
  })

  it('propagates cancellation immediately without swallowing abort signal in full log resolution', async () => {
    const compactRecords = [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-07-15T17:00:00.000Z',
        content: '<USER_REQUEST>Cancel test</USER_REQUEST>',
        truncated_fields: ['content']
      }
    ]

    const { transcriptPath, root } = await createHarness(compactRecords)
    const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl')
    await writeTranscriptFile(fullPath, [
      {
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        content: '<USER_REQUEST>Full cancel test</USER_REQUEST>'
      }
    ])

    const controller = new AbortController()
    controller.abort(new Error('abort during history resolution'))

    await expect(
      readAntigravitySessionHistoryPage({
        source: { providerId: 'antigravity', nativeSessionId: NATIVE_CONVERSATION_ID },
        transcriptPath,
        command: 'agy',
        args: [],
        env: {},
        workspacePath: root,
        limit: 10,
        signal: controller.signal
      })
    ).rejects.toThrow('abort during history resolution')
  })

  it('distinguishes budget exhaustion from truly absent full content with a visible honest limitation notice', async () => {
    const compactRecords = [
      {
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-07-15T18:00:00.000Z',
        content: 'Budget compact prefix...',
        truncated_fields: ['content']
      }
    ]

    const { client, transcriptPath, session } = await createHarness(compactRecords)
    const fullPath = join(dirname(transcriptPath), 'transcript_full.jsonl')

    // Write full record for step 0 at the very start, followed by >4.5 MiB of unrelated steps
    let fullContent = JSON.stringify({
      step_index: 0,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Buried full content that cannot be reached within 4MiB backwards read'
    }) + '\n'

    const paddingLine = JSON.stringify({
      step_index: 99,
      source: 'SYSTEM',
      type: 'CHECKPOINT',
      content: 'X'.repeat(64 * 1024)
    }) + '\n'
    fullContent += paddingLine.repeat(75) // ~4.8 MiB between step 0 and EOF

    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, fullContent, 'utf8')

    const page = await client.sessionHistoryPage(session.agentSessionId)
    expect(page.items).toHaveLength(1)
    const parts = page.items[0]!.contentParts
    // Must distinguish budget exhaustion honestly
    expect(
      parts.some((p) => p.kind === 'text' && p.text.includes('[Antigravity full transcript budget exceeded: omitted fields content]'))
    ).toBe(true)
  })

  it('paginates without gaps or duplicates across cursors', async () => {
    const { client, session } = await createHarness()
    const firstPage = await client.sessionHistoryPage(session.agentSessionId, { limit: 3 })
    expect(firstPage.items).toHaveLength(3)
    expect(firstPage.nextCursor).not.toBeNull()
    expect(firstPage.items.map((item) => item.id)).toEqual([
      `${NATIVE_CONVERSATION_ID}:3`,
      `${NATIVE_CONVERSATION_ID}:4`,
      `${NATIVE_CONVERSATION_ID}:5`
    ])

    const secondPage = await client.sessionHistoryPage(session.agentSessionId, {
      limit: 3,
      cursor: firstPage.nextCursor!
    })
    expect(secondPage.items).toHaveLength(3)
    expect(secondPage.nextCursor).toBeNull()
    expect(secondPage.items.map((item) => item.id)).toEqual([
      `${NATIVE_CONVERSATION_ID}:0`,
      `${NATIVE_CONVERSATION_ID}:1`,
      `${NATIVE_CONVERSATION_ID}:2`
    ])

    const allIds = [...secondPage.items, ...firstPage.items].map((i) => i.id)
    expect(allIds).toEqual([
      `${NATIVE_CONVERSATION_ID}:0`,
      `${NATIVE_CONVERSATION_ID}:1`,
      `${NATIVE_CONVERSATION_ID}:2`,
      `${NATIVE_CONVERSATION_ID}:3`,
      `${NATIVE_CONVERSATION_ID}:4`,
      `${NATIVE_CONVERSATION_ID}:5`
    ])
  })

  it('handles partial unclosed tail line by safely ignoring incomplete final write', async () => {
    const { client, session } = await createHarness(SAMPLE_RECORDS, undefined, true)
    const page = await client.sessionHistoryPage(session.agentSessionId)
    expect(page.items).toHaveLength(6)
    expect(page.items[5]?.id).toBe(`${NATIVE_CONVERSATION_ID}:5`)
  })

  it('rejects when transcript path belongs to another conversation ID', async () => {
    const foreignId = 'ffffffff-0000-4000-8000-000000000000'
    const root = await mkdtemp(join(tmpdir(), 'agentmux-antigravity-wrong-'))
    roots.push(root)
    const foreignPath = join(
      root,
      '.gemini',
      'antigravity-cli',
      'brain',
      foreignId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    )
    const { client, session } = await createHarness(SAMPLE_RECORDS, foreignPath)

    await expect(client.sessionHistoryPage(session.agentSessionId)).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
    })
  })

  it('rejects when durable transcript locator is missing without guessing filesystem paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-antigravity-nopath-'))
    roots.push(root)
    const storePath = join(root, 'sessions.json')
    const store = new AgentMuxFileAgentSessionStore(storePath)
    const session: AgentMuxStoredAgentSession = {
      kind: 'agent',
      agentSessionId: 'antigravity-agent-session-nopath',
      providerId: 'antigravity',
      executorId: 'antigravity',
      hostId: 'local',
      workspacePath: root,
      run: { runId: 'healthy-run-antigravity' },
      retiredRuns: [],
      createdAt: 1000,
      updatedAt: 1000,
      hookBindingId: 'binding-1',
      hookToken: 'token-1',
      nativeHandle: {
        kind: 'provider',
        providerId: 'antigravity',
        sessionId: NATIVE_CONVERSATION_ID
      }
    }
    await store.compareAndSwap(null, session)
    const providers = new AgentProviderRegistry()
    const client = new AgentMuxClient({ store, providers: [providers.get('antigravity')] })
    clients.push(client)

    await expect(client.sessionHistoryPage(session.agentSessionId)).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE'
    })
  })

  it('recovers and reads history in a fresh Client from the durable store after restart', async () => {
    const { storePath, session } = await createHarness()

    const reopenedStore = new AgentMuxFileAgentSessionStore(storePath)
    const reopenedProviders = new AgentProviderRegistry()
    const freshClient = new AgentMuxClient({
      store: reopenedStore,
      providers: [reopenedProviders.get('antigravity')]
    })
    clients.push(freshClient)

    const page = await freshClient.sessionHistoryPage(session.agentSessionId)
    expect(page.items).toHaveLength(6)
    expect(page.items[0]?.kind).toBe('user-message')
    expect(page.items[5]?.kind).toBe('assistant-message')
  })

  it('properly closes file descriptors allowing immediate directory cleanup', async () => {
    const { client, session, root } = await createHarness()
    const page = await client.sessionHistoryPage(session.agentSessionId)
    expect(page.items).toHaveLength(6)

    await client.dispose()
    await rm(root, { recursive: true, force: true })
    await expect(readFile(join(root, 'sessions.json'))).rejects.toThrow()
  })

  it('aborts cleanly when reader client is disposed during operation', async () => {
    const { client, session } = await createHarness()
    const promise = client.sessionHistoryPage(session.agentSessionId)
    await client.dispose()
    await expect(promise).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_CANCELLED'
    })
  })
})
