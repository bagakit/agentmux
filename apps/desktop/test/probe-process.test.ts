const { fixturePath: _reshape_fixturePath } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const ports = vi.hoisted(() => ({ spawn: vi.fn(), readPs: vi.fn() }))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const execFile = vi.fn()
  Object.defineProperty(execFile, Symbol.for('nodejs.util.promisify.custom'), { value: ports.readPs })
  ports.spawn.mockImplementation(original.spawn)
  return { ...original, spawn: ports.spawn, execFile }
})
import { runProbeProcess } from '../scripts/probe-process.mjs'
const actualRequire = createRequire(import.meta.url)
const modulePath = fileURLToPath(new URL('../scripts/probe-process.mjs', import.meta.url))
function heldChild() {
  return Object.assign(new EventEmitter(), { pid: 41001, stderr: new PassThrough(), exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null, kill: vi.fn(() => true), unref: vi.fn() })
}
function end(child: ReturnType<typeof heldChild>, code: number | null, signal: NodeJS.Signals | null = null) {
  child.exitCode = code; child.signalCode = signal; child.emit('exit', code, signal)
}

// Execute the actual owning script/fixture source with explicitly controlled dependency ports.
// This is not native Browser proof; the separate original Electron entry supplies that evidence.
async function evaluateSource(relative: string, mocks: Record<string, unknown>, argv: string[] = []) {
  const path = fileURLToPath(new URL(relative, import.meta.url))
  const source = (await readFile(path, 'utf8')).replaceAll('import.meta.dirname', JSON.stringify(join(path, '..')))
    .replaceAll('import.meta.url', JSON.stringify(new URL(relative, import.meta.url).href))
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    transformers: { before: [context => root => ts.visitNode(root, function visit(node: ts.Node): ts.Node {
      if (ts.isIdentifier(node) && node.text === 'require') return ts.factory.createIdentifier('scriptRequire')
      return ts.visitEachChild(node, visit, context)
    }) as ts.SourceFile] } }).outputText
  const module = { exports: {} as Record<string, (...args: any[]) => Promise<any>> }
  const fakeProcess = { argv: ['node', path, ...argv], env: {}, exitCode: undefined }
  const load = (id: string) => Object.hasOwn(mocks, id) ? mocks[id] : actualRequire(id)
  const execute = new Function('require', 'module', 'exports', 'process', 'console', `return (async () => {${code}\n})();`)
  await execute(load, module, module.exports, fakeProcess, { log() {}, error() {} })
  return module.exports
}
async function htmlDriver(outcome: Record<string, unknown>, changedIdentity = false, nativeFailure?: unknown) {
  const root = _reshape_fixturePath("controlled/original-private-directory"), removed = vi.fn(), writes = new Map<string, string>()
  let observations = 0
  const identity = (ino: bigint) => ({ dev: 1n, ino, isDirectory: () => true, isSymbolicLink: () => false })
  const fs = { mkdtemp: async () => root, mkdir: async () => {}, symlink: async () => {}, rm: removed,
    lstat: async () => identity(changedIdentity && observations++ > 0 ? 3n : 2n),
    writeFile: async (path: string, value: string) => { writes.set(path, value) },
    readFile: async (path: string) => writes.get(path) ?? Buffer.from('controlled source/build byte') }
  const build = { build: async (options: any) => ({ metafile: { inputs: { [options.entryPoints[0]]: {} } } }) }
  const require = Object.assign((id: string) => id === 'esbuild' ? build : _reshape_fixturePath("controlled/electron"), { resolve: () => _reshape_fixturePath("controlled/vite.js") })
  await evaluateSource('../scripts/verify-local-file-html.mjs', {
    'node:fs/promises': fs, 'node:module': { createRequire: () => require },
    './lib/fixture-values.mjs': { fixturePath: (value: string) => value },
    './probe-process.mjs': { runProbeProcess: async () => {
      // Execute the actual generated Main and its serializer, replacing only the native import port.
      const main = writes.get(`${root}/main.cjs`)!, bundle = `${root}/native-html.mjs`
      const nativeImport = `import(${JSON.stringify(bundle)})`
      expect(main.split(nativeImport)).toHaveLength(2)
      let completion: Promise<void> | undefined
      const app = { setPath() {}, exit() {}, whenReady: () => ({ then: (run: () => Promise<void>) => { completion = Promise.resolve().then(run); return completion } }) }
      const load = (id: string) => id === 'electron' ? { app, BrowserWindow: class { destroy() {} } } : id === 'node:fs/promises' ? fs : actualRequire(id)
      const loadNative = async () => ({ verifyNativeHtml: async () => {
        if (nativeFailure !== undefined) throw nativeFailure
        return { passed: true }
      } })
      new Function('require', 'loadNative', 'console', main.replace(nativeImport, 'loadNative()'))(load, loadNative, { error() {} })
      await completion
      return outcome
    } }
  }, [("--output=" + _reshape_fixturePath("controlled/evidence"))])
  return { removed, receipt: JSON.parse(writes.get(_reshape_fixturePath("controlled/evidence/html-native-receipt.json"))!) }
}

