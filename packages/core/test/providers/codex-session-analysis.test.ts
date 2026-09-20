import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../../src/agent-session-store.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { CODEX_HOOK_EVENTS, CODEX_HOOKS, createCodexManagedHookPlan } from '../../src/providers/codex.js'
import type { AgentSessionHistoryPageOptions } from '../../src/types.js'

type ProtocolRequest = { id?: number; method: string; params?: Record<string, unknown> }
const nativeId = 'codex-native-session-uuid-001'

const turnEntries = [
  {
    turnId: 'turn-2',
    startedAtMs: 2000,
    completedAtMs: 2500,
    item: {
      type: 'agentMessage',
      id: 'asst-1',
      text: 'Repository inspection complete. README updated.'
    }
  },
  {
    turnId: 'turn-2',
    startedAtMs: 1800,
    completedAtMs: 1900,
    item: {
      type: 'mcpToolCall',
      id: 'mcp-1',
      server: 'github',
      tool: 'get_issue',
      arguments: { issue_number: 42 },
      result: { content: [{ type: 'text', text: 'Issue #42: Parity request' }] },
      status: 'completed'
    }
  },
  {
    turnId: 'turn-2',
    startedAtMs: 1600,
    completedAtMs: 1750,
    item: {
      type: 'fileChange',
      id: 'patch-1',
      changes: [
        {
          path: 'README.md',
          kind: { type: 'update' },
          diff: '@@ -1 +1 @@\n-old content\n+new content'
        }
      ],
      status: 'completed'
    }
  },
  {
    turnId: 'turn-2',
    startedAtMs: 1500,
    completedAtMs: null,
    item: {
      type: 'commandExecution',
      id: 'cmd-running',
      command: 'sleep 30',
      cwd: '/workspace',
      aggregatedOutput: null,
      exitCode: null,
      status: 'inProgress'
    }
  },
  {
    turnId: 'turn-2',
    startedAtMs: 1300,
    completedAtMs: 1400,
    item: {
      type: 'commandExecution',
      id: 'cmd-failed',
      command: 'cat nonexistent.txt',
      cwd: '/workspace',
      aggregatedOutput: 'cat: nonexistent.txt: No such file or directory',
      exitCode: 1,
      status: 'failed'
    }
  },
  {
    turnId: 'turn-2',
    startedAtMs: 1100,
    completedAtMs: 1250,
    item: {
      type: 'commandExecution',
      id: 'cmd-ok',
      command: 'git status',
      cwd: '/workspace',
      aggregatedOutput: 'On branch main\nnothing to commit',
      exitCode: 0,
      status: 'completed'
    }
  },
  {
    turnId: 'turn-2',
    startedAtMs: 1000,
    completedAtMs: 1080,
    item: {
      type: 'reasoning',
      id: 'rsn-1',
      summary: ['Checking git repository status'],
      content: ['Examining working tree and diffs']
    }
  },
  {
    turnId: 'turn-1',
    startedAtMs: 500,
    completedAtMs: 600,
    item: {
      type: 'userMessage',
      id: 'usr-1',
      content: [
        { type: 'text', text: 'Please check git status and update README' },
        { type: 'mention', name: 'README.md', path: '/workspace/README.md' }
      ]
    }
  }
]

