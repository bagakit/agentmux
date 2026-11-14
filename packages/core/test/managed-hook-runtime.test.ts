import { constants, createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareManagedHookRuntime } from '../src/managed-hook-runtime.js'
import { mutateManagedHookRuntime } from './vitest.managed-hook-runtime.config.mjs'

const execFileAsync = promisify(execFile)
const workerPath = fileURLToPath(new URL('../dist/agentmux-hook.mjs', import.meta.url))
const publisherPath = fileURLToPath(new URL('../src/managed-hook-runtime.ts', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const roots: string[] = []
type Source = { executablePath: string; workerPath: string; electron?: boolean }
type Runtime = Awaited<ReturnType<typeof prepareManagedHookRuntime>>
type Fixture = { root: string; home: string; state: string; sourceDirectory: string; source: Source }
type Receipt = { receiptId: string; eventName: string; payload: Record<string, unknown> }

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true })
})

async function fixture(outsidePackage = false): Promise<Fixture> {
  // Repeated publishers use the repository volume; the first worker proof also
  // leaves its package resolution tree, with the same native COW copy operation.
  const parent = outsidePackage ? tmpdir() : join(repositoryRoot, '.local/state/managed-hook-runtime-tests')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await realpath(await mkdtemp(join(parent, outsidePackage ? 'amx-hook-runtime-case-' : 'case-')))
  roots.push(root)
  const home = join(root, 'home'), state = join(root, 'state'), sourceDirectory = join(root, 'private-source')
  for (const path of [home, state, sourceDirectory, join(root, 'tmp')]) await mkdir(path, { mode: 0o700 })
  const source = { executablePath: join(sourceDirectory, 'node'), workerPath: join(sourceDirectory, 'worker.mjs') }
  const f = { root, home, state, sourceDirectory, source }
  if (process.platform === 'darwin') await execFileAsync('/bin/cp', ['-c', process.execPath, source.executablePath], { env: privateEnvironment(f) })
  else await copyFile(process.execPath, source.executablePath, constants.COPYFILE_FICLONE)
  // This is the real built worker, not a test replacement with the same filename.
  await copyFile(workerPath, source.workerPath)
  await chmod(source.executablePath, 0o755)
  await chmod(source.workerPath, 0o644)
  return f
}

function privateEnvironment(f: Fixture): NodeJS.ProcessEnv {
  return { HOME: f.home, TMPDIR: join(f.root, 'tmp'), PATH: '/usr/bin:/bin', LANG: 'C',
    ELECTRON_RUN_AS_NODE: '1', AGENTMUX_ENV: '1', AGENTMUX_PROVIDER_ID: 'codex',
    AGENTMUX_HOOK_PROVIDER: 'codex', AGENTMUX_HOOK_PAYLOAD_KEY: 'hook_event_name' }
}

function expectPrivateRuntime(f: Fixture, runtime: Runtime): void {
  for (const path of [runtime.nodePath, runtime.runnerPath]) {
    expect(isAbsolute(path)).toBe(true)
    const within = relative(f.state, path)
    expect(within && within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within), path).toBeTruthy()
    expect(path.startsWith(f.sourceDirectory + sep), 'published path must not refer to the private source').toBe(false)
  }
}

async function fileDigest(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  return digest.digest('hex')
}

async function runWorker(f: Fixture, runtime: Runtime, event: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolveResult, reject) => {
    const child = execFile(runtime.nodePath, [runtime.runnerPath, '--launch-scoped'], {
      cwd: f.root, env: { ...privateEnvironment(f), ...env }, encoding: 'utf8', timeout: 15_000,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => error ? reject(error) : resolveResult({ stdout, stderr }))
    child.stdin!.end(JSON.stringify(event))
  })
}

async function withIngress<T>(run: (ingress: { url: string; token: string; receipts: Receipt[] }) => Promise<T>): Promise<T> {
  const token = 'private-hook-runtime-token'
  const receipts: Receipt[] = []
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401); response.end(); return
    }
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      try {
        receipts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Receipt)
        response.writeHead(200, { 'content-type': 'application/json', 'x-agentmux-hook-mode': 'observer' })
        response.end('{}')
      } catch { response.writeHead(400); response.end() }
    })
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Private Hook ingress did not bind a TCP port')
  try { return await run({ url: `http://127.0.0.1:${address.port}/private-hook`, token, receipts }) }
  finally {
    server.closeAllConnections()
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  }
}

async function verifyOriginalReceipt(f: Fixture, runtime: Runtime): Promise<void> {
  await withIngress(async ingress => {
    const original = { hook_event_name: 'PreToolUse', session_id: 'private-original-native-session',
      tool_use_id: 'private-original-tool', tool_name: 'Read', tool_input: { file_path: join(f.root, 'original.txt') } }
    const result = await runWorker(f, runtime, original, { AGENTMUX_HOOK_URL: ingress.url, AGENTMUX_HOOK_TOKEN: ingress.token })
    expect(result.stdout).toBe('{}\n')
    expect(result.stderr).toBe('')
    expect(ingress.receipts).toHaveLength(1)
    expect(ingress.receipts[0]).toMatchObject({ eventName: 'PreToolUse', payload: original })
    expect(ingress.receipts[0]!.receiptId).toEqual(expect.any(String))
    expect(ingress.receipts[0]!.receiptId.length).toBeGreaterThan(0)
  })
}

