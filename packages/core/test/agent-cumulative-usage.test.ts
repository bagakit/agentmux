import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { extractTurnUsage, parseTurnUsage } from '../src/agent-usage-transcript.js'
import { decodeClaudeUsage } from '../src/providers/claude-usage.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions, normalizeAgentSession } from '../src/agent-session-store.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { runAgentHookCommand } from '../src/agent-hook-command.js'
import type { AgentHookServer } from '../src/hook-server.js'
import type { AgentTurnUsage } from '../src/types.js'
import { Readable } from 'node:stream'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { ObjectCliProbe, objectCliEnvironment, type CliResult } from './helpers/object-cli-rpc.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const response = { input_tokens: 29, output_tokens: 7, total_tokens: 43 }
const cumulative = { scope: 'native-session' as const, inputTokens: 400, outputTokens: 90, totalTokens: 523 }
const rawCumulative = { input_tokens: 400, output_tokens: 90, total_tokens: 523 }
const context = { usedTokens: 43, capacityTokens: 256 }
const rollout = (total: unknown) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
  last_token_usage: response, model_context_window: 256, ...(total === undefined ? {} : { total_token_usage: total })
} } }) + '\n'

let directory = '', cli = ''
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cumulative-usage-cli-'))
  cli = join(directory, 'amux.mjs')
  const core = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
  await symlink(join(core, 'node_modules'), join(directory, 'node_modules'), 'dir')
  const result = await build({ entryPoints: [join(core, 'src/agentmux.ts')], outfile: cli,
    bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent', metafile: true })
  if (process.env.AGENTMUX_USAGE_CLI_BUILD) {
    await appendFile(process.env.AGENTMUX_USAGE_CLI_BUILD, JSON.stringify({ kind: 'compiled-cli',
      sha256: createHash('sha256').update(await readFile(cli)).digest('hex') }) + '\n')
    const root = resolve(core, '../..')
    for (const input of Object.keys(result.metafile.inputs)) {
      const path = relative(root, resolve(input))
      if (!path.startsWith('packages/core/src/')) continue
      await appendFile(process.env.AGENTMUX_USAGE_CLI_BUILD, JSON.stringify({ path,
        sha256: createHash('sha256').update(await readFile(resolve(input))).digest('hex') }) + '\n')
    }
  }
})
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

function run(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Original CLI exceeded its bounded read deadline.')) }, 10_000)
    child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

async function fixture() {
  const h = await rpcOwnerFixture(['usage-agent'])
  const path = join(h.root, 'rollout.jsonl')
  const native = { kind: 'provider' as const, providerId: 'codex', sessionId: 'usage-native', transcriptPath: path }
  // The process/native witness is the only synthetic identity port. The original
  // Hook worker, authenticated ingress, normalization, CAS/file and RPC are real.
  Reflect.get(h.client, 'hookNativeWitnesses').set('run-usage-agent', { candidate: JSON.stringify(native.sessionId), handle: native })
  const hook = Reflect.get(h.client, 'hookServer') as AgentHookServer
  Object.defineProperty(hook, 'port', { value: 0 }); await hook.start()
  const binding = hook.createBinding('usage-agent', 'codex'); await binding.bindRun('run-usage-agent')
  const server = new AgentMuxControlServer({ coreClients: h.coreClients, socketPath: join(h.root, 'owner.sock') })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  async function observe(total: unknown, extra = {}) {
    await writeFile(path, rollout(total))
    const environment = Reflect.get(h.client, 'agentEnvironment').call(h.client, {}, 'usage-agent', 'codex', 'codex', binding, 'usage-observation', h.capability) as Record<string, string>
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
    const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!
    Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from([JSON.stringify({
      hook_event_name: 'Stop', session_id: native.sessionId, transcript_path: path, ...extra })]) })
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    try { await runAgentHookCommand() } finally { stdout.mockRestore(); Object.defineProperty(process, 'stdin', stdin) }
  }
  return { ...h, native, rpc, server, observe, close: async () => { await rpc.dispose(); await server.stop(); await h.close() } }
}

