import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, readdir, realpath } from 'node:fs/promises'
import { appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { build, compileRendererProfileCli } from '../../../packages/core/test/helpers/renderer-profile-cli.js'
import type { RendererWorkerMemoryResult, RendererMemoryResult, RendererV8ProfileTarget, MetricsObservation } from '../../../packages/core/src/metrics.js'

type Trace = { owner: string; method: string; params: Record<string, unknown>; sessionId: string | null; requestedAt: number; status: string; result: Record<string, unknown> }
type Heartbeat = { key: string; bytes: number; first: number; last: number; ticks: number; beforeTicks: number; progressed: boolean }
type Health = { at: number; windows: Record<string, { target: RendererV8ProfileTarget; debuggerAttached: boolean; destroyed: boolean; visible: boolean; focused: boolean; heartbeats: Heartbeat[] }> }
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

it('uses the real CLI and original memory owner for pre-existing and nested Workers without including a foreign window or interrupting work', async () => {
  const root = resolve(import.meta.dirname, '../../..')
  const output = process.env.RENDERER_WORKER_MEMORY_NATIVE_OUTPUT ?? tmpdir()
  await mkdir(output, { recursive: true })
  const directory = await mkdtemp(join(output, 'workers-native-'))
  const namespace = await mkdtemp(join(tmpdir(), 'amux-workers-')), socket = join(namespace, 'c.sock')
  const frozen: Record<string, string> = process.env.AGENTMUX_PERFORMANCE_SOURCES ? JSON.parse(readFileSync(process.env.AGENTMUX_PERFORMANCE_SOURCES, 'utf8')) : {}
  const loaded: Record<string, string> = {}
  const read = async (path: string) => {
    const name = relative(root, path), contents = frozen[name] ?? await readFile(path, 'utf8'); loaded[name] = hash(contents)
    if (process.env.AGENTMUX_PERFORMANCE_LOADED) appendFileSync(process.env.AGENTMUX_PERFORMANCE_LOADED, JSON.stringify({ kind: 'native-worker-source', path: name, sha256: loaded[name], sourceRoot: root }) + '\n')
    return contents
  }
  const cliDirectory = join(directory, 'cli'); await mkdir(cliDirectory)
  const cliEntry = await compileRendererProfileCli(root, cliDirectory, frozen, process.env.AGENTMUX_PERFORMANCE_LOADED)
  const emittedCore = join(cliDirectory, 'cli-core/dist')
  // This installed-package asset is selected by findPackageJSON + join, rather
  // than an import/new URL edge. Preserve its original standalone ESM identity.
  const listenerSource = await read(join(root, 'packages/core/src/control-endpoint-listener-worker.ts'))
  const listenerOutput = join(emittedCore, 'control-endpoint-listener-worker.js')
  await build({ stdin: { contents: listenerSource, loader: 'ts', sourcefile: 'packages/core/src/control-endpoint-listener-worker.ts' },
    outfile: listenerOutput, bundle: false, platform: 'node', format: 'esm', target: 'node24' })
  await writeFile(join(directory, 'native-asset-source.json'), JSON.stringify({ source: 'packages/core/src/control-endpoint-listener-worker.ts',
    sourceSha256: hash(listenerSource), output: listenerOutput, outputSha256: hash(await readFile(listenerOutput)), emission: 'esbuild-single-module-esm', bundled: false }, null, 2))
  const fixture = join(root, 'apps/desktop/test/renderer-worker-memory-native.fixture.ts'), entry = join(directory, 'native.mjs')
  await build({ entryPoints: [fixture], outfile: entry, bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node22',
    plugins: [{ name: 'native-workers-exact-source', setup(builder) {
      // The actual Core server starts its own relative listener worker asset.
      // Share the source-bound, separately emitted Core package with the CLI;
      // merging it into Main would erase those module/asset identities.
      builder.onResolve({ filter: /^@agentmux\/core(?:\/control|\/object-id)?$/ }, args => args.path === '@agentmux/core'
        ? { path: join(root, 'packages/core/src/index.ts') }
        : { path: join(emittedCore, args.path.slice('@agentmux/core/'.length) + '.js'), external: true })
      builder.onResolve({ filter: /packages\/core\/src\/public-rpc-server\.js$/ }, () => ({ path: join(emittedCore, 'public-rpc-server.js'), external: true }))
      builder.onLoad({ filter: /\.[cm]?ts$/ }, async args => ({ contents: await read(args.path), loader: 'ts' }))
    } }] })
  const preload = join(directory, 'preload.cjs')
  await writeFile(preload, await read(join(root, 'apps/desktop/test/renderer-worker-memory-native.preload.cjs')))
  await read(join(root, 'apps/desktop/test/renderer-worker-memory-native.test.ts'))
  await read(join(root, 'apps/desktop/test/renderer-worker-memory-native.config.mts'))
  await read(join(root, 'packages/core/test/helpers/renderer-profile-cli.ts'))
  const modules = join(directory, 'node_modules'), coreModules = join(root, 'packages/core/node_modules')
  await mkdir(modules)
  for (const dependency of await readdir(coreModules)) {
    if (dependency.startsWith('.')) continue
    if (dependency.startsWith('@')) {
      await mkdir(join(modules, dependency))
      for (const name of await readdir(join(coreModules, dependency))) {
        if (dependency === '@agentmux' && name === 'core') continue
        await symlink(join(coreModules, dependency, name), join(modules, dependency, name), 'dir')
      }
    } else await symlink(join(coreModules, dependency), join(modules, dependency), 'dir')
  }
  await mkdir(join(modules, '@agentmux'), { recursive: true })
  await symlink(join(root, 'packages/core'), join(modules, '@agentmux/core'), 'dir')
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(AGENTMUX_|CTXMUX_|CODEX_|ELECTRON_|NODE_OPTIONS$|OPENAI_|ANTHROPIC_)/u.test(key) && !/(TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY|PROXY)/iu.test(key)))
  const privatePaths: Record<string, string> = {}
  for (const [key, name] of Object.entries({ HOME: 'home', CODEX_HOME: 'codex', AGENTMUX_RUNTIME_DIRECTORY: 'runtime', AGENTMUX_STATE_DIRECTORY: 'state',
    XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data', XDG_CACHE_HOME: 'cache', TMPDIR: 'tmp' })) {
    env[key] = privatePaths[key] = join(namespace, name); await mkdir(env[key]!, { recursive: true })
  }
  Object.assign(env, { RENDERER_WORKER_MEMORY_NATIVE_DIRECTORY: directory, RENDERER_WORKER_MEMORY_NATIVE_SOCKET: socket, RENDERER_WORKER_MEMORY_NATIVE_PRELOAD: preload })
  await writeFile(join(directory, 'private-environment.json'), JSON.stringify({ privatePaths, socket,
    removedNames: Object.keys(process.env).filter(key => !(key in env)),
    inheritedAgentCredential: 'AGENTMUX_AGENT_CAPABILITY' in env, inheritedAgentIdentity: 'AGENTMUX_AGENT_SESSION_ID' in env,
    externalDependencyDirectory: await realpath(coreModules), candidateSourceRoot: root, compiledCliEntry: cliEntry }, null, 2))
  const electronDirectory = join(root, 'apps/desktop/node_modules/electron')
  const electron = join(electronDirectory, 'dist', readFileSync(join(electronDirectory, 'path.txt'), 'utf8').trim())
  // Imported Core helper modules must remain imports: directly executing the
  // merged bundle would turn each original import.meta.url entry guard true.
  const launcher = join(directory, 'launcher.mjs')
  await writeFile(launcher, 'import "./native.mjs"\n')
  await writeFile(join(directory, 'source-read.json'), JSON.stringify(loaded, null, 2))
  await writeFile(join(directory, 'native-binary.json'), JSON.stringify({ path: await realpath(electron), sha256: hash(await readFile(electron)),
    entrySha256: hash(await readFile(entry)), launcherSha256: hash(await readFile(launcher)), preloadSha256: hash(await readFile(preload)) }, null, 2))
  const native = spawn(electron, [launcher], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', exited = false
  native.stdout.on('data', data => { stdout += data.toString() }); native.stderr.on('data', data => { stderr += data.toString() })
  const exit = new Promise<number | null>((resolve, reject) => { native.once('close', code => { exited = true; resolve(code) }); native.once('error', reject) })
  const until = async (line: string) => {
    const deadline = Date.now() + 10000
    while (!stdout.split('\n').includes(line)) {
      if (exited || Date.now() >= deadline) throw new Error('Private native stage did not complete: ' + line + '\n' + stderr)
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  const json = async <T,>(name: string): Promise<T> => JSON.parse(await readFile(join(directory, name + '.json'), 'utf8'))
  const invoke = async (words: string[], label: string, target?: RendererV8ProfileTarget) => {
    const flags = Object.entries(target ?? {}).flatMap(([key, value]) => ['--' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), String(value)])
    const args = [cliEntry, '--endpoint', 'unix://' + socket, 'system', 'metrics', ...words, ...flags]
    const child = spawn(process.execPath, args, { env })
    let out = '', err = ''; child.stdout.on('data', data => { out += data.toString() }); child.stderr.on('data', data => { err += data.toString() })
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 10000)
    const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) }).finally(() => clearTimeout(watchdog))
    await writeFile(join(directory, label + '-cli.json'), JSON.stringify({ args, code, stdout: out, stderr: err }, null, 2))
    expect(code, err + out).toBe(0)
    const body = JSON.parse(out)
    expect(body).toMatchObject({ ok: true, operation: 'system.metrics.' + words.join('.') })
    return body.result
  }
  const health = async (label: string) => {
    native.stdin.write('health:' + label + '\n'); await until('health:' + label)
    const value = await json<Health>(label)
    for (const owner of ['root', 'foreign']) {
      expect(value.windows[owner]).toMatchObject({ debuggerAttached: false, destroyed: false, visible: false, focused: false })
      expect(value.windows[owner]!.heartbeats.length).toBeGreaterThan(0)
      expect(value.windows[owner]!.heartbeats.every(beat => beat.progressed && beat.ticks > beat.beforeTicks)).toBe(true)
    }
    expect(value.windows.root!.heartbeats.find(beat => beat.key.endsWith(':direct'))).toMatchObject({ bytes: 32 * 1024 * 1024, first: 37, last: 37 })
    expect(value.windows.foreign!.heartbeats.find(beat => beat.key.endsWith(':direct'))).toMatchObject({ bytes: 8 * 1024 * 1024, first: 91, last: 91 })
    return value
  }
  const workers = async (target: RendererV8ProfileTarget, label: string) => {
    const value = (await invoke(['memory', 'workers', 'inspect'], label, target)).observation as RendererWorkerMemoryResult
    expect(value).toMatchObject({ schema: 'agentmux.renderer-worker-memory.v1', scope: 'renderer-related-dedicated-worker-isolates', status: 'completed', target,
      sourceVerified: { before: true, after: true }, cleanup: { detached: 'confirmed' }, issues: [], issuesOmitted: 0, discovery: { coverage: 'bounded', omitted: 0, pending: 0 } })
    expect(value.root).not.toBeNull()
    expect(value.relations.length).toBeGreaterThan(0)
    expect(value.isolates.length).toBeGreaterThan(0)
    expect(new Set(value.isolates.map(row => row.isolateId)).size).toBe(value.isolates.length)
    expect(value.isolates.every(row => row.isolateId !== value.root!.isolateId)).toBe(true)
    expect(value).not.toHaveProperty('total')
    expect(value).not.toHaveProperty('totals')
    return value
  }
  try {
    await until('ready')
    const ready = await json<{ target: RendererV8ProfileTarget; foreignTarget: RendererV8ProfileTarget }>('native-ready')
    const discovered = (await invoke(['get'], 'metrics-target')).observation as MetricsObservation
    expect(discovered.renderer.state).toBe('available')
    const target = { ...discovered.window!, ...discovered.renderer.data!.process } as RendererV8ProfileTarget
    expect(target).toEqual(ready.target)
    expect(target.webContentsId).not.toBe(ready.foreignTarget.webContentsId)
    const before = (await invoke(['memory', 'inspect'], 'main-before', target)).observation as RendererMemoryResult
    native.stdin.write('allocate\n'); await until('allocated')
    const after = (await invoke(['memory', 'inspect'], 'main-after', target)).observation as RendererMemoryResult
    expect(before.status).toBe('completed'); expect(after.status).toBe('completed')
    expect(before.usage!.backingStorageSize).toBeTypeOf('number'); expect(after.usage!.backingStorageSize).toBeTypeOf('number')
    const mainBackingDelta = after.usage!.backingStorageSize! - before.usage!.backingStorageSize!
    expect(mainBackingDelta).toBeLessThan(1024 * 1024)
    const first = await workers(target, 'pre-existing')
    const foreign = await json<{ isolateId: string; targetInfo: { targetId: string }; usage: { backingStorageSize: number } }>('foreign-counter')
    expect(foreign.usage.backingStorageSize).toBeGreaterThanOrEqual(8 * 1024 * 1024)
    expect(first.isolates.some(row => row.usage.backingStorageSize! >= 32 * 1024 * 1024)).toBe(true)
    const excludesForeign = (value: RendererWorkerMemoryResult) => {
      expect(value.root!.isolateId).not.toBe(foreign.isolateId)
      expect(value.isolates.every(row => row.isolateId !== foreign.isolateId && row.targetId !== foreign.targetInfo.targetId)).toBe(true)
      expect(value.relations.every(row => row.target.targetId !== foreign.targetInfo.targetId)).toBe(true)
    }
    excludesForeign(first)
    const firstHealth = await health('after-first-query')
    native.stdin.write('nested\n'); await until('nested')
    const second = await workers(target, 'nested')
    excludesForeign(second)
    expect(second.root!.isolateId).toBe(first.root!.isolateId)
    expect(second.isolates.length).toBeGreaterThan(first.isolates.length)
    const nested = second.relations.find(row => row.parentSessionId !== null)
    expect(nested).toBeDefined()
    expect(second.relations.some(row => row.sessionId === nested!.parentSessionId)).toBe(true)
    expect(second.isolates.find(row => row.sessionId === nested!.sessionId)!.usage.backingStorageSize).toBeGreaterThanOrEqual(4 * 1024 * 1024)
    const secondHealth = await health('after-second-query')
    expect(secondHealth.windows.root!.heartbeats.find(beat => beat.key.endsWith(':nested'))).toMatchObject({ bytes: 4 * 1024 * 1024, first: 53, last: 53 })
    native.stdin.write('quit\n'); expect(await exit).toBe(0)
    const trace = await json<Trace[]>('native-command-trace')
    expect(trace.every(row => ['Target.getTargetInfo', 'Target.setAutoAttach', 'Runtime.getIsolateId', 'Runtime.getHeapUsage'].includes(row.method) && row.status === 'completed')).toBe(true)
    expect(trace.filter(row => row.method === 'Target.setAutoAttach').every(row => row.params.waitForDebuggerOnStart === false && row.params.flatten === true)).toBe(true)
    const autoAttach = trace.find(row => row.owner === 'root' && row.method === 'Target.setAutoAttach')!
    const allocation = await json<{ at: number }>('root-allocation')
    const beforeFirst = await json<Health>('before-first-query')
    expect(allocation.at).toBeLessThan(autoAttach.requestedAt)
    expect(beforeFirst.at).toBeLessThan(autoAttach.requestedAt)
    expect(beforeFirst.windows.root!.heartbeats[0]!.bytes).toBe(32 * 1024 * 1024)
    const eventRows = await json<Array<{ owner: string; method?: string; sessionId?: string | null; at: number;
      params?: { waitingForDebugger?: boolean; sessionId?: string; targetInfo?: { targetId: string } } }>>('native-events')
    const heartbeatTrace = await json<{ samples: Array<{ owner: string; worker: string; at: number; debuggerAttached: boolean; bytes: number }>; omitted: number }>('native-heartbeats')
    expect(heartbeatTrace.omitted).toBe(0)
    expect(eventRows.filter(row => row.method === 'Target.attachedToTarget').every(row => row.params!.waitingForDebugger === false)).toBe(true)
    const nativeWitnesses = (value: RendererWorkerMemoryResult) => {
      const query = trace.filter(row => row.owner === 'root' && row.requestedAt >= value.timing.requestedAt && row.requestedAt <= value.timing.finishedAt)
      const sampled = (sessionId: string | null, isolateId: string, usage: NonNullable<RendererWorkerMemoryResult['root']>['usage']) => {
        expect(query.some(row => row.method === 'Runtime.getIsolateId' && row.sessionId === sessionId && row.result.id === isolateId)).toBe(true)
        const native = query.find(row => row.method === 'Runtime.getHeapUsage' && row.sessionId === sessionId)!.result
        expect(usage).toEqual({ usedSize: native.usedSize, totalSize: native.totalSize, embedderHeapUsedSize: native.embedderHeapUsedSize ?? null,
          backingStorageSize: native.backingStorageSize ?? null })
      }
      sampled(null, value.root!.isolateId, value.root!.usage)
      for (const isolate of value.isolates) sampled(isolate.sessionId, isolate.isolateId, isolate.usage)
      for (const relation of value.relations) expect(eventRows.some(row => row.owner === 'root' && row.method === 'Target.attachedToTarget' &&
        row.params!.sessionId === relation.sessionId && row.params!.targetInfo!.targetId === relation.target.targetId &&
        (row.sessionId || null) === relation.parentSessionId && row.params!.waitingForDebugger === false)).toBe(true)
      expect(heartbeatTrace.samples.some(row => row.owner === 'root' && row.worker === 'direct' && row.debuggerAttached &&
        row.bytes === 32 * 1024 * 1024 && row.at >= value.timing.requestedAt && row.at <= value.timing.finishedAt)).toBe(true)
    }
    nativeWitnesses(first); nativeWitnesses(second)
    expect(heartbeatTrace.samples.some(row => row.owner === 'root' && row.worker === 'nested' && row.debuggerAttached &&
      row.bytes === 4 * 1024 * 1024 && row.at >= second.timing.requestedAt && row.at <= second.timing.finishedAt)).toBe(true)
    await writeFile(join(directory, 'qualification.json'), JSON.stringify({ schema: 'agentmux.renderer-worker-memory.native-qualification.v1', status: 'completed', sourceRoot: root,
      sourceHashes: loaded, mainBackingDelta, preExisting: { observed: first.discovery.observed, isolates: first.isolates.length, allocationBeforeAutoAttach: true, heartbeatBeforeAutoAttach: true },
      nested: { observed: second.discovery.observed, isolates: second.isolates.length, parentSessionObserved: true },
      foreign: { isolateId: foreign.isolateId, targetId: foreign.targetInfo.targetId, excluded: true, positiveBackingBytes: foreign.usage.backingStorageSize },
      health: { first: firstHealth, second: secondHealth }, nativeCommandCount: trace.length,
      limits: 'Two private self-created windows only. No all-Worker/process/PA/RSS coverage or savings claim. Source samplers except private window/process identity are controlled or explicitly unavailable.' }, null, 2))
  } finally {
    let forced = false
    if (!exited) { native.stdin.write('quit\n'); await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 1000))]); if (!exited) { forced = true; native.kill('SIGKILL'); await exit } }
    await writeFile(join(directory, 'process-output.json'), JSON.stringify({ stdout, stderr, exited, forced, privatePid: native.pid }, null, 2))
    if (process.env.AGENTMUX_PERFORMANCE_LOADED) appendFileSync(process.env.AGENTMUX_PERFORMANCE_LOADED, JSON.stringify({ kind: 'native-worker-memory-fixture', directory, sourceRoot: root, loaded }) + '\n')
    await rm(namespace, { recursive: true, force: true })
    await writeFile(join(directory, 'cleanup.json'), JSON.stringify({ privateProcessExited: exited, forced, removedNamespace: namespace, originalAppUntouched: true }))
    if (!process.env.RENDERER_WORKER_MEMORY_NATIVE_OUTPUT) await rm(directory, { recursive: true, force: true })
  }
}, 60000)
