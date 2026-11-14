import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { expect, vi } from 'vitest'
// The Host resolves Core by its package name. Any other copy is a second class whose
// spies never reach the Host's client, which would then activate a real detached Runtime.
import * as core from '@agentmux/core'
import type { AgentMuxHostedClient } from '../../../../packages/core/src/hosted.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../../../../packages/core/src/hosted-client-contract.js'
import { rpcOwnerFixture } from '../../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, type CliResult } from '../../../../packages/core/test/helpers/object-cli-rpc.js'
import { startAgentMuxHost } from '../../src/host.js'

export type CrossHostCleanup = Array<() => void | Promise<void>>
// Give each new test namespace its actual semantic identity before the fixture
// imports its first Session. Reopening a used database without that identity is
// correctly refused by the product. Later Host restarts reuse these same bytes.
class GoalFixtureStore extends core.AgentMuxFileAgentSessionStore {
  private initialized = false
  override async compareAndSwap(...args: Parameters<core.AgentMuxFileAgentSessionStore['compareAndSwap']>): Promise<void> {
    if (!this.initialized) {
      this.initialized = true
      const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockResolvedValue()
      try {
        const runtime = await core.startHeadlessAgentMux({ store: this, socketPath: join(dirname(this.path), 'initialize.sock') })
        await runtime.stop()
      } finally { connect.mockRestore() }
    }
    return super.compareAndSwap(...args)
  }
}

/** Two genuine semantic owners; only the Native byte transport is deterministic. */
export async function crossHostOwner(cleanup: CrossHostCleanup, name: string, ids: string[]) {
  const original = await rpcOwnerFixture(ids, { AgentMuxClient: core.AgentMuxClient, AgentMuxFileAgentSessionStore: GoalFixtureStore }, () => ({ providerId: 'claude', executorId: 'claude' }))
  cleanup.push(async () => {
    const activated = existsSync(join(original.root, 'ctxmux.sock'))
    await original.close()
    expect.soft(activated, 'A real Runtime outlives this private root; only the Native byte transport may serve these owners.').toBe(false)
  })
  for (const agentSessionId of ids) {
    const previous = (await original.store.readMetadata(agentSessionId))!
    await original.store.compareAndSwap(previous, { ...previous, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: name + '-' + agentSessionId + '-native', transcriptPath: join(original.root, 'native.jsonl') } })
  }
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(AGENTMUX_|CTXMUX_)/u.test(key)))
  const directory = join(original.root, 'connections'), socketPath = join(original.root, name + '.sock')
  const configurationPath = join(original.root, 'configuration.json')
  await mkdir(directory, { mode: 0o700 })
  await writeFile(join(original.root, 'native.jsonl'), '')
  await writeFile(configurationPath, JSON.stringify({ workspaces: [{ id: 'original-project', name: 'Original project', kind: 'folder', hostId: 'local', path: original.root }], executors: {}, hosts: [{ id: 'local', kind: 'local', label: name }] }))
  const native = original.inner.kernel
  await original.client.dispose()
  let clients: { hostId: string; client: AgentMuxHostedClient }[] = []
  let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
  let rpc: Awaited<ReturnType<typeof core.connectAgentMuxRpc>>
  let reader: AgentMuxHostedClient
  let identity: AgentMuxRuntimeOwnerIdentity
  const forwarded: Array<{ method: string; params: unknown; result?: unknown }> = []
  let lostIntakeAck = false
  const start = async () => {
    for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_')) vi.stubEnv(key, undefined)
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
      const inner = this as unknown as typeof original.inner
      await inner.registry.load('local'); inner.connected = true
      for (const key of ['connect', 'isConnected', 'status', 'identity', 'input', 'openInput', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[key] = native[key]
      this.providers.get('claude').planPromptInput = text => ({ kind: 'single-phase', data: text + '\r' })
    })
    try {
      host = await startAgentMuxHost({ store: original.store, socketPath, configurationPath,
        desktopSocketPath: join(original.root, 'absent-desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile'),
        connections: { directory, clients: () => clients } })
      await vi.waitFor(() => expect((host!.client as unknown as typeof original.inner).connected).toBe(true))
    } finally { connect.mockRestore() }
    rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
    identity = (await rpc.call('runtime.owner.identity', {})).owner
    reader = await core.connectHostedAgentMux({ rpc, expectedRuntimeId: identity.runtimeId, forwardRpc: async (method, params, context) => {
      const entry = { method, params: structuredClone(params) } as typeof forwarded[number]; forwarded.push(entry)
      const result = await rpc.call(method, params, context); entry.result = result
      if (method === 'message.federation.intake' && lostIntakeAck) { lostIntakeAck = false; throw Object.assign(Error('The private transport lost the original committed intake ACK.'), { code: 'CONTROL_UNAVAILABLE' }) }
      return result
    } })
  }
  const stop = async () => { await reader?.dispose(); await rpc?.dispose(); const previous = host; host = undefined; await previous?.dispose() }
  cleanup.push(stop); await start()
  const cliReceipts: unknown[] = []
  const cli = async (who: string | null, args: string[], input?: unknown, capability = original.capability): Promise<CliResult> => {
    const env = objectCliEnvironment(original.root, { ...(who ? { AGENTMUX_AGENT_SESSION_ID: who, AGENTMUX_AGENT_CAPABILITY: capability } : {}) })
    const result = await new Promise<CliResult>((accept, reject) => {
      const child = spawn(process.execPath, ['--experimental-transform-types', '--import', resolve('apps/host/test/goal-cross-host-node-loader.mjs'), resolve('packages/core/bin/amux'), '--endpoint', 'unix:' + socketPath, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('The private public CLI exceeded its bounded deadline.')) }, 20_000)
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => { clearTimeout(timer); accept({ code, stdout, stderr }) })
      child.stdin.end(input === undefined ? '' : JSON.stringify(input))
    })
    cliReceipts.push({ who, args, input, ...result }); return result
  }
  const call = async (who: string | null, args: string[], input?: unknown) => {
    const result = await cli(who, args, input)
    expect(result.code, result.stderr || result.stdout).toBe(0)
    const receipt = JSON.parse(result.stdout); expect(receipt.ok).toBe(true); return receipt.result
  }
  return { original, native, configurationPath, socketPath, get rpc() { return rpc }, get reader() { return reader }, get identity() { return identity },
    client: () => host!.client, start, stop, cli, call, cliReceipts, forwarded, loseNextIntakeAck: () => { lostIntakeAck = true }, routes: (value: typeof clients) => { clients = value } }
}
