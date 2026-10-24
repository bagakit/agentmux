// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, mkdir, readdir, stat, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { AgentMuxRpcService, type AgentMuxRpcCorePort } from '../../../packages/core/src/public-rpc-service'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { parseRpcNativeResult } from '../../../packages/core/src/rpc-native-codec'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli'

const cleanup: Array<() => unknown> = []
afterEach(async () => { const errors: unknown[] = []; for (const close of cleanup.splice(0).reverse()) { try { await close() } catch (error) { errors.push(error) } }; expect(errors).toEqual([]) })
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-skills-')), root = `.skills-${randomUUID()}`
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, root, 'review', 'SKILL.md')
  await mkdir(join(directory, root, 'review'), { recursive: true })
  await writeFile(path, '---\nname: review-original\ndescription: Check the original evidence\n---\nRead only.\n')
  const session = { agentSessionId: 'original-session', hostId: 'local', providerId: 'original-provider', workspacePath: directory }
  const readAgentSession = vi.fn(async (id: string) => id === session.agentSessionId ? session : null)
  const port = { readAgentSession, catalog: () => [{ id: session.providerId, composer: { skillRoots: [root] } }] } as unknown as AgentMuxRpcCorePort
  return { directory, skillRoot: join(directory, root), path, session, readAgentSession, port }
}
it('reads original Provider roots through the real public service, CLI parser and transport without changing the Session', async () => {
  const f = await setup(), before = structuredClone(f.session)
  const server = new AgentMuxControlServer({ coreClients: () => [{ hostId: 'local', client: f.port }] }, join(f.directory, 'rpc.sock'))
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const params = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const expected = { ...params, sourceHostId: 'local', providerId: f.session.providerId, workspacePath: f.directory,
    skills: [{ name: 'review-original', description: 'Check the original evidence', path: f.path, source: 'project' }] }
  expect(await rpc.call('skill.ls', params)).toEqual(expected)
  expect(f.readAgentSession.mock.calls).toEqual([[f.session.agentSessionId]])
  const env = { ...process.env, AGENTMUX_RPC_ENDPOINT: 'unix:' + server.path }
  for (const key of Object.keys(env)) if (/^AGENTMUX_(?:AGENT|SESSION|RUN|CALLER|HOOK|CONTROL)/u.test(key)) delete env[key]
  const cli = await runSourceObjectCli(['skill', 'ls', '--host', 'local', '--session', f.session.agentSessionId], env)
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result).toEqual(expected)
  const help = await runSourceObjectCli(['skill', 'ls', '--help'], env)
  expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('--host ID --session ID')
  const guide = await runSourceObjectCli(['skill', '--skill'], env)
  expect(guide.code, guide.stderr).toBe(0); expect(guide.stdout).toContain('does not execute a Skill')
  expect(f.session).toEqual(before)
}, 30000)
it('reports a real unreadable Skill root even with a warm cache and recovers the original Skills after chmod', async () => {
  const f = await setup(), before = structuredClone(f.session)
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.port }] })
  cleanup.push(() => service.dispose())
  const input = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const expected = await service.call('skill.ls', input)
  expect(expected.skills).toHaveLength(1)
  for (const directory of [f.skillRoot, f.directory]) {
    const metadata = await stat(directory)
    await chmod(directory, 0)
    try {
      await expect(readdir(directory)).rejects.toMatchObject({ code: 'EACCES' })
      expect((await stat(directory)).mtimeMs).toBe(metadata.mtimeMs)
      // Reopening while denied must not produce either cached success or a cached empty listing.
      await expect(service.call('skill.ls', input)).rejects.toMatchObject({ code: 'EACCES' })
      await expect(service.call('skill.ls', input)).rejects.toMatchObject({ code: 'EACCES' })
    } finally { await chmod(directory, metadata.mode & 0o7777) }
    expect(await service.call('skill.ls', input)).toEqual(expected)
  }
  expect(f.session).toEqual(before)
})
it('keeps missing and non-directory roots empty while malformed YAML still allows valid siblings', async () => {
  const f = await setup()
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.port }] })
  cleanup.push(() => service.dispose())
  const input = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  await mkdir(join(f.skillRoot, 'invalid'))
  await writeFile(join(f.skillRoot, 'invalid', 'SKILL.md'), '---\nname: [unterminated\n---\n')
  expect((await service.call('skill.ls', input)).skills.map((skill) => skill.path)).toEqual([f.path])
  await rm(f.skillRoot, { recursive: true })
  expect((await service.call('skill.ls', input)).skills).toEqual([])
  await writeFile(f.skillRoot, 'A regular file is not a Skill root.')
  expect((await service.call('skill.ls', input)).skills).toEqual([])
})
it('rejects an unavailable original or substituted directory and validates original result identity', async () => {
  const f = await setup(), service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.port }] })
  cleanup.push(() => service.dispose())
  const input = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  await expect(service.call('skill.ls', { ...input, workspacePath: tmpdir() } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(service.call('skill.ls', { ...input, hostId: 'unknown-host' })).rejects.toMatchObject({ code: 'UNKNOWN_HOST' })
  await expect(service.call('skill.ls', { ...input, agentSessionId: 'original' })).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  f.readAgentSession.mockResolvedValueOnce({ ...f.session, agentSessionId: 'other-session' })
  await expect(service.call('skill.ls', input)).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  f.readAgentSession.mockResolvedValueOnce({ ...f.session, hostId: 'other-host' })
  await expect(service.call('skill.ls', input)).rejects.toMatchObject({ code: 'UNKNOWN_AGENT_SESSION' })
  const page = await service.call('skill.ls', input)
  expect(() => parseRpcNativeResult('skill.ls', { ...page, agentSessionId: 'other' }, input)).toThrow()
  expect(() => parseRpcNativeResult('skill.ls', { ...page, skills: [{ ...page.skills[0], source: 'display-text' }] }, input)).toThrow()
  f.readAgentSession.mockRejectedValueOnce(new Error('Original Store unavailable'))
  await expect(service.call('skill.ls', input)).rejects.toThrow('Original Store unavailable')
})
it('reads a configured remote at its original local namespace and preserves the returned source Host', async () => {
  const page = { hostId: 'local', sourceHostId: 'local', agentSessionId: 'remote-session', providerId: 'original-provider', workspacePath: '/original/work', skills: [] }
  const forwardRpc = vi.fn(async () => page)
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'remote-route', client: { forwardRpc } as unknown as AgentMuxRpcCorePort }] })
  cleanup.push(() => service.dispose())
  expect(await service.call('skill.ls', { hostId: 'remote-route', agentSessionId: page.agentSessionId })).toEqual({ ...page, hostId: 'remote-route' })
  expect(forwardRpc).toHaveBeenCalledExactlyOnceWith('skill.ls', { hostId: 'local', agentSessionId: page.agentSessionId }, expect.any(Object))
})
