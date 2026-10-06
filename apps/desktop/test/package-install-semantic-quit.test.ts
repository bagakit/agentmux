const { fixturePath: _reshape_fixturePath } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
const { fixturePath: _hygiene_fixturePath, fixturePsBirth: _hygiene_fixturePsBirth, fixtureTime: _hygiene_fixtureTime } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { EventEmitter } from 'node:events'
import { access, appendFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

type Row = { uid: number; pid: number; ppid: number; birth: string; command: string }
type Scope = {
  root: string; home: string; app: string; candidate: string; store: string
  gui: Row | null; host: Row | null; worker: Row | null
  hostMode: string; workerMode?: string; retainNamespaceWorker?: boolean; publicPid: number; publicStore: string
  events: string[]; signals: [number, string][]; cutover: boolean
  beforeQuit?: () => Promise<void>
  afterGuiQuit?: () => void
}
const boundary = vi.hoisted(() => ({ scope: undefined as Scope | undefined }))
const roots: string[] = []

// Only OS and unrelated UI/SDK observation boundaries are controlled. The full
// installer, default quit, process classifier and semantic fences are real.
// No operation can escape the private filesystem/OS snapshot below.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execute = async (command: string, args: string[]) => {
    const f = boundary.scope
    if (!f) throw new Error('No owned installer OS scope')
    const system: Row = { uid: process.getuid!(), pid: 1, ppid: 0, birth: _hygiene_fixturePsBirth(24019200000), command: '/sbin/launchd' }
    const daemon: Row = { ...system, pid: 999, ppid: 1, command: `${f.app}/Contents/Resources/app/vendor/ctxmuxd --socket ${f.root}/native.sock` }
    const rows = [system, f.gui, f.host, f.worker, daemon].filter((row): row is Row => row !== null)
    if (command === process.execPath && args[1] === '--bootstrap') {
      expect(args[0]).toMatch(/package-semantic-host\.mjs$/)
      f.events.push('public-owner')
      return { stdout: JSON.stringify({ hostProcessId: f.publicPid, storePath: f.publicStore }), stderr: '' }
    }
    if (command === '/usr/bin/python3') {
      const requested = args.slice(2).map(Number)
      return { stdout: JSON.stringify(rows.filter(row => requested.includes(row.pid)).map(row => ({
        uid: row.uid, pid: row.pid, ppid: row.ppid, birth: row.birth,
        mode: row.pid === f.gui?.pid ? 'gui' : row.pid === f.host?.pid ? f.hostMode : f.workerMode ?? 'node',
        executable: `${f.app}/Contents/MacOS/AgentMux`
      }))), stderr: '' }
    }
    if (command === '/bin/ps') {
      const selected = args[0] === '-p' ? rows.filter(row => row.pid === Number(args[1])) : rows
      if (!selected.length) throw Object.assign(new Error('Owned process exited'), { code: 1 })
      return { stdout: selected.map(row => `${row.uid} ${row.pid} ${row.ppid} ${row.birth} ${row.command}`).join('\n') + '\n', stderr: '' }
    }
    throw new Error(`Unowned OS read refused: ${command}`)
  }
  const execFile = Object.assign(() => { throw new Error('Only the product promisified OS boundary is admitted') }, {
    [Symbol.for('nodejs.util.promisify.custom')]: execute
  })
  return { ...actual, execFile, spawn: (command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    queueMicrotask(async () => {
      try {
        const f = boundary.scope
        if (!f) throw new Error('No owned installer copy scope')
        let output = ''
        if (command === 'ditto' || command === 'cp') {
          if (command === 'cp') args = args.slice(1)
          expect(args[0]).toBe(f.candidate); expect(args[1]).toBe(join(f.home, `Applications/.AgentMux.install-${process.pid}.app`))
          await cp(args[0]!, args[1]!, { recursive: true })
        } else if (command === 'codesign') {
          expect(args).toContain(join(f.home, `Applications/.AgentMux.install-${process.pid}.app`))
        } else if (command === 'plutil') output = 'dev.agentmux.desktop\n'
        else if (command === 'osascript') {
          expect(args).toEqual(['-e', 'quit app id "dev.agentmux.desktop"'])
          f.events.push('normal-gui-quit'); f.gui = null
          if (f.host) f.host.ppid = 1
          if (f.worker?.ppid === 201) f.worker.ppid = 1
          f.afterGuiQuit?.()
        } else throw new Error(`Unowned installer command refused: ${command}`)
        child.stdout.end(output); child.stderr.end(); child.emit('exit', 0, null)
      } catch (error) { child.emit('error', error) }
    })
    return child
  } }
})

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (from: string, to: string) => {
    const f = boundary.scope
    if (!f || from !== f.app || !to.startsWith(join(f.home, '.Trash/AgentMux-'))) throw new Error('Unowned directory cutover refused')
    f.cutover = true; f.events.push('cutover')
    throw new Error('OWNED_CUTOVER_BOUNDARY')
  } }
})

