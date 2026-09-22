import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../src/client.js'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import { SESSION_HISTORY_MAX_PAGE_BYTES } from '../../src/session-history.js'
import {
  encodeCwdDirname,
  slugify,
  urlencodeRfc3986
} from '../../src/providers/grok-native-history.js'
import type { AgentMuxStoredAgentSession } from '../../src/types.js'
import type { CtxmuxRunAdapter } from '../../src/ctxmux-run-adapter.js'

const fixtures: Array<{ close(): Promise<void> }> = []
const clients: AgentMuxClient[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(clients.splice(0).map((c) => c.dispose()))
  await Promise.all(fixtures.splice(0).map((f) => f.close()))
})

function jsonl(values: unknown[]): string {
  return values.map((v) => JSON.stringify(v)).join('\n') + '\n'
}

type GrokFixtureOptions = {
  sessionId?: string
  workspacePath?: string
  transcriptFileName?: string
  summaryData?: Record<string, unknown> | string
  useUpdatesAsHandle?: boolean
  omittedTranscriptPath?: boolean
  customHandlePath?: string
  grokHomeRoot?: string
}

async function createGrokFixture(
  transcriptContent: string | Buffer,
  options: GrokFixtureOptions = {}
) {
  const sessionId = options.sessionId ?? '019e37f4-5135-7b63-a4ab-6d13aa6bf532'
  const workspacePath = options.workspacePath ?? 'home//workspace'

  let root: string
  let sessionDir: string
  if (options.grokHomeRoot) {
    root = options.grokHomeRoot
    const encodedGroup = encodeCwdDirname(workspacePath)
    sessionDir = join(root, 'sessions', encodedGroup, sessionId)
    await mkdir(sessionDir, { recursive: true })
  } else {
    root = await mkdtemp(join(tmpdir(), 'agentmux-grok-history-'))
    sessionDir = root
  }

  const fileName = options.transcriptFileName ?? 'chat_history.jsonl'
  const chatHistoryPath = join(sessionDir, fileName)
  await writeFile(chatHistoryPath, transcriptContent)

  if (options.summaryData !== undefined) {
    const content = typeof options.summaryData === 'string'
      ? options.summaryData
      : JSON.stringify(options.summaryData, null, 2)
    await writeFile(join(sessionDir, 'summary.json'), content)
  }

  let handleTranscriptPath: string | undefined = chatHistoryPath
  if (options.customHandlePath) {
    handleTranscriptPath = options.customHandlePath
  } else if (options.useUpdatesAsHandle) {
    const updatesPath = join(sessionDir, 'updates.jsonl')
    await writeFile(updatesPath, '{"type":"session_update"}\n')
    handleTranscriptPath = updatesPath
  } else if (options.omittedTranscriptPath) {
    handleTranscriptPath = undefined
  }

  const storePath = join(root, 'agent-sessions.json')
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const session: AgentMuxStoredAgentSession = {
    kind: 'agent',
    agentSessionId: 'grok-test-agent',
    providerId: 'grok',
    executorId: 'grok',
    hostId: 'local',
    workspacePath,
    run: { runId: 'healthy-grok-run' },
    retiredRuns: [],
    createdAt: 1000,
    updatedAt: 1000,
    hookBindingId: 'grok-binding',
    hookToken: 'grok-token',
    nativeHandle: {
      kind: 'provider',
      providerId: 'grok',
      sessionId,
      ...(handleTranscriptPath !== undefined ? { transcriptPath: handleTranscriptPath } : {})
    }
  }
  await store.compareAndSwap(null, session)

  const before = {
    native: await readFile(chatHistoryPath),
    store: await readFile(storePath)
  }

  const client = new AgentMuxClient({ store })
  clients.push(client)

  const kernel = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map((name) =>
    vi.spyOn(kernel, name as 'start')
  )

  const fixture = {
    root,
    sessionDir,
    chatHistoryPath,
    storePath,
    store,
    session,
    client,
    controls,
    before,
    async bytes() {
      return {
        native: await readFile(chatHistoryPath),
        store: await readFile(storePath)
      }
    },
    async close() {
      await client.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
  fixtures.push(fixture)
  return fixture
}

describe('Grok session history analysis and reader', () => {
  it('exposes readSessionHistoryPage on grok provider', () => {
    const providers = new AgentProviderRegistry()
    const grok = providers.get('grok')
    expect(grok.readSessionHistoryPage).toBeTypeOf('function')
  })

  describe('RFC3986 URL-encoding and BLAKE3 slug-hash CWD directory resolution', () => {
    it('strictly encodes punctuation ! \' ( ) * as uppercase hex percent bytes', () => {
      const pathWithPunctuation = "home//repo!/app'(star)*/code"
      const encoded = urlencodeRfc3986(pathWithPunctuation)
      expect(encoded).toContain('%21')
      expect(encoded).toContain('%27')
      expect(encoded).toContain('%28')
      expect(encoded).toContain('%29')
      expect(encoded).toContain('%2A')
      expect(encoded).not.toContain('!')
      expect(encoded).not.toContain("'")
      expect(encoded).not.toContain('(')
      expect(encoded).not.toContain(')')
      expect(encoded).not.toContain('*')
    })

    it('slugify matches first-party paths.rs implementation', () => {
      expect(slugify('Hello World!', 40)).toBe('hello-world')
      expect(slugify('深层目录', 40)).toBe('')
      expect(slugify('a'.repeat(100), 10)).toBe('aaaaaaaaaa')
    })

    it('handles 255/256 byte boundary strictly', () => {
      const cwd255 = '/' + 'a'.repeat(252)
      expect(Buffer.byteLength(urlencodeRfc3986(cwd255), 'ascii')).toBe(255)
      expect(encodeCwdDirname(cwd255)).toBe(urlencodeRfc3986(cwd255))

      const cwd256 = '/' + 'a'.repeat(253)
      expect(Buffer.byteLength(urlencodeRfc3986(cwd256), 'ascii')).toBe(256)
      const encoded256 = encodeCwdDirname(cwd256)
      expect(encoded256).toMatch(/^a{40}-[0-9a-f]{16}$/)
    })

    it('matches exact hashes for long CWDs published in xai-grok-config/src/paths.rs', () => {
      const cwd1 = 'home//Documents/開発プロジェクト/機能追加/テスト環境/ソースコード/main-branch'
      expect(encodeCwdDirname(cwd1)).toBe('main-branch-6aaeefdde2a621aa')

      const cwd2 = 'home//Library/Mobile Documents/com~apple~CloudDocs/项目文件/深层嵌套目录/更深层次的/工作区域/project'
      expect(encodeCwdDirname(cwd2)).toBe('project-5a22eee5d15e14bd')

      const cwd3 = 'home//Library/CloudStorage/OneDrive-대한민국회사/프로젝트/개발환경/소스코드/백엔드/서비스/my-app'
      expect(encodeCwdDirname(cwd3)).toBe('my-app-00d240a68a30d482')

      const cwd4 = 'home//Documents/工作文件夹/二零二六年项目/子目录一/子目录二/子目录三/源代码/code'
      expect(encodeCwdDirname(cwd4)).toBe('code-e5f13e136e4516ab')
    })

    it('falls back to workspace for CJK-only basename in long CWDs', () => {
      const cjkCwd = 'home//Documents/' + '长路径/'.repeat(20) + '项目'
      const encoded = encodeCwdDirname(cjkCwd)
      expect(encoded.startsWith('workspace-')).toBe(true)
      expect(encoded.length).toBe('workspace-'.length + 16)
    })

    it('preserves literal backslash on Darwin without splitting filename', () => {
      // In Rust paths.rs on Unix: Path::new(cwd).file_name() does not split on \
      const longCwdWithBackslash = 'home//Documents/' + 'long/'.repeat(50) + 'dir\\name'
      const encoded = encodeCwdDirname(longCwdWithBackslash)
      expect(encoded.startsWith('dir-name-')).toBe(true)
    })

    it('produces distinct hashes for different long paths', () => {
      const a = 'home//' + '中'.repeat(30)
      const b = 'home//' + '日'.repeat(30)
      expect(encodeCwdDirname(a)).not.toBe(encodeCwdDirname(b))
    })

    it('resolves deterministic on-disk candidate without transcriptPath for long CWD', async () => {
      const root = await mkdtemp(join(tmpdir(), 'agentmux-grok-longcwd-'))
      fixtures.push({ close: () => rm(root, { recursive: true, force: true }) })

      const longCwd = 'home//Documents/開発プロジェクト/機能追加/テスト環境/ソースコード/main-branch'
      const sessionId = '019e37f4-5135-7b63-a4ab-6d13aa6bf532'
      const encodedGroup = encodeCwdDirname(longCwd)

      const sessionDir = join(root, 'sessions', encodedGroup, sessionId)
      await mkdir(sessionDir, { recursive: true })
      await writeFile(
        join(sessionDir, 'chat_history.jsonl'),
        jsonl([
          {
            type: 'user',
            content: [{ type: 'text', text: 'Hello from long CWD' }]
          },
          {
            type: 'assistant',
            content: 'Hello!'
          }
        ])
      )
      await writeFile(
        join(sessionDir, 'summary.json'),
        JSON.stringify({ info: { id: sessionId, cwd: longCwd } })
      )

      const storePath = join(root, 'sessions.json')
      const store = new AgentMuxFileAgentSessionStore(storePath)
      const session: AgentMuxStoredAgentSession = {
        kind: 'agent',
        agentSessionId: 'long-cwd-agent',
        providerId: 'grok',
        executorId: 'grok',
        hostId: 'local',
        workspacePath: longCwd,
        run: { runId: 'run-long-cwd' },
        retiredRuns: [],
        createdAt: 1000,
        updatedAt: 1000,
        hookBindingId: 'binding',
        hookToken: 'token',
        nativeHandle: {
          kind: 'provider',
          providerId: 'grok',
          sessionId
        }
      }
      await store.compareAndSwap(null, session)

      const client = new AgentMuxClient({ store })
      clients.push(client)

      const page = await client.sessionHistoryPage('long-cwd-agent', {
        env: { GROK_HOME: root }
      })

      expect(page.items).toHaveLength(2)
      expect(page.items[0]!.kind).toBe('user-message')
      expect(page.items[0]!.contentParts).toEqual([{ kind: 'text', text: 'Hello from long CWD' }])
      expect(page.items[1]!.kind).toBe('assistant-message')
      expect(page.items[1]!.contentParts).toEqual([{ kind: 'text', text: 'Hello!' }])
    })

    it('rejects arbitrary transcriptPath that is not chat_history.jsonl or updates.jsonl', async () => {
      const f = await createGrokFixture('{"type":"user","content":[]}\n', {
        customHandlePath: '/tmp/arbitrary/directory/or/file.txt'
      })
      await expect(f.client.sessionHistoryPage('grok-test-agent')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE'
      })
    })

    it('rejects prefix-chat_history.jsonl matching only as a suffix', async () => {
      const f = await createGrokFixture('{"type":"user","content":[]}\n', {
        customHandlePath: '/tmp/session/prefix-chat_history.jsonl'
      })
      await expect(f.client.sessionHistoryPage('grok-test-agent')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE'
      })
    })

    it('rejects prefix-updates.jsonl matching only as a suffix', async () => {
      const f = await createGrokFixture('{"type":"user","content":[]}\n', {
        customHandlePath: '/tmp/session/prefix-updates.jsonl'
      })
      await expect(f.client.sessionHistoryPage('grok-test-agent')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_LOCATOR_UNAVAILABLE'
      })
    })
  })

  describe('Native first-party ConversationItem deserialization and trace mapping', () => {
    it('reads authentic source-derived records with honest byte-offset IDs and absent timestamps', async () => {
      const firstLine = JSON.stringify({
        type: 'user',
        content: [
          { type: 'text', text: 'Literal user prompt <user_query>kept intact</user_query>' },
          { type: 'image', url: 'https://example.com/spec.png' }
        ]
      })
      const secondLine = JSON.stringify({
        type: 'assistant',
        content: 'Response with tool call',
        tool_calls: [
          {
            id: 'call-first-party',
            name: 'read_file',
            arguments: '{"path":"main.rs"}'
          }
        ]
      })
      const thirdLine = JSON.stringify({
        type: 'tool_result',
        tool_call_id: 'call-first-party',
        content: 'file content here',
        images: [
          { type: 'image', url: 'https://example.com/diagram.png' }
        ]
      })

      const rawContent = [firstLine, secondLine, thirdLine].join('\n') + '\n'
      const f = await createGrokFixture(rawContent, {
        summaryData: { info: { id: '019e37f4-5135-7b63-a4ab-6d13aa6bf532', cwd: 'home//workspace' } }
      })

      const page = await f.client.sessionHistoryPage('grok-test-agent')
      expect(page.items).toHaveLength(3)

      // User turn
      const u = page.items[0]!
      expect(u.kind).toBe('user-message')
      expect(u.id).toBe('grok-record:0')
      expect(u.startedAt).toBeUndefined()
      expect(u.contentParts).toEqual([
        { kind: 'text', text: 'Literal user prompt <user_query>kept intact</user_query>' },
        { kind: 'resource', resourceType: 'image', reference: 'https://example.com/spec.png' }
      ])

      // Mixed assistant turn
      const a = page.items[1]!
      expect(a.kind).toBe('assistant-message')
      expect(a.id).toBe(`grok-record:${Buffer.byteLength(firstLine + '\n', 'utf8')}`)
      expect(a.startedAt).toBeUndefined()
      expect(a.contentParts).toEqual([
        { kind: 'text', text: 'Response with tool call' },
        { kind: 'tool-call', name: 'read_file', input: '{"path":"main.rs"}', callId: 'call-first-party' }
      ])

      // Tool result turn: retains callId and images, NO fabricated failed flag
      const t = page.items[2]!
      expect(t.kind).toBe('activity')
      expect(t.title).toBe('Grok tool_result')
      expect(t.id).toBe(`grok-record:${Buffer.byteLength(firstLine + '\n' + secondLine + '\n', 'utf8')}`)
      expect(t.startedAt).toBeUndefined()
      expect(t.contentParts).toEqual([
        { kind: 'tool-result', output: 'file content here', callId: 'call-first-party' },
        { kind: 'resource', resourceType: 'image', reference: 'https://example.com/diagram.png' }
      ])
      expect((t.contentParts[0] as { failed?: boolean }).failed).toBeUndefined()

      // Zero run controls called
      for (const control of f.controls) {
        expect(control).not.toHaveBeenCalled()
      }
      expect(await f.bytes()).toEqual(f.before)
    })

    it('classifies pure tool assistant as activity and preserves full backend tool call payload', async () => {
      const rows = [
        {
          type: 'assistant',
          content: '',
          tool_calls: [
            { id: 'c-bash', name: 'bash', arguments: '{"command":"ls"}' }
          ]
        },
        {
          type: 'backend_tool_call',
          kind: {
            tool_type: 'web_search',
            id: 'ws_a',
            status: 'completed',
            action: {
              type: 'search',
              query: 'alpha',
              sources: [{ title: 'Alpha Source', url: 'https://alpha.example' }]
            }
          }
        },
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Step 1: plan' }],
          content: [{ type: 'text', text: 'Detailed plan text' }]
        }
      ]

      const f = await createGrokFixture(jsonl(rows), {
        summaryData: { info: { id: '019e37f4-5135-7b63-a4ab-6d13aa6bf532', cwd: 'home//workspace' } }
      })
      const page = await f.client.sessionHistoryPage('grok-test-agent')

      expect(page.items).toHaveLength(3)

      // Pure tool assistant
      expect(page.items[0]!.kind).toBe('activity')
      expect(page.items[0]!.title).toBe('Grok tool_calls')
      expect(page.items[0]!.contentParts).toEqual([
        { kind: 'tool-call', name: 'bash', input: '{"command":"ls"}', callId: 'c-bash' }
      ])

      // Backend tool call with full inner payload
      expect(page.items[1]!.kind).toBe('activity')
      expect(page.items[1]!.title).toBe('Grok backend_tool_call')
      expect(page.items[1]!.contentParts).toHaveLength(1)
      const btc = page.items[1]!.contentParts[0] as { kind: string; name: string; input: string; callId: string }
      expect(btc.kind).toBe('tool-call')
      expect(btc.name).toBe('web_search')
      expect(btc.callId).toBe('ws_a')
      const parsedInput = JSON.parse(btc.input)
      expect(parsedInput.status).toBe('completed')
      expect(parsedInput.action.sources[0].title).toBe('Alpha Source')

      // Reasoning
      expect(page.items[2]!.kind).toBe('activity')
      expect(page.items[2]!.title).toBe('Grok reasoning')
      expect(page.items[2]!.contentParts).toEqual([
        { kind: 'reasoning', text: 'Step 1: plan\nDetailed plan text' }
      ])
    })

    it('preserves opaque encrypted_content in reasoning items without losing data or pretending to be visible text', async () => {
      const rows = [
        {
          type: 'reasoning',
          id: 'rs-opaque-only',
          summary: [],
          encrypted_content: 'native-opaque-ciphertext-AQID'
        }
      ]
      const f = await createGrokFixture(jsonl(rows), {
        summaryData: { info: { id: '019e37f4-5135-7b63-a4ab-6d13aa6bf532', cwd: 'home//workspace' } }
      })
      const page = await f.client.sessionHistoryPage('grok-test-agent')
      expect(page.items).toHaveLength(1)
      const item = page.items[0]!
      expect(item.kind).toBe('activity')
      expect(item.title).toBe('Grok reasoning')
      expect(item.contentParts).toEqual([
        {
          kind: 'resource',
          resourceType: 'other',
          reference: 'native-opaque-ciphertext-AQID',
          label: 'Encrypted reasoning'
        }
      ])
      // Real ciphertext is preserved and copied
      expect(JSON.stringify(page)).toContain('native-opaque-ciphertext-AQID')
    })

    it('preserves sequence when reasoning contains both visible text and encrypted_content', async () => {
      const rows = [
        {
          type: 'reasoning',
          id: 'rs-mixed',
          summary: [{ type: 'summary_text', text: 'Step 1: planning' }],
          content: [{ type: 'text', text: 'Detailed plan' }],
          encrypted_content: 'ciphertext-payload-XYZ'
        }
      ]
      const f = await createGrokFixture(jsonl(rows), {
        summaryData: { info: { id: '019e37f4-5135-7b63-a4ab-6d13aa6bf532', cwd: 'home//workspace' } }
      })
      const page = await f.client.sessionHistoryPage('grok-test-agent')
      expect(page.items).toHaveLength(1)
      const item = page.items[0]!
      expect(item.contentParts).toEqual([
        { kind: 'reasoning', text: 'Step 1: planning\nDetailed plan' },
        {
          kind: 'resource',
          resourceType: 'other',
          reference: 'ciphertext-payload-XYZ',
          label: 'Encrypted reasoning'
        }
      ])
    })

    it('maps synthetic user items to activity based on SyntheticReason', async () => {
      const rows = [
        {
          type: 'user',
          content: [{ type: 'text', text: 'AGENTS.md project instructions' }],
          synthetic_reason: 'project_instructions'
        },
        {
          type: 'user',
          content: [{ type: 'text', text: 'Runtime reminder' }],
          synthetic_reason: 'system_reminder'
        },
        {
          type: 'user',
          content: [{ type: 'text', text: 'User prompt' }],
          synthetic_reason: 'human'
        }
      ]

      const f = await createGrokFixture(jsonl(rows), {
        summaryData: { info: { id: '019e37f4-5135-7b63-a4ab-6d13aa6bf532', cwd: 'home//workspace' } }
      })
      const page = await f.client.sessionHistoryPage('grok-test-agent')

      expect(page.items).toHaveLength(3)
      expect(page.items[0]!.kind).toBe('activity')
      expect(page.items[0]!.title).toBe('Grok project_instructions')
      expect(page.items[1]!.kind).toBe('activity')
      expect(page.items[1]!.title).toBe('Grok system_reminder')
      expect(page.items[2]!.kind).toBe('user-message')
      expect(page.items[2]!.contentParts).toEqual([{ kind: 'text', text: 'User prompt' }])
    })
  })

  describe('Bounded metadata validation and strict directory identity', () => {
    it('rejects huge summary.json exceeding 1MB budget before allocation', async () => {
      const root = await mkdtemp(join(tmpdir(), 'agentmux-grok-hugesummary-'))
      fixtures.push({ close: () => rm(root, { recursive: true, force: true }) })

      const chatHistoryPath = join(root, 'chat_history.jsonl')
      await writeFile(chatHistoryPath, '{"type":"user","content":[]}\n')

      const hugeSummaryPath = join(root, 'summary.json')
      const hugePadding = 'x'.repeat(1024 * 1024 + 100)
      await writeFile(hugeSummaryPath, `{"info":{"id":"019e37f4-5135-7b63-a4ab-6d13aa6bf532","cwd":"home//workspace"},"padding":"${hugePadding}"}`)

      const storePath = join(root, 'sessions.json')
      const store = new AgentMuxFileAgentSessionStore(storePath)
      const session: AgentMuxStoredAgentSession = {
        kind: 'agent',
        agentSessionId: 'huge-summary-agent',
        providerId: 'grok',
        executorId: 'grok',
        hostId: 'local',
        workspacePath: 'home//workspace',
        run: { runId: 'run-huge' },
        retiredRuns: [],
        createdAt: 1000,
        updatedAt: 1000,
        hookBindingId: 'binding',
        hookToken: 'token',
        nativeHandle: {
          kind: 'provider',
          providerId: 'grok',
          sessionId: '019e37f4-5135-7b63-a4ab-6d13aa6bf532',
          transcriptPath: chatHistoryPath
        }
      }
      await store.compareAndSwap(null, session)

      const client = new AgentMuxClient({ store })
      clients.push(client)

      await expect(client.sessionHistoryPage('huge-summary-agent')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT'
      })
    })

    it('rejects empty summary object {}', async () => {
      const f = await createGrokFixture('{"type":"user","content":[]}\n', {
        summaryData: {}
      })
      await expect(f.client.sessionHistoryPage('grok-test-agent')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT'
      })
    })

    it('rejects flat summary lacking required info object', async () => {
      const f = await createGrokFixture('{"type":"user","content":[]}\n', {
        summaryData: { id: '019e37f4-5135-7b63-a4ab-6d13aa6bf532', cwd: 'home//workspace' }
      })
      await expect(f.client.sessionHistoryPage('grok-test-agent')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_INVALID_TRANSCRIPT'
      })
    })

    it('rejects summary missing info.id', async () => {
      const f = await createGrokFixture('{"type":"user","content":[]}\n', {
        summaryData: { info: { cwd: 'home//workspace' } }
      })
      await expect(f.client.sessionHistoryPage('grok-test-agent')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
      })
    })

    it('rejects summary missing info.cwd', async () => {
      const f = await createGrokFixture('{"type":"user","content":[]}\n', {
        summaryData: { info: { id: '019e37f4-5135-7b63-a4ab-6d13aa6bf532' } }
      })
      await expect(f.client.sessionHistoryPage('grok-test-agent')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
      })
    })

    it('rejects summary absence on an arbitrary unverified directory', async () => {
      // Arbitrary directory without summary.json must be rejected as unverified/wrong source
      const arbitraryRoot = await mkdtemp(join(tmpdir(), 'arbitrary-unverified-'))
      fixtures.push({ close: () => rm(arbitraryRoot, { recursive: true, force: true }) })

      const chatHistoryPath = join(arbitraryRoot, 'chat_history.jsonl')
      await writeFile(chatHistoryPath, '{"type":"user","content":[{"type":"text","text":"hello"}]}\n')

      const storePath = join(arbitraryRoot, 'sessions.json')
      const store = new AgentMuxFileAgentSessionStore(storePath)
      const session: AgentMuxStoredAgentSession = {
        kind: 'agent',
        agentSessionId: 'unverified-dir-agent',
        providerId: 'grok',
        executorId: 'grok',
        hostId: 'local',
        workspacePath: 'home//workspace',
        run: { runId: 'run-unverified' },
        retiredRuns: [],
        createdAt: 1000,
        updatedAt: 1000,
        hookBindingId: 'binding',
        hookToken: 'token',
        nativeHandle: {
          kind: 'provider',
          providerId: 'grok',
          sessionId: '019e37f4-5135-7b63-a4ab-6d13aa6bf532',
          transcriptPath: chatHistoryPath
        }
      }
      await store.compareAndSwap(null, session)

      const client = new AgentMuxClient({ store })
      clients.push(client)

      await expect(client.sessionHistoryPage('unverified-dir-agent')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED'
      })
    })

    it('tolerates summary absence when located under exact native directory layout', async () => {
      const grokHome = await mkdtemp(join(tmpdir(), 'grok-home-nosummary-'))
      fixtures.push({ close: () => rm(grokHome, { recursive: true, force: true }) })

      const workspacePath = 'home//workspace'
      const sessionId = '019e37f4-5135-7b63-a4ab-6d13aa6bf532'
      const encodedGroup = encodeCwdDirname(workspacePath)

      const sessionDir = join(grokHome, 'sessions', encodedGroup, sessionId)
      await mkdir(sessionDir, { recursive: true })

      const chatHistoryPath = join(sessionDir, 'chat_history.jsonl')
      await writeFile(chatHistoryPath, '{"type":"user","content":[{"type":"text","text":"In exact native directory"}]}\n')

      const storePath = join(grokHome, 'sessions.json')
      const store = new AgentMuxFileAgentSessionStore(storePath)
      const session: AgentMuxStoredAgentSession = {
        kind: 'agent',
        agentSessionId: 'exact-native-dir-agent',
        providerId: 'grok',
        executorId: 'grok',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-exact' },
        retiredRuns: [],
        createdAt: 1000,
        updatedAt: 1000,
        hookBindingId: 'binding',
        hookToken: 'token',
        nativeHandle: {
          kind: 'provider',
          providerId: 'grok',
          sessionId,
          transcriptPath: chatHistoryPath
        }
      }
      await store.compareAndSwap(null, session)

      const client = new AgentMuxClient({ store })
      clients.push(client)

      const page = await client.sessionHistoryPage('exact-native-dir-agent', {
        env: { GROK_HOME: grokHome }
      })
      expect(page.items).toHaveLength(1)
      expect(page.items[0]!.kind).toBe('user-message')
    })
  })

  describe('Multi-page pagination and resource budget bounds', () => {
    it('supports reverse pagination without gaps or duplicates and terminates with nextCursor null', async () => {
      const rows = Array.from({ length: 7 }, (_, i) => ({
        type: i % 2 === 0 ? 'user' : 'assistant',
        content: i % 2 === 0 ? [{ type: 'text', text: `Prompt ${i}` }] : `Answer ${i}`
      }))

      const f = await createGrokFixture(jsonl(rows), {
        summaryData: { info: { id: '019e37f4-5135-7b63-a4ab-6d13aa6bf532', cwd: 'home//workspace' } }
      })

      const page1 = await f.client.sessionHistoryPage('grok-test-agent', { limit: 3 })
      expect(page1.items).toHaveLength(3)
      expect(page1.items.map((it) => (it.contentParts[0] as { text: string }).text)).toEqual([
        'Prompt 4', 'Answer 5', 'Prompt 6'
      ])
      expect(page1.nextCursor).not.toBeNull()

      const page2 = await f.client.sessionHistoryPage('grok-test-agent', {
        limit: 3,
        cursor: page1.nextCursor!
      })
      expect(page2.items).toHaveLength(3)
      expect(page2.items.map((it) => (it.contentParts[0] as { text: string }).text)).toEqual([
        'Answer 1', 'Prompt 2', 'Answer 3'
      ])
      expect(page2.nextCursor).not.toBeNull()

      const page3 = await f.client.sessionHistoryPage('grok-test-agent', {
        limit: 3,
        cursor: page2.nextCursor!
      })
      expect(page3.items).toHaveLength(1)
      expect(page3.items.map((it) => (it.contentParts[0] as { text: string }).text)).toEqual([
        'Prompt 0'
      ])
      expect(page3.nextCursor).toBeNull()
    })

    it('rejects history page when page size exceeds byte budget', async () => {
      const largeChunk = 'y'.repeat(160 * 1024)
      const largeRows = Array.from({ length: 30 }, (_, i) => ({
        type: 'assistant',
        content: `Large chunk ${i}: ${largeChunk}`
      }))

      const f = await createGrokFixture(jsonl(largeRows), {
        summaryData: { info: { id: '019e37f4-5135-7b63-a4ab-6d13aa6bf532', cwd: 'home//workspace' } }
      })
      await expect(f.client.sessionHistoryPage('grok-test-agent')).rejects.toMatchObject({
        code: 'AGENT_SESSION_HISTORY_TOO_LARGE'
      })
    })

    it('enforces shared 4 MiB page budget across summary.json and chat_history.jsonl combined', async () => {
      // Summary: ~1,000,000 bytes (under 1MB cap)
      const summaryPadding = 's'.repeat(1024 * 1024 - 4096)
      const summaryData = {
        info: { id: '019e37f4-5135-7b63-a4ab-6d13aa6bf532', cwd: 'home//workspace' },
        session_summary: summaryPadding
      }

      // JSONL: 50 records of ~70,000 bytes (~3.5MB, under 4MB cap alone)
      const hugeRows = Array.from({ length: 50 }, (_, i) => ({
        type: 'reasoning',
        id: `opaque-${i}`,
        summary: [],
        encrypted_content: 'c'.repeat(70000)
      }))

      const f = await createGrokFixture(jsonl(hugeRows), { summaryData })

      const probeHandle = await open(f.chatHistoryPath, constants.O_RDONLY)
      const proto = Object.getPrototypeOf(probeHandle)
      await probeHandle.close()

      type PhysicalReadLog = { position: number; requested: number; returned: number }
      const physicalReads: PhysicalReadLog[] = []
      const origProtoRead = proto.read

      proto.read = async function(buffer: Buffer, offset: number, length: number, position: number | null) {
        const res = await origProtoRead.apply(this, [buffer, offset, length, position])
        physicalReads.push({
          position: position ?? 0,
          requested: length,
          returned: res.bytesRead
        })
        return res
      }

      try {
        await expect(f.client.sessionHistoryPage('grok-test-agent', { limit: 100 })).rejects.toMatchObject({
          code: 'AGENT_SESSION_HISTORY_TOO_LARGE'
        })

        // Summary was read, but over-budget read on JSONL was rejected BEFORE physical read
        expect(physicalReads.length).toBeGreaterThan(0)
        const totalPhysical = physicalReads.reduce((sum, r) => sum + r.returned, 0)
        expect(totalPhysical).toBeLessThanOrEqual(SESSION_HISTORY_MAX_PAGE_BYTES)
      } finally {
        proto.read = origProtoRead
      }
    })

    it('allows reading when summary.json and chat_history.jsonl combined stay within 4 MiB budget', async () => {
      const summaryData = {
        info: { id: '019e37f4-5135-7b63-a4ab-6d13aa6bf532', cwd: 'home//workspace' },
        session_summary: 's'.repeat(200 * 1024)
      }
      const rows = Array.from({ length: 10 }, (_, i) => ({
        type: 'assistant',
        content: `Record ${i}: ${'x'.repeat(40 * 1024)}`
      }))

      const f = await createGrokFixture(jsonl(rows), { summaryData })
      const page = await f.client.sessionHistoryPage('grok-test-agent')

      expect(page.items).toHaveLength(10)
      expect(page.items[0]!.kind).toBe('assistant-message')
    })

    it('stops before allocation and read when client is disconnected during pending summary fstat', async () => {
      const f = await createGrokFixture('{"type":"user","content":[{"type":"text","text":"hi"}]}\n', {
        summaryData: {
          info: { id: '019e37f4-5135-7b63-a4ab-6d13aa6bf532', cwd: 'home//workspace' },
          session_summary: 's'.repeat(1000)
        }
      })

      const probeHandle = await open(f.chatHistoryPath, constants.O_RDONLY)
      const proto = Object.getPrototypeOf(probeHandle)
      await probeHandle.close()

      const origStat = proto.stat
      const origRead = proto.read
      let statPending = false
      let resolveBarrier!: () => void
      const barrier = new Promise<void>((r) => { resolveBarrier = r })
      let summaryReadCount = 0

      proto.stat = async function(...args: unknown[]) {
        statPending = true
        await barrier
        return origStat.apply(this, args)
      }
      proto.read = async function(...args: unknown[]) {
        summaryReadCount++
        return origRead.apply(this, args)
      }

      try {
        const pagePromise = f.client.sessionHistoryPage('grok-test-agent')

        // Wait until stat is actively in flight
        await vi.waitFor(() => expect(statPending).toBe(true))

        // Disconnect the client while stat is in flight
        f.client.disconnect()

        // Release the barrier so stat completes
        resolveBarrier()

        await expect(pagePromise).rejects.toMatchObject({
          code: 'AGENT_SESSION_HISTORY_CANCELLED'
        })
        // ZERO reads occurred on summary.json
        expect(summaryReadCount).toBe(0)
      } finally {
        proto.stat = origStat
        proto.read = origRead
      }
    })

    it('enforces 10-second deadline timeout across the shared page budget', async () => {
      const f = await createGrokFixture('{"type":"user","content":[{"type":"text","text":"hi"}]}\n', {
        summaryData: { info: { id: '019e37f4-5135-7b63-a4ab-6d13aa6bf532', cwd: 'home//workspace' } }
      })

      const probeHandle = await open(f.chatHistoryPath, constants.O_RDONLY)
      const proto = Object.getPrototypeOf(probeHandle)
      await probeHandle.close()

      const origStat = proto.stat
      let resolveBarrier!: () => void
      const barrier = new Promise<void>((r) => { resolveBarrier = r })

      proto.stat = async function(...args: unknown[]) {
        await barrier
        return origStat.apply(this, args)
      }

      try {
        vi.useFakeTimers()
        const pagePromise = f.client.sessionHistoryPage('grok-test-agent')
        const rejection = expect(pagePromise).rejects.toMatchObject({
          code: 'AGENT_SESSION_HISTORY_TIMEOUT'
        })

        await vi.advanceTimersByTimeAsync(10_001)
        resolveBarrier()
        await rejection
        vi.useRealTimers()
        await new Promise((r) => setTimeout(r, 50))
      } finally {
        vi.useRealTimers()
        proto.stat = origStat
      }
    })
  })

  describe('End-to-end production hook -> durable store -> fresh client recovery chain', () => {
    it('proves real public hook payload captures handle, stores durably, and recovers in fresh client', async () => {
      const root = await mkdtemp(join(tmpdir(), 'agentmux-grok-e2e-'))
      fixtures.push({ close: () => rm(root, { recursive: true, force: true }) })

      const sessionId = '01a0937d-a27c-7ca3-ba45-00a0c547f374'
      const workspacePath = 'home//e2e-workspace'
      const encodedGroup = encodeCwdDirname(workspacePath)
      const sessionDir = join(root, 'sessions', encodedGroup, sessionId)
      await mkdir(sessionDir, { recursive: true })

      const updatesPath = join(sessionDir, 'updates.jsonl')
      const chatHistoryPath = join(sessionDir, 'chat_history.jsonl')
      await writeFile(updatesPath, '{"type":"session_update"}\n')
      await writeFile(
        chatHistoryPath,
        jsonl([
          { type: 'user', content: [{ type: 'text', text: 'End to end prompt' }] },
          { type: 'assistant', content: 'End to end response' }
        ])
      )
      await writeFile(
        join(sessionDir, 'summary.json'),
        JSON.stringify({ info: { id: sessionId, cwd: workspacePath } })
      )

      const providers = new AgentProviderRegistry()
      const grok = providers.get('grok')

      const normalized = grok.normalizeHook({
        receiptId: 'receipt-1',
        agentSessionId: 'e2e-grok-session',
        runId: 'run-e2e',
        providerId: 'grok',
        payload: {
          hookEventName: 'user_prompt_submit',
          sessionId,
          transcriptPath: updatesPath,
          cwd: workspacePath
        }
      })

      expect(normalized.nativeHandle).toBeDefined()
      if (!normalized.nativeHandle) {
        throw new Error('Expected normalized.nativeHandle to be defined')
      }
      const nativeHandle = normalized.nativeHandle

      expect(nativeHandle).toEqual({
        kind: 'provider',
        providerId: 'grok',
        sessionId
      })

      const storePath = join(root, 'agent-sessions.json')
      const store = new AgentMuxFileAgentSessionStore(storePath)
      const session: AgentMuxStoredAgentSession = {
        kind: 'agent',
        agentSessionId: 'e2e-grok-session',
        providerId: 'grok',
        executorId: 'grok',
        hostId: 'local',
        workspacePath,
        run: { runId: 'run-e2e' },
        retiredRuns: [],
        createdAt: 2000,
        updatedAt: 2000,
        hookBindingId: 'binding-e2e',
        hookToken: 'token-e2e',
        nativeHandle
      }
      await store.compareAndSwap(null, session)

      const freshClient = new AgentMuxClient({ store })
      clients.push(freshClient)

      const page = await freshClient.sessionHistoryPage('e2e-grok-session', {
        env: { GROK_HOME: root }
      })
      expect(page.items).toHaveLength(2)
      expect(page.items[0]!.kind).toBe('user-message')
      expect(page.items[0]!.contentParts).toEqual([{ kind: 'text', text: 'End to end prompt' }])
      expect(page.items[1]!.kind).toBe('assistant-message')
      expect(page.items[1]!.contentParts).toEqual([{ kind: 'text', text: 'End to end response' }])

      const resumeLaunch = grok.buildResumeLaunch({
        workspacePath,
        nativeHandle: session.nativeHandle!,
        prompt: 'continue working',
        args: ['--debug'],
        env: {}
      })
      expect(resumeLaunch).toEqual({
        command: 'grok',
        args: ['--resume', sessionId, '--debug', '--', 'continue working'],
        env: {}
      })
    })
  })
})
