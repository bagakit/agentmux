import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { AgentProviderRegistry } from '../../src/agent-provider.js'
import { AgentManagedHookInstaller } from '../../src/managed-hook-installer.js'
import { AgentHookServer } from '../../src/hook-server.js'
import { prepareManagedHookRuntime } from '../../src/managed-hook-runtime.js'
import { retainedHookEnvironment } from '../../src/providers/shared.js'
import { HERMES_HOOK_EVENTS } from '../../src/providers/hermes.js'
import type { NativeHookEnvelope } from '../../src/types.js'

const exec = promisify(execFile)
type NativeReport = {
  configPath: string; allowlistPath: string; registered: Array<{ event: string; command: string }>
  results: Array<{ event: string; returned: unknown[] }>
  nativeSource: Record<string, { path: string; sha256: string }>
}

it('runs the installed Hermes non-shell loader through its exact consent and original retained Hook bindings', async () => {
  const python = process.env.AGENTMUX_HERMES_NATIVE_PYTHON
  const builtWorker = process.env.AGENTMUX_HERMES_NATIVE_WORKER
  expect(python, 'Select the installed native Python artifact through verify-hermes-hook-binding.mjs').toBeTruthy()
  expect(builtWorker, 'The verifier selects one current immutable built worker input for this proof').toBeTruthy()
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-hermes-native-')))
  const workspace = join(root, 'workspace'), home = join(root, 'home'), hermesHome = join(root, 'hermes'), source = join(root, 'source')
  const state = join(root, 'state'), legacyLog = join(root, 'legacy-receipts'), observed: NativeHookEnvelope[] = []
  const server = new AgentHookServer(event => { observed.push(event) }, 0)
  for (const path of [workspace, home, hermesHome, source, state]) await mkdir(path)
  try {
    const executablePath = join(source, 'node'), workerPath = join(source, 'worker.mjs')
    if (process.platform === 'darwin') await exec('/bin/cp', ['-c', process.execPath, executablePath])
    else await copyFile(process.execPath, executablePath, constants.COPYFILE_FICLONE)
    await chmod(executablePath, 0o755)
    await copyFile(builtWorker!, workerPath)
    const runtime = await prepareManagedHookRuntime(state, { executablePath, workerPath })
    await rm(source, { recursive: true })
    await expect(readFile(executablePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(workerPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await server.start()
    const provider = new AgentProviderRegistry().get('hermes')
    expect(provider.hook.permissionDecision).toBeUndefined(); expect(provider.catalog.capabilities.permission).toBe('observe')
    const env = { PATH: process.env.PATH!, HOME: home, HERMES_HOME: hermesHome, HERMES_MANAGED_DIR: join(root, 'absent-managed'),
      LANG: 'en_US.UTF-8', PRIVATE_OLD_RECEIPTS: legacyLog }
    const plan = provider.planManagedHooks!({ workspacePath: workspace, env })!
    const expectedHooks = JSON.parse(plan.mutations[0]!.content).hooks as Record<string, Array<{ command: string }>>
    const command = expectedHooks.on_session_start![0]!.command
    expect(Object.keys(expectedHooks).sort()).toEqual([...HERMES_HOOK_EVENTS].sort())
    expect(command).not.toContain(process.execPath); expect(command).not.toContain(root)
    const installer = new AgentManagedHookInstaller(join(root, 'installer'))
    // An earlier owned callback remains runnable and consented when a new Core
    // publishes this stable declaration; no user or live callback is retired.
    const legacyCommand = `/bin/sh -c 'printf "legacy\\n" >> "$PRIVATE_OLD_RECEIPTS"; printf "{}\\n"'`
    const legacy = { ...plan, mutations: plan.mutations.map((mutation, index) => ({ ...mutation,
      content: JSON.stringify(index === 0 ? { hooks: { on_session_start: [{ command: legacyCommand, timeout: 30 }] } } :
        { approvals: [{ event: 'on_session_start', command: legacyCommand }] }) })) }
    await installer.ensure(legacy); await installer.ensure(plan)
    const configBefore = await readFile(plan.mutations[0]!.path, 'utf8'), consentBefore = await readFile(plan.mutations[1]!.path, 'utf8')
    const reports: NativeReport[] = []
    for (const label of ['a', 'b', 'outside', 'missing-runtime']) {
      const binding = server.createBinding(`original-agent-${label}`, 'hermes'); await binding.bindRun(`original-run-${label}`)
      const input = join(root, label + '.json'), nativeSessionId = 'original-native-' + label
      await writeFile(input, JSON.stringify({ events: HERMES_HOOK_EVENTS, nativeSessionId }), { mode: 0o600 })
      const nativeEnv: Record<string, string> = { ...env, AGENTMUX_ENV: label === 'outside' ? '' : '1', AGENTMUX_PROVIDER_ID: 'hermes',
        AGENTMUX_HOOK_URL: binding.endpoint.url, AGENTMUX_HOOK_TOKEN: binding.endpoint.token,
        AGENTMUX_HOOK_PAYLOAD_KEY: 'hook_event_name', AGENTMUX_HERMES_NATIVE_MODULE_PATHS: process.env.AGENTMUX_HERMES_NATIVE_MODULE_PATHS!,
        ...retainedHookEnvironment(provider.hook.retainedRuntime === true, true, runtime) }
      if (label === 'missing-runtime') nativeEnv.AGENTMUX_HOOK_RUNNER = join(root, 'absent-worker.mjs')
      const result = await exec(python!, ['-I', '-S', '-B', fileURLToPath(new URL('../fixtures/hermes-native-hooks.py', import.meta.url)), input], {
        cwd: workspace, env: nativeEnv, timeout: 20_000, maxBuffer: 1024 * 1024 })
      const report = JSON.parse(result.stdout.trim()) as NativeReport; reports.push(report)
      expect(report.configPath).toBe(plan.mutations[0]!.path); expect(report.allowlistPath).toBe(plan.mutations[1]!.path)
      expect(report.registered).toEqual([{ event: 'on_session_start', command: legacyCommand },
        ...HERMES_HOOK_EVENTS.map(event => ({ event, command }))])
      expect(report.results).toHaveLength(HERMES_HOOK_EVENTS.length)
      expect(report.results.every(event => event.returned.length === 0)).toBe(true)
    }
    expect(observed).toHaveLength(HERMES_HOOK_EVENTS.length * 2)
    for (const label of ['a', 'b']) {
      const events = observed.filter(event => event.runId === `original-run-${label}`)
      expect(events.map(event => event.eventName)).toEqual([...HERMES_HOOK_EVENTS])
      for (const event of events) {
        expect(event).toMatchObject({ agentSessionId: `original-agent-${label}`, providerId: 'hermes', payload: {
          hook_event_name: event.eventName, session_id: `original-native-${label}`, cwd: workspace,
          extra: { completed: true, interrupted: false, failed: false, choice: 'deny' } } })
        expect(event.permissionCallback).toBeUndefined(); expect(event.turnEndCallback).toBeUndefined()
      }
    }
    expect(observed.some(event => ['original-run-outside', 'original-run-missing-runtime'].includes(event.runId))).toBe(false)
    expect((await readFile(legacyLog, 'utf8')).trim().split('\n')).toHaveLength(4)
    expect(await readFile(plan.mutations[0]!.path, 'utf8')).toBe(configBefore)
    expect(await readFile(plan.mutations[1]!.path, 'utf8')).toBe(consentBefore)
    if (process.env.AGENTMUX_HERMES_NATIVE_RECEIPT) await writeFile(process.env.AGENTMUX_HERMES_NATIVE_RECEIPT, JSON.stringify({
      nativePython: python, nativeSource: reports[0]!.nativeSource, events: HERMES_HOOK_EVENTS, registered: reports[0]!.registered,
      actualNativeLoader: true, nativeShellFalse: true, originalBindings: ['original-run-a', 'original-run-b'], observedEvents: observed.length,
      oldOwnedCallbackPreserved: true, outsideIngress: false, missingRuntimeIngress: false, observeOnly: true,
      privateSourceRemoved: true, stableDeclarationUnchanged: true, scope: 'Installed Hermes load_config/register_from_config/invoke_hook → native shell=False callback → retained bundled worker → original authenticated HookServer; no model or Core.createAgent.'
    }, null, 2) + '\n', { mode: 0o600 })
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
})
