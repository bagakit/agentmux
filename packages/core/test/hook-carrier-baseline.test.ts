import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentManagedHookInstaller } from '../src/managed-hook-installer.js'
import { inspectManagedHookContent } from '../src/hook-config-merge.js'
import { hookResponseFor } from '../src/hook-passive-response.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import type { RunSpec } from '@ctxmux/sdk'

const ids = ['gemini', 'antigravity', 'cursor', 'copilot', 'droid'] as const
const roots: string[] = [], cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function commands(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => key === 'command' && typeof child === 'string' ? [child] : commands(child))
}
function rewriteCommands(value: unknown, command: string): void {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'command') (value as Record<string, unknown>)[key] = command
    else rewriteCommands(child, command)
  }
}
function environment(root: string): Record<string, string> {
  return { HOME: root, GEMINI_CLI_HOME: root, GROK_HOME: join(root, 'grok'), CURSOR_DATA_DIR: join(root, 'cursor'),
    CURSOR_CONFIG_DIR: join(root, 'cursor'), COPILOT_HOME: join(root, 'copilot'), FACTORY_HOME_OVERRIDE: root }
}
function invoke(command: string, env: Record<string, string>, payload: object) {
  return new Promise<{ stdout: string; stderr: string }>((yes, no) => {
    const child = execFile('/bin/sh', ['-c', command], { env: { PATH: '/usr/bin:/bin', ...env }, timeout: 15_000 },
      (error, stdout, stderr) => error ? no(error) : yes({ stdout, stderr }))
    child.stdin!.end(JSON.stringify(payload))
  })
}

it.each(ids)('%s preserves old and foreign callbacks while preparing one stable owned declaration', async providerId => {
  const root = await mkdtemp(join(tmpdir(), 'amx-carrier-')); roots.push(root)
  const provider = new AgentProviderRegistry().get(providerId)
  const plan = provider.planManagedHooks!({ workspacePath: root, env: environment(root) })!
  expect(provider.hook.retainedRuntime).toBe(true)
  expect(plan.retainPreviousDeclarations).toBe(true)
  const mutation = plan.mutations[0]!, declared = JSON.parse(mutation.content), stable = commands(declared)
  if (providerId === 'gemini') {
    const definitions = Object.values(declared.hooks).flat() as Array<{ hooks: Array<{ timeout: number }> }>
    expect(definitions.flatMap(group => group.hooks.map(hook => hook.timeout))).toEqual(definitions.map(() => 10_000))
  }
  expect(stable.length).toBeGreaterThan(0)
  for (const command of stable) {
    expect(command).not.toContain(process.execPath)
    expect(command).not.toContain('agentmux-hook.js')
    expect(command).toContain('$AGENTMUX_HOOK_RUNNER')
    expect(command).toContain('--launch-scoped')
  }
  const historic = 'historical-original-Run-callback', previous = JSON.parse(mutation.content)
  rewriteCommands(previous, historic)
  previous.foreignMetadata = { audit: 'preserved' }
  const container = mutation.merge?.kind === 'json-root-managed-events' ? previous
    : previous[mutation.merge?.kind === 'json-managed-events' ? mutation.merge.key ?? 'hooks'
      : mutation.merge?.kind === 'json-owned-key' ? mutation.merge.key : 'hooks']
  container.ForeignAudit = [{ command: 'foreign-native-audit' }]
  await mkdir(dirname(mutation.path), { recursive: true })
  await writeFile(mutation.path, JSON.stringify(previous))
  const owner = new AgentManagedHookInstaller(join(root, 'owner-a'))
  const preparation = await owner.ensure(plan).catch(error => ({ preparationError: String(error) }))
  expect(preparation).not.toHaveProperty('preparationError')
  const current = await readFile(mutation.path, 'utf8'), parsed = JSON.parse(current), actual = commands(parsed)
  expect(parsed.foreignMetadata).toEqual({ audit: 'preserved' })
  expect(actual.filter(command => command === historic)).toHaveLength(stable.length)
  expect(actual.filter(command => command === 'foreign-native-audit')).toHaveLength(1)
  for (const command of new Set(stable)) expect(actual.filter(value => value === command)).toHaveLength(stable.filter(value => value === command).length)
  expect(inspectManagedHookContent(current, mutation.content, mutation.merge!)).toEqual({ present: true, current: true })
  const receiptDirectory = join(root, 'owner-a', 'receipts')
  const registration = (await readdir(receiptDirectory)).find(name => name.endsWith('.ownership.json'))!
  const before = await readFile(join(receiptDirectory, registration), 'utf8')
  expect(JSON.parse(before).scope.merge).toEqual(mutation.merge)
  expect(await owner.ensure(plan)).toBeNull()
  expect(await readFile(join(receiptDirectory, registration), 'utf8')).toBe(before)
  expect(await new AgentManagedHookInstaller(join(root, 'owner-b')).ensure(plan)).toBeNull()
  expect(await readFile(mutation.path, 'utf8')).toBe(current)
})

