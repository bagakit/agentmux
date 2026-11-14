import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { AgentHookServer } from '../../src/hook-server.js'
import type { NativeHookEnvelope } from '../../src/types.js'

it('loads shared product plugin in simultaneous native TUI Workers and authenticates only their original Core Runs', async () => {
  const binary = process.env.AGENTMUX_OPENCODE_NATIVE_BINARY
  expect(binary, 'Native proof requires an explicitly selected verified artifact').toBeTruthy()
  const root = await mkdtemp(join(tmpdir(), 'amx-opencode-native-'))
  const workspace = join(root, 'workspace'), config = join(root, 'config', 'opencode')
  const acknowledgement = join(root, 'accepted'), observed: NativeHookEnvelope[] = []
  const server = new AgentHookServer(event => { observed.push(event) }, 0)
  await mkdir(workspace); await server.start()
  const provider = new AgentProviderRegistry().get('opencode')
  const hosts: { label: string; env: Record<string, string> }[] = []
  for (const label of ['a', 'b', 'outside']) {
    const home = join(root, label); await mkdir(home)
    const env: Record<string, string> = {
      HOME: home, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(root, 'cache'),
      npm_config_cache: join(root, 'npm-cache'),
      OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_PRUNE: '1',
      OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: [] })
    }
    const launch = provider.buildLaunch({ workspacePath: workspace, prompt: '', args: [], env, commandOverride: binary! })
    if (label !== 'outside') {
      const binding = server.createBinding(`original-agent-${label}`, 'opencode'); await binding.bindRun(`original-run-${label}`)
      Object.assign(launch.env, { AGENTMUX_ENV: '1', AGENTMUX_PROVIDER_ID: 'opencode',
        AGENTMUX_HOOK_URL: binding.endpoint.url, AGENTMUX_HOOK_TOKEN: binding.endpoint.token })
    }
    hosts.push({ label, env: { ...env, ...launch.env } })
  }
  const plan = provider.planManagedHooks!({ workspacePath: workspace, env: hosts[0]!.env })!
  expect(plan.mutations).toHaveLength(1)
  const mutation = plan.mutations[0]!
  await mkdir(dirname(mutation.path), { recursive: true }); await writeFile(mutation.path, mutation.content, { mode: 0o600 })
  const before = await readFile(mutation.path, 'utf8')
  const input = join(root, 'input.json')
  await writeFile(input, JSON.stringify({ root, binary, workspace, hosts, acknowledgement }), { mode: 0o600 })
  const child = spawn('python3', [fileURLToPath(new URL('../fixtures/opencode-hook-hosts.py', import.meta.url)), input],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes.toString() })
  const closed = once(child, 'close')
  const lines = createInterface({ input: child.stdout })
  let cleaned = false
  const triggered = new Promise<{ sessions: Record<string, string> }>((resolve, reject) => {
    lines.on('line', line => {
      const value = JSON.parse(line)
      if (value.phase === 'triggered') resolve(value)
      if (value.phase === 'cleaned') cleaned = value.childrenReaped === true
    })
    child.once('error', reject)
    child.once('close', code => { if (code) reject(new Error(`Native TUI probe exited ${code}: ${stderr}`)) })
  })
  try {
    const native = await triggered
    const subject = (event: NativeHookEnvelope) => event.payload?.sessionID ?? (event.payload?.part as { sessionID?: string } | undefined)?.sessionID
    await expect.poll(() => ['a', 'b'].every(label => observed.some(event => event.eventName === 'session.error' &&
      event.runId === `original-run-${label}` && subject(event) === native.sessions[label])), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => observed.some(event => subject(event) === native.sessions.foreignA && event.eventName === 'session.status'),
      { timeout: 15_000 }).toBe(true)
    expect(observed.length).toBeGreaterThan(0)
    for (const event of observed) {
      expect(['original-run-a', 'original-run-b']).toContain(event.runId)
      const label = event.runId.endsWith('-a') ? 'a' : 'b'
      expect(event.agentSessionId).toBe(`original-agent-${label}`)
      if (subject(event) === native.sessions.foreignA) {
        expect(label).toBe('a')
        const normalized = provider.normalizeHook(event, { nativeHandle: {
          kind: 'provider', providerId: 'opencode', sessionId: native.sessions.a! } })
        expect(normalized.semanticState).toBe('unknown'); expect(normalized.nativeHandle).toBeUndefined()
        expect(normalized.lifecycleEvent).toBeNull()
      } else expect(subject(event)).toBe(native.sessions[label])
    }
    expect(observed.some(event => event.payload?.sessionID === native.sessions.outside)).toBe(false)
    expect(await readFile(mutation.path, 'utf8')).toBe(before)
    await writeFile(acknowledgement, 'original observations received')
    const [code] = await closed
    expect(code, stderr).toBe(0); expect(cleaned).toBe(true)
    if (process.env.AGENTMUX_OPENCODE_NATIVE_RECEIPT) await writeFile(process.env.AGENTMUX_OPENCODE_NATIVE_RECEIPT,
      JSON.stringify({ binary, sameConfig: true, sameWorkspace: true, nativeHostCount: 3, nativeSessionCount: 4,
        originalRunIds: [...new Set(observed.map(event => event.runId))].sort(), observedEvents: observed.length,
        errorsDelivered: observed.filter(event => event.eventName === 'session.error').length,
        outsideIngress: false, sharedServerForeignSubjectFenced: true,
        sharedPluginUnchanged: true, childrenReaped: cleaned }, null, 2) + '\n')
  } finally {
    await writeFile(acknowledgement, 'finish private probe')
    if (child.exitCode === null) await closed
    lines.close(); await server.stop()
    if (child.exitCode === 0 && cleaned) await rm(root, { recursive: true, force: true })
  }
}, 120_000)
