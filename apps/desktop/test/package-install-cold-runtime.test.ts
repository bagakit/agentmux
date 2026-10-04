const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({
  current: '', candidate: '', afterFirst: undefined as (() => Promise<void>) | undefined,
  preflights: [] as unknown[], cutovers: 0, signals: [] as unknown[],
  review: ''
}))
const roots: string[] = [], servers: Server[] = []
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
vi.mock('../scripts/package-process-scope.mjs', async original => ({
  ...await original<typeof import('../scripts/package-process-scope.mjs')>(),
  observeApplicationProcesses: async () => ({ serving: [], processes: [] })
}))
vi.mock('../scripts/package-semantic-host.mjs', async original => ({
  ...await original<typeof import('../scripts/package-semantic-host.mjs')>(),
  prepareSemanticHostReload: async () => null,
  stopSemanticHostForInstall: async () => { await boundary.afterFirst?.() }
}))
vi.mock('../scripts/package-runtime-upgrade.mjs', async original => {
  const real = await original<typeof import('../scripts/package-runtime-upgrade.mjs')>()
  return { ...real,
    prepareRuntimeUpgrade: async (...args: Parameters<typeof real.prepareRuntimeUpgrade>) => {
      boundary.preflights.push(args[2])
      return await real.prepareRuntimeUpgrade(...args)
    },
    finishRuntimeUpgrade: async () => { throw new Error('HOT_HANDOFF_MUST_NOT_BE_REACHED') }
  }
})
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  const execute = promisify(actual.execFile)
  const execFile = Object.assign(() => { throw new Error('Only the promisified private OS boundary is admitted') }, {
    [Symbol.for('nodejs.util.promisify.custom')]: async (command: string, args: string[], options: unknown) => {
      if (command === '/usr/bin/codesign') return { stdout: '', stderr: `CDHash=${sha(await readFile(args.at(-1)!)).slice(0, 40)}\n` }
      return execute(command, args, options as never)
    }
  })
  return { ...actual, execFile,
  spawn: (command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    queueMicrotask(async () => {
      try {
        if (command === 'cp' || command === 'ditto') await cp(args.at(-2)!, args.at(-1)!, { recursive: true })
        else if (command !== 'codesign') throw new Error(`Unowned installer OS action: ${command}`)
        child.stdout.end(); child.stderr.end(); child.emit('exit', 0, null)
      } catch (error) { child.emit('error', error) }
    })
    return child
  }
} })
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (from: string, to: string) => {
    if (from === boundary.current) { boundary.cutovers++; throw new Error('PRIVATE_CUTOVER_BOUNDARY') }
    return actual.rename(from, to)
  } }
})
async function fixture() {
  const root = await mkdtemp(_hygiene_fixturePath("tmp/amx-cold-route-")); roots.push(root)
  const home = join(root, 'home'), current = join(home, 'Applications/AgentMux.app'), candidate = join(root, 'candidate.app')
  const socket = join(root, 'native.sock'), state = join(root, 'original-state'), sentinel = join(state, 'original-native-handle-and-layout')
  await mkdir(state); await writeFile(sentinel, 'NONEMPTY ORIGINAL DURABLE STATE\n')
  for (const [app, content] of [[current, 'old'], [candidate, 'new']]) {
    const core = join(app!, 'Contents/Resources/app/node_modules/@agentmux/core')
    const vendor = join(core, 'vendor/ctxmux', `${process.platform}-${process.arch}`)
    const daemon = Buffer.from(`private never-executed daemon ${content}`), archive = Buffer.from('private never-unpacked SDK')
    const files: Record<string, string | Buffer> = {
      [join(core, 'package.json')]: '{"type":"module"}',
      [join(core, 'dist/runtime-paths.js')]: `export const defaultCtxmuxSocketPath=()=>${JSON.stringify(socket)};export const defaultCtxmuxStateDirectory=()=>${JSON.stringify(state)};`,
      [join(vendor, 'bin/ctxmuxd')]: daemon,
      [join(vendor, 'sdk.tgz')]: archive,
      [join(vendor, 'manifest.json')]: JSON.stringify({ schema: 'ctxmux.local-artifacts.v1',
        support: { platform: process.platform, architecture: process.arch },
        binaries: [{ name: 'ctxmuxd', path: 'bin/ctxmuxd', sha256: sha(daemon) }],
        sdk: { archive: { path: 'sdk.tgz', sha256: sha(archive) } } })
    }
    for (const [path, bytes] of Object.entries(files)) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes) }
  }
  boundary.current = current; boundary.candidate = candidate
  boundary.review = join(root, 'runtime-review.md'); await writeFile(boundary.review, 'Explicit private cold restart review\n')
  process.argv.push(`--runtime-reviewed=${boundary.review}`)
  vi.spyOn(process, 'kill').mockImplementation((...args) => { boundary.signals.push(args); throw new Error('No signal is authorized in the private fixture') })
  return { home, current, candidate, socket, sentinel }
}
async function listen(path: string) {
  const server = createServer(connection => connection.destroy()); servers.push(server)
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(path, done) })
}
async function install(f: Awaited<ReturnType<typeof fixture>>) {
  vi.resetModules()
  const { installApplication } = await import('../scripts/package-macos.mjs')
  return installApplication(f.candidate, { intent: 'full', coldRuntime: true, homeDirectory: f.home })
}
afterEach(async () => {
  vi.restoreAllMocks()
  process.argv = process.argv.filter(arg => arg !== `--runtime-reviewed=${boundary.review}`)
  for (const server of servers.splice(0)) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  boundary.afterFirst = undefined; boundary.preflights = []; boundary.cutovers = 0; boundary.signals = []
})
it('cold-only actual installer admits two dead preflights up to the private cutover boundary', async () => {
  const f = await fixture()
  await expect(install(f)).rejects.toThrow('PRIVATE_CUTOVER_BOUNDARY')
  expect(boundary.preflights).toEqual([{ coldOnly: true }, { coldOnly: true }])
  expect(boundary.cutovers).toBe(1); expect(boundary.signals).toEqual([])
  expect(await readFile(f.sentinel, 'utf8')).toBe('NONEMPTY ORIGINAL DURABLE STATE\n')
})
it('cold-only actual installer refuses an already alive same-state listener before cutover or signal', async () => {
  const f = await fixture(); await listen(f.socket)
  await expect(install(f)).rejects.toThrow('Cold Runtime installation requires a dead listener')
  expect(boundary.preflights).toEqual([{ coldOnly: true }]); expect(boundary.cutovers).toBe(0)
  expect(boundary.signals).toEqual([]); expect(servers[0]!.listening).toBe(true)
})
it('a real same-state listener appearing between the installer preflights cannot enter hot handoff', async () => {
  const f = await fixture(); boundary.afterFirst = () => listen(f.socket)
  await expect(install(f)).rejects.toThrow('Cold Runtime installation requires a dead listener')
  expect(boundary.preflights).toEqual([{ coldOnly: true }, { coldOnly: true }])
  expect(boundary.cutovers).toBe(0); expect(boundary.signals).toEqual([])
  expect(servers[0]!.listening).toBe(true)
  expect(await readFile(f.sentinel, 'utf8')).toBe('NONEMPTY ORIGINAL DURABLE STATE\n')
})
it('unknown second liveness refuses the cold transaction without replacing the original application', async () => {
  const f = await fixture(); boundary.afterFirst = () => writeFile(f.socket, 'ordinary file: not a socket')
  await expect(install(f)).rejects.toThrow('liveness is unknown')
  expect(boundary.preflights).toEqual([{ coldOnly: true }, { coldOnly: true }])
  expect(boundary.cutovers).toBe(0); expect(boundary.signals).toEqual([])
})
