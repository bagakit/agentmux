import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { parseTopicParams, parseTopicResult, type TopicKnowledge, type TopicKnowledgeWrite, type TopicResult } from '../src/public-rpc-topics.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { AGENTMUX_CLI_SKILL, agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { AgentMuxRpcService as SourceRpcService, type AgentMuxRpcCallContext } from '../src/public-rpc-service.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
const RpcService: typeof SourceRpcService = process.env.AGENTMUX_TEST_TOPIC_FORWARD_ENTRY
  ? (await import(/* @vite-ignore */ pathToFileURL(process.env.AGENTMUX_TEST_TOPIC_FORWARD_ENTRY).href)).AgentMuxRpcService : SourceRpcService
const category = { categoryId: '11111111-1111-4111-8111-111111111111', hostId: 'local', spaceId: JSON.stringify(['local', upstreamFixturePath('topics/category')]), directoryPath: upstreamFixturePath("topics/category"), title: '工作', revision: 'sha256:' + 'a'.repeat(64) }
describe('Topic typed public contract', () => {
  it('rejects spoofed envelopes, malformed revisions and inexact content identities before mutation', () => {
    for (const params of [{ categoryId: category.categoryId, title: 'Valid', caller: { id: 'spoof' } }, { categoryId: '../escape', title: 'Valid' }])
      expect(() => parseTopicParams('topic.category.create', params)).toThrow()
    expect(() => parseTopicParams('topic.move', { topicId: 'view:topic', categoryId: category.categoryId, expectedRevision: -1 })).toThrow()
    expect(() => parseTopicParams('topic.inspect', { topicId: 'self' })).toThrow()
    expect(() => parseTopicParams('topic.category.rename', { categoryId: category.categoryId, title: 'Valid', expectedRevision: 'latest' })).toThrow()
  })
  it('preserves exact original results and refuses a different category or unconfirmed save', () => {
    const params = { categoryId: category.categoryId, title: '工作' }, result = { category, diskDurability: 'confirmed' }
    expect(parseRpcNativeResult('topic.category.create', result, params)).toEqual(result)
    expect(() => parseTopicResult('topic.category.create', { ...result, category: { ...category, categoryId: '22222222-2222-4222-8222-222222222222' } }, params)).toThrow()
    expect(() => parseTopicResult('topic.category.create', { ...result, diskDurability: 'unconfirmed' }, params)).toThrow()
    expect(() => parseTopicResult('topic.migrate.apply', { spatialRevision: 1, backupPath: null, migratedTopicIds: ['self'], diskDurability: 'confirmed' }, { expectedRevision: 0 })).toThrow()
  })
  it('discovers actual executable commands in help and skill without replacing Notebook capabilities', () => {
    expect(AGENTMUX_CLI_SKILL).toContain('agentmux topic category create')
    expect(AGENTMUX_CLI_SKILL).toContain('agentmux topic migrate preview')
    expect(AGENTMUX_CLI_SKILL).toContain('agentmux notebook ls')
    expect(agentMuxCommandHelp('topic.move')).toContain('--revision NUMBER')
    expect(AGENTMUX_CLI_SKILL).toContain('agentmux topic knowledge search')
    expect(agentMuxCommandHelp('topic.knowledge.write')).toContain('--input FILE|-')
  })
  it('requires typed original sources, exact revisions and bounded scopes for knowledge writes and results', () => {
    const input: TopicKnowledgeWrite = { topicId: 'view:topic', entryId: category.categoryId, title: 'Decision', content: 'A reviewed derivation.\nOriginal discussion retained.',
      form: 'derived', certainty: 'decision', sources: [{ kind: 'note', noteId: 'source-note', blockId: 'source-block' }], expectedRevision: null }
    expect(parseTopicParams('topic.knowledge.write', input)).toEqual(input)
    const spaceSource = { kind: 'space', zoneId: 'source-project-zone', tabId: 'source-chat', regionId: 'source-thread' }
    expect(parseTopicParams('topic.knowledge.write', { ...input, sources: [spaceSource] }).sources).toEqual([spaceSource])
    for (const bad of [{ ...input, form: 'reference', sources: [] }, { ...input, expectedRevision: 'latest' }, { ...input, certainty: 'guessed' },
      { ...input, sources: [{ kind: 'note', noteId: 'source-note', copiedChildren: [] }] }, { ...input, sources: [{ ...spaceSource, topicId: 'view:spoof' }] },
      { ...input, sources: [{ kind: 'space', regionId: 'source-thread' }] }, { ...input, sources: [{ kind: 'topic', topicId: 'self' }] },
      { ...input, content: 'x'.repeat(128 * 1024 + 1) }, { ...input, caller: { id: 'spoof' } }])
      expect(() => parseTopicParams('topic.knowledge.write', bad)).toThrow()
    expect(() => parseTopicParams('topic.knowledge.search', { query: '  ' })).toThrow()
    expect(() => parseTopicParams('topic.knowledge.ls', { topicId: input.topicId, limit: 0 })).toThrow()
    const { expectedRevision, ...authored } = input
    const entry = { ...authored, revision: category.revision, updatedAt: 1 }
    expect(parseRpcNativeResult('topic.knowledge.write', { entry, diskDurability: 'confirmed' }, input)).toEqual({ entry, diskDurability: 'confirmed' })
    expect(() => parseTopicResult('topic.knowledge.read', { entry: { ...entry, topicId: 'view:different' } }, input)).toThrow()
    expect(() => parseTopicResult('topic.knowledge.read', { entry: { ...entry, entryId: '22222222-2222-4222-8222-222222222222' } }, input)).toThrow()
    expect(() => parseTopicResult('topic.knowledge.write', { entry, diskDurability: 'unknown' }, input)).toThrow()
    expect(() => parseTopicResult('topic.knowledge.ls', { entries: [entry, entry], documents: [], unavailable: [] }, { topicId: input.topicId, limit: 1 })).toThrow()
  })
  it('separates bounded exact original documents from authored UUID entries and validates every preview receipt', () => {
    const target = { zoneId: 'original-topic-zone', path: 'outcome/result.md', expectedResource: { hostId: 'local', workspaceId: 'scratch', workspacePath: upstreamFixturePath("scratch") }, maxBytes: 131072 }
    const name = { topicId: 'view:topic', target, title: 'result.md', snippet: null, revision: null, readScope: 'name' }
    const listed = { entries: [], documents: [name], unavailable: [] }, input = { topicId: 'view:topic', limit: 2 }
    expect(parseTopicResult('topic.knowledge.ls', listed, input)).toEqual(listed)
    const full = { ...name, snippet: 'A bounded body match', revision: category.revision, readScope: 'full' }
    const searched = { ...listed, documents: [full] }, query = { ...input, query: 'body' }
    expect(parseTopicResult('topic.knowledge.search', searched, query)).toEqual(searched)
    for (const document of [{ ...full, topicId: 'view:other' }, { ...full, target: { ...target, maxBytes: undefined } },
      { ...full, target: { ...target, path: '../foreign.md' } }, { ...full, target: { ...target, path: 'outcome//file.md' } },
      { ...full, entryId: category.categoryId }, { ...full, certainty: 'fact' }, { ...full, revision: 'latest' }, { ...full, snippet: null }])
      expect(() => parseTopicResult('topic.knowledge.search', { ...searched, documents: [document] }, query)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    expect(() => parseTopicResult('topic.knowledge.search', listed, query)).toThrow()
    expect(() => parseTopicResult('topic.knowledge.ls', searched, input)).toThrow()
    expect(() => parseTopicResult('topic.knowledge.ls', { ...listed, documents: [name, name] }, input)).toThrow()
    expect(() => parseTopicResult('topic.knowledge.search', { ...searched, documents: [full, { ...full, target: { ...target, path: 'different.md' } }] }, { ...query, limit: 1 })).toThrow()
    expect(agentMuxCommandHelp('file.read')).toContain('--max-bytes')
  })
  it('rejects malformed Notebook locators and copied resource fields in both request and response sources', () => {
    const input: TopicKnowledgeWrite = { topicId: 'view:topic', entryId: category.categoryId, title: 'Original notebook', content: '',
      form: 'reference', certainty: 'proposal', sources: [{ kind: 'notebook', notebookId: 'original-notebook' }], expectedRevision: null }
    expect(parseTopicParams('topic.knowledge.write', input).sources).toEqual(input.sources)
    const { expectedRevision, ...authored } = input
    for (const source of [{ kind: 'notebook' }, { kind: 'notebook', notebookId: '' }, { kind: 'notebook', notebookId: 42 },
      { kind: 'notebook', notebookId: 'original\nnotebook' }, { kind: 'notebook', notebookId: 'original-notebook', noteId: 'borrowed-note' },
      { kind: 'notebook', notebookId: 'original-notebook', resource: { path: 'copied.note.json' } }]) {
      expect(() => parseTopicParams('topic.knowledge.write', { ...input, sources: [source] })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
      expect(() => parseTopicResult('topic.knowledge.read', { entry: { ...authored, sources: [source], revision: category.revision, updatedAt: 1 } }, input))
        .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
    }
  })
  it('round-trips exact Notebook and Note source identities through the real RPC service and shipping CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amx-topic-cui-')), cli = join(root, 'cli.mjs')
    const entries = new Map<string, TopicKnowledge>(), calls: string[] = []
    const server = new AgentMuxControlServer({ socketPath: join(root, 'owner.sock'), coreClients: () => [], topics: {
      async call(method, params) {
        calls.push(method)
        const input = params as TopicKnowledgeWrite
        if (method === 'topic.knowledge.write') {
          const { expectedRevision, ...authored } = input
          const entry: TopicKnowledge = structuredClone({ ...authored, revision: category.revision!, updatedAt: 1 })
          entries.set(entry.entryId, entry)
          return { entry, diskDurability: 'confirmed' } as TopicResult<typeof method>
        }
        if (method === 'topic.knowledge.read') return { entry: entries.get(input.entryId) ?? null } as TopicResult<typeof method>
        throw new Error('Unexpected content owner operation: ' + method)
      }
    } })
    try {
      // Compile this source candidate privately; never rebuild or mutate shipping Core dist.
      await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir')
      const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/agentmux.ts', import.meta.url))], outfile: cli,
        bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true, logLevel: 'silent' })
      expect(Object.keys(compiled.metafile!.inputs).some(path => path.endsWith('/src/public-rpc-topics.ts'))).toBe(true)
      await server.start()
      const env = objectCliEnvironment(root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path })
      async function run(args: string[], stdin = '') {
        return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
          let stdout = '', stderr = ''
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Private Topic CLI exceeded its test deadline.')) }, 10_000)
          child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
          child.stdout.on('data', text => { stdout += text }); child.stderr.on('data', text => { stderr += text })
          child.once('error', error => { clearTimeout(timer); reject(error) })
          child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
          child.stdin.end(stdin)
        })
      }
      const input: TopicKnowledgeWrite = { topicId: 'view:topic', entryId: category.categoryId, title: 'Original notebook and borrowed Note', content: '',
        form: 'reference', certainty: 'proposal', sources: [{ kind: 'notebook', notebookId: 'original-notebook' }, { kind: 'note', noteId: 'borrowed-note' }], expectedRevision: null }
      const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
      try {
        const written = await client.call('topic.knowledge.write', input)
        expect(written.entry.sources).toEqual(input.sources)
        expect((await client.call('topic.knowledge.read', { topicId: input.topicId, entryId: input.entryId })).entry).toEqual(written.entry)
        const cliInput = { ...input, entryId: '22222222-2222-4222-8222-222222222222' }
        const saved = await run(['topic', 'knowledge', 'write', '--input', '-'], JSON.stringify(cliInput))
        expect(saved.code, saved.stderr).toBe(0)
        expect(JSON.parse(saved.stdout).result.entry.sources).toEqual(input.sources)
        const read = await run(['topic', 'knowledge', 'read', '--topic', input.topicId, '--entry', cliInput.entryId])
        expect(read.code, read.stderr).toBe(0)
        expect(JSON.parse(read.stdout).result.entry).toEqual(entries.get(cliInput.entryId))
        const admittedCalls = [...calls]
        await expect(client.call('topic.knowledge.write', { ...input, sources: [{ kind: 'notebook', notebookId: 'original-notebook', copiedChildren: [] }] } as unknown as TopicKnowledgeWrite))
          .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
        const refused = await run(['topic', 'knowledge', 'write', '--input', '-'], JSON.stringify({ ...cliInput, sources: [{ kind: 'notebook' }] }))
        expect(refused.code).not.toBe(0)
        expect(JSON.parse(refused.stderr).error.code).toBe('INVALID_CONTROL_REQUEST')
        expect(calls).toEqual(admittedCalls)
        expect(admittedCalls).toEqual(['topic.knowledge.write', 'topic.knowledge.read', 'topic.knowledge.write', 'topic.knowledge.read'])
        expect(entries.size).toBe(2)
      } finally { await client.dispose() }
    } finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
  }, 20_000)
})