/** Compile only the actual publishing owner for independent process contention. */
async function publisherHelper(f: Fixture): Promise<string> {
  const require = createRequire(import.meta.url)
  const vitestRequire = createRequire(require.resolve('vitest/package.json'))
  const viteRequire = createRequire(vitestRequire.resolve('vite/package.json'))
  const esbuild = viteRequire('esbuild') as { build(options: Record<string, unknown>): Promise<unknown> }
  const owner = join(f.root, 'publisher-owner.mjs')
  await esbuild.build({ entryPoints: [publisherPath], outfile: owner, bundle: true, platform: 'node',
    format: 'esm', target: 'node24', logLevel: 'silent',
    alias: { '@agentmux/identity': fileURLToPath(new URL('../../identity/src/index.ts', import.meta.url)) },
    plugins: [{ name: 'same-publisher-owner-mutation', setup(build: { onLoad(options: { filter: RegExp },
      callback: (args: { path: string }) => Promise<{ contents: string; loader: string } | undefined>): void }) {
      build.onLoad({ filter: /managed-hook-runtime\.ts$/ }, async args => args.path === publisherPath
        ? { contents: mutateManagedHookRuntime(await readFile(args.path, 'utf8'), args.path, 'esbuild-owner'), loader: 'ts' }
        : undefined)
    } }] })
  const helper = join(f.root, 'publish.mjs')
  await writeFile(helper, `import { prepareManagedHookRuntime } from ${JSON.stringify(pathToFileURL(owner).href)}\n` +
    'const [state, source] = process.argv.slice(2)\n' +
    'process.stdout.write(JSON.stringify(await prepareManagedHookRuntime(state, JSON.parse(source))) + "\\n")\n')
  return helper
}

