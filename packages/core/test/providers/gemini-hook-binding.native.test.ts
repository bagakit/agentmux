import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { AgentProviderRegistry, AgentManagedHookInstaller } from '../../dist/index.js'
import { AgentHookServer } from '../../dist/hook-server.js'
import { prepareManagedHookRuntime } from '../../dist/managed-hook-runtime.js'
import type { NativeHookEnvelope } from '../../src/types.js'

const marker = 'AGENTMUX_GEMINI_NATIVE:'
async function nativeHost(input: Record<string, unknown>, env: Record<string, string>, root: string) {
  const requestPath = join(root, String(input.nativeSessionId) + '.json')
  await writeFile(requestPath, JSON.stringify(input), { mode: 0o600 })
  const fixture = fileURLToPath(new URL('../fixtures/gemini-hook-native-host.mjs', import.meta.url))
  const args = process.platform === 'darwin' ? ['-p',
    '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))', process.execPath, fixture, requestPath]
    : [fixture, requestPath]
  const child = spawn(process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : process.execPath, args,
    { cwd: String(input.workspace), env, stdio: ['pipe', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  let resolveReady!: (value: any) => void, rejectReady!: (error: Error) => void, diagnostic = '', sequence = 0
  const ready = new Promise<any>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    if (!line.startsWith(marker)) { diagnostic += line + '\n'; return }
    const message = JSON.parse(line.slice(marker.length))
    if (message.ready) { resolveReady(message); return }
    const target = pending.get(message.id)
    if (target) { pending.delete(message.id); message.error ? target.reject(new Error(message.error)) : target.resolve(message) }
  })
  child.stderr.on('data', bytes => { diagnostic += bytes.toString() })
  child.once('error', rejectReady)
  void closed.then(([code, signal]) => {
    const error = new Error(`Private Gemini loader exited ${code}/${signal}: ${diagnostic}`)
    rejectReady(error)
    for (const target of pending.values()) target.reject(error)
    pending.clear(); lines.close()
  })
  return { ready, pid: child.pid!, fire: (event: string) => new Promise<any>((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, event }) + '\n')
  }), close: async () => {
    child.stdin.end()
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    try { const [code] = await closed; expect(code, diagnostic).toBe(0) } finally { clearTimeout(timer) }
  } }
}