it.each(ids)('%s public Core creates and receives its actual declared callback using only the original Run environment', async providerId => {
  const f = await rpcOwnerFixture([]); cleanup.push(f.close)
  const inner = f.client as any, provider = f.client.providers.get(providerId), env = environment(f.root)
  inner.ensureTerminalHandshakeOrDegrade = async (session: unknown) => session
  vi.spyOn(inner, 'probePreparedAgent').mockResolvedValue({ providerId, executable: providerId, installed: true,
    capabilities: provider.catalog.capabilities })
  let started: RunSpec | undefined
  const runtime = inner.kernel as { startPrepared(request: RunSpec, operationKey: string): Promise<ReturnType<typeof f.run>> }
  vi.spyOn(runtime, 'startPrepared').mockImplementation(async (request, operationKey) => {
    started = request
    return { ...f.run('private-native-run'), lifecycleOperationId: operationKey }
  })
  const session = await f.client.createAgent({ agentSessionId: 'private-native-agent', createOperationId: 'private-native-create',
    providerId, executorId: providerId, workspacePath: f.root, env, injectAgentMuxGuide: false })
  expect(session.run.runId).toBe('private-native-run')
  const launchEnv = started!.env as Record<string, string>
  expect(launchEnv.AGENTMUX_HOOK_LAUNCH_SCOPED).toBe('1')
  expect(launchEnv.AGENTMUX_HOOK_NODE).toContain('/hook-runtime/interpreters/')
  expect(launchEnv.AGENTMUX_HOOK_RUNNER).toContain('/hook-runtime/workers/')
  const plan = provider.planManagedHooks!({ workspacePath: f.root, env })!, mutation = plan.mutations[0]!
  const installed = await readFile(mutation.path, 'utf8'), command = commands(JSON.parse(installed))[0]!
  const event = provider.hook.eventNameSource?.kind === 'flag'
    ? /--event ([A-Za-z]+)/u.exec(command)![1]! : provider.hook.rules[0]!.events[0]!
  const key = provider.hook.eventNameSource?.kind === 'payload' ? provider.hook.eventNameSource.payloadKey : 'hook_event_name'
  const nativeSubject = Object.fromEntries((provider.hook.nativeHandle?.sessionIdKeys ?? []).map(key => [key, '11111111-1111-4111-8111-111111111111']))
  const result = await invoke(command, launchEnv, { [key]: event, ...nativeSubject })
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe(hookResponseFor(providerId, event))
  expect((await f.store.readMetadata(session.agentSessionId))!.hookReceipt).toMatchObject({ providerId, eventName: event,
    agentSessionId: session.agentSessionId, run: session.run })
  const receipt = (await f.store.readMetadata(session.agentSessionId))!.hookReceipt
  expect(await invoke(command, { ...launchEnv, AGENTMUX_ENV: '' }, { [key]: event })).toEqual({ stdout: hookResponseFor(providerId, event), stderr: '' })
  expect(await invoke(command, { ...launchEnv, AGENTMUX_PROVIDER_ID: 'foreign-provider' }, { [key]: event })).toEqual({ stdout: hookResponseFor(providerId, event), stderr: '' })
  expect((await f.store.readMetadata(session.agentSessionId))!.hookReceipt).toEqual(receipt)
  const inspection = await f.client.inspectManagedHooks(providerId, { workspacePath: f.root, env })
  expect(inspection.targets[0]).toMatchObject({ path: mutation.path, status: 'current' })
  expect(await readFile(mutation.path, 'utf8')).toBe(installed)
})

it('separates two native event containers on the same file through install, repair and uninstall receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-container-')); roots.push(root)
  const target = join(root, 'native.json'), owner = new AgentManagedHookInstaller(join(root, 'owner'))
  const plan = (key: string, command: string) => ({ providerId: 'antigravity', retainPreviousDeclarations: true as const,
    mutations: [{ path: target, content: JSON.stringify({ [key]: { NativeEvent: [{ command }] } }),
      merge: { kind: 'json-managed-events' as const, key } }] })
  const a = await owner.ensure(plan('container-a', 'command-a'))
  expect(a).not.toBeNull()
  const b = await owner.ensure(plan('container-b', 'command-b')).catch(error => ({ preparationError: String(error) }))
  expect(b).not.toHaveProperty('preparationError')
  expect(b).not.toBeNull()
  expect(await owner.ensure(plan('container-a', 'command-a'))).toBeNull()
  expect(await owner.ensure(plan('container-b', 'command-b'))).toBeNull()
  const registrations = (await readdir(join(root, 'owner', 'receipts'))).filter(name => name.endsWith('.ownership.json'))
  expect(registrations).toHaveLength(2)
  await owner.uninstall(b as Exclude<typeof a, null>)
  expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ 'container-a': { NativeEvent: [{ command: 'command-a' }] } })
  await owner.uninstall(a!)
  await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
})