describe('native Session cumulative usage through original public consumers', () => {
  it('keeps native-session cumulative separate from response/context through the Hook, durable reload, typed RPC and freshly compiled CLI', async () => {
    const h = await fixture()
    try {
      await h.observe(rawCumulative)
      const expected: AgentTurnUsage = { scope: 'response', inputTokens: 29, outputTokens: 7, totalTokens: 43,
        context, cumulative, observedAt: h.client.agentSession('usage-agent').turnUsage!.observedAt }
      const durable = await loadAgentSessions(new AgentMuxFileAgentSessionStore(join(h.root, 'sessions.json')))
      const result = await h.rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'usage-agent' } })
      const command = await run(['--endpoint', 'unix:' + h.server.path, 'agent', 'inspect', '--session', 'usage-agent'], objectCliEnvironment(h.root))
      expect(result.session.turnUsage).toEqual(expected); expect(result.session.nativeHandle).toEqual(h.native)
      expect(result.session.run.runId).toBe('run-usage-agent')
      expect(h.client.agentSession('usage-agent').turnUsage).toEqual(expected); expect(durable[0]?.turnUsage).toEqual(expected)
      expect(command.code).toBe(0); expect(command.stderr).toBe('')
      expect(JSON.parse(command.stdout).result.session.turnUsage).toEqual(expected)
      expect(expected.cumulative!.totalTokens).not.toBe(expected.totalTokens)
      expect(expected.cumulative!.totalTokens).not.toBe(cumulative.inputTokens + cumulative.outputTokens)
      expect(h.inner.kernel.stop).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
    } finally { await h.close() }
  }, 20_000)

  it.each([undefined, { ...rawCumulative, total_tokens: -1 }, { input_tokens: 400, output_tokens: 90 }])(
    'keeps a valid response/context and clears prior cumulative when the latest original native total is missing or invalid (%j)', async total => {
      const h = await fixture()
      try {
        await h.observe(rawCumulative)
        expect(h.client.agentSession('usage-agent').turnUsage?.cumulative).toEqual(cumulative)
        await h.observe(total)
        const result = await h.rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'usage-agent' } })
        expect(result.session.turnUsage).toMatchObject({ scope: 'response', inputTokens: 29, outputTokens: 7, totalTokens: 43, context })
        expect(result.session.turnUsage?.cumulative).toBeUndefined()
        expect((await loadAgentSessions(h.store))[0]?.turnUsage?.cumulative).toBeUndefined()
        const command = await run(['--endpoint', 'unix:' + h.server.path, 'agent', 'inspect', '--session', 'usage-agent'], objectCliEnvironment(h.root))
        expect(command.code).toBe(0); expect(command.stderr).toBe('')
        expect(JSON.parse(command.stdout).result.session.turnUsage).toMatchObject({ totalTokens: 43, context })
        expect(JSON.parse(command.stdout).result.session.turnUsage.cumulative).toBeUndefined()
        expect(h.inner.kernel.stop).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
      } finally { await h.close() }
    }, 20_000)

  it('does not let a child native Hook replace the exact main Session accounting', async () => {
    const h = await fixture()
    try {
      await h.observe(rawCumulative)
      const original = h.client.agentSession('usage-agent').turnUsage
      Reflect.get(h.client, 'hookNativeWitnesses').set('run-usage-agent', { candidate: JSON.stringify(h.native.sessionId), handle: h.native, childSessionIds: ['native-child'] })
      await h.observe({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }, { agent_id: 'native-child' })
      expect((await h.rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'usage-agent' } })).session.turnUsage).toEqual(original)
    } finally { await h.close() }
  })

  it('drops invalid optional scope/counts at ingress and disk normalization without inventing cumulative for Claude', () => {
    const valid = { scope: 'response' as const, inputTokens: 29, outputTokens: 7, totalTokens: 43, context, observedAt: _historyFixtureEpoch(0, 0, 1) }
    for (const bad of [null, [], { ...cumulative, scope: 'response' }, { ...cumulative, totalTokens: Infinity },
      { ...cumulative, inputTokens: 1.5 }, { ...cumulative, outputTokens: '90' }]) {
      expect(parseTurnUsage({ ...valid, cumulative: bad })).toEqual(valid)
      expect(normalizeAgentSession({ kind: 'agent', agentSessionId: 'sample', providerId: 'codex', executorId: 'codex',
        hostId: 'local', workspacePath: 'fixture', run: { runId: 'sample-run' }, retiredRuns: [], createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1), turnUsage: { ...valid, cumulative: bad } }).turnUsage).toEqual(valid)
    }
    expect(extractTurnUsage(decodeClaudeUsage, JSON.stringify({
      message: { usage: { input_tokens: 3, output_tokens: 2, total_token_usage: rawCumulative } } }), 1)?.cumulative).toBeUndefined()
  })

  it('rejects a forged public cumulative scope in the actual typed RPC and compiled CLI without changing the original Session', async () => {
    const h = await fixture()
    let probe: ObjectCliProbe | undefined
    try {
      await h.observe(rawCumulative)
      const params = { target: { kind: 'agent-session' as const, agentSessionId: 'usage-agent' } }
      const legitimate = await h.rpc.call('agent.inspect', params)
      const forged = { ...legitimate, session: { ...legitimate.session, turnUsage: {
        ...legitimate.session.turnUsage!, cumulative: { ...cumulative, scope: 'response' }
      } } }
      probe = new ObjectCliProbe(() => forged); await probe.start()
      const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: probe.socketPath } })
      try {
        const code = await rpc.call('agent.inspect', params).then(() => undefined, (error: { code?: string }) => error.code)
        expect(code).toBe('CONTROL_PROTOCOL_ERROR')
      }
      finally { await rpc.dispose() }
      const command = await run(['--endpoint', 'unix:' + probe.socketPath, 'agent', 'inspect', '--session', 'usage-agent'], objectCliEnvironment(h.root))
      expect(command.code).toBe(1); expect(command.stderr).toContain('CONTROL_PROTOCOL_ERROR')
      expect(h.client.agentSession('usage-agent').turnUsage?.cumulative).toEqual(cumulative)
      expect(h.inner.kernel.stop).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
    } finally { await probe?.stop(); await h.close() }
  })
})