vi.mock('../scripts/package-runtime-upgrade.mjs', async importOriginal => {
  const actual = await importOriginal<typeof import('../scripts/package-runtime-upgrade.mjs')>()
  return { ...actual,
    observeUiClient: async () => {
      const f = boundary.scope!
      return { main: { package: JSON.parse(await readFile(join(f.app, 'Contents/Resources/app/package-identity.json'), 'utf8')),
        renderer: { identity: { shell: 'original-shell', ctxmux: 'original-native' } } }, workbench: { loading: false } }
    },
    requireOutgoingWorkbenchStorage: () => {},
    prepareUiRuntime: async () => { await boundary.scope?.beforeQuit?.(); return { privateObservation: true } },
    confirmUiRuntime: async () => {}, closeRuntimeUpgrade: async () => {}
  }
})

afterEach(async () => {
  const scope = boundary.scope
  vi.restoreAllMocks(); boundary.scope = undefined
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
    expect(await access(root).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT'), 'The private installer filesystem must be removed').toBe(true)
    if (process.env.PACKAGE_INSTALL_QUIT_SCOPE_RECEIPT) await appendFile(process.env.PACKAGE_INSTALL_QUIT_SCOPE_RECEIPT,
      JSON.stringify({ caseName: expect.getState().currentTestName, root, removed: true, noLiveProcessCreated: true,
        events: scope?.events, signals: scope?.signals, cutover: scope?.cutover }) + '\n', { mode: 0o600 })
  }
})

