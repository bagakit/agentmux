import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { headlessFixture } from './helpers/headless-runtime-fixture.js'

const exec = promisify(execFile)
const entry = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

it('observes the exact saved ACP invocation through built CLI, typed RPC and the real Host', async () => {
  const scope = await headlessFixture({ cli: true })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } })
  try {
    const trace = join(scope.root, 'acp-requests.ndjson')
    const register = async (scenario: string) => await rpc.call('settings.executors.register', {
      hostId: 'local', executorId: `acp-${scenario}`, input: { config: {
        label: `ACP ${scenario}`, providerId: 'antigravity', command: entry('./fixtures/acp-probe-cli.mjs'),
        args: [scenario], env: { ACP_PROBE_TRACE: trace }, injectAgentMuxGuide: false
      } }
    })
    const target = async (scenario: string) => {
      const registered = await register(scenario)
      return { hostId: 'local', runtimeId: registered.runtimeId, executorId: registered.executor.executorId,
        configRevision: registered.executor.configRevision, workspacePath: scope.root }
    }
    const calls = async () => await readFile(trace, 'utf8').then(body => body.trim().split('\n').map(line => JSON.parse(line)), error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const signedOut = await target('signed-out')
    const declarations = await rpc.call('agent.provider.ls', { hostId: 'local', providerId: 'antigravity' })
    expect(declarations.catalog).toMatchObject([{ id: 'antigravity', capabilities: { terminal: true, providerResume: true } }])
    await expect(rpc.call('agent.provider.probe', { ...signedOut, hostId: 'another-host' })).rejects.toMatchObject({ code: 'UNKNOWN_HOST' })
    await expect(rpc.call('agent.provider.probe', { ...signedOut, runtimeId: 'another-runtime' })).rejects.toMatchObject({ code: 'EXECUTOR_HOST_CHANGED' })
    await expect(rpc.call('agent.provider.probe', { ...signedOut, executorId: 'another-executor' })).rejects.toMatchObject({ code: 'EXECUTOR_CONFIGURATION_CHANGED' })
    await expect(rpc.call('agent.provider.probe', { ...signedOut, configRevision: 'stale-revision' })).rejects.toMatchObject({ code: 'EXECUTOR_CONFIGURATION_CHANGED' })
    expect(await calls()).toEqual([])

    const { stdout, stderr } = await exec(process.execPath, [entry('../bin/amux'), '--endpoint', `unix:${scope.socketPath}`,
      'agent', 'provider', 'probe', '--host', signedOut.hostId, '--runtime', signedOut.runtimeId, '--executor', signedOut.executorId,
      '--config-revision', signedOut.configRevision, '--workspace', signedOut.workspacePath], { env: scope.env })
    const handshake = { protocolVersion: 1, sessions: { list: true, load: true, resume: true, close: false, additionalDirectories: false },
      prompt: { image: true, audio: false, embeddedContext: false } }
    expect(JSON.parse(stdout).result).toEqual({ routeHostId: 'local', runtimeId: signedOut.runtimeId, executorId: signedOut.executorId,
      configRevision: signedOut.configRevision, workspacePath: scope.root, providerId: 'antigravity', handshake,
      service: { state: 'authentication-required', stage: 'session/list', rpcCode: -32000 } })
    expect(stdout + stderr).not.toContain('private text from the native process')
    expect(stdout + stderr).not.toContain('private token')
    const ready = await rpc.call('agent.provider.probe', await target('ready'))
    expect(ready).toMatchObject({ handshake, service: { state: 'ready', stage: 'session/list' } })
    expect(JSON.stringify(ready)).not.toContain('private-session')
    expect(JSON.stringify(ready)).not.toContain('private title')
    await expect(rpc.call('agent.provider.probe', await target('no-list'))).resolves.toMatchObject({
      handshake: { sessions: { list: false } }, service: { state: 'unsupported', stage: 'session/list' }
    })
    await expect(rpc.call('agent.provider.probe', await target('bad-response'))).resolves.toMatchObject({
      handshake, service: { state: 'unconfirmed', stage: 'session/list', reason: 'invalid-response' }
    })
    const initialize = { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'agentmux', version: '1' } }
    const cwd = await realpath(scope.root)
    expect(await calls()).toEqual(['signed-out', 'ready', 'no-list', 'bad-response'].flatMap(scenario => [
      { scenario, cwd, method: 'initialize', params: initialize },
      ...(scenario === 'no-list' ? [] : [{ scenario, cwd, method: 'session/list', params: { cwd: scope.root } }])
    ]))
  } finally {
    await rpc.dispose()
    await scope.cleanup()
  }
}, 60_000)
