import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runScopedHookCommand } from '../src/providers/shared.js'
import { hookResponseFor } from '../src/hook-passive-response.js'
import { AgentManagedHookInstaller } from '../src/managed-hook-installer.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'

const worker = fileURLToPath(new URL('../dist/agentmux-hook.mjs', import.meta.url))
const roots: string[] = []
const historicalCommand = "ELECTRON_RUN_AS_NODE=1 AGENTMUX_HOOK_PROVIDER='grok' '/private/retired-app/node' '/private/retired-app/agentmux-hook.js'"
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() })
type Body = { receiptId: string; eventName: string; payload: Record<string, unknown> }
async function sink(mode: 'observer' | 'decision' | 'disconnect' = 'observer', decision: Record<string, unknown> = {}) {
  const bodies: Body[] = [], token = 'private-bridge-token'
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return }
    const chunks: Buffer[] = []
    request.on('data', value => chunks.push(Buffer.from(value)))
    request.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body)
      if (mode === 'disconnect') { request.socket.destroy(); return }
      response.writeHead(200, { 'content-type': 'application/json', 'x-agentmux-hook-mode': mode })
      response.end(JSON.stringify(decision))
    })
  })
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes))
  const address = server.address() as { port: number }
  return { bodies, token, url: `http://127.0.0.1:${address.port}/hook`,
    close: () => new Promise<void>((yes, no) => server.close(error => error ? no(error) : yes())) }
}
function invoke(command: string, env: NodeJS.ProcessEnv, payload: Record<string, unknown> = {}) {
  return new Promise<{ stdout: string; stderr: string }>((yes, no) => {
    const child = execFile('/bin/sh', ['-c', command], { env: { PATH: '/usr/bin:/bin', ...env }, timeout: 30_000 },
      (error, stdout, stderr) => error ? no(error) : yes({ stdout, stderr }))
    child.stdin!.end(JSON.stringify(payload))
  })
}
function environment(provider: string, endpoint: Awaited<ReturnType<typeof sink>>) {
  return { AGENTMUX_ENV: '1', AGENTMUX_PROVIDER_ID: provider, AGENTMUX_HOOK_NODE: process.execPath,
    AGENTMUX_HOOK_RUNNER: worker, AGENTMUX_HOOK_LAUNCH_SCOPED: '1', AGENTMUX_HOOK_URL: endpoint.url,
    AGENTMUX_HOOK_TOKEN: endpoint.token, AGENTMUX_HOOK_PAYLOAD_KEY: provider === 'grok' ? 'hookEventName' : 'hook_event_name' }
}

