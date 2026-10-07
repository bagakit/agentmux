import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'

it('retains literal executable diagnostics through the actual Host owner, Unix RPC and public CLI', async () => {
  const f = await rpcOwnerFixture()
  const owner = new AgentMuxHostExecutorOwner({ path: join(f.root, 'executors.json'), runtimeId: 'target-runtime',
    catalog: () => new AgentProviderRegistry().catalog(), environment: () => ({ PATH: f.root }) })
  Object.assign(f.client, { hostExecutorOwner: owner })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'public.sock'), coreClients: () => [{ hostId: 'target', client: f.client }] })
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  try {
    await server.start()
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    const bin = join(f.root, 'Tool Directory', 'literal wrapper')
    await mkdir(join(f.root, 'Tool Directory'))
    await writeFile(bin, '#!/bin/sh\nexit 0\n'); await chmod(bin, 0o755)
    const base = { label: 'Literal', providerId: 'codex', args: ['--name', 'two words', ''], env: {}, injectAgentMuxGuide: true }
    for (const [executorId, command] of [['valid', bin], ['whole-line', bin + ' --name "two words"']] as const) {
      await rpc.call('settings.executors.register', { hostId: 'target', executorId, input: { config: { ...base, command } } })
    }
    const observed = await rpc.call('settings.executors.discover', { hostId: 'target' })
    const valid = observed.executors.find(item => item.executorId === 'valid')!
    const missing = observed.executors.find(item => item.executorId === 'whole-line')!
    expect(valid).toMatchObject({ command: bin, executable: bin, availability: 'available' })
    expect(missing).toMatchObject({ command: bin + ' --name "two words"', availability: 'missing', cause: { code: 'EXECUTABLE_NOT_FOUND' } })
    expect(missing.cause!.message).toContain(JSON.stringify(missing.command))
    expect(missing.cause!.message).toContain('args')
    expect(missing.cause!.message).not.toContain('not installed')
    const cli = await promisify(execFile)(process.execPath, [resolve('packages/core/bin/amux'), '--endpoint', 'unix:' + server.path,
      'settings', 'executors', 'discover', '--host', 'target'], { timeout: 10000,
      env: { ...process.env, AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined, AGENTMUX_ENV: undefined, AGENTMUX_RUNTIME_DIRECTORY: f.root } })
    const reported = JSON.parse(cli.stdout).result
    expect(reported.routeHostId).toBe('target')
    expect(reported.executors.find((item: { executorId: string }) => item.executorId === 'whole-line')).toEqual(missing)
    expect(reported.executors.find((item: { executorId: string }) => item.executorId === 'valid')).toEqual(valid)
  } finally { await rpc?.dispose(); await server.stop(); await f.close() }
})
