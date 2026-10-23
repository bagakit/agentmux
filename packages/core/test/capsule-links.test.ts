import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NodeCapsuleOwner } from '@agentmux/capsule/node'
import { formatAmuxObjectLink, formatCapsuleAddress, parseAmuxObjectLink } from '../src/sharing.js'
import { searchAgentMuxMetadata } from '../src/search-metadata.js'
import { agentMuxSearchTargetKey } from '../src/search-contract.js'
import { parseAgentMuxSearchPage } from '../src/search-codec.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const catalog = () => ({ spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] })

it('round trips the exact original Capsule identity without executable additions or normalization', () => {
  const id = 'original/page 中文?#%'
  const uri = formatCapsuleAddress(id)
  expect(uri).toBe('amux://capsule/original%2Fpage%20%E4%B8%AD%E6%96%87%3F%23%25')
  expect(formatAmuxObjectLink({ kind: 'capsule', capsuleId: id })).toBe(uri)
  expect(parseAmuxObjectLink(uri)).toEqual({ kind: 'capsule', capsuleId: id })
  const invalid = ['amux://capsule/', 'amux://capsule/a/b', 'amux://capsule/a/', 'amux://capsule/a?open=1',
    'amux://capsule/a#reply', 'amux://CAPSULE/a', 'amux://capsule/%61', 'amux://capsule/%2f', 'amux://capsule/%', 'amux://capsule/%FF']
  expect(invalid).toHaveLength(10)
  for (const value of invalid) expect(() => parseAmuxObjectLink(value)).toThrow()
})

it('matches Capsule links by their typed identity without confusing an Agent or spatial scalar', () => {
  const target = { kind: 'capsule' as const, capsuleId: '123456789ABC', hostId: 'local' }
  const result = searchAgentMuxMetadata(formatCapsuleAddress(target.capsuleId), {
    sessions: [{ agentSessionId: target.capsuleId, hostId: 'local', kind: 'agent', identities: [], text: [] }],
    catalog: catalog(), projects: [], sources: [],
    objects: [{ target, name: 'Original page', identities: [], text: [], locations: [] },
      { target: { kind: 'region', regionId: target.capsuleId }, name: 'Same scalar', identities: [], text: [], locations: [] }]
  })
  expect(result.issue).toBeNull(); expect(result.objects.map(object => object.target)).toEqual([target])
  expect(result.sessions).toEqual([]); expect(result.locations).toEqual([])
  expect(agentMuxSearchTargetKey(target)).toBe(JSON.stringify(['capsule', 'local', target.capsuleId]))
})

it('finds the original Capsule through actual public search and the compiled CLI using the same owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capsule-links-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'page'); await mkdir(source); await writeFile(join(source, 'index.html'), '<title>Durable original</title>')
  const owner = await NodeCapsuleOwner.open({ stateDirectory: join(root, 'capsules') }); cleanup.push(() => owner.close())
  const original = await owner.call('capsule.create', { operationId: 'original-create', sourcePath: source, title: 'Durable original' })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'rpc.sock'), coreClients: () => [], capsules: owner,
    execute: async request => {
      if (request.operation === 'space.ls') return { operation: 'space.ls', catalog: catalog() }
      if (request.operation === 'list.projects') return { operation: 'list.projects', projects: [] }
      throw new Error('Search must not operate unrelated resources')
    }, snapshot: async () => ({ workspaces: [], topics: [], motes: [], unavailable: [] }) })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const input = { mode: 'metadata' as const, query: formatCapsuleAddress(original.record.capsuleId) }
  const page = await rpc.call('app.search', input)
  expect(page.coverage.complete).toBe(true)
  expect(page.hits).toEqual([{ kind: 'object', target: { kind: 'capsule', capsuleId: original.record.capsuleId, hostId: 'local' }, name: 'Durable original', locations: [] }])
  const cli = await runCompiledObjectCli(['--endpoint', `unix:${server.path}`, 'app', 'search', '--mode', 'metadata', '--query', input.query], objectCliEnvironment(root))
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.hits).toEqual(page.hits)
  expect(() => parseAgentMuxSearchPage({ ...page, hits: [{ ...page.hits[0], target: { kind: 'capsule', capsuleId: original.record.capsuleId, zoneId: 'forged' } }] }, input)).toThrow()
})
