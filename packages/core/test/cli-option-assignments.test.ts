import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AgentMuxControlServer, AgentMuxError } from '@agentmux/core'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-options-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const json = async (name: string, value: unknown) => {
    const path = join(root, name + '=literal.json')
    await writeFile(path, JSON.stringify(value)); return path
  }
  return { root, json }
}

it('compiled CLI assignments reach original public service owner ports with exact literal data', async () => {
  const { root, json } = await fixture()
  const seen: Array<{ method: string; params: unknown }> = []
  const reached = async (method: string, params: unknown): Promise<never> => {
    seen.push({ method, params })
    throw new AgentMuxError('Original controlled owner reached; no effect performed.', 'CLI_ASSIGNMENT_OWNER_REACHED')
  }
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [],
    nodePublishing: { call: reached }, forwardControl: reached,
    execute: async request => {
      const { schemaVersion: _schema, requestId: _id, operation, ...params } = request
      return reached(operation, params)
    } })
  await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(root)
  const path = await json('schedule', { operationId: '--host=literal-original' })
  for (const args of [
    ['schedule', 'inspect', '--data=' + path],
    ['node', 'inspect', '--host=local'],
    ['settings', 'hosts', 'home', '--host=local'],
    ['settings', 'prompts', 'inspect', '--id=--keyword=literal'],
    ['settings', 'themes', 'inspect', 'theme-original', '--output=' + join(root, 'theme=output.json')]
  ]) {
    const result = await runCompiledObjectCli(args, env)
    expect(result.code).not.toBe(0)
    expect(JSON.parse(result.stderr).error.code, result.stderr).toBe('CLI_ASSIGNMENT_OWNER_REACHED')
  }
  expect(seen).toEqual([
    { method: 'schedule.inspect', params: { operationId: '--host=literal-original' } },
    { method: 'node.inspect', params: { hostId: 'local' } },
    { method: 'settings.hosts.home', params: { hostId: 'local' } },
    { method: 'settings.prompts.inspect', params: { id: '--keyword=literal' } },
    { method: 'settings.themes.inspect', params: { id: 'theme-original' } }
  ])
  const before = seen.length
  for (const args of [
    ['schedule', 'inspect', '--data=' + path, '--data', path],
    ['node', 'inspect', '--host=local', '--host', 'other'],
    ['settings', 'hosts', 'home', '--host=local', '--host', 'other']
  ]) expect((await runCompiledObjectCli(args, env)).code).not.toBe(0)
  expect(seen).toHaveLength(before)
})

it('all pair-based domain carriers accept the shared spelling through their actual parsers', async () => {
  const { json } = await fixture()
  const progress = await json('progress', { target: { hostId: 'local', agentSessionId: 'SID', providerId: 'provider', workspacePath: '/fixture' } })
  const native = await json('native', { hostId: 'local' })
  const image = await json('image', { hostId: 'local', operationId: 'image-original' })
  const capsule = await json('capsule', {})
  const folder = await json('folder', { hostId: 'local', workspacePath: '/fixture', projectRootPath: '/fixture' })
  const memberInput = { target: { reference: { runtimeId: 'source', spaceId: 'SPACE' }, regionId: 'REGION', runtimeId: 'original', agentSessionId: 'SID', expectedRun: { runId: 'RUN' } },
    call: { method: 'runtime.owner.identity', params: { expectedRuntimeId: 'original' } } }
  const member = await json('member', memberInput)
  const cases: Array<[string[], string, unknown]> = [
    [['agent', 'progress', 'list', '--data=' + progress], 'agent.progress.list', { target: { hostId: 'local', agentSessionId: 'SID', providerId: 'provider', workspacePath: '/fixture' } }],
    [['native', 'capabilities', '--data=' + native], 'native.capabilities', { hostId: 'local' }],
    [['image', 'inspect', '--input=' + image], 'image.inspect', { hostId: 'local', operationId: 'image-original' }],
    [['capsule', 'ls', '--input=' + capsule], 'capsule.ls', {}],
    [['capsule', 'runtime', 'inspect', '--input=' + capsule], 'capsule.runtime.inspect', {}],
    [['node', 'locate', '--alias=studio', '--expected-runtime=original'], 'node.locate', { alias: 'studio', expectedRuntimeId: 'original' }],
    [['space', 'snapshot', '--runtime=original', '--space=SPACE'], 'space.snapshot', { reference: { runtimeId: 'original', spaceId: 'SPACE' } }],
    [['space', 'folder', 'register', '--runtime=original', '--workspace=WORKSPACE', '--input=' + folder], 'space.folder.register', { runtimeId: 'original', workspaceId: 'WORKSPACE', expectedResource: { hostId: 'local', workspacePath: '/fixture', projectRootPath: '/fixture' } }],
    [['route', 'edge', 'inspect', '--edge=EDGE'], 'route.edge.inspect', { edgeId: 'EDGE' }],
    [['space', 'member', 'call', '--input=' + member], 'space.member.call', memberInput]
  ]
  for (const [args, method, params] of cases) {
    const invocation = await parseAgentMuxCliInvocation(args)
    expect(invocation.command.method).toBe(method); expect(invocation.params).toEqual(params)
  }
})

it('preserves positional data, consumed option-looking values and real boolean syntax', async () => {
  expect((await parseAgentMuxCliInvocation(['settings', 'set', 'profile.label', '--host=literal'])).params)
    .toEqual({ key: 'profile.label', value: '--host=literal' })
  expect((await parseAgentMuxCliInvocation(['settings', 'hosts', 'test', '--input=literal-id'])).params)
    .toEqual({ id: '--input=literal-id' })
  expect((await parseAgentMuxCliInvocation(['settings', 'prompts', 'inspect', '--help'])).params).toEqual({ id: '--help' })
  expect((await parseAgentMuxCliInvocation(['settings', 'prompts', 'inspect', '--keyword=hello'])).params).toEqual({ keyword: 'hello' })
  expect((await parseAgentMuxCliInvocation(['toolkit', 'inspect', 'performance', '--failure-evidence', '--execution-id=--help'])).params)
    .toEqual({ toolId: 'performance', includeFailureEvidence: true, executionId: '--help' })
  expect((await parseAgentMuxCliInvocation(['toolkit', 'inspect', 'performance', '--execution-id', '--failure-evidence=literal'])).params)
    .toEqual({ toolId: 'performance', executionId: '--failure-evidence=literal' })
  expect((await parseAgentMuxCliInvocation(['agent', 'inspect', '--session=--help'])).params)
    .toEqual({ target: { kind: 'agent-session', agentSessionId: '--help' } })
  for (const args of [
    ['toolkit', 'watch', 'performance', '--evaluate=yes'],
    ['node', 'inspect', '--host'],
    ['node', 'inspect', '--host='],
    ['agent', 'inspect', '--session'],
    ['agent', 'ls', '--all=yes']
  ]) await expect(parseAgentMuxCliInvocation(args)).rejects.toBeDefined()
})
