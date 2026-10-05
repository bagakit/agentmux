import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function originalOwner(ids = ['healthy']) {
  const h = await rpcOwnerFixture(ids); cleanup.push(h.close)
  await h.store.applyTimelineMutation({ type: 'append', agentSessionId: ids[0]!, item: {
    id: 'original-input', agentSessionId: ids[0]!, kind: 'user_message', status: 'complete', source: 'user',
    createdAt: 1, updatedAt: 1, title: 'Original work', content: '原执行机器上的完整输入', authorHuman: true } })
  const source = new AgentMuxControlServer({ socketPath: join(h.root, 'source.sock'), coreClients: h.coreClients })
  await source.start(); cleanup.push(() => source.stop())
  const remote = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: source.path } }); cleanup.push(() => remote.dispose())
  // Actual original Core and public connection. This facade borrows that owner's
  // inventory/status and forwards context through a second real Unix service.
  const routed = new Proxy(h.client, { get(target, property) {
    if (property === 'forwardRpc') return remote.call.bind(remote)
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'build-host', client: routed }] })
  const controller = new AgentMuxControlServer({ socketPath: join(h.root, 'controller.sock'), coreClients: () => [{ hostId: 'build-host', client: routed }] })
  await controller.start(); cleanup.push(() => controller.stop())
  const cli = (path: string, args: string[], overrides: NodeJS.ProcessEnv = {}) => runCompiledObjectCli(
    ['--endpoint', path, ...args], objectCliEnvironment(h.root, overrides))
  return { ...h, source, controller, service, routed, cli }
}
function json(reply: Awaited<ReturnType<typeof runCompiledObjectCli>>) {
  expect(reply.code, reply.stderr).toBe(0); return JSON.parse(reply.stdout)
}
function keepRun(h: Awaited<ReturnType<typeof originalOwner>>) {
  for (const name of ['attach', 'detach', 'stop']) expect(h.inner.kernel[name]).not.toHaveBeenCalled()
}
it('actual compiled CLI consumes discovered routeHostId through the original public owner and preserves source identity', async () => {
  const h = await originalOwner(), endpoint = `unix:${h.controller.path}`, before = await readFile(join(h.root, 'sessions.json'))
  const listed = json(await h.cli(endpoint, ['agent', 'ls'])).result
  expect(listed.sessions).toHaveLength(1); expect(listed.errors).toEqual([])
  const discovered = listed.sessions[0]
  expect(discovered.routeHostId).toBe('build-host'); expect(discovered.session.hostId).toBe('local')
  const sid = discovered.session.agentSessionId
  for (const selector of [['--session', sid], ['--run', discovered.session.run.runId]]) {
    const inspected = json(await h.cli(endpoint, ['agent', 'inspect', ...selector])).result
    expect(inspected).toMatchObject({ routeHostId: 'build-host', session: { agentSessionId: sid, hostId: 'local' } })
  }
  const context = json(await h.cli(endpoint, ['agent', 'context', '--host', discovered.routeHostId, '--session', sid])).result
  expect(context).toMatchObject({ hostId: 'build-host', sourceHostId: 'local', session: { hostId: 'local' }, descriptor: { hostId: 'local' } })
  expect(context.captured.items[0].content).toBe('原执行机器上的完整输入')
  const snapshot = json(await h.cli(endpoint, ['app', 'snapshot', '--include', 'sessions'])).result
  expect(snapshot.sessions).toHaveLength(1); expect(snapshot.sessions[0]).toMatchObject({ routeHostId: discovered.routeHostId, session: discovered.session })
  expect(await readFile(join(h.root, 'sessions.json'))).toEqual(before); keepRun(h)
})
it('direct service local refers to that receiving original Core, and failures identify the exact service route', async () => {
  const h = await originalOwner(), endpoint = `unix:${h.source.path}`
  const listed = json(await h.cli(endpoint, ['agent', 'ls'])).result.sessions[0]
  expect(listed.routeHostId).toBe('local'); expect(listed.session.hostId).toBe('local')
  const context = json(await h.cli(endpoint, ['agent', 'context', '--host', listed.routeHostId, '--session', listed.session.agentSessionId])).result
  expect(context).toMatchObject({ hostId: 'local', sourceHostId: 'local' })
  const failed = await h.cli(endpoint, ['agent', 'context', '--host', 'build-host', '--session', 'healthy'])
  expect(failed.code).toBe(1); const error = JSON.parse(failed.stderr).error
  expect(error.code).toBe('UNKNOWN_HOST'); expect(error.message).toContain('build-host')
  expect(error.message).toContain('same endpoint'); expect(error.message).toContain('receiving Core service')
  const missing = await h.cli(endpoint, ['agent', 'context', '--host', 'local', '--session', 'missing'])
  expect(missing.code).toBe(1); expect(JSON.parse(missing.stderr).error).toMatchObject({ code: 'UNKNOWN_AGENT_SESSION', message: expect.stringContaining('route Host "local"') })
  expect(json(await h.cli(endpoint, ['agent', 'ls'])).result.sessions).toHaveLength(1); keepRun(h)
})
it('partial and unconfirmed inventories retain healthy discoveries and route-specific diagnostics', async () => {
  const h = await originalOwner(['healthy', 'unobserved'])
  const status = h.client.statusAgent.bind(h.client)
  vi.spyOn(h.client, 'statusAgent').mockImplementation(async id => {
    if (id === 'unobserved') throw new AgentMuxError('Status observation unavailable; original Agent retained.', 'PRIVATE_STATUS_UNKNOWN')
    return status(id)
  })
  const missing = new Proxy(h.routed, { get(target, property) {
    if (property === 'readAgentSessions') return async () => { throw new Error('Original store cannot be read') }
    return Reflect.get(target, property)
  } })
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'build-host', client: h.routed }, { hostId: 'other-host', client: missing }] })
  const response = await service.call('agent.ls', {})
  expect(response.sessions.map(item => [item.routeHostId, item.session.agentSessionId])).toEqual([['build-host', 'healthy']])
  expect(response.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ hostId: 'build-host', agentSessionId: 'unobserved', code: 'PRIVATE_STATUS_UNKNOWN' }),
    expect.objectContaining({ hostId: 'other-host', agentSessionId: null, code: 'AGENT_SESSION_STORE_READ_UNCONFIRMED' })
  ]))
  expect(() => parseRpcNativeResult('agent.ls', response, {})).not.toThrow()
  const snapshot = await service.call('app.snapshot', { include: ['sessions'] })
  expect(snapshot.unavailable.map(issue => issue.message)).toEqual(expect.arrayContaining([expect.stringContaining('Host "build-host" Session "unobserved"'), expect.stringContaining('Host "other-host"')]))
  expect(h.client.agentSessions()).toHaveLength(2); keepRun(h)
})
it('strict public consumption requires route facts while preserving original nested status shapes', async () => {
  const h = await originalOwner(), list = await h.service.call('agent.ls', {})
  const observed = list.sessions[0]!, { routeHostId, ...unrouted } = observed
  for (const missing of [undefined, '', null, 7]) {
    expect(() => parseRpcNativeResult('agent.ls', { sessions: [{ ...unrouted, ...(missing === undefined ? {} : { routeHostId: missing }) }], errors: [] }, {}))
      .toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  }
  expect(() => parseRpcNativeResult('agent.ls', { sessions: [], errors: [{ agentSessionId: 'unobserved', code: 'UNKNOWN', message: 'Unconfirmed' }] }, {}))
    .toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const inspection = await h.service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'healthy' } })
  expect(inspection.status).not.toHaveProperty('routeHostId')
  const { routeHostId: _, ...missingRoute } = inspection
  expect(() => parseRpcNativeResult('agent.inspect', missingRoute, { target: { kind: 'agent-session', agentSessionId: 'healthy' } })).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  const snapshot = await h.service.call('app.snapshot', { include: ['sessions'] })
  expect(() => parseRpcNativeResult('app.snapshot', { ...snapshot, sessions: [unrouted] }, { include: ['sessions'] })).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
})
it('endpoint selection is explicitly not attempted while an actual public response says only responded', async () => {
  const h = await originalOwner()
  // This absent socket cannot serve RPC. CLI endpoint selection still succeeds.
  const endpoint = `unix:${join(h.root, 'never-listening.sock')}`
  const selected = json(await h.cli(endpoint, ['system', 'endpoint'])).result
  expect(selected).toMatchObject({ connection: 'not-attempted', endpoint: { transport: 'unix', path: join(h.root, 'never-listening.sock') } })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: h.source.path } }); cleanup.push(() => rpc.dispose())
  const responded = await rpc.call('system.endpoint', {})
  expect(responded.connection).toBe('responded')
  const { connection, ...missing } = responded
  expect(() => parseRpcNativeResult('system.endpoint', missing, {})).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  expect(() => parseRpcNativeResult('system.endpoint', { ...responded, connection: 'not-attempted' }, {})).toThrow(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
})
it('actual compiled CLI SSH carrier reaches the official stdio leaf and original service using ordinary aliases', async () => {
  const h = await originalOwner(), carrier = join(h.root, 'carrier'), log = join(h.root, 'ssh.json')
  await mkdir(carrier)
  const cli = process.env.AGENTMUX_TEST_OBJECT_CLI ?? resolve('packages/core/bin/amux')
  // Controlled SSH executable tests real child stdio and both compiled CLI leaves.
  // It does not certify network reachability or OpenSSH authentication.
  await writeFile(join(carrier, 'ssh'), `#!${process.execPath}\nconst {writeFileSync}=require('node:fs');const {spawn}=require('node:child_process');writeFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2)));const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},'--endpoint',${JSON.stringify(`unix:${h.source.path}`)},'system','endpoint','--stdio'],{env:process.env,stdio:'inherit'});child.on('exit',code=>process.exit(code??1));\n`, { mode: 0o700 })
  const endpoint = `ssh://user@build-node/?socket=${encodeURIComponent(h.source.path)}`
  const listed = json(await h.cli(endpoint, ['agent', 'ls'], { PATH: carrier + ':' + process.env.PATH })).result.sessions[0]
  expect(listed).toMatchObject({ routeHostId: 'local', session: { agentSessionId: 'healthy', hostId: 'local' } })
  const context = json(await h.cli(endpoint, ['agent', 'context', '--host', listed.routeHostId, '--session', listed.session.agentSessionId], { PATH: carrier + ':' + process.env.PATH })).result
  expect(context.captured.items[0].content).toBe('原执行机器上的完整输入')
  const args = JSON.parse(await readFile(log, 'utf8'))
  expect(args).toContain('user@build-node'); expect(args.at(-1)).toContain("'system' 'endpoint' '--stdio'")
  expect(args.at(-1)).toContain(`'unix:${h.source.path}'`); keepRun(h)
})
it('compiled help, command help and skill share exact service-relative remote semantics', async () => {
  const h = await originalOwner()
  for (const args of [['--help'], ['--help', 'agent', 'context'], ['--skill']]) {
    const reply = await h.cli(`unix:${join(h.root, 'absent.sock')}`, args)
    expect(reply.code).toBe(0)
    for (const text of ["local means the receiving Core service's own machine", 'routeHostId', 'sourceHostId', 'same endpoint',
      'connection=not-attempted', 'connection=responded', 'ssh://user@build-node/', 'system endpoint --stdio']) expect(reply.stdout).toContain(text)
    expect(reply.stdout).not.toMatch(/\bfarm\b/i)
  }
})