const repairEntries = [
  {
    turnId: 'turn-repair',
    item: {
      type: 'fileChange',
      id: 'patch-prog-diff',
      changes: [{ path: 'src/index.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' }],
      status: 'inProgress'
    }
  },
  {
    turnId: 'turn-repair',
    item: {
      type: 'fileChange',
      id: 'patch-prog-nodiff',
      changes: [{ path: 'src/new.ts', kind: { type: 'add' } }],
      status: 'inProgress'
    }
  },
  {
    turnId: 'turn-repair',
    item: {
      type: 'fileChange',
      id: 'patch-unknown-status',
      changes: [{ path: 'src/unknown.ts', kind: { type: 'update' } }],
      status: 'someFutureNonTerminalStatus'
    }
  },
  {
    turnId: 'turn-repair',
    item: {
      type: 'mcpToolCall',
      id: 'mcp-struct',
      server: 'github',
      tool: 'list_runs',
      arguments: { limit: 1 },
      status: 'completed',
      result: {
        content: [{ type: 'text', text: 'Runs found' }],
        structuredContent: { runs: [{ id: 101, status: 'success' }] }
      }
    }
  },
  {
    turnId: 'turn-repair',
    item: {
      type: 'webSearch',
      id: 'ws-1',
      query: 'codex protocol',
      action: { type: 'findInPage', url: 'https://example.com', pattern: 'generate-ts' },
      results: [{ title: 'Doc', url: 'https://example.com' }]
    }
  },
  {
    turnId: 'turn-repair',
    item: {
      type: 'imageView',
      id: 'img-null',
      path: null
    }
  },
  {
    turnId: 'turn-repair',
    item: {
      type: 'customAgentActivity',
      id: 'custom-note-1',
      text: 'Internal agent note'
    }
  },
  {
    turnId: 'turn-repair',
    item: {
      type: 'dynamicToolCall',
      id: 'dyn-ordered',
      tool: 'multimedia_inspect',
      arguments: { target: 'assets' },
      status: 'completed',
      success: true,
      contentItems: [
        { type: 'inputText', text: 'Step 1: Found graphic banner' },
        { type: 'inputImage', imageUrl: 'https://example.com/banner.png' },
        { type: 'inputText', text: 'Step 2: Found audio narration' },
        { type: 'inputAudio', audioUrl: 'https://example.com/narration.mp3' },
        { type: 'unsupportedCustomFormat', rawValue: 42 }
      ]
    }
  },
  {
    turnId: 'turn-repair',
    item: {
      type: 'mcpToolCall',
      id: 'mcp-mixed',
      server: 'media_server',
      tool: 'fetch_bundle',
      arguments: { bundleId: 'b-99' },
      status: 'failed',
      result: {
        content: [
          { type: 'text', text: 'Bundle preview retrieved with warnings', _meta: { block: 'text-meta-marker' } },
          { type: 'image', data: 'aW1hZ2VkYXRh', mimeType: 'image/png', _meta: { block: 'image-meta-marker' } },
          { type: 'audio', data: 'YXVkaW9kYXRh', mimeType: 'audio/wav', _meta: { block: 'audio-meta-marker' } },
          { type: 'resource', _meta: { block: 'outer-meta-marker' }, resource: { uri: 'file:///workspace/embedded.ts', name: 'embedded.ts', text: 'export const embedded = 1;', _meta: { block: 'inner-meta-marker' } } },
          { type: 'resource', resource: { uri: 'file:///workspace/blob.png', mimeType: 'image/png', blob: 'YmxvYmRhdGE=' } },
          { type: 'resource_link', uri: 'file:///workspace/link.ts', name: 'link.ts', description: 'Linked doc', _meta: { block: 'link-meta-marker' } },
          { type: 'image', data: '', mimeType: '' }
        ],
        structuredContent: { bundleId: 'b-99', warnings: ['deprecated codec'] },
        _meta: { traceId: 'trace-mcp-99' }
      }
    }
  },
  {
    turnId: 'turn-repair',
    item: {
      type: 'mcpToolCall',
      id: 'mcp-resource-failure',
      server: 'media_server',
      tool: 'render_image',
      arguments: { id: 'img-1' },
      status: 'failed',
      error: null,
      result: {
        content: [
          { type: 'image', data: 'aW1hZ2VkYXRh', mimeType: 'image/png' }
        ],
        structuredContent: null,
        _meta: null
      }
    }
  },
  {
    turnId: 'turn-repair',
    item: {
      type: 'dynamicToolCall',
      id: 'dyn-image-failed',
      tool: 'generate_chart',
      arguments: { type: 'pie' },
      status: 'failed',
      success: false,
      contentItems: [
        { type: 'inputImage', imageUrl: 'https://example.com/partial-chart.png' }
      ]
    }
  },
  {
    turnId: 'turn-repair',
    item: {
      type: 'dynamicToolCall',
      id: 'dyn-audio-failed',
      tool: 'synthesize_speech',
      arguments: { voice: 'en-US' },
      status: 'failed',
      contentItems: [
        { type: 'inputAudio', audioUrl: 'https://example.com/truncated-audio.mp3' }
      ]
    }
  },
  {
    turnId: 'turn-repair',
    item: {
      type: 'dynamicToolCall',
      id: 'dyn-media-in-progress',
      tool: 'stream_media',
      arguments: {},
      status: 'inProgress',
      contentItems: [
        { type: 'inputImage', imageUrl: 'https://example.com/streaming-frame.png' }
      ]
    }
  },
  {
    turnId: 'turn-repair',
    item: {
      type: 'dynamicToolCall',
      id: 'dyn-media-success',
      tool: 'render_media',
      arguments: {},
      status: 'completed',
      success: true,
      contentItems: [
        { type: 'inputImage', imageUrl: 'https://example.com/done-image.png' }
      ]
    }
  }
]