describe('Topic Host routing retains the original content owner and authority', () => {
  const input = { topicId: 'view:original-topic', entryId: category.categoryId }
  const entry: TopicKnowledge = { ...input, title: 'Original knowledge', content: 'Original file remains at its owner.',
    form: 'derived', certainty: 'fact', sources: [{ kind: 'note', noteId: 'original-note' }], revision: category.revision!, updatedAt: 1 }
  it('prefers the local content owner and reports unknown when neither original owner port exists', async () => {
    const local = vi.fn(async () => ({ entry })), forward = vi.fn(async () => { throw new Error('Local Topic must not be forwarded.') })
    const service = new RpcService({ coreClients: () => [], topics: { call: local as never }, forwardControl: forward })
    const unavailable = new RpcService({ coreClients: () => [] })
    try {
      expect(await service.call('topic.knowledge.read', input)).toEqual({ entry })
      expect(local).toHaveBeenCalledExactlyOnceWith('topic.knowledge.read', input, {})
      expect(forward).not.toHaveBeenCalled()
      await expect(unavailable.call('topic.knowledge.read', input)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    } finally { await service.dispose(); await unavailable.dispose() }
  })
  it('forwards the parsed exact Topic method/input/context and validates the original owner result', async () => {
    const controller = new AbortController(), afterResponse: Array<() => void> = []
    const context: AgentMuxRpcCallContext = { signal: controller.signal, principal: { kind: 'user', id: 'original-user' }, afterResponse, transport: 'unix' }
    let result: unknown = { entry }
    const forward = vi.fn(async (..._args: unknown[]) => result as never), service = new RpcService({ coreClients: () => [], forwardControl: forward })
    try {
      expect(await service.call('topic.knowledge.read', input, context)).toEqual({ entry })
      expect(forward).toHaveBeenCalledExactlyOnceWith('topic.knowledge.read', input, context)
      expect(forward.mock.calls[0]?.[2]).toBe(context)
      result = { entry: { ...entry, topicId: 'view:another-owner' } }
      await expect(service.call('topic.knowledge.read', input, context)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
      result = { entry: { ...entry, revision: 'unconfirmed' } }
      await expect(service.call('topic.knowledge.read', input, context)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
      const count = forward.mock.calls.length
      await expect(service.call('topic.knowledge.read', { ...input, caller: { id: 'spoof' } } as never, context)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
      expect(forward).toHaveBeenCalledTimes(count)
      controller.abort()
      await expect(service.call('topic.knowledge.read', input, context)).rejects.toMatchObject({ name: 'AbortError' })
      expect(forward).toHaveBeenCalledTimes(count)
    } finally { await service.dispose() }
  })
  it('authenticates the exact managed caller before forwarding and retains original authority errors', async () => {
    const fixture = await rpcOwnerFixture(['original-source-agent'])
    const context: AgentMuxRpcCallContext = { caller: fixture.credentials, signal: new AbortController().signal }
    const forward = vi.fn(async (..._args: unknown[]) => ({ entry } as never)), service = new RpcService({ coreClients: fixture.coreClients, forwardControl: forward })
    const before = fixture.client.agentSession('original-source-agent')
    try {
      expect(await service.call('topic.knowledge.read', input, context)).toEqual({ entry })
      expect(forward).toHaveBeenCalledExactlyOnceWith('topic.knowledge.read', input, context)
      for (const caller of [{ ...fixture.credentials, capability: 'invalid-capability' }, { ...fixture.credentials, agentSessionId: 'original-source' }]) {
        await expect(service.call('topic.knowledge.read', input, { caller })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
      }
      expect(forward).toHaveBeenCalledTimes(1)
      const refusal = Object.assign(new Error('The original content owner refused this write.'), { code: 'TOPIC_CONTENT_CONFLICT', detail: 'original-owner-revision' })
      forward.mockRejectedValueOnce(refusal)
      await expect(service.call('topic.knowledge.read', input, context)).rejects.toBe(refusal)
      expect(fixture.client.agentSession('original-source-agent')).toEqual(before)
      expect(fixture.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await service.dispose(); await fixture.close() }
  })
})