async function electronSource(f: Fixture): Promise<Source> {
  // Use the repository's installed Electron as read-only input. In a Git worktree,
  // the common Git directory identifies the original checkout without a personal path.
  const repository = repositoryRoot
  const git = await execFileAsync('git', ['rev-parse', '--git-common-dir'], { cwd: repository, env: {
    ...privateEnvironment(f), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'
  } })
  const mainRoot = dirname(resolve(repository, git.stdout.trim()))
  const candidates = [repository, mainRoot].map(root => join(root, 'apps/desktop/node_modules/electron/dist/Electron.app'))
  let original: string | undefined
  for (const path of candidates) {
    try { if ((await lstat(join(path, 'Contents/MacOS/Electron'))).isFile()) { original = path; break } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  if (!original) throw new Error('The actual installed Electron runtime is required for the Darwin closure proof')
  const contents = join(f.sourceDirectory, 'Private Electron.app/Contents')
  await mkdir(contents, { recursive: true, mode: 0o700 })
  for (const entry of ['MacOS', 'Frameworks', 'Info.plist', 'PkgInfo']) {
    const source = join(original, 'Contents', entry)
    try { await lstat(source) } catch (error) {
      if (entry === 'PkgInfo' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    await execFileAsync('/bin/cp', ['-cR', source, join(contents, entry)], { env: privateEnvironment(f) })
  }
  return { executablePath: join(contents, 'MacOS/Electron'), workerPath: f.source.workerPath, electron: true }
}

describe('managed Hook runtime preserves its executable lifetime', () => {
  it('runs the real bundled worker after its private Node source is removed', async () => {
    const f = await fixture(true)
    const runtime = await prepareManagedHookRuntime(f.state, f.source)
    expectPrivateRuntime(f, runtime)
    expect(await readFile(runtime.runnerPath)).toEqual(await readFile(f.source.workerPath))
    await rm(f.sourceDirectory, { recursive: true })
    await expect(lstat(f.sourceDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    // The state and cwd have no node_modules. A surviving import back into the
    // package or its dependency tree cannot borrow the removed private source.
    await expect(lstat(join(f.root, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(f.state, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
    await verifyOriginalReceipt(f, runtime)
  })

  it('publishes one usable content identity under concurrent calls in one process', async () => {
    const f = await fixture()
    const runtimes = await Promise.all(Array.from({ length: 3 }, () => prepareManagedHookRuntime(f.state, f.source)))
    expect(runtimes).toEqual([runtimes[0], runtimes[0], runtimes[0]])
    expectPrivateRuntime(f, runtimes[0]!)
    await rm(f.sourceDirectory, { recursive: true })
    await verifyOriginalReceipt(f, runtimes[0]!)
  })

  it('converges two actual publisher processes on the same complete artifact', async () => {
    const f = await fixture(), helper = await publisherHelper(f)
    const results = await Promise.all(Array.from({ length: 2 }, () => execFileAsync(process.execPath,
      [helper, f.state, JSON.stringify(f.source)], { cwd: f.root, env: privateEnvironment(f), timeout: 20_000 })))
    const runtimes = results.map(result => JSON.parse(result.stdout.trim()) as Runtime)
    expect(runtimes[0]).toEqual(runtimes[1])
    expectPrivateRuntime(f, runtimes[0]!)
    await rm(f.sourceDirectory, { recursive: true })
    await verifyOriginalReceipt(f, runtimes[0]!)
  })

  it('retains both immutable worker revisions while reusing the interpreter', async () => {
    const f = await fixture()
    const originalBytes = await readFile(f.source.workerPath)
    const original = await prepareManagedHookRuntime(f.state, f.source)
    const revisedPath = join(f.sourceDirectory, 'revised-worker.mjs')
    await writeFile(revisedPath, Buffer.concat([originalBytes, Buffer.from('\n// private revision\n')]), { mode: 0o644 })
    const revised = await prepareManagedHookRuntime(f.state, { ...f.source, workerPath: revisedPath })
    expect(revised.nodePath).toBe(original.nodePath)
    expect(revised.runnerPath).not.toBe(original.runnerPath)
    expect(await readFile(original.runnerPath)).toEqual(originalBytes)
    await rm(f.sourceDirectory, { recursive: true })
    await verifyOriginalReceipt(f, original)
    await verifyOriginalReceipt(f, revised)
  })

  it('does not damage a published runtime when another preparation fails', async () => {
    const f = await fixture()
    const original = await prepareManagedHookRuntime(f.state, f.source)
    const executable = await fileDigest(original.nodePath), worker = await fileDigest(original.runnerPath)
    await expect(prepareManagedHookRuntime(f.state, { ...f.source, workerPath: join(f.sourceDirectory, 'absent-worker.mjs') })).rejects.toThrow()
    expect(await fileDigest(original.nodePath)).toEqual(executable)
    expect(await fileDigest(original.runnerPath)).toEqual(worker)
    expect(await prepareManagedHookRuntime(f.state, f.source)).toEqual(original)
    await rm(f.sourceDirectory, { recursive: true })
    await verifyOriginalReceipt(f, original)
  })

  it('preserves executable and worker permission modes in the retained closure', async () => {
    const f = await fixture()
    await chmod(f.source.executablePath, 0o751)
    await chmod(f.source.workerPath, 0o640)
    const runtime = await prepareManagedHookRuntime(f.state, f.source)
    expect((await lstat(runtime.nodePath)).mode & 0o777).toBe(0o751)
    expect((await lstat(runtime.runnerPath)).mode & 0o777).toBe(0o640)
    const worker = await readFile(runtime.runnerPath)
    await chmod(f.source.workerPath, 0o600)
    const restricted = await prepareManagedHookRuntime(f.state, { ...f.source })
    expect(restricted.nodePath).toBe(runtime.nodePath)
    expect(restricted.runnerPath).not.toBe(runtime.runnerPath)
    expect((await lstat(restricted.runnerPath)).mode & 0o777).toBe(0o600)
    expect((await lstat(runtime.runnerPath)).mode & 0o777).toBe(0o640)
    expect(await readFile(restricted.runnerPath)).toEqual(worker)
    await rm(f.sourceDirectory, { recursive: true })
    await verifyOriginalReceipt(f, runtime)
    await verifyOriginalReceipt(f, restricted)
  })

  it.skipIf(process.platform !== 'darwin')('retains the actual Electron Framework closure and its relative symlinks after private application removal', async () => {
    const f = await fixture(), source = await electronSource(f)
    const sourceFramework = resolve(dirname(source.executablePath), '../Frameworks/Electron Framework.framework')
    const originalCurrentLink = await readlink(join(sourceFramework, 'Versions/Current'))
    const originalExecutableLink = await readlink(join(sourceFramework, 'Electron Framework'))
    const originalFrameworkMode = (await lstat(await realpath(join(sourceFramework, 'Electron Framework')))).mode & 0o777
    const runtime = await prepareManagedHookRuntime(f.state, source)
    expectPrivateRuntime(f, runtime)
    const retainedFramework = resolve(dirname(runtime.nodePath), '../Frameworks/Electron Framework.framework')
    await expect(readlink(join(retainedFramework, 'Versions/Current'))).resolves.toBe(originalCurrentLink)
    await expect(readlink(join(retainedFramework, 'Electron Framework'))).resolves.toBe(originalExecutableLink)
    expect((await lstat(await realpath(join(retainedFramework, 'Electron Framework')))).mode & 0o777).toBe(originalFrameworkMode)
    await rm(f.sourceDirectory, { recursive: true })
    await expect(lstat(source.executablePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await verifyOriginalReceipt(f, runtime)
  }, 120_000)
})