describe('stable native Hook bridge and original Run environment', () => {
  it('does not persist a Core installation or interpreter path in the shared command', () => {
    const command = runScopedHookCommand('grok')
    expect(command).not.toContain(process.execPath)
    expect(command).not.toContain(resolve(import.meta.dirname, '..'))
    expect(command).toContain('$AGENTMUX_HOOK_NODE')
    expect(command).toContain('$AGENTMUX_HOOK_RUNNER')
    expect(command).toContain('--launch-scoped')
  })

  it.each(['grok', 'codex', 'claude', 'antigravity'])('returns %s native passive output before loading an absent worker outside AgentMux', async provider => {
    const endpoint = await sink()
    try {
      const response = await invoke(runScopedHookCommand(provider) + ' --event PreToolUse', {
        ...environment(provider, endpoint), AGENTMUX_ENV: '', AGENTMUX_HOOK_NODE: '/absent/node', AGENTMUX_HOOK_RUNNER: '/absent/worker'
      })
      expect(response).toEqual({ stdout: hookResponseFor(provider, 'PreToolUse'), stderr: '' })
      expect(endpoint.bodies).toHaveLength(0)
    } finally { await endpoint.close() }
  })

  it('does not borrow another Provider binding when compatibility config is read', async () => {
    const endpoint = await sink()
    try {
      expect(await invoke(runScopedHookCommand('grok'), environment('claude', endpoint), { hookEventName: 'pre_tool_use' }))
        .toEqual({ stdout: '{}\n', stderr: '' })
      expect(endpoint.bodies).toHaveLength(0)
    } finally { await endpoint.close() }
  })

  it('keeps the original native flow and names a missing managed runtime without a delivery receipt', async () => {
    const endpoint = await sink()
    try {
      const response = await invoke(runScopedHookCommand('antigravity') + ' --event PreToolUse', {
        ...environment('antigravity', endpoint), AGENTMUX_HOOK_RUNNER: '/absent/worker'
      })
      expect(response.stdout).toBe(hookResponseFor('antigravity', 'PreToolUse'))
      expect(response.stderr).toContain('Hook delivery is unconfirmed')
      expect(endpoint.bodies).toHaveLength(0)
    } finally { await endpoint.close() }
  })

  it('one shared declaration delivers each exact original Run to its own endpoint', async () => {
    const first = await sink(), second = await sink()
    try {
      const command = runScopedHookCommand('grok')
      for (const [endpoint, session] of [[first, 'native-original-a'], [second, 'native-original-b']] as const) {
        expect(await invoke(command, environment('grok', endpoint), { hookEventName: 'post_tool_use',
          hook_event_name: 'PostToolUse', sessionId: session, toolName: 'read_file', toolUseId: 'native-tool' }))
          .toEqual({ stdout: '{}\n', stderr: '' })
        expect(endpoint.bodies).toHaveLength(1)
        expect(endpoint.bodies[0]).toMatchObject({ eventName: 'post_tool_use', payload: { sessionId: session } })
      }
      expect(first.bodies[0]!.receiptId).not.toBe(second.bodies[0]!.receiptId)
    } finally { await first.close(); await second.close() }
  })

  it.each(['allow', 'deny', 'native-reviewer'] as const)('writes the original synchronous %s response without widening it', async choice => {
    const output = choice === 'native-reviewer' ? {} : {
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: choice } }
    }
    const endpoint = await sink('decision', output)
    try {
      const result = await invoke(runScopedHookCommand('codex'), environment('codex', endpoint), {
        hook_event_name: 'PermissionRequest', session_id: 'native-original', tool_name: 'Bash', tool_use_id: 'original-request'
      })
      expect(JSON.parse(result.stdout)).toEqual(output)
      expect(result.stderr).toBe('')
      expect(endpoint.bodies).toHaveLength(1)
      expect(endpoint.bodies[0]!.payload).toMatchObject({ tool_use_id: 'original-request' })
    } finally { await endpoint.close() }
  })

  it('a disconnected original decision stays unconfirmed and is never replayed as a new callback', async () => {
    const endpoint = await sink('disconnect')
    try {
      const result = await invoke(runScopedHookCommand('claude'), environment('claude', endpoint), {
        hook_event_name: 'PermissionRequest', session_id: 'native-original', tool_use_id: 'original-request'
      })
      expect(result.stdout).toBe('{}\n')
      expect(result.stderr).toContain('delivery unconfirmed')
      expect(endpoint.bodies).toHaveLength(1)
    } finally { await endpoint.close() }
  })

  it('two Core publishers add one stable declaration and preserve previous Run callbacks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amx-bridge-config-')); roots.push(root)
    const home = join(root, 'home'); await mkdir(home)
    const plan = new AgentProviderRegistry().get('grok').planManagedHooks!({ env: { HOME: home, GROK_HOME: undefined } })!
    const mutation = plan.mutations[0]!
    const initial = JSON.parse(mutation.content)
    for (const definitions of Object.values(initial.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
      for (const definition of definitions) for (const hook of definition.hooks) hook.command = historicalCommand
    }
    const original = new AgentManagedHookInstaller(join(root, 'owner-a'))
    await original.ensure({ providerId: 'grok', mutations: [{ ...mutation, content: JSON.stringify(initial) }] })
    await original.ensure(plan)
    const receiptDirectory = join(root, 'owner-a', 'receipts')
    const registrations = (await readdir(receiptDirectory)).filter(name => name.endsWith('.ownership.json'))
    expect(registrations).toHaveLength(1)
    const registrationPath = join(receiptDirectory, registrations[0]!)
    const registrationBytes = await readFile(registrationPath, 'utf8')
    const retainedOwnership = JSON.parse(JSON.parse(registrationBytes).after.content)
    expect(Object.keys(retainedOwnership.hooks).length).toBeGreaterThan(0)
    for (const definitions of Object.values(retainedOwnership.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
      expect(definitions.flatMap(definition => definition.hooks.map(hook => hook.command))).toEqual([
        historicalCommand, runScopedHookCommand('grok')
      ])
    }
    const second = new AgentManagedHookInstaller(join(root, 'owner-b'))
    expect(await second.ensure(plan)).toBeNull()
    await expect(readdir(join(root, 'owner-b', 'receipts')),
      'An already-present foreign declaration must not create an ownership receipt').rejects.toMatchObject({ code: 'ENOENT' })
    expect(await original.ensure(plan)).toBeNull()
    expect(await original.ensure(plan)).toBeNull()
    expect(await readFile(registrationPath, 'utf8'),
      'Repeated preparation must retain the exact original ownership generation').toBe(registrationBytes)
    const actual = JSON.parse(await readFile(mutation.path, 'utf8'))
    expect(Object.keys(actual.hooks).length).toBeGreaterThan(0)
    for (const definitions of Object.values(actual.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
      expect(definitions.flatMap(definition => definition.hooks.map(hook => hook.command))).toEqual([
        historicalCommand, runScopedHookCommand('grok')
      ])
    }
  })
})
