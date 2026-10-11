import { fixturePath as _historyFixturePath } from "./helpers/fixture-values.js"
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { prepareCodexManagedLaunch } from '../src/providers/codex-native-input.js'
import { CODEX_NATIVE_TOKEN_ENV, runCodexManaged } from '../src/providers/codex-managed-run.js'
import { nativeProcessTcpListeners } from '../src/agent-native-process.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs() })
async function command(version = 'codex-cli 0.163.0') {
  const root = await mkdtemp(join(tmpdir(), 'amux-native-plan-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'native-fixture')
  await writeFile(path, '#!/usr/bin/env node\nconsole.log(' + JSON.stringify(version) + ')\n', { mode: 0o700 })
  return { root, path }
}

it.runIf(process.platform === 'darwin')('qualifies create only, preserving the original Provider invocation and Electron Node contract in the final launch plan', async () => {
  const f = await command(), original = { command: f.path, args: ['--no-alt-screen', '--profile', 'original-profile', '--dangerously-bypass-hook-trust', 'Original initial prompt'], env: { ORIGINAL_FIXTURE: 'kept' } }
  const prepared = await prepareCodexManagedLaunch(original, 'original-lifecycle', { kind: 'create', prompt: 'Original initial prompt' })
  expect(prepared.nativeActor?.launch).toEqual({ command: original.command, args: original.args })
  expect(prepared.nativeActor?.lifecycleOperationId).toBe('original-lifecycle'); expect(prepared.nativeActor?.token).toMatch(/^[a-f0-9]{64}$/u)
  expect(prepared.plan.env).toMatchObject({ ORIGINAL_FIXTURE: 'kept', ELECTRON_RUN_AS_NODE: '1', [CODEX_NATIVE_TOKEN_ENV]: prepared.nativeActor!.token })
  expect(prepared.plan.command).toBe(process.execPath)
  const helper = JSON.parse(prepared.plan.args[1]!)
  expect(helper).toEqual({ command: original.command, args: original.args, serverConfig: [] })
  expect(JSON.stringify(prepared.plan.args)).not.toContain(prepared.nativeActor!.token)
  expect(original.env).toEqual({ ORIGINAL_FIXTURE: 'kept' })
})

it.runIf(process.platform === 'darwin')('keeps unsupported argv/version and semantic resume/fork on their original TTY plan without inventing a native capability', async () => {
  const f = await command(), plan = { command: f.path, args: ['--dangerously-bypass-hook-trust'], env: {} }
  for (const kind of ['resume', 'fork'] as const) expect(await prepareCodexManagedLaunch(plan, 'original-lifecycle', { kind })).toEqual({ plan })
  for (const args of [['--add-dir', _historyFixturePath("original/workspace")], ['agents'], ['exec', 'original prompt'], ['--unknown-flag']]) {
    const unsupported = { ...plan, args }; expect(await prepareCodexManagedLaunch(unsupported, 'original-lifecycle', { kind: 'create' })).toEqual({ plan: unsupported })
  }
  const old = await command('codex-cli 0.162.0'), unsupported = { ...plan, command: old.path }
  expect(await prepareCodexManagedLaunch(unsupported, 'original-lifecycle', { kind: 'create' })).toEqual({ plan: unsupported })
})

it.runIf(process.platform === 'darwin' || process.platform === 'linux')('reads an actual ephemeral loopback listener including native lsof descriptor boundaries in the exact original process group', async () => {
  const child = spawn(process.execPath, ['--eval', 'const net=require("node:net");const server=net.createServer();server.listen(0,"127.0.0.1",()=>process.send({port:server.address().port}));'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  cleanup.push(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') } })
  const [receipt] = await once(child, 'message')
  const result = await nativeProcessTcpListeners(child.pid!, new AbortController().signal).then(listeners => ({ listeners, error: null }), error => ({ listeners: null, error }))
  expect(result.error).toBeNull()
  expect(result.listeners).toEqual([{ processId: child.pid, endpoint: `ws://127.0.0.1:${receipt.port}` }])
})

it('never replaces a failed frozen native bootstrap with an embedded TUI', async () => {
  const f = await command(), marker = join(f.root, 'unexpected-tui')
  vi.stubEnv(CODEX_NATIVE_TOKEN_ENV, 'a'.repeat(64))
  await expect(runCodexManaged({ command: process.execPath, serverConfig: ['--eval', 'process.exit(7)'], args: ['--eval', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'wrong actor')`] })).rejects.toThrow('did not publish')
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
})