describe('probe process ownership', () => {
  let globalSignal: MockInstance<typeof process.kill>
  beforeEach(async () => {
    const native = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    ports.spawn.mockReset().mockImplementation(native.spawn)
    ports.readPs.mockReset().mockResolvedValue({ stdout: '' })
    globalSignal = vi.spyOn(process, 'kill').mockReturnValue(true)
  })
  afterEach(() => { vi.useRealTimers(); globalSignal.mockRestore() })

  it('stops only the original real child on its early failure marker and confirms its signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-probe-process-'))
    try {
      const result = await runProbeProcess(process.execPath, ['-e', "process.stderr.write('file_editing_probe_failed=boom\\n'); setInterval(() => {}, 1000)"],
        { temporaryRoot: root, cwd: root, env: { ...process.env }, timeoutMs: 5000, graceMs: 100 })
      expect(result).toMatchObject({ exitCode: 1, originalExitCode: null, exitSignal: 'SIGTERM', exitConfirmed: true, timedOut: false })
      expect(ports.readPs).not.toHaveBeenCalled(); expect(globalSignal).not.toHaveBeenCalled()
    } finally { await rm(root, { recursive: true }) }
  })

  it('bounds a real timeout and confirms the original child exit rather than a path inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-probe-process-')), started = Date.now()
    try {
      const result = await runProbeProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
        { temporaryRoot: root, cwd: root, env: { ...process.env }, timeoutMs: 100, graceMs: 50 })
      expect(result).toMatchObject({ timedOut: true, exitSignal: 'SIGTERM', exitConfirmed: true })
      expect(Date.now() - started).toBeLessThan(3000)
      expect(ports.readPs).not.toHaveBeenCalled(); expect(globalSignal).not.toHaveBeenCalled()
    } finally { await rm(root, { recursive: true }) }
  })

  it('keeps a real spawn failure without claiming an original child exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentmux-probe-spawn-'))
    try {
      const error = await runProbeProcess(join(root, 'never-created-private-executable'), [],
        { cwd: root, env: { ...process.env }, timeoutMs: 5000 }).catch((failure: any) => failure)
      expect(error.errors.some((cause: any) => cause.code === 'ENOENT')).toBe(true)
      expect(error.probe).toMatchObject({ originalPid: null, exitConfirmed: false, cleanup: 'unknown', signals: [] })
      expect(ports.readPs).not.toHaveBeenCalled(); expect(globalSignal).not.toHaveBeenCalled()
    } finally { await rm(root, { recursive: true }) }
  })

  it('does not scan or signal after the original child exit', async () => {
    const child = heldChild(); ports.spawn.mockReturnValue(child)
    const pending = runProbeProcess('private-probe', [], { temporaryRoot: _reshape_fixturePath("controlled/path"), timeoutMs: 50 })
    end(child, 0)
    const result = await pending
    expect(child.kill).not.toHaveBeenCalled(); expect(ports.readPs).not.toHaveBeenCalled(); expect(globalSignal).not.toHaveBeenCalled()
    expect(result).toMatchObject({ exitCode: 0, originalExitCode: 0, exitSignal: null, exitConfirmed: true })
  })

  it('does not turn accepted signals without an exit receipt into success', async () => {
    const child = heldChild(); ports.spawn.mockReturnValue(child); vi.useFakeTimers()
    const pending = runProbeProcess('private-probe', [], { temporaryRoot: _reshape_fixturePath("controlled/path"), timeoutMs: 10, graceMs: 20 }).catch((error: any) => error)
    await vi.advanceTimersByTimeAsync(2200)
    const error = await pending
    expect(error.probe).toMatchObject({ originalPid: child.pid, exitConfirmed: false, cleanup: 'unknown', timedOut: true })
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(ports.readPs).not.toHaveBeenCalled(); expect(globalSignal).not.toHaveBeenCalled()
  })

  it('does not mutate an ended unknown receipt when a later exit arrives', async () => {
    const child = heldChild(); ports.spawn.mockReturnValue(child); vi.useFakeTimers()
    const pending = runProbeProcess('private-probe', [], { timeoutMs: 10, graceMs: 20 }).catch((error: any) => error)
    await vi.advanceTimersByTimeAsync(2200)
    const error = await pending, original = JSON.stringify(error.probe)
    end(child, 0)
    expect(JSON.stringify(error.probe)).toBe(original)
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
  })

  it('keeps an original observation error and cleanup error together', async () => {
    const child = heldChild(), primary = new Error('original onLine failure'), cleanup = new Error('original child signal refused')
    ports.spawn.mockReturnValue(child); child.kill.mockImplementation(() => { throw cleanup }); vi.useFakeTimers()
    const pending = runProbeProcess('private-probe', [], { timeoutMs: 10000, graceMs: 20, onLine: () => { throw primary } }).catch((error: any) => error)
    child.stderr.write('private-original-observation\n')
    await vi.advanceTimersByTimeAsync(2100)
    const error = await pending
    expect(error.errors).toContain(primary); expect(error.errors).toContain(cleanup)
    expect(error.probe).toMatchObject({ exitConfirmed: false, cleanup: 'unknown' })
    expect(ports.readPs).not.toHaveBeenCalled(); expect(globalSignal).not.toHaveBeenCalled()
  })

  it('keeps a frozen original observation error after the original child exits', async () => {
    const child = heldChild(), primary = Object.freeze(new Error('immutable original error'))
    child.kill.mockImplementation(() => { end(child, null, 'SIGTERM'); return true })
    ports.spawn.mockReturnValue(child)
    const pending = runProbeProcess('private-probe', [], { timeoutMs: 10000, onLine: () => { throw primary } }).catch((error: any) => error)
    child.stderr.write('private-observation\n')
    const error = await pending
    expect(error.errors).toContain(primary)
    expect(error.probe).toMatchObject({ exitConfirmed: true, exitSignal: 'SIGTERM' })
    expect(primary).not.toHaveProperty('probe')
  })

  it('does not interpret renderer diagnostic text as the original failure marker', async () => {
    const child = heldChild(); ports.spawn.mockReturnValue(child)
    const pending = runProbeProcess('private-probe', [], { timeoutMs: 10000 })
    child.stderr.write('file_editing_renderer_console={"message":"file_editing_probe_failed=quoted"}\n')
    expect(child.kill).not.toHaveBeenCalled(); end(child, 0); await pending
  })

  it('the original HTML driver retains its namespace when original exit is unconfirmed', async () => {
    const { removed, receipt } = await htmlDriver({ exitCode: null, originalExitCode: null, exitSignal: null, exitConfirmed: false })
    expect(removed).not.toHaveBeenCalled(); expect(receipt.cleanup.status).toBe('retained')
  })

  it('the original HTML driver retains a changed namespace even after exact exit', async () => {
    const { removed, receipt } = await htmlDriver({ exitCode: 0, originalExitCode: 0, exitSignal: null, exitConfirmed: true, timedOut: false, interruption: null }, true)
    expect(removed).not.toHaveBeenCalled(); expect(receipt.cleanup.status).toBe('retained')
  })

  it('the original HTML driver accepts only its naturally completed selected consumer', async () => {
    const { removed, receipt } = await htmlDriver({ exitCode: 0, originalExitCode: 0, exitSignal: null, exitConfirmed: true, timedOut: false, interruption: null })
    expect(receipt.passed).toBe(true); expect(removed).toHaveBeenCalledOnce()
    expect(receipt.result.mainCleanup).toEqual([{ owner: 'private-window', released: true }])
  })

  it.each([
    { timedOut: true, interruption: null },
    { timedOut: false, interruption: 'SIGINT' }
  ])('the original HTML driver rejects interrupted graceful exit 0: %j', async stopped => {
    const { removed, receipt } = await htmlDriver({ exitCode: 0, originalExitCode: 0, exitSignal: null, exitConfirmed: true, ...stopped })
    expect(receipt.result.passed).toBe(true)
    expect(receipt.passed).toBe(false)
    expect(receipt.failure).toMatchObject({ name: 'AssertionError', message: expect.any(String) })
    expect(removed).toHaveBeenCalledOnce() // Exact original exit still permits releasing its original namespace.
  })

  it('the original Browser fixture and generated Main keep both owner receipts and its first assertion', async () => {
    const profileDispose = vi.fn(), cleanup = new Error('controlled manager disposal failed')
    const page = { isLoading: () => false, executeJavaScript: async () => ({ imageLoaded: false }) }
    const exports = await evaluateSource('../scripts/fixtures/local-file-preview/native-html.ts', {
      '../../../src/main/browser-profile-manager': { BrowserProfileManager: class { async initialize() {} dispose = profileDispose } },
      '../../../src/main/browser-profile-store': { BrowserProfileStore: class {} },
      '../../../src/main/browser-ref-ledger-store': { BrowserRefLedgerStore: class {} },
      '../../../src/main/browser-view-manager': { BrowserViewManager: class { async create() {} setBounds() {} nativeOwner() { return { view: { webContents: page } } } dispose() { throw cleanup } } },
      'node:fs/promises': { writeFile: async () => {}, readFile: async () => Buffer.from('original-file') }
    })
    const error = await exports.verifyNativeHtml!({}, _reshape_fixturePath("controlled/root"), _reshape_fixturePath("controlled/evidence")).catch(error => error)
    expect(profileDispose).toHaveBeenCalledOnce()
    expect(error.errors.some((cause: any) => cause.code === 'ERR_ASSERTION')).toBe(true)
    expect(error.errors.some((cause: any) => cause === cleanup || cause.cause === cleanup)).toBe(true)
    const { receipt } = await htmlDriver({ exitCode: 1, originalExitCode: 1, exitSignal: null, exitConfirmed: true, timedOut: false, interruption: null }, false, error)
    expect(receipt.passed).toBe(false)
    expect(receipt.result.error.cleanup).toEqual([
      { owner: 'browser-manager', released: false, error: expect.objectContaining({ name: 'Error', message: cleanup.message }) },
      { owner: 'browser-profiles', released: true }
    ])
    expect(receipt.result.error.errors).toHaveLength(2)
  })
})
