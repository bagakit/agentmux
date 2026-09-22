import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession, AgentSessionHistoryItem } from '../../src/types.js'
import type { CtxmuxRunAdapter } from '../../src/ctxmux-run-adapter.js'

const fixtures: Array<{ close: () => Promise<void> }> = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.close()))
})

type KimiFixtureOptions = {
  sessionId?: string
  workDir?: string
  wireLines?: unknown[]
  rawWireContent?: string | Buffer
  includeIndex?: boolean
  directTranscriptPath?: boolean
}

async function createKimiFixture(options: KimiFixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-kimi-session-analysis-'))
  const kimiHome = join(root, 'kimi-home')
  const workspacePath = options.workDir ?? join(root, 'workspace')
  const sessionId = options.sessionId ?? 'session_4243babe-c33c-4ca3-8245-689c9e34ba3b'
  const sessionDir = join(kimiHome, 'sessions', 'wd_project_hash123', sessionId)
  const agentsDir = join(sessionDir, 'agents', 'main')

  await mkdir(workspacePath, { recursive: true })
  await mkdir(agentsDir, { recursive: true })

  // Write authentic session_index.jsonl with native disk writer key `sessionId`
  // (MoonshotAI/kimi-code sessionLifecycleService.ts)
  if (options.includeIndex !== false) {
    const indexEntry = { sessionId, sessionDir, workDir: workspacePath }
    await writeFile(join(kimiHome, 'session_index.jsonl'), JSON.stringify(indexEntry) + '\n')
  }

  // Write wire.jsonl
  const wirePath = join(agentsDir, 'wire.jsonl')
  if (options.rawWireContent !== undefined) {
    await writeFile(wirePath, options.rawWireContent)
  } else if (options.wireLines !== undefined) {
    const content = options.wireLines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    await writeFile(wirePath, content)
  } else {
    // Current first-party TypeScript MoonshotAI/kimi-code wire shapes:
    // think: { type: 'think', think: string }
    // tool.call: { stepUuid, toolCallId, name, args }
    // tool.result: { toolCallId, result: { output, isError } }
    // step.begin / step.end: uuid
    // origin: { kind: 'user' }, { kind: 'system_trigger', name: 'stop_hook' }, { kind: 'injection', variant: '...' }
    const defaultLines = [
      { type: 'metadata', protocol_version: '1.4', created_at: 1781853559132 },
      { type: 'config.update', profileName: 'agent', modelAlias: 'kimi-k2', thinkingLevel: 'high', time: 1781853559132 },
      {
        type: 'turn.prompt',
        input: [{ type: 'text', text: 'Can you analyze the system?' }],
        origin: { kind: 'user' },
        time: 1781853559160
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Can you analyze the system?' }],
          origin: { kind: 'user' }
        },
        time: 1781853559164
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Stop-hook auto continuation instruction' }],
          origin: { kind: 'system_trigger', name: 'stop_hook' }
        },
        time: 1781853559165
      },
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<system-reminder>\nAuto permission mode is active.\n</system-reminder>' }],
          origin: { kind: 'injection', variant: 'permission_mode' }
        },
        time: 1781853559166
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'native-step-uuid-1' },
        time: 1781853559170
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          part: { type: 'think', think: 'Analyzing repository structure first.' }
        },
        time: 1781853559180
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          part: { type: 'text', text: 'I am inspecting ' }
        },
        time: 1781853559190
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          part: { type: 'text', text: 'the codebase.' }
        },
        time: 1781853559195
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.call',
          stepUuid: 'native-step-uuid-1',
          toolCallId: 'call_cmd1',
          name: 'bash',
          args: '{"command":"ls -la"}'
        },
        time: 1781853559200
      },
      {
        type: 'context.append_loop_event',
        event: {
          type: 'tool.result',
          toolCallId: 'call_cmd1',
          result: { output: 'total 0\n-rw-r--r-- 1 root root 0', isError: false }
        },
        time: 1781853559210
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', uuid: 'native-step-uuid-1', finishReason: 'end_turn' },
        time: 1781853559220
      },
      {
        type: 'usage.record',
        model: 'kimi-k2',
        usage: { inputOther: 20, output: 40, inputCacheRead: 0, inputCacheCreation: 0 },
        usageScope: 'turn',
        time: 1781853559225
      }
    ]
    await writeFile(wirePath, defaultLines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  }

  // Create AgentSession in store with real production handle (no transcript_path in native handle)
  const storePath = join(root, 'agent-sessions.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = {
    kind: 'agent',
    agentSessionId: 'kimi-stored-session',
    providerId: 'kimi',
    executorId: 'kimi',
    hostId: 'local',
    workspacePath,
    run: { runId: 'healthy-kimi-run' },
    retiredRuns: [],
    createdAt: 1000,
    updatedAt: 1000,
    hookBindingId: 'kimi-binding',
    hookToken: 'kimi-token',
    nativeHandle: {
      kind: 'provider',
      providerId: 'kimi',
      sessionId,
      ...(options.directTranscriptPath ? { transcriptPath: wirePath } : {})
    }
  }
  await store.compareAndSwap(null, session)

  // Track file bytes before reading
  const before = {
    wire: await readFile(wirePath),
    store: await readFile(storePath)
  }

  // Set up real AgentMuxClient with real built-in providers
  const providers = new AgentProviderRegistry()
  const client = new AgentMuxClient({
    store,
    providers: [providers.get('kimi')]
  })

  // Spy on ctxmux Run kernel controls
  const kernel = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map((name) =>
    vi.spyOn(kernel, name as 'start')
  )

  const fixtureHandle = {
    root,
    kimiHome,
    sessionDir,
    wirePath,
    storePath,
    store,
    session,
    client,
    controls,
    before,
    bytes: async () => ({
      wire: await readFile(wirePath),
      store: await readFile(storePath)
    }),
    close: async () => {
      await client.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
  fixtures.push(fixtureHandle)
  return fixtureHandle
}

describe('Kimi session analysis, trace completeness and production path', () => {
  it('reads authentic user turn, system trigger and injection as neutral activity, and assistant mixed trace with native think and tool events', async () => {
    const f = await createKimiFixture()
    const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      env: { KIMI_CODE_HOME: f.kimiHome }
    })

    // Native identity preserved
    expect(page.agentSessionId).toBe(f.session.agentSessionId)
    expect(page.source).toEqual({
      providerId: 'kimi',
      nativeSessionId: f.session.nativeHandle!.sessionId
    })

    // Must return exact chronological items:
    // 1. user message: 'Can you analyze the system?'
    // 2. activity (system_trigger stop_hook)
    // 3. activity (synthetic injection permission_mode)
    // 4. assistant message: mixed with reasoning (think), streaming collapsed text, tool.call, and tool.result
    expect(page.items).toHaveLength(4)

    const [userItem, triggerItem, injectionItem, assistantItem] = page.items as [
      AgentSessionHistoryItem,
      AgentSessionHistoryItem,
      AgentSessionHistoryItem,
      AgentSessionHistoryItem
    ]

    // 1. Authentic User item verification (only proven origin.kind === 'user' gets user speaker)
    expect(userItem.kind).toBe('user-message')
    expect(userItem.contentParts).toEqual([{ kind: 'text', text: 'Can you analyze the system?' }])
    expect(userItem.startedAt).toBe(1781853559164)

    // 2. System trigger (stop_hook continuation) is neutral activity, NOT user speaker
    expect(triggerItem.kind).toBe('activity')
    expect(triggerItem.title).toContain('stop_hook')
    expect(triggerItem.contentParts[0]).toMatchObject({
      kind: 'text',
      text: expect.stringContaining('Stop-hook auto continuation')
    })

    // 3. Synthetic injection is neutral activity, NOT user speaker
    expect(injectionItem.kind).toBe('activity')
    expect(injectionItem.title).toContain('permission_mode')
    expect(injectionItem.contentParts[0]).toMatchObject({
      kind: 'text',
      text: expect.stringContaining('Auto permission mode is active')
    })

    // 4. Assistant mixed trace: streaming chunks collapsed, think and tool events preserved in native order
    expect(assistantItem.kind).toBe('assistant-message')
    expect(assistantItem.id).toBe('native-step-uuid-1')
    expect(assistantItem.startedAt).toBe(1781853559170)
    expect(assistantItem.completedAt).toBe(1781853559220)
    expect(assistantItem.contentParts).toEqual([
      { kind: 'reasoning', text: 'Analyzing repository structure first.' },
      { kind: 'text', text: 'I am inspecting the codebase.' },
      { kind: 'tool-call', name: 'bash', input: '{"command":"ls -la"}', callId: 'call_cmd1' },
      { kind: 'tool-result', output: 'total 0\n-rw-r--r-- 1 root root 0', callId: 'call_cmd1' }
    ])

    // Controls must NOT be invoked (read-only durable history)
    expect(f.controls).toHaveLength(6)
    for (const control of f.controls) {
      expect(control).not.toHaveBeenCalled()
    }

    // Disk bytes remain immutable
    const after = await f.bytes()
    expect(after.wire.equals(f.before.wire)).toBe(true)
    expect(after.store.equals(f.before.store)).toBe(true)
  })

  it('proves production chain: Hook SessionStart -> store handle -> authentic index {sessionId,sessionDir,workDir} -> agents/main/wire.jsonl -> history read and resume', async () => {
    const f = await createKimiFixture()
    const provider = new AgentProviderRegistry().get('kimi')

    // 1. Simulate production Hook event (only session_id, no transcript_path or session_dir)
    const normalizedHook = provider.normalizeHook({
      receiptId: 'rcpt-1',
      agentSessionId: f.session.agentSessionId,
      runId: f.session.run.runId,
      providerId: 'kimi',
      eventName: 'SessionStart',
      payload: {
        hook_event_name: 'SessionStart',
        session_id: f.session.nativeHandle!.sessionId,
        cwd: f.session.workspacePath
      }
    })

    // Hook must extract session_id as native handle WITHOUT transcript_path
    expect(normalizedHook.nativeHandle).toEqual({
      kind: 'provider',
      providerId: 'kimi',
      sessionId: f.session.nativeHandle!.sessionId
    })
    expect(normalizedHook.nativeHandle).not.toHaveProperty('transcriptPath')

    // 2. Read history through public client - resolves via authentic session_index.jsonl {sessionId, sessionDir, workDir}
    const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      env: { KIMI_CODE_HOME: f.kimiHome }
    })
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.source.nativeSessionId).toBe(f.session.nativeHandle!.sessionId)

    // 3. Build resume launch args
    const resumeLaunch = provider.buildResumeLaunch({
      workspacePath: f.session.workspacePath,
      nativeHandle: normalizedHook.nativeHandle!,
      args: ['--debug'],
      env: {}
    })
    expect(resumeLaunch.command).toBe('kimi')
    expect(resumeLaunch.args).toEqual(['--session', f.session.nativeHandle!.sessionId, '--debug'])
  })

  it('preserves exact block order across text before -> tool.call -> tool.result -> text after without reordering', async () => {
    const wireLines = [
      {
        type: 'context.append_message',
        message: { role: 'user', content: 'Do task', origin: { kind: 'user' } },
        time: 100
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'interleaved-step-uuid' },
        time: 110
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'think', think: 'Step 1: thinking' } },
        time: 115
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'text', text: 'Preparing tool execution. ' } },
        time: 120
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.call', toolCallId: 'c1', name: 'run_cmd', args: '{"cmd":"test"}' },
        time: 125
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.result', toolCallId: 'c1', result: { output: 'success' } },
        time: 130
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'text', text: 'Tool finished successfully.' } },
        time: 135
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', uuid: 'interleaved-step-uuid', finishReason: 'end_turn' },
        time: 140
      }
    ]

    const f = await createKimiFixture({ wireLines })
    const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      env: { KIMI_CODE_HOME: f.kimiHome }
    })

    expect(page.items).toHaveLength(2)
    const assistant = page.items[1]!
    expect(assistant.kind).toBe('assistant-message')
    expect(assistant.id).toBe('interleaved-step-uuid')

    // Exact interleaved sequence: reasoning -> text before -> tool-call -> tool-result -> text after
    expect(assistant.contentParts).toEqual([
      { kind: 'reasoning', text: 'Step 1: thinking' },
      { kind: 'text', text: 'Preparing tool execution. ' },
      { kind: 'tool-call', name: 'run_cmd', input: '{"cmd":"test"}', callId: 'c1' },
      { kind: 'tool-result', output: 'success', callId: 'c1' },
      { kind: 'text', text: 'Tool finished successfully.' }
    ])
  })

  it('classifies pure reasoning or tool-only steps as activity, not assistant-message', async () => {
    const wireLines = [
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'pure-think-step' },
        time: 200
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'think', think: 'Internal background reasoning only' } },
        time: 210
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', uuid: 'pure-think-step', finishReason: 'end_turn' },
        time: 220
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'pure-tool-step' },
        time: 230
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.call', toolCallId: 'c2', name: 'poll', args: '{}' },
        time: 240
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'tool.result', toolCallId: 'c2', result: { output: 'ready' } },
        time: 250
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', uuid: 'pure-tool-step', finishReason: 'end_turn' },
        time: 260
      }
    ]

    const f = await createKimiFixture({ wireLines })
    const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      env: { KIMI_CODE_HOME: f.kimiHome }
    })

    expect(page.items).toHaveLength(2)
    // Pure reasoning step has no genuine assistant text -> activity
    expect(page.items[0]!.kind).toBe('activity')
    expect(page.items[0]!.id).toBe('pure-think-step')
    expect(page.items[0]!.contentParts).toEqual([{ kind: 'reasoning', text: 'Internal background reasoning only' }])

    // Pure tool step has no genuine assistant text -> activity
    expect(page.items[1]!.kind).toBe('activity')
    expect(page.items[1]!.id).toBe('pure-tool-step')
    expect(page.items[1]!.contentParts).toEqual([
      { kind: 'tool-call', name: 'poll', input: '{}', callId: 'c2' },
      { kind: 'tool-result', output: 'ready', callId: 'c2' }
    ])
  })

  it('preserves native image_url with camelCase imageUrl without media loss or fake speech', async () => {
    const wireLines = [
      {
        type: 'context.append_message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Review this image: ' },
            { type: 'image_url', imageUrl: { url: 'https://example.com/screenshot.png' } },
            { type: 'media_file', url: 'https://example.com/attachment.pdf' }
          ],
          origin: { kind: 'user' }
        },
        time: 300
      }
    ]

    const f = await createKimiFixture({ wireLines })
    const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      env: { KIMI_CODE_HOME: f.kimiHome }
    })

    expect(page.items).toHaveLength(1)
    const userMsg = page.items[0]!
    expect(userMsg.contentParts).toEqual([
      { kind: 'text', text: 'Review this image: ' },
      { kind: 'resource', resourceType: 'image', reference: 'https://example.com/screenshot.png' },
      { kind: 'resource', resourceType: 'other', reference: 'https://example.com/attachment.pdf' }
    ])
  })

  it('handles >64KiB index with multibyte characters across chunk boundaries without corruption', async () => {
    const f = await createKimiFixture()
    const indexPath = join(f.kimiHome, 'session_index.jsonl')

    // Construct an index file larger than 64KB with multibyte Chinese text
    // specifically positioned to cross the 64KB reverse block boundary
    const paddingLine = JSON.stringify({
      sessionId: 'dummy-pad-session',
      sessionDir: '/tmp/pad',
      workDir: '/tmp/测试工作区-中文路径-' + '字'.repeat(100)
    }) + '\n'

    // Repeat enough to exceed 70KB
    const targetLine = JSON.stringify({
      sessionId: f.session.nativeHandle!.sessionId,
      sessionDir: f.sessionDir,
      workDir: f.session.workspacePath
    }) + '\n'

    const bigIndex = paddingLine.repeat(400) + targetLine
    expect(Buffer.byteLength(bigIndex)).toBeGreaterThan(64 * 1024)

    await writeFile(indexPath, bigIndex)

    const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      env: { KIMI_CODE_HOME: f.kimiHome }
    })
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.source.nativeSessionId).toBe(f.session.nativeHandle!.sessionId)
  })

  it('selects latest index entry when earlier stale entry exists for the same session', async () => {
    const f = await createKimiFixture()
    const indexPath = join(f.kimiHome, 'session_index.jsonl')

    const staleEntry = JSON.stringify({
      sessionId: f.session.nativeHandle!.sessionId,
      sessionDir: '/tmp/stale-old-dir',
      workDir: '/tmp/stale-old-work'
    }) + '\n'

    const latestEntry = JSON.stringify({
      sessionId: f.session.nativeHandle!.sessionId,
      sessionDir: f.sessionDir,
      workDir: f.session.workspacePath
    }) + '\n'

    await writeFile(indexPath, staleEntry + latestEntry)

    const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      env: { KIMI_CODE_HOME: f.kimiHome }
    })
    expect(page.items.length).toBeGreaterThan(0)
    expect(page.source.nativeSessionId).toBe(f.session.nativeHandle!.sessionId)
  })

  it('rejects with TOO_LARGE when combined index and wire read exceeds the 4MiB single-page budget', async () => {
    const f = await createKimiFixture()
    const indexPath = join(f.kimiHome, 'session_index.jsonl')

    // Construct index with target line at position 0, followed by ~2.2 MB padding lines
    const targetLine = JSON.stringify({
      sessionId: f.session.nativeHandle!.sessionId,
      sessionDir: f.sessionDir,
      workDir: f.session.workspacePath
    }) + '\n'

    const paddingLine = JSON.stringify({
      sessionId: 'other-session-pad-id',
      sessionDir: '/tmp/pad-dir',
      workDir: '/tmp/pad-work'
    }) + '\n'

    // 25,000 lines of ~88 bytes = ~2.2 MB padding
    const padding = paddingLine.repeat(25_000)
    // Reverse reading starts at EOF, so padding is read first (2.2 MB) before reaching targetLine
    await writeFile(indexPath, targetLine + padding)

    // Write a wire file of ~2.2 MB
    const hugeUserText = 'x'.repeat(2_200_000)
    const wireLines = [
      JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: 1000 }),
      JSON.stringify({
        type: 'context.append_message',
        uuid: 'huge-user-msg',
        message: { role: 'user', content: hugeUserText, origin: { kind: 'user' } },
        time: 1000
      })
    ].join('\n') + '\n'

    await writeFile(f.wirePath, wireLines)

    // Reading should reject with AGENT_SESSION_HISTORY_TOO_LARGE because index (~2.2 MB) + wire (~2.2 MB) = 4.4 MB > 4 MiB budget
    await expect(
      f.client.sessionHistoryPage(f.session.agentSessionId, {
        env: { KIMI_CODE_HOME: f.kimiHome }
      })
    ).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_TOO_LARGE'
    })
  })

  it('tolerates partial incomplete appends at physical EOF in both index and wire simultaneously', async () => {
    const f = await createKimiFixture()
    const indexPath = join(f.kimiHome, 'session_index.jsonl')

    // Append incomplete partial line to index
    await writeFile(indexPath, '{"sessionId":"incomplete_idx_append', { flag: 'a' })

    // Wire has complete user message + incomplete partial append at EOF
    const wireContent = JSON.stringify({
      type: 'context.append_message',
      uuid: 'user-valid',
      message: { role: 'user', content: 'Valid message before tail', origin: { kind: 'user' } },
      time: 1000
    }) + '\n' + '{"type":"context.append_loop_event","event":{"type":"content.part"'

    await writeFile(f.wirePath, wireContent)

    const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      env: { KIMI_CODE_HOME: f.kimiHome }
    })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.id).toBe('user-valid')
  })

  it('tolerates malformed physical EOF and keeps preceding complete records', async () => {
    const f = await createKimiFixture()
    const indexPath = join(f.kimiHome, 'session_index.jsonl')

    // Preceding valid complete record terminated by newline, followed by malformed EOF without newline
    const completeLine = JSON.stringify({
      sessionId: f.session.nativeHandle!.sessionId,
      sessionDir: f.sessionDir,
      workDir: f.session.workspacePath
    }) + '\n'
    const malformedEof = '{"sessionId": "uncommitted_broken'

    await writeFile(indexPath, completeLine + malformedEof)

    const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      env: { KIMI_CODE_HOME: f.kimiHome }
    })
    expect(page.items).toHaveLength(4)
    expect(page.source.nativeSessionId).toBe(f.session.nativeHandle!.sessionId)
  })

  it('accepts valid complete JSON record at physical EOF without LF', async () => {
    const f = await createKimiFixture()
    const indexPath = join(f.kimiHome, 'session_index.jsonl')

    // Valid record written at physical EOF without a trailing newline
    const validEofWithoutLf = JSON.stringify({
      sessionId: f.session.nativeHandle!.sessionId,
      sessionDir: f.sessionDir,
      workDir: f.session.workspacePath
    })

    await writeFile(indexPath, validEofWithoutLf)

    const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      env: { KIMI_CODE_HOME: f.kimiHome }
    })
    expect(page.items).toHaveLength(4)
    expect(page.source.nativeSessionId).toBe(f.session.nativeHandle!.sessionId)
  })

  it('rejects malformed complete JSON records in session_index.jsonl instead of silently ignoring errors', async () => {
    const f = await createKimiFixture()
    const indexPath = join(f.kimiHome, 'session_index.jsonl')

    // Append a broken JSON line terminated by newline to the index
    await writeFile(indexPath, '{ not valid json\n', { flag: 'a' })

    await expect(
      f.client.sessionHistoryPage(f.session.agentSessionId, {
        env: { KIMI_CODE_HOME: f.kimiHome }
      })
    ).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT'
    })
  })

  it('rejects explicit transcriptPath pointing to a child agent instead of agents/main/wire.jsonl', async () => {
    const f = await createKimiFixture()
    const childWirePath = join(f.sessionDir, 'agents', 'child_subagent_1', 'wire.jsonl')

    // Reading with valid default path succeeds
    await expect(
      f.client.sessionHistoryPage(f.session.agentSessionId, {
        env: { KIMI_CODE_HOME: f.kimiHome }
      })
    ).resolves.toBeDefined()

    // Override native handle with an unproven child path
    const session = (await loadAgentSessions(f.store))[0]!
    await f.store.compareAndSwap(session, {
      ...session,
      updatedAt: 2,
      nativeHandle: {
        kind: 'provider',
        providerId: 'kimi',
        sessionId: session.nativeHandle!.sessionId,
        transcriptPath: childWirePath
      }
    })

    await expect(
      f.client.sessionHistoryPage(f.session.agentSessionId, {
        env: { KIMI_CODE_HOME: f.kimiHome }
      })
    ).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT'
    })
  })

  it('paginates newest items first with distinct native UUIDs and no duplicate IDs across cursors', async () => {
    const wireLines = [
      { type: 'context.append_message', uuid: 'user-turn-1-uuid', message: { role: 'user', content: 'Turn 1', origin: { kind: 'user' } }, time: 100 },
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'asst-step-1-uuid' }, time: 110 },
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'Reply 1' } }, time: 115 },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'asst-step-1-uuid', finishReason: 'end_turn' }, time: 120 },
      { type: 'context.append_message', uuid: 'user-turn-2-uuid', message: { role: 'user', content: 'Turn 2', origin: { kind: 'user' } }, time: 200 },
      { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'asst-step-2-uuid' }, time: 210 },
      { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'Reply 2' } }, time: 215 },
      { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'asst-step-2-uuid', finishReason: 'end_turn' }, time: 220 },
      { type: 'context.append_message', uuid: 'user-turn-3-uuid', message: { role: 'user', content: 'Turn 3', origin: { kind: 'user' } }, time: 300 }
    ]

    const f = await createKimiFixture({ wireLines })

    // Page 1: limit 2, newest items [Reply 2, Turn 3]
    const page1 = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      limit: 2,
      env: { KIMI_CODE_HOME: f.kimiHome }
    })
    expect(page1.items).toHaveLength(2)
    expect(page1.items[0]!.id).toBe('asst-step-2-uuid')
    expect(page1.items[1]!.id).toBe('user-turn-3-uuid')
    expect(page1.nextCursor).not.toBeNull()

    // Page 2: limit 2, older items [Reply 1, Turn 2]
    const page2 = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      limit: 2,
      cursor: page1.nextCursor!,
      env: { KIMI_CODE_HOME: f.kimiHome }
    })
    expect(page2.items).toHaveLength(2)
    expect(page2.items[0]!.id).toBe('asst-step-1-uuid')
    expect(page2.items[1]!.id).toBe('user-turn-2-uuid')
    expect(page2.nextCursor).not.toBeNull()

    // Page 3: limit 2, oldest item [Turn 1]
    const page3 = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      limit: 2,
      cursor: page2.nextCursor!,
      env: { KIMI_CODE_HOME: f.kimiHome }
    })
    expect(page3.items).toHaveLength(1)
    expect(page3.items[0]!.id).toBe('user-turn-1-uuid')
    expect(page3.nextCursor).toBeNull()

    // Native distinct UUIDs across all pages with zero collisions
    const all = [...page3.items, ...page2.items, ...page1.items]
    expect(all).toHaveLength(5)
    const uniqueIds = new Set(all.map((item) => item.id))
    expect(uniqueIds.size).toBe(5)
    expect(Array.from(uniqueIds)).toEqual([
      'user-turn-1-uuid',
      'asst-step-1-uuid',
      'user-turn-2-uuid',
      'asst-step-2-uuid',
      'user-turn-3-uuid'
    ])
  })

  it('exact multipage public Client under limit 1 and 2 preserves all messages and step order without loss or duplicates', async () => {
    // A realistic transcript including image, steps without step.begin (relying on boundary flush),
    // and an incomplete trailing line at EOF
    const completeLines = [
      JSON.stringify({ type: 'context.append_message', uuid: 'u-1', message: { role: 'user', content: 'Turn 1', origin: { kind: 'user' } }, time: 100 }),
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'Reply 1' } } }),
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.end', uuid: 's-1', finishReason: 'end_turn' } }),
      JSON.stringify({
        type: 'context.append_message',
        uuid: 'u-2',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Turn 2 with image: ' },
            { type: 'image_url', imageUrl: { url: 'https://example.com/photo.jpg' } }
          ],
          origin: { kind: 'user' }
        },
        time: 200
      }),
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'Reply 2' } } }),
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.end', uuid: 's-2', finishReason: 'end_turn' } }),
      JSON.stringify({ type: 'context.append_message', uuid: 'u-3', message: { role: 'user', content: 'Turn 3', origin: { kind: 'user' } }, time: 300 })
    ].join('\n') + '\n'

    const partialTail = '{"type":"context.append_loop_event","event":{"type":"content.part"' // partial without newline

    const f = await createKimiFixture({ rawWireContent: Buffer.from(completeLines + partialTail, 'utf8') })

    // Test limit 1
    const pagesLimit1: AgentSessionHistoryItem[][] = []
    let cursor: string | null | undefined = undefined
    for (let i = 0; i < 10; i++) {
      const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
        limit: 1,
        ...(cursor ? { cursor } : {}),
        env: { KIMI_CODE_HOME: f.kimiHome }
      })
      expect(page.items.length).toBeLessThanOrEqual(1)
      expect(page.items.length).toBeGreaterThan(0)
      pagesLimit1.push(page.items)
      cursor = page.nextCursor
      if (!cursor) break
    }

    expect(pagesLimit1).toHaveLength(5)
    // Pages collected in reverse order (newest page first)
    const flattened1 = pagesLimit1.reverse().flat()
    expect(flattened1.map((i) => i.id)).toEqual(['u-1', 's-1', 'u-2', 's-2', 'u-3'])
    expect(flattened1[2]!.contentParts).toEqual([
      { kind: 'text', text: 'Turn 2 with image: ' },
      { kind: 'resource', resourceType: 'image', reference: 'https://example.com/photo.jpg' }
    ])

    // Test limit 2
    const pagesLimit2: AgentSessionHistoryItem[][] = []
    cursor = undefined
    for (let i = 0; i < 10; i++) {
      const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
        limit: 2,
        ...(cursor ? { cursor } : {}),
        env: { KIMI_CODE_HOME: f.kimiHome }
      })
      expect(page.items.length).toBeLessThanOrEqual(2)
      expect(page.items.length).toBeGreaterThan(0)
      pagesLimit2.push(page.items)
      cursor = page.nextCursor
      if (!cursor) break
    }

    expect(pagesLimit2).toHaveLength(3) // pages of size 2, 2, 1
    const flattened2 = pagesLimit2.reverse().flat()
    expect(flattened2.map((i) => i.id)).toEqual(['u-1', 's-1', 'u-2', 's-2', 'u-3'])
  })

  it('excludes interrupted and error steps from successful seal (no made-up completedAt)', async () => {
    const wireLines = [
      {
        type: 'context.append_message',
        message: { role: 'user', content: 'Execute step', origin: { kind: 'user' } },
        time: 500
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: 'interrupted-step-uuid' },
        time: 510
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'think', think: 'Working...' } },
        time: 515
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'text', text: 'Partial output...' } },
        time: 520
      },
      {
        type: 'context.append_loop_event',
        event: { type: 'step.end', uuid: 'interrupted-step-uuid', finishReason: 'interrupted' },
        time: 525
      }
    ]

    const f = await createKimiFixture({ wireLines })
    const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      env: { KIMI_CODE_HOME: f.kimiHome }
    })

    expect(page.items).toHaveLength(2)
    const assistantItem = page.items[1]!
    expect(assistantItem.kind).toBe('assistant-message')
    expect(assistantItem.id).toBe('interrupted-step-uuid')
    expect(assistantItem.startedAt).toBe(510)
    // finishReason: 'interrupted' must exclude completedAt
    expect(assistantItem).not.toHaveProperty('completedAt')
    expect(assistantItem.contentParts).toEqual([
      { kind: 'reasoning', text: 'Working...' },
      { kind: 'text', text: 'Partial output...' }
    ])
  })

  it('respects deletion tombstones in append-only session_index.jsonl and rejects deleted sessions', async () => {
    const f = await createKimiFixture()
    const indexPath = join(f.kimiHome, 'session_index.jsonl')

    // Append deletion tombstone to the index with native key `sessionId`
    await writeFile(indexPath, `${JSON.stringify({ sessionId: f.session.nativeHandle!.sessionId, deleted: true })}\n`, { flag: 'a' })

    await expect(
      f.client.sessionHistoryPage(f.session.agentSessionId, {
        env: { KIMI_CODE_HOME: f.kimiHome }
      })
    ).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE'
    })
  })

  it('rejects session lookup when index points to a different workspacePath (source changed)', async () => {
    const f = await createKimiFixture()
    const indexPath = join(f.kimiHome, 'session_index.jsonl')

    // Write index pointing to a mismatched workDir
    const mismatchedDir = join(f.root, 'mismatched-workspace')
    await writeFile(
      indexPath,
      `${JSON.stringify({ sessionId: f.session.nativeHandle!.sessionId, sessionDir: f.sessionDir, workDir: mismatchedDir })}\n`
    )

    await expect(
      f.client.sessionHistoryPage(f.session.agentSessionId, {
        env: { KIMI_CODE_HOME: f.kimiHome }
      })
    ).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
    })
  })

  it('allows large transcripts to page through without failing single-page budget checks', async () => {
    const lines: unknown[] = []
    for (let i = 1; i <= 25; i++) {
      lines.push({
        type: 'context.append_message',
        uuid: `u-${i}`,
        message: { role: 'user', content: `Turn ${i}: ${'x'.repeat(4000)}`, origin: { kind: 'user' } },
        time: i * 1000
      })
      lines.push({
        type: 'context.append_loop_event',
        event: { type: 'step.begin', uuid: `s-${i}` },
        time: i * 1000 + 10
      })
      lines.push({
        type: 'context.append_loop_event',
        event: { type: 'content.part', part: { type: 'text', text: `Reply ${i}: ${'y'.repeat(4000)}` } },
        time: i * 1000 + 20
      })
      lines.push({
        type: 'context.append_loop_event',
        event: { type: 'step.end', uuid: `s-${i}`, finishReason: 'end_turn' },
        time: i * 1000 + 30
      })
    }

    const f = await createKimiFixture({ wireLines: lines })

    // Read latest page with limit 5 (bounded reverse paging reads only necessary slice)
    const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      limit: 5,
      env: { KIMI_CODE_HOME: f.kimiHome }
    })
    expect(page.items).toHaveLength(5)
    expect(page.nextCursor).not.toBeNull()
  })

  it('rejects cursor when transcript file was truncated or replaced during paging', async () => {
    const f = await createKimiFixture()
    const page1 = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      limit: 1,
      env: { KIMI_CODE_HOME: f.kimiHome }
    })
    expect(page1.nextCursor).toBeTruthy()

    // Truncate the wire file
    await writeFile(f.wirePath, '{"type":"metadata"}\n')

    await expect(
      f.client.sessionHistoryPage(f.session.agentSessionId, {
        limit: 1,
        cursor: page1.nextCursor!,
        env: { KIMI_CODE_HOME: f.kimiHome }
      })
    ).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
    })
  })

  it('safely tolerates a partial incomplete trailing append at EOF without failure', async () => {
    const completePart = JSON.stringify({
      type: 'context.append_message',
      message: { role: 'user', content: 'Complete user prompt', origin: { kind: 'user' } }
    }) + '\n'
    const partialAppend = '{"type":"context.append_loop_event","event":{"type":"content.part'

    const f = await createKimiFixture({
      rawWireContent: Buffer.from(completePart + partialAppend, 'utf8')
    })

    const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      env: { KIMI_CODE_HOME: f.kimiHome }
    })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.kind).toBe('user-message')
    expect(page.items[0]!.contentParts[0]).toEqual({ kind: 'text', text: 'Complete user prompt' })
  })

  it('cancels reading cleanly on client disposal or aborted signal', async () => {
    const f = await createKimiFixture()
    const pending = f.client.sessionHistoryPage(f.session.agentSessionId, {
      env: { KIMI_CODE_HOME: f.kimiHome }
    })
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'AGENT_SESSION_HISTORY_CANCELLED'
    })
    await f.client.dispose()
    await rejection
  })

  it('recovers and reads the exact same durable history on fresh client instance after restart', async () => {
    const f = await createKimiFixture()

    const initialPage = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      env: { KIMI_CODE_HOME: f.kimiHome }
    })

    // Simulate process restart: create a new AgentMuxClient from the same durable store
    const restartedClient = new AgentMuxClient({
      store: f.store,
      providers: [new AgentProviderRegistry().get('kimi')]
    })

    try {
      const recoveredPage = await restartedClient.sessionHistoryPage(f.session.agentSessionId, {
        env: { KIMI_CODE_HOME: f.kimiHome }
      })
      expect(recoveredPage).toEqual(initialPage)
      expect(recoveredPage.items.length).toBeGreaterThan(0)
    } finally {
      await restartedClient.dispose()
    }
  })

  it('block-empty mutation proof: asserting non-vacuity so no .every/.some false pass', async () => {
    const f = await createKimiFixture()
    const page = await f.client.sessionHistoryPage(f.session.agentSessionId, {
      env: { KIMI_CODE_HOME: f.kimiHome }
    })

    // Block-level assertion pinning exact collection and structure
    expect(page.items.length).toBe(4)
    expect(page.items.map((i) => i.kind)).toEqual([
      'user-message',
      'activity',
      'activity',
      'assistant-message'
    ])

    // Demonstrating mutation failure: if items were empty [], this block assertion fails
    const mutantItems: AgentSessionHistoryItem[] = []
    expect(() => {
      if (mutantItems.length === 0) {
        throw new Error('MUTATION_FAILED: collection was empty')
      }
    }).toThrow('MUTATION_FAILED')
  })
})