type HelperRecord = {
  pid: number
  args: string[]
  cwd: string
  home: string
  deletedEnv: boolean
  descendantPid?: number
}

async function fixture(
  verify: (owner: {
    client: AgentMuxClient
    store: AgentMuxFileAgentSessionStore
    storePath: string
    read(options?: AgentSessionHistoryPageOptions): ReturnType<AgentMuxClient['sessionHistoryPage']>
    requests(): Promise<ProtocolRequest[]>
    helpers(): Promise<HelperRecord[]>
    home: string
    workspace: string
  }) => Promise<void>,
  mode = 'normal'
): Promise<void> {
  const home = await mkdtemp('/tmp/amx-codex-analysis-test-')
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const script = join(home, 'codex-protocol-mock.mjs')
  const requestFile = join(home, 'requests.jsonl')
  const helperFile = join(home, 'helpers.jsonl')
  await writeFile(
    script,
    `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const entries = ${JSON.stringify(turnEntries)}
const repairEntries = ${JSON.stringify(repairEntries)}
const nativeId = ${JSON.stringify(nativeId)}
const mode = process.env.AMX_NATIVE_MODE

appendFileSync(process.env.AMX_HELPER_FILE, JSON.stringify({
  pid: process.pid,
  args: process.argv.slice(2),
  cwd: process.cwd(),
  deletedEnv: !Object.hasOwn(process.env, 'AMX_DELETE_ME')
}) + '\\n')

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  const request = JSON.parse(line)
  appendFileSync(process.env.AMX_REQUEST_FILE, JSON.stringify(request) + '\\n')
  const send = (result) => {
    process.stdout.write(Buffer.from(JSON.stringify({ id: request.id, result }) + '\\n'))
  }
  if (request.method === 'initialize') {
    send({ userAgent: 'codex-app-server-mock' })
  } else if (request.method === 'thread/read') {
    if (mode === 'wrong-identity') {
      send({ thread: { id: 'foreign-thread-id', historyMode: 'paginated' } })
    } else if (mode === 'legacy-mode') {
      send({ thread: { id: nativeId, historyMode: 'legacy' } })
    } else {
      send({ thread: { id: nativeId, historyMode: 'paginated' } })
    }
  } else if (request.method === 'thread/items/list') {
    if (mode === 'timeout') return
    const activeEntries = mode === 'repair-mode' ? repairEntries : entries
    const limit = typeof request.params?.limit === 'number' ? request.params.limit : activeEntries.length
    if (request.params?.cursor === 'older-page-cursor') {
      send({
        data: [
          {
            turnId: 'turn-0',
            startedAtMs: 100,
            completedAtMs: 200,
            item: {
              type: 'userMessage',
              id: 'usr-0',
              content: [{ type: 'text', text: 'Initial conversation message' }]
            }
          }
        ],
        nextCursor: null
      })
    } else {
      send({
        data: activeEntries.slice(0, limit),
        nextCursor: 'older-page-cursor'
      })
    }
  }
})
`
  )
  const requests = async (): Promise<ProtocolRequest[]> =>
    readFile(requestFile, 'utf8').then(
      (text) =>
        text
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      () => []
    )
  const helpers = async (): Promise<HelperRecord[]> =>
    readFile(helperFile, 'utf8').then(
      (text) =>
        text
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      () => []
    )
  const storePath = join(home, 'agent-sessions.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  await store.compareAndSwap(null, {
    kind: 'agent',
    agentSessionId: 'session-codex-analysis',
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: workspace,
    run: { runId: 'run-codex-1' },
    retiredRuns: [],
    hookBindingId: 'binding-codex',
    hookToken: 'token-codex',
    createdAt: 1000,
    updatedAt: 1000,
    nativeHandle: {
      kind: 'provider',
      providerId: 'codex',
      sessionId: nativeId,
      transcriptPath: '/synthetic/codex-transcript.jsonl'
    }
  })
  const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(storePath) })
  const invocation: AgentSessionHistoryPageOptions = {
    commandOverride: process.execPath,
    args: [script, 'read-helper-arg'],
    env: {
      AMX_NATIVE_MODE: mode,
      AMX_REQUEST_FILE: requestFile,
      AMX_HELPER_FILE: helperFile,
      AMX_DELETE_ME: undefined
    }
  }
  const originalHomedir = os.homedir
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  try {
    await verify({
      client,
      store,
      storePath,
      home,
      workspace,
      requests,
      helpers,
      read: (options) => client.sessionHistoryPage('session-codex-analysis', { ...invocation, ...options })
    })
    for (const helper of await helpers()) {
      expect(() => process.kill(helper.pid, 0)).toThrowError(/ESRCH/)
    }
  } finally {
    vi.mocked(os.homedir).mockRestore?.()
    await client.dispose()
    for (const helper of await helpers()) {
      try {
        process.kill(-helper.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    await rm(home, { recursive: true, force: true })
  }
}

describe('Codex provider completeness & session analysis', () => {
  const registry = new AgentProviderRegistry()
  const codex = registry.get('codex')

  it('exposes authoritative catalog declarations and native handle rules', () => {
    expect(codex.id).toBe('codex')
    expect(codex.catalog.capabilities).toMatchObject({
      terminal: true,
      timeline: 'complete-events',
      permission: 'respond',
      providerResume: true,
      replyCorrelation: 'none',
      usage: { kind: 'native-transcript', transcriptFormat: 'codex-rollout' }
    })
    expect(codex.catalog.resumeStrategy).toEqual({
      kind: 'provider-native',
      locator: 'session-id'
    })

    // Native Hook normalization and handle extraction
    const normalizedStart = codex.normalizeHook({
      receiptId: 'r-start',
      agentSessionId: 's-1',
      runId: 'r-1',
      providerId: 'codex',
      eventName: 'SessionStart',
      payload: {
        hook_event_name: 'SessionStart',
        session_id: 'test-session-uuid-42',
        transcript_path: '/tmp/codex-session.jsonl'
      }
    })
    expect(normalizedStart.nativeHandle).toEqual({
      kind: 'provider',
      providerId: 'codex',
      sessionId: 'test-session-uuid-42',
      transcriptPath: '/tmp/codex-session.jsonl'
    })
    expect(normalizedStart.semanticState).toBe('working')

    const normalizedPerm = codex.normalizeHook({
      receiptId: 'r-perm',
      agentSessionId: 's-1',
      runId: 'r-1',
      providerId: 'codex',
      eventName: 'PermissionRequest',
      payload: { hook_event_name: 'PermissionRequest', session_id: 'test-session-uuid-42' }
    })
    expect(normalizedPerm.semanticState).toBe('waiting')

    const normalizedStop = codex.normalizeHook({
      receiptId: 'r-stop',
      agentSessionId: 's-1',
      runId: 'r-1',
      providerId: 'codex',
      eventName: 'Stop',
      payload: { hook_event_name: 'Stop', session_id: 'test-session-uuid-42' }
    })
    expect(normalizedStop.semanticState).toBe('done')

    // Managed hook plan verification
    const plan = createCodexManagedHookPlan('/mock/workspace')
    expect(plan.providerId).toBe('codex')
    expect(plan.mutations[0]!.path).toBe('/mock/workspace/.codex/hooks.json')
  })

  it('reads chronological native items with structured trace blocks for reasoning, commands, patches, and tools', async () => {
    await fixture(async ({ read, store, requests, helpers, home }) => {
      const page = await read({ limit: 10 })
      expect(page.source).toEqual({ providerId: 'codex', nativeSessionId: nativeId })
      expect(page.nextCursor).toBe('older-page-cursor')

      // Verify item ordering: chronological per page (oldest usr-1 first, newest asst-1 last)
      const ids = page.items.map((item) => item.id)
      expect(ids).toEqual([
        'usr-1',
        'rsn-1',
        'cmd-ok',
        'cmd-failed',
        'cmd-running',
        'patch-1',
        'mcp-1',
        'asst-1'
      ])

      // 1. User message with text and mention resource
      expect(page.items[0]).toMatchObject({
        id: 'usr-1',
        kind: 'user-message',
        turnId: 'turn-1',
        contentParts: [
          { kind: 'text', text: 'Please check git status and update README' },
          { kind: 'resource', resourceType: 'file', reference: '/workspace/README.md', label: 'README.md' }
        ]
      })

      // 2. Reasoning item: mapped to kind 'activity' with title 'reasoning' and reasoning block
      expect(page.items[1]).toMatchObject({
        id: 'rsn-1',
        kind: 'activity',
        title: 'reasoning',
        turnId: 'turn-2',
        contentParts: [
          { kind: 'reasoning', text: 'Examining working tree and diffs' }
        ]
      })

      // 3. Successful command: tool-call + tool-result (without failed flag)
      expect(page.items[2]).toMatchObject({
        id: 'cmd-ok',
        kind: 'activity',
        title: 'commandExecution',
        turnId: 'turn-2',
        startedAt: 1100,
        completedAt: 1250,
        contentParts: [
          { kind: 'tool-call', name: 'shell', input: 'git status', callId: 'cmd-ok' },
          { kind: 'tool-result', output: 'On branch main\nnothing to commit', name: 'shell', callId: 'cmd-ok' }
        ]
      })
      const okResult = page.items[2]!.contentParts[1]
      expect(okResult?.kind).toBe('tool-result')
      if (okResult?.kind === 'tool-result') {
        expect(okResult.failed).toBeUndefined()
      }

      // 4. Failed command: tool-call + tool-result with failed: true
      expect(page.items[3]).toMatchObject({
        id: 'cmd-failed',
        kind: 'activity',
        title: 'commandExecution',
        turnId: 'turn-2',
        startedAt: 1300,
        completedAt: 1400,
        contentParts: [
          { kind: 'tool-call', name: 'shell', input: 'cat nonexistent.txt', callId: 'cmd-failed' },
          {
            kind: 'tool-result',
            output: 'cat: nonexistent.txt: No such file or directory',
            name: 'shell',
            callId: 'cmd-failed',
            failed: true
          }
        ]
      })

      // 5. In-progress command: tool-call ONLY, no invented tool-result or completion
      expect(page.items[4]).toMatchObject({
        id: 'cmd-running',
        kind: 'activity',
        title: 'commandExecution',
        turnId: 'turn-2',
        startedAt: 1500,
        contentParts: [
          { kind: 'tool-call', name: 'shell', input: 'sleep 30', callId: 'cmd-running' }
        ]
      })
      expect(page.items[4]!.completedAt).toBeUndefined()
      expect(page.items[4]!.contentParts).toHaveLength(1)

      // 6. File change / patch item: tool-call + tool-result
      expect(page.items[5]).toMatchObject({
        id: 'patch-1',
        kind: 'activity',
        title: 'fileChange',
        turnId: 'turn-2',
        startedAt: 1600,
        completedAt: 1750,
        contentParts: [
          { kind: 'tool-call', name: 'apply_patch', callId: 'patch-1' },
          { kind: 'tool-result', name: 'apply_patch', callId: 'patch-1' }
        ]
      })

      // 7. MCP Tool Call item: tool-call + tool-result
      expect(page.items[6]).toMatchObject({
        id: 'mcp-1',
        kind: 'activity',
        title: 'mcpToolCall',
        turnId: 'turn-2',
        startedAt: 1800,
        completedAt: 1900,
        contentParts: [
          { kind: 'tool-call', name: 'github/get_issue', callId: 'mcp-1' },
          { kind: 'tool-result', output: 'Issue #42: Parity request', name: 'github/get_issue', callId: 'mcp-1' }
        ]
      })

      // 8. Assistant message: kind 'assistant-message', speaker kept
      expect(page.items[7]).toMatchObject({
        id: 'asst-1',
        kind: 'assistant-message',
        turnId: 'turn-2',
        startedAt: 2000,
        completedAt: 2500,
        contentParts: [
          { kind: 'text', text: 'Repository inspection complete. README updated.' }
        ]
      })

      // Pagination test: older page read
      const olderPage = await read({ cursor: page.nextCursor! })
      expect(olderPage.items.map((i) => i.id)).toEqual(['usr-0'])
      expect(olderPage.nextCursor).toBeNull()

      // Verify healthy run controls were uncalled and store session run is intact
      const sessions = await loadAgentSessions(store)
      expect(sessions).toHaveLength(1)
      expect(sessions[0]!.run).toEqual({ runId: 'run-codex-1' })
      expect(sessions[0]!.retiredRuns).toHaveLength(0)

      // Verify helper process invocation
      const owners = await helpers()
      expect(owners.length).toBeGreaterThanOrEqual(1)
      expect(owners[0]!.args).toEqual(['read-helper-arg', '-s', 'read-only', '-a', 'never', 'app-server', '--stdio'])
    })
  })

  it('rejects wrong-identity and legacy historyMode without reading items', async () => {
    await fixture(async ({ read, requests }) => {
      await expect(read()).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
      })
      const reqs = await requests()
      expect(reqs.map((r) => r.method)).toEqual(['initialize', 'initialized', 'thread/read'])
    }, 'wrong-identity')

    await fixture(async ({ read, requests }) => {
      await expect(read()).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_UNSUPPORTED'
      })
      const reqs = await requests()
      expect(reqs.map((r) => r.method)).toEqual(['initialize', 'initialized', 'thread/read'])
    }, 'legacy-mode')
  })

  it('allows fresh Client recovery of the same durable session and preserves store bytes', async () => {
    await fixture(async ({ read, storePath, store, home }) => {
      // First read with primary client
      const page1 = await read({ limit: 5 })
      expect(page1.items.length).toBeGreaterThan(0)

      // Save store file content snapshot
      const rawStoreBefore = await readFile(storePath, 'utf8')

      // Create a fresh client recovery reading the same store
      const recoveredStore = new AgentMuxFileAgentSessionStore(storePath)
      const recoveredClient = new AgentMuxClient({ store: recoveredStore })
      try {
        const recoveredSessions = await loadAgentSessions(recoveredStore)
        expect(recoveredSessions).toHaveLength(1)
        expect(recoveredSessions[0]!.agentSessionId).toBe('session-codex-analysis')
        expect(recoveredSessions[0]!.nativeHandle).toMatchObject({
          sessionId: nativeId
        })

        // Verify recovered client can read history using same durable session
        const recoveredPage = await recoveredClient.sessionHistoryPage('session-codex-analysis', {
          commandOverride: process.execPath,
          args: [join(home, 'codex-protocol-mock.mjs'), 'read-helper-arg'],
          env: {
            AMX_NATIVE_MODE: 'normal',
            AMX_REQUEST_FILE: join(home, 'requests.jsonl'),
            AMX_HELPER_FILE: join(home, 'helpers.jsonl')
          }
        })
        expect(recoveredPage.items.length).toBeGreaterThan(0)
        expect(recoveredPage.source).toEqual({ providerId: 'codex', nativeSessionId: nativeId })

        // Verify store bytes did not change during read
        const rawStoreAfter = await readFile(storePath, 'utf8')
        expect(rawStoreAfter).toBe(rawStoreBefore)
      } finally {
        await recoveredClient.dispose()
      }
    })
  })

  it('correctly handles in-progress fileChange, structured MCP output, webSearch actions, malformed images, and speaker isolation', async () => {
    await fixture(async ({ read, requests }) => {
      const page = await read({ limit: 20 })
      const itemMap = new Map(page.items.map((i) => [i.id, i]))

      // 1. inProgress fileChange with diff must NOT emit tool-result
      const patchProgDiff = itemMap.get('patch-prog-diff')
      expect(patchProgDiff).toBeDefined()
      expect(patchProgDiff!.contentParts).toHaveLength(1)
      expect(patchProgDiff!.contentParts[0]!.kind).toBe('tool-call')

      // 2. inProgress fileChange without diff must NOT emit tool-result
      const patchProgNoDiff = itemMap.get('patch-prog-nodiff')
      expect(patchProgNoDiff).toBeDefined()
      expect(patchProgNoDiff!.contentParts).toHaveLength(1)
      expect(patchProgNoDiff!.contentParts[0]!.kind).toBe('tool-call')

      // 3. unknown status fileChange must NOT emit tool-result
      const patchUnknown = itemMap.get('patch-unknown-status')
      expect(patchUnknown).toBeDefined()
      expect(patchUnknown!.contentParts).toHaveLength(1)
      expect(patchUnknown!.contentParts[0]!.kind).toBe('tool-call')

      // 4. MCP output must preserve structuredContent alongside text content
      const mcpStruct = itemMap.get('mcp-struct')
      expect(mcpStruct).toBeDefined()
      expect(mcpStruct!.contentParts).toHaveLength(3)
      expect(mcpStruct!.contentParts[1]).toMatchObject({
        kind: 'tool-result',
        output: 'Runs found'
      })
      expect(mcpStruct!.contentParts[2]).toMatchObject({
        kind: 'tool-result',
        output: expect.stringContaining('101')
      })

      // 5. webSearch preserves action details
      const ws = itemMap.get('ws-1')
      expect(ws).toBeDefined()
      expect(ws!.contentParts).toHaveLength(2)
      const wsResult = ws!.contentParts[1]
      expect(wsResult?.kind).toBe('tool-result')
      if (wsResult?.kind === 'tool-result') {
        expect(wsResult.output).toContain('Find in page')
        expect(wsResult.output).toContain('generate-ts')
      }

      // 6. malformed imageView with null path falls back to readable activity JSON without crashing
      const imgNull = itemMap.get('img-null')
      expect(imgNull).toBeDefined()
      expect(imgNull!.kind).toBe('activity')
      expect(imgNull!.contentParts[0]!.kind).toBe('text')

      // 7. Unknown type with 'agent' in name stays 'activity', not 'assistant-message'
      const customNote = itemMap.get('custom-note-1')
      expect(customNote).toBeDefined()
      expect(customNote!.kind).toBe('activity')

      // 8. Dynamic tool call preserves exact text/image/text/audio ordering and unknown payload falls back to raw JSON tool-result
      const dyn = itemMap.get('dyn-ordered')
      expect(dyn).toBeDefined()
      expect(dyn!.contentParts).toEqual([
        { kind: 'tool-call', name: 'multimedia_inspect', input: '{\n  "target": "assets"\n}', callId: 'dyn-ordered' },
        { kind: 'tool-result', output: 'Step 1: Found graphic banner', name: 'multimedia_inspect', callId: 'dyn-ordered' },
        { kind: 'resource', resourceType: 'image', reference: 'https://example.com/banner.png' },
        { kind: 'tool-result', output: 'Step 2: Found audio narration', name: 'multimedia_inspect', callId: 'dyn-ordered' },
        { kind: 'resource', resourceType: 'audio', reference: 'https://example.com/narration.mp3' },
        { kind: 'tool-result', output: JSON.stringify({ type: 'unsupportedCustomFormat', rawValue: 42 }, null, 2), name: 'multimedia_inspect', callId: 'dyn-ordered' }
      ])

      // 9. Mixed MCP tool call preserves text/image/audio/embedded/link resource + structuredContent + _meta with native status: 'failed'
      const mcpMixed = itemMap.get('mcp-mixed')
      expect(mcpMixed).toBeDefined()
      expect(mcpMixed!.contentParts).toEqual([
        { kind: 'tool-call', name: 'media_server/fetch_bundle', input: '{\n  "bundleId": "b-99"\n}', callId: 'mcp-mixed' },
        { kind: 'tool-result', output: 'Bundle preview retrieved with warnings', name: 'media_server/fetch_bundle', callId: 'mcp-mixed', failed: true },
        { kind: 'tool-result', output: JSON.stringify({ block: 'text-meta-marker' }, null, 2), name: 'media_server/fetch_bundle', callId: 'mcp-mixed', failed: true },
        { kind: 'resource', resourceType: 'image', reference: 'data:image/png;base64,aW1hZ2VkYXRh' },
        { kind: 'tool-result', output: JSON.stringify({ block: 'image-meta-marker' }, null, 2), name: 'media_server/fetch_bundle', callId: 'mcp-mixed', failed: true },
        { kind: 'resource', resourceType: 'audio', reference: 'data:audio/wav;base64,YXVkaW9kYXRh' },
        { kind: 'tool-result', output: JSON.stringify({ block: 'audio-meta-marker' }, null, 2), name: 'media_server/fetch_bundle', callId: 'mcp-mixed', failed: true },
        { kind: 'resource', resourceType: 'file', reference: 'file:///workspace/embedded.ts', label: 'embedded.ts' },
        { kind: 'tool-result', output: 'export const embedded = 1;', name: 'media_server/fetch_bundle', callId: 'mcp-mixed', failed: true },
        { kind: 'tool-result', output: JSON.stringify({ block: 'outer-meta-marker' }, null, 2), name: 'media_server/fetch_bundle', callId: 'mcp-mixed', failed: true },
        { kind: 'tool-result', output: JSON.stringify({ block: 'inner-meta-marker' }, null, 2), name: 'media_server/fetch_bundle', callId: 'mcp-mixed', failed: true },
        { kind: 'resource', resourceType: 'file', reference: 'file:///workspace/blob.png' },
        { kind: 'resource', resourceType: 'image', reference: 'data:image/png;base64,YmxvYmRhdGE=', label: 'file:///workspace/blob.png (blob)' },
        { kind: 'resource', resourceType: 'file', reference: 'file:///workspace/link.ts', label: 'link.ts' },
        { kind: 'tool-result', output: JSON.stringify({ block: 'link-meta-marker' }, null, 2), name: 'media_server/fetch_bundle', callId: 'mcp-mixed', failed: true },
        { kind: 'tool-result', output: expect.not.stringContaining('data:;base64,'), name: 'media_server/fetch_bundle', callId: 'mcp-mixed', failed: true },
        { kind: 'tool-result', output: JSON.stringify({ bundleId: 'b-99', warnings: ['deprecated codec'] }, null, 2), name: 'media_server/fetch_bundle', callId: 'mcp-mixed', failed: true },
        { kind: 'tool-result', output: JSON.stringify({ traceId: 'trace-mcp-99' }, null, 2), name: 'media_server/fetch_bundle', callId: 'mcp-mixed', failed: true }
      ])

      // 10. Resource-only MCP tool call with status='failed' and error=null preserves failed: true outcome (without any cast)
      const mcpResFail = itemMap.get('mcp-resource-failure')
      expect(mcpResFail).toBeDefined()
      expect(mcpResFail!.contentParts.length).toBeGreaterThan(0)
      expect(mcpResFail!.contentParts.some(part => part.kind === 'tool-result' && part.failed === true)).toBe(true)

      // 11. Image-only dynamic tool call with status='failed' and success=false preserves native failure in a typed tool-result
      const dynImgFail = itemMap.get('dyn-image-failed')
      expect(dynImgFail).toBeDefined()
      expect(dynImgFail!.contentParts).toEqual([
        { kind: 'tool-call', name: 'generate_chart', input: '{\n  "type": "pie"\n}', callId: 'dyn-image-failed' },
        { kind: 'resource', resourceType: 'image', reference: 'https://example.com/partial-chart.png' },
        { kind: 'tool-result', output: 'Dynamic tool failed', name: 'generate_chart', callId: 'dyn-image-failed', failed: true }
      ])

      // 12. Audio-only dynamic tool call with status='failed' preserves native failure in a typed tool-result
      const dynAudFail = itemMap.get('dyn-audio-failed')
      expect(dynAudFail).toBeDefined()
      expect(dynAudFail!.contentParts).toEqual([
        { kind: 'tool-call', name: 'synthesize_speech', input: '{\n  "voice": "en-US"\n}', callId: 'dyn-audio-failed' },
        { kind: 'resource', resourceType: 'audio', reference: 'https://example.com/truncated-audio.mp3' },
        { kind: 'tool-result', output: 'Dynamic tool failed', name: 'synthesize_speech', callId: 'dyn-audio-failed', failed: true }
      ])

      // 13. Genuine in-progress dynamic tool call with media does NOT gain a fake result
      const dynInProgress = itemMap.get('dyn-media-in-progress')
      expect(dynInProgress).toBeDefined()
      expect(dynInProgress!.contentParts).toEqual([
        { kind: 'tool-call', name: 'stream_media', input: '{}', callId: 'dyn-media-in-progress' },
        { kind: 'resource', resourceType: 'image', reference: 'https://example.com/streaming-frame.png' }
      ])
      expect(dynInProgress!.contentParts.some(part => part.kind === 'tool-result')).toBe(false)

      // 14. Genuine success dynamic tool call with media retains success and does NOT gain a fake failure
      const dynSuccess = itemMap.get('dyn-media-success')
      expect(dynSuccess).toBeDefined()
      expect(dynSuccess!.contentParts).toEqual([
        { kind: 'tool-call', name: 'render_media', input: '{}', callId: 'dyn-media-success' },
        { kind: 'resource', resourceType: 'image', reference: 'https://example.com/done-image.png' }
      ])
      expect(dynSuccess!.contentParts.some(part => part.kind === 'tool-result' && part.failed === true)).toBe(false)
    }, 'repair-mode')
  })
})