it.runIf(Boolean(process.env.AGENTMUX_GEMINI_NATIVE_MODULE))('loads the stable declaration through the installed Gemini Config/HookSystem and retains original authenticated Run bindings', async () => {
  const nativeModule = process.env.AGENTMUX_GEMINI_NATIVE_MODULE!
  const receiptPath = process.env.AGENTMUX_GEMINI_NATIVE_RECEIPT
  const root = await mkdtemp(join(tmpdir(), 'amx-gemini-native-'))
  const home = join(root, 'home'), workspace = join(root, 'workspace'), source = join(root, 'private-source')
  const hosts: Awaited<ReturnType<typeof nativeHost>>[] = [], observed: NativeHookEnvelope[] = []
  let server = new AgentHookServer(event => { observed.push(event) }, 0)
  let proof: Record<string, unknown> | undefined
  try {
    for (const path of [home, workspace, source, join(root, 'tmp')]) await mkdir(path, { recursive: true })
    const seed = join(workspace, 'seed.txt'); await writeFile(seed, 'private-original-tool-result')
    const worker = fileURLToPath(new URL('../../dist/agentmux-hook.mjs', import.meta.url))
    const privateExecutable = join(source, 'node'), privateWorker = join(source, 'worker.mjs')
    await copyFile(process.execPath, privateExecutable, constants.COPYFILE_FICLONE)
    await copyFile(worker, privateWorker, constants.COPYFILE_FICLONE)
    const runtime = await prepareManagedHookRuntime(join(root, 'state'), { executablePath: privateExecutable, workerPath: privateWorker })
    const provider = new AgentProviderRegistry().get('gemini')
    const plan = provider.planManagedHooks!({ workspacePath: workspace, env: { HOME: home, GEMINI_CLI_HOME: home } })!
    expect(provider.hook.retainedRuntime).toBe(true)
    expect(plan.mutations).toHaveLength(1)
    const installer = new AgentManagedHookInstaller(join(root, 'receipts'))
    await installer.ensure(plan)
    const settingsPath = plan.mutations[0]!.path, original = await readFile(settingsPath, 'utf8')
    expect(original).not.toContain(process.execPath)
    expect(original).not.toContain(fileURLToPath(new URL('../../', import.meta.url)))
    expect(await installer.ensure(plan)).toBeNull()
    await rm(source, { recursive: true, force: true })
    await expect(readFile(privateWorker)).rejects.toMatchObject({ code: 'ENOENT' })
    await server.start()
    const first = server.createBinding('original-gemini-a', 'gemini'), second = server.createBinding('original-gemini-b', 'gemini')
    await first.bindRun('original-run-a'); await second.bindRun('original-run-b')
    const nativeIds = ['00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000102']
    const environment = (endpoint: { url: string; token: string }, mode = 'managed') => ({
      PATH: '/usr/bin:/bin', HOME: home, GEMINI_CLI_HOME: home, TMPDIR: join(root, 'tmp'), LANG: 'en_US.UTF-8',
      AGENTMUX_ENV: mode === 'outside' ? '' : '1', AGENTMUX_PROVIDER_ID: mode === 'foreign' ? 'claude' : 'gemini',
      AGENTMUX_HOOK_NODE: runtime.nodePath, AGENTMUX_HOOK_RUNNER: runtime.runnerPath,
      AGENTMUX_HOOK_LAUNCH_SCOPED: '1', AGENTMUX_HOOK_PAYLOAD_KEY: 'hook_event_name',
      AGENTMUX_HOOK_URL: endpoint.url, AGENTMUX_HOOK_TOKEN: endpoint.token,
      AGENTMUX_HOOK_EVENT_NAME_SOURCE: 'payload'
    })
    for (const [index, binding] of [first, second].entries()) {
      const host = await nativeHost({ nativeModule, home, workspace, settingsPath, seed, nativeSessionId: nativeIds[index] },
        environment(binding.endpoint), root); hosts.push(host)
      expect(await host.ready).toMatchObject({ ready: true, nativeSessionId: nativeIds[index], registered: 5 })
      for (const event of ['BeforeAgent', 'BeforeTool', 'AfterTool']) {
        const result = (await host.fire(event)).result
        expect(result, JSON.stringify({ event, result })).toMatchObject({ success: true, errors: [] })
      }
    }
    expect(observed).toHaveLength(6)
    for (const [index, runId] of ['original-run-a', 'original-run-b'].entries()) {
      const events = observed.filter(event => event.runId === runId)
      expect(events.map(event => event.eventName)).toEqual(['BeforeAgent', 'BeforeTool', 'AfterTool'])
      expect(events.every(event => event.payload?.session_id === nativeIds[index])).toBe(true)
      expect(events.every(event => event.agentSessionId === `original-gemini-${index === 0 ? 'a' : 'b'}`)).toBe(true)
    }
    // Replace the real ingress owner while both native loader processes retain their frozen env.
    const port = Number(new URL(first.endpoint.url).port)
    await server.stop()
    server = new AgentHookServer(event => { observed.push(event) }, port); await server.start()
    const recovered = server.createBinding('original-gemini-a', 'gemini', first.bindingId, first.endpoint.token)
    await recovered.bindRun('original-run-a')
    expect((await hosts[0]!.fire('AfterAgent')).result).toMatchObject({ success: true, errors: [] })
    expect(observed.at(-1)).toMatchObject({ runId: 'original-run-a', agentSessionId: 'original-gemini-a', eventName: 'AfterAgent',
      payload: { session_id: nativeIds[0] } })
    expect(observed).toHaveLength(7)
    for (const mode of ['outside', 'foreign']) {
      const host = await nativeHost({ nativeModule, home, workspace, settingsPath, seed,
        nativeSessionId: `00000000-0000-4000-8000-00000000010${mode === 'outside' ? 3 : 4}` }, environment(first.endpoint, mode), root)
      hosts.push(host); expect((await host.ready).registered).toBe(5)
      const result = (await host.fire('BeforeAgent')).result
      expect(result).toMatchObject({ success: true, errors: [], allOutputs: [{}] })
    }
    expect(observed).toHaveLength(7)
    expect(await readFile(settingsPath, 'utf8')).toBe(original)
    proof = { schema: 'agentmux.gemini-native-hook-binding.v1', nativeModule, configLoader: 'installed Config/Storage/HookSystem',
      nativeHostPids: hosts.map(host => host.pid), originalBindings: ['original-run-a', 'original-run-b'],
      eventNames: observed.map(event => event.eventName), sourceRemoved: true, unchangedSharedDeclaration: true,
      ingressOwnerReplaced: true, originalNativeHostPidPreserved: hosts[0]!.pid, outsideIngress: false, foreignIngress: false,
      scope: 'real installed native Hook loader and real compiled Core ingress; no inference, full CLI lifecycle or new native Session recovery claim' }
  } finally {
    for (const host of hosts.reverse()) await host.close()
    await server.stop(); await rm(root, { recursive: true, force: true })
  }
  if (receiptPath) await writeFile(receiptPath, JSON.stringify({ ...proof, privateRootRemoved: true }, null, 2) + '\n', { mode: 0o600 })
}, 60_000)