async function fixture({ host = true, worker = false, sameSource = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-semantic-gui-quit-'))); roots.push(root)
  const home = join(root, 'home'), app = join(home, 'Applications/AgentMux.app'), candidate = join(root, 'candidate.app')
  const store = join(root, 'original Store/agent-sessions.json'), uid = process.getuid!()
  const birth = _hygiene_fixturePsBirth(24022800000), executable = `${app}/Contents/MacOS/AgentMux`
  const f: Scope = { root, home, app, candidate, store,
    gui: { uid, pid: 201, ppid: 1, birth, command: executable },
    host: host ? { uid, pid: 211, ppid: 201, birth, command: `${executable} ${app}/Contents/Resources/app/out/main/agentmux-host.js --store ${store}` } : null,
    worker: worker ? { uid, pid: 212, ppid: 201, birth, command: `${executable} ${app}/Contents/Resources/app/out/main/file-worker.js` } : null,
    publicPid: 211, publicStore: store, hostMode: 'node', events: [], signals: [], cutover: false }
  for (const [directory, sourceCommit] of [[app, 'a'.repeat(40)], [candidate, (sameSource ? 'a' : 'b').repeat(40)]]) {
    const files = {
      'Contents/MacOS/AgentMux': 'Private executable identity, never executed',
      'Contents/Info.plist': 'Private plist, OS parse boundary controlled',
      'Contents/Resources/app/package-identity.json': JSON.stringify({ schema: 'agentmux.package-identity.v1', sourceCommit,
        sourceTree: 'c'.repeat(40), appVersion: '0.1.0', platform: process.platform, arch: process.arch }),
      'Contents/Resources/app/out/renderer/release.json': JSON.stringify({ identity: { shell: 'original-shell', ctxmux: 'original-native' } }),
      [`Contents/Resources/app/node_modules/@agentmux/core/vendor/ctxmux/${process.platform}-${process.arch}/manifest.json`]: 'Identical private host artifact'
    }
    for (const [relative, bytes] of Object.entries(files)) {
      const target = join(directory!, relative); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes)
    }
  }
  boundary.scope = f
  expect(await realpath(app), 'The private OS snapshot must use the actual canonical application path').toBe(app)
  // Advance only this test's installation deadline. There is no live process,
  // no caller write timeout and no production clock change.
  let time = _hygiene_fixtureTime(24024400000)
  vi.spyOn(Date, 'now').mockImplementation(() => time += 10_000)
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    expect(pid, 'Only the original semantic owner may receive a shutdown signal').toBe(211)
    expect(signal).toBe('SIGTERM'); expect(f.gui).toBeNull(); expect(f.host?.ppid).toBe(1)
    f.signals.push([pid, String(signal)]); f.events.push('semantic-host-shutdown'); f.host = null
    if (f.worker?.ppid === 211 && !f.retainNamespaceWorker) f.worker = null
    return true
  })
  return f
}
async function install(f: Scope, intent = 'full') {
  const { installApplication } = await import('../scripts/package-macos.mjs')
  // Deliberately omit quit and launch overrides: this is the default production IO.
  return await installApplication(f.candidate, { intent, homeDirectory: f.home }).then(
    () => ({ error: null }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
}

it('the default full installer completes GUI quit while only its fenced semantic owner survives', async () => {
  const f = await fixture(), outcome = await install(f)
  expect(outcome.error, 'Normal GUI quit must complete while its exact fenced semantic Host remains alive').toBe('OWNED_CUTOVER_BOUNDARY')
  expect(f.events.filter(event => event !== 'public-owner')).toEqual(['normal-gui-quit', 'semantic-host-shutdown', 'cutover'])
  expect(f.signals).toEqual([[211, 'SIGTERM']]); expect(f.cutover).toBe(true)
})

it('the default full installer protects another original worker after GUI reparenting', async () => {
  const f = await fixture({ worker: true }), outcome = await install(f)
  expect(outcome.error, 'A different original worker must still block application cutover').toContain('has not exited gracefully')
  expect(f.worker?.ppid).toBe(1); expect(f.signals).toEqual([]); expect(f.cutover).toBe(false)
})

it('the default quit retains a prepared owner whose Node mode becomes unknown during GUI exit', async () => {
  const f = await fixture()
  f.afterGuiQuit = () => { f.hostMode = 'unknown' }
  const outcome = await install(f)
  expect(f.events).toContain('normal-gui-quit')
  expect(f.host?.ppid).toBe(1)
  expect(outcome.error, 'A prepared owner with newly unknown mode must remain protected during quit polling').toContain('has not exited gracefully')
  expect(f.signals).toEqual([]); expect(f.cutover).toBe(false)
})

it.each(['birth', 'Store', 'PID', 'UID', 'argv', 'mode', 'Source'] as const)(
  'the default full installer rejects changed %s facts before excluding or stopping an owner', async change => {
    const f = await fixture()
    f.beforeQuit = async () => {
      if (change === 'birth') f.host!.birth = _hygiene_fixturePsBirth(24022801000)
      if (change === 'Store') f.publicStore = join(f.root, 'foreign-store.json')
      if (change === 'PID') f.publicPid = 999
      if (change === 'UID') f.host!.uid++
      if (change === 'argv') f.host!.command = ("" + (f.app) + ("/Contents/MacOS/AgentMux " + _hygiene_fixturePath("other-worker.js") + " --store ") + (f.store) + "")
      if (change === 'mode') f.hostMode = 'unknown'
      if (change === 'Source') {
        const file = join(f.app, 'Contents/Resources/app/package-identity.json')
        const identity = JSON.parse(await readFile(file, 'utf8')); identity.sourceCommit = 'd'.repeat(40)
        await writeFile(file, JSON.stringify(identity))
      }
    }
    const outcome = await install(f)
    expect(outcome.error, 'Changed owner facts must reject the current installation before ordinary quit').not.toBe('OWNED_CUTOVER_BOUNDARY')
    expect(outcome.error, 'Changed owner facts must remain an explicit ownership rejection').toMatch(/Semantic Host|installation changed/)
    expect(f.events, 'Unverified semantic identity must not permit the GUI quit request').not.toContain('normal-gui-quit')
    expect(f.signals).toEqual([]); expect(f.cutover).toBe(false)
  })

it('the ui-only path does not exempt an unplanned child semantic Host', async () => {
  const f = await fixture(), outcome = await install(f, 'ui-only')
  expect(outcome.error, 'Without a prepared full Source plan, the original child owner must remain protected').toContain('has not exited gracefully')
  expect(f.signals).toEqual([]); expect(f.cutover).toBe(false)
})

it.each(['GUI-child', 'detached', 'endpoint-worker'] as const)(
  'the same-Source full installer reloads its exact %s semantic namespace', async shape => {
    const f = await fixture({ sameSource: true, worker: shape === 'endpoint-worker' })
    if (shape === 'detached') f.host!.ppid = 1
    if (shape === 'endpoint-worker') {
      f.worker!.ppid = 211
      f.worker!.command = `${join(f.app, 'Contents/MacOS/AgentMux')} ${join(f.app, 'Contents/Resources/app/node_modules/@agentmux/core/dist/control-endpoint-listener-worker.js')} ${join(f.root, 'original-namespace')}`
    }
    const outcome = await install(f)
    expect(outcome.error, 'Equal Source commits cannot skip exact owner qualification or independent Host shutdown').toBe('OWNED_CUTOVER_BOUNDARY')
    expect(f.events.filter(event => event !== 'public-owner')).toEqual(['normal-gui-quit', 'semantic-host-shutdown', 'cutover'])
    expect(f.signals).toEqual([[211, 'SIGTERM']]); expect(f.host).toBeNull(); expect(f.worker).toBeNull()
    expect(f.cutover).toBe(true)
  })

it('the default full installer preserves the GUI-only cold namespace path', async () => {
  const f = await fixture({ host: false }), outcome = await install(f)
  expect(outcome.error, 'An ordinary GUI exit without a semantic Host must still reach cutover').toBe('OWNED_CUTOVER_BOUNDARY')
  expect(f.events).toEqual(['normal-gui-quit', 'cutover']); expect(f.signals).toEqual([])
})


it('the default installer drains the original Host endpoint worker without signalling it', async () => {
  const f = await fixture({ worker: true }); f.worker!.ppid = 211
  f.worker!.command = ("" + (f.app) + "/Contents/MacOS/AgentMux " + (f.app) + ("/Contents/Resources/app/node_modules/@agentmux/core/dist/control-endpoint-listener-worker.js " + _hygiene_fixturePath("original-namespace")))
  const outcome = await install(f)
  expect(outcome.error).toBe('OWNED_CUTOVER_BOUNDARY')
  expect(f.signals).toEqual([[211, 'SIGTERM']]); expect(f.worker).toBeNull()
  expect(f.events.filter(event => event !== 'public-owner')).toEqual(['normal-gui-quit', 'semantic-host-shutdown', 'cutover'])
})

it('unknown mode on a Host child retains that original worker and blocks cutover', async () => {
  const f = await fixture({ worker: true }); f.worker!.ppid = 211; f.workerMode = 'unknown'
  const outcome = await install(f)
  expect(outcome.error).toContain('has not exited gracefully')
  expect(f.signals).toEqual([]); expect(f.cutover).toBe(false)
})

it('the semantic shutdown waits for original children without signalling a lingering child', async () => {
  const f = await fixture({ worker: true }); f.worker!.ppid = 211; f.retainNamespaceWorker = true
  f.gui = null; f.host!.ppid = 1
  const { stopSemanticHostForInstall } = await import('../scripts/package-semantic-host.mjs')
  const plan = { currentApp: f.app, originalSource: 'a'.repeat(40), owner: { ...f.host! }, identity: { hostProcessId: 211, storePath: f.store } }
  const ops = {
    source: async () => 'a'.repeat(40), bootstrap: async () => plan.identity,
    processRow: async (pid: number) => [f.host, f.worker].find(row => row?.pid === pid) ?? null,
    processes: async () => { const rows = [f.host, f.worker].filter((row): row is Row => !!row); return {
      serving: [], externalNode: rows.map(row => row.pid), processes: rows,
      nodeModes: rows.map(row => ({ ...row, mode: 'node', executable: `${f.app}/Contents/MacOS/AgentMux` })) } },
    signal: (pid: number, signal: string) => process.kill(pid, signal as NodeJS.Signals),
    now: () => Date.now(), wait: async () => {}
  }
  const error = await stopSemanticHostForInstall(plan, ops).then(() => null, (error: Error) => error.message)
  expect(error).toContain('No force kill')
  expect(f.signals).toEqual([[211, 'SIGTERM']]); expect(f.worker?.pid).toBe(212); expect(f.cutover).toBe(false)
})

it.each(['healthy', 'UID', 'birth', 'parent', 'executable', 'mode', 'cycle'])(
  'semantic family requires a complete bound Node chain (%s)', async change => {
    const { semanticHostProcessIds } = await import('../scripts/package-semantic-host.mjs')
    const app = _reshape_fixturePath("Applications/AgentMux.app"), uid = process.getuid!(), executable = `${app}/Contents/MacOS/AgentMux`
    const owner = { uid, pid: 211, ppid: 1, birth: 'owner' }
    const middle = { uid, pid: 212, ppid: 211, birth: 'middle' }, child = { uid, pid: 213, ppid: 212, birth: 'child' }
    const rows = [owner, middle, child], modes = rows.map(row => ({ ...row, mode: 'node', executable }))
    if (change === 'UID') modes[1]!.uid++
    if (change === 'birth') modes[1]!.birth = 'reused'
    if (change === 'parent') { middle.ppid = 999; modes[1]!.ppid = 999 }
    if (change === 'executable') modes[1]!.executable = _hygiene_fixturePath("other/Electron")
    if (change === 'mode') modes[1]!.mode = 'unknown'
    if (change === 'cycle') { middle.ppid = 213; modes[1]!.ppid = 213 }
    expect([...semanticHostProcessIds(app, owner, { processes: rows, nodeModes: modes })]).toEqual(
      change === 'healthy' ? [211, 212, 213] : [211])
  })
