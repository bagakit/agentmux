import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { existsSync, readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { EventEmitter } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

// Execute the actual canonical function bytes without its top-level Electron launch.
// Explicit Electron/CDP doubles below are Source evidence, never Native evidence.
const source = readFileSync(new URL('../scripts/verify-browser-recovery-restart.mjs', import.meta.url), 'utf8')
function canonical(name: string, globals: Record<string, unknown>, original = source) {
  const file = ts.createSourceFile('canonical.mjs', original, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const matches = file.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  expect(matches).toHaveLength(1)
  return new Function(...Object.keys(globals), `return (${matches[0]!.getText(file)})`)(...Object.values(globals))
}

// Only spawn and time are modeled. The original CLI adapter owns waiting and its reply parsing.
function dailyCommand() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { end: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn> }
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  child.kill = vi.fn((signal: string) => { queueMicrotask(() => child.emit('close', null, signal)); return true })
  const spawn = vi.fn(() => child)
  const cli = canonical('cli', { spawn, process: { execPath: 'source-node', env: {} }, join, assert, q: JSON.stringify },
    readFileSync(new URL('../scripts/browser-daily-workface-probe-scenario.mjs', import.meta.url), 'utf8'))
  const ctx = { privateHome: _hygiene_fixturePath('held-decision/home'), runtimeDirectory: _hygiene_fixturePath('held-decision/runtime'),
    coreRoot: _hygiene_fixturePath('held-decision/core'), workspacePath: _hygiene_fixturePath('held-decision/workspace'),
    fixtureTlsEnvironment: { NODE_EXTRA_CA_CERTS: 'source-ca.pem' }, receipt: { daily: { cli: [] } } }
  return { child, spawn, run: (args: string[]) => cli(ctx, null, args) as Promise<unknown> }
}

describe('original native decision wait', () => {
  it('keeps the same apply pending beyond the former overall deadline until its original child returns', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    try {
      const fixture = dailyCommand(), result = fixture.run(['browser', 'profile', 'extension', 'apply', '--review', 'original-review'])
      let settled = false
      void result.then(() => { settled = true }, () => { settled = true })
      await vi.advanceTimersByTimeAsync(480_001)
      expect(fixture.child.kill).not.toHaveBeenCalled(); expect(fixture.spawn).toHaveBeenCalledTimes(1)
      expect(settled).toBe(false)
      const original = { outcome: 'applied', receipt: { operationId: 'original-review' } }
      fixture.child.stdout.emit('data', JSON.stringify({ ok: true, operation: 'browser.profile.extension.apply', result: original }))
      fixture.child.emit('close', 0, null)
      await expect(result).resolves.toEqual(original)
      expect(fixture.spawn).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('keeps the original ordinary command timeout', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    try {
      const fixture = dailyCommand(), result = fixture.run(['browser', 'profile', 'extension', 'ls'])
      void result.catch(() => {})
      await vi.advanceTimersByTimeAsync(30_001)
      expect(fixture.child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      await expect(result).rejects.toThrow('Private CLI deadline is not a business result')
    } finally { vi.useRealTimers() }
  })

  it('gives the next business observation its own finite budget after a long original decision', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    try {
      const file = ts.createSourceFile('canonical.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      const declarations = file.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).filter(node => node.name.getText(file) === 'deadline')
      expect(declarations).toHaveLength(1)
      const deadline = new Function('dailyCase', 'collaborationCase', 'taskDataCase', 'privateCase', `return (${declarations[0]!.initializer!.getText(file)})`)(true, false, false, false)
      const waitFor = canonical('waitFor', { deadline, delay: (ms: number) => new Promise(done => setTimeout(done, ms)) })
      await vi.advanceTimersByTimeAsync(480_001)
      await expect(waitFor('original result after decision', () => 'original fact')).resolves.toBe('original fact')
      const pending = waitFor('bounded next observation', () => null)
      void pending.catch(() => {})
      await vi.advanceTimersByTimeAsync(20_061)
      await expect(pending).rejects.toThrow('Browser recovery timed out: bounded next observation')
    } finally { vi.useRealTimers() }
  })
})

// The actual capture evaluator reads a DOM with two retained Browser Tabs.
// Geometry and Electron pixels are explicit Source doubles, not Native proof.
function captureDocument({ reader = 'unrelated', content = 'page', pageUrl = true, nativeVisible = true, outsideStage = false, preview = 'none', duplicateSource = false } = {}) {
  const document = new Window({ url: 'http://fixture/workbench' })
  const targetUrl = 'http://127.0.0.1:9912/effect', siblingUrl = 'http://127.0.0.1:9912/old'
  const stage = { x: 300, y: 50, width: 500, height: 600 }, siblingStage = { x: 10, y: 50, width: 200, height: 300 }
  const rect = (value: typeof stage) => ({ ...value, left: value.x, top: value.y, right: value.x + value.width, bottom: value.y + value.height })
  const bounds = (value: typeof stage) => JSON.stringify(value).replaceAll('"', '&quot;')
  const timeline = (id: string, sequence: string) => `<section class="browser-rsi-timeline" data-operation-id="${id}"><div class="browser-rsi-timeline__step" data-sequence="${sequence}"><button aria-pressed="false" aria-expanded="false"></button><span class="browser-rsi-timeline__status">completed</span></div></section>`
  document.document.body.innerHTML = `
    <section data-browser-surface="sibling" data-test-rect="${bounds(siblingStage)}">
      <input aria-label="Browser address" value="${siblingUrl}"><div class="browser-toolbar"><span class="browser-operation-status" data-phase="failed" data-operation-id="old-operation"></span></div>
      <div data-native-browser-stage="sibling"></div>
    </section>
    <section data-browser-surface="target" data-test-rect="${bounds(stage)}">
      <input aria-label="Browser address" value="${targetUrl}"><div class="browser-toolbar"><span class="browser-operation-status" data-phase="idle" data-control="human" data-operation-id="target-operation"></span></div>
      <div data-native-browser-stage="target"></div>
    </section>
    <aside class="browser-trace-rail browser-trace-rail--floating" data-test-rect="${bounds({ x: 10, y: 400, width: 200, height: 200 })}">
      ${reader === 'empty' ? '<section class="browser-rsi-history" aria-label="Browser operation history"><p class="browser-rsi-history__empty">No recorded operation yet.</p></section>' : timeline('old-operation', 'old')}
    </aside>`
  if (preview !== 'none') {
    // happy-dom models MediaStream/video objects but omits the standard media ready-state constants.
    Object.defineProperty(document.HTMLMediaElement, 'HAVE_CURRENT_DATA', { value: 2 })
    const host = document.document.querySelector(`[data-native-browser-stage="${preview === 'other-browser' ? 'sibling' : 'target'}"]`)!
    const video = document.document.createElement('video'), stream = document.document.createElement('canvas').captureStream()
    video.style.objectFit = 'contain'; video.style.objectPosition = '50% 50%'
    video.srcObject = stream // Actual happy-dom MediaStream/video objects; decoder/playback fields are an explicit Source model.
    Object.defineProperties(video, { readyState: { value: 2 }, paused: { value: preview === 'paused' },
      ended: { value: false }, videoWidth: { value: preview === 'missing-decoded' ? 0 : 640 }, videoHeight: { value: preview === 'missing-decoded' ? 0 : 480 } })
    if (preview === 'ended') stream.getVideoTracks()[0]!.stop()
    if (preview === 'zero-size') video.setAttribute('data-test-rect', JSON.stringify({ ...stage, width: 0 }))
    host.appendChild(video)
  }
  for (const element of document.document.querySelectorAll('*')) {
    const geometry = () => rect(JSON.parse(element.closest('[data-test-rect]')?.getAttribute('data-test-rect') ?? JSON.stringify(stage)))
    Object.defineProperties(element, {
      getBoundingClientRect: { value: geometry }, getClientRects: { value: () => [geometry()] },
      checkVisibility: { value: () => !element.closest('[hidden]') }
    })
  }
  const originalStage = pageUrl ? stage : siblingStage
  const nativeBounds = outsideStage ? { ...originalStage, x: 1300 } : originalStage, captures: number[] = []
  const image = { isEmpty: () => false, getSize: () => ({ width: 500, height: 600 }), toPNG: () => Buffer.from([1, 2, 3]) }
  const view = { getVisible: () => nativeVisible, getBounds: () => nativeBounds, webContents: {
    id: 30, isDestroyed: () => false, isLoading: () => false, getURL: () => pageUrl ? targetUrl : siblingUrl,
    capturePage: async () => { captures.push(30); return image }
  } }
  const main = { evaluate: async (expression: string) => JSON.parse(JSON.stringify(await runInNewContext(expression, {
    process: { pid: 41000, getBuiltinModule: (name: string) => name === 'module' ? { createRequire: () => () => ({ BrowserWindow: {
      getAllWindows: () => [{ webContents: { getZoomFactor: () => 1, capturePage: async () => image }, contentView: { children: duplicateSource ? [view, { ...view, webContents: { ...view.webContents, id: 31 } }] : [view] },
        getSize: () => [1024, 768], getContentSize: () => [1024, 768], getBounds: () => ({ x: 0, y: 0, width: 1024, height: 768 }),
        isVisible: () => true, isMinimized: () => false, isFocused: () => true }]
    } }) } : name === 'fs' ? { writeFileSync: () => {} } : name === 'crypto' ? { createHash: () => ({ update: () => ({ digest: () => 'source-pixels' }) }) } : null }
  }))) }
  const receipt = { visual: { frames: [] } } as Record<string, any>
  const capture = canonical('capture', { assert, waitFor: async (label: string, read: () => unknown) => {
    const value = await read(); assert.ok(value, label + ': ' + JSON.stringify(receipt.visual.lastCaptureObservation.preview)); return value
  }, desktopRoot: _hygiene_fixturePath('private-candidate'), join: (...parts: string[]) => parts.join('/'), receipt,
  captureDirectory: _hygiene_fixturePath('private-captures'), localRecoveryCase: false, captureOsWindow: async () => {} })
  return { capture: () => capture({ main, cdp: { evaluate: async (expression: string) => JSON.parse(JSON.stringify(await document.eval(expression))) } },
    'actual-target', content, pageUrl ? targetUrl : undefined),
  receipt, captures, close: () => document.happyDOM.cancelAsync() }
}

describe('canonical Browser recovery boundaries', () => {
  it('initializes the ordinary Desktop application root before resolving its original native dependency', () => {
    const file = ts.createSourceFile('canonical.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const initializers: ts.Expression[] = []
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'bootstrap' && node.initializer) initializers.push(node.initializer)
      ts.forEachChild(node, visit)
    }
    visit(file); expect(initializers).toHaveLength(1)
    const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const root = _hygiene_fixturePath('application-identity'), privateHome = join(root, 'home'), mainPath = join(desktopRoot, 'out/main/index.js')
    const bootstrap = new Function('zoomCase', 'desktopRoot', 'privateHome', 'root', 'userData', 'mainPath', 'pathToFileURL', 'join',
      `return (${initializers[0]!.getText(file)})`)(false, desktopRoot, privateHome, root, join(root, 'user-data'), mainPath, pathToFileURL, join)
    const emitted = ts.createSourceFile('bootstrap.cjs', bootstrap, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    // Execute the real emitted pre-import setup; this Source model never imports or launches Electron/Main.
    const setup = emitted.statements.filter(node => !node.getText(emitted).startsWith('import(')).map(node => node.getText(emitted)).join('\n')
    let applicationPath = dirname(mainPath)
    const paths = new Map<string, string>(), globals: Record<string, unknown> = {}
    const app = { isPackaged: false, getAppPath: () => applicationPath, setAppPath: (value: string) => { applicationPath = value },
      setPath: (name: string, value: string) => paths.set(name, value) }
    new Function('require', 'globalThis', setup)(() => ({ app }), globals)
    const ownerSource = readFileSync(new URL('../src/main/native-desktop-owner.ts', import.meta.url), 'utf8')
    const owner = ts.createSourceFile('owner.ts', ownerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const declarations = owner.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'resolvedNativeDesktopOptions')
    expect(declarations).toHaveLength(1)
    const resolver = ts.transpileModule(declarations[0]!.getText(owner).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const options = new Function('app', 'join', 'resolve', resolver + '\nreturn resolvedNativeDesktopOptions()')(app, join, resolve)
    expect(options.executablePath).toBe(resolve(desktopRoot, '../../packages/native-desktop/macos/.build/debug/agentmux-native-macos'))
    expect(applicationPath).toBe(desktopRoot)
    expect(paths.get('home')).toBe(privateHome); expect(paths.get('userData')).toBe(join(root, 'user-data'))
    expect(globals.__amxPrivatePathsConfigured).toBe(true)
  })

  it('captures the exact page Browser while an earlier retained Tab and unrelated floating reader remain mounted', async () => {
    const fixture = captureDocument()
    try {
      await fixture.capture()
      const frame = fixture.receipt.visual.frames[0]
      expect(frame.observation.browserSurface.browserId).toBe('target')
      expect(frame.observation.operationStatus.phase).toBe('idle')
      expect(frame.observation.stage).toEqual({ x: 300, y: 50, width: 500, height: 600 })
      expect(frame.observation.selectedStageBrowserId).toBe('target')
      expect(frame.observation.stages.map((item: { browserId: string }) => item.browserId)).toEqual(['sibling', 'target'])
      expect(frame.observation.trace).toBeUndefined()
      expect(frame.observation.rows).toEqual([])
      expect(fixture.captures).toEqual([30])
      expect(frame.observation.presentationProof.kind).toBe('native-fit')
    } finally { await fixture.close() }
  })

  it('accepts a live renderer preview of the exact Browser without moving its execution source', async () => {
    const fixture = captureDocument({ preview: 'live', nativeVisible: false, outsideStage: true })
    try {
      await fixture.capture()
      const frame = fixture.receipt.visual.frames[0]
      expect(frame.observation.presentationProof).toMatchObject({ kind: 'renderer-preview', webContentsId: 30,
        preview: { browserId: 'target', passed: true, videos: [{ readyState: 2, paused: false, width: 640, height: 480 }] } })
      expect(frame.nativePage).toMatchObject({ captureRole: 'execution-source', webContentsId: 30, visible: false, bounds: { x: 1300, y: 50, width: 500, height: 600 } })
      expect(fixture.captures).toEqual([30])
    } finally { await fixture.close() }
  })

  it.each(['missing-decoded', 'ended', 'paused', 'zero-size', 'other-browser', 'duplicate-source'])('rejects incomplete preview proof: %s', async preview => {
    const fixture = captureDocument({ preview: preview === 'duplicate-source' ? 'live' : preview, duplicateSource: preview === 'duplicate-source', nativeVisible: false, outsideStage: true })
    try {
      await expect(fixture.capture()).rejects.toThrow('native page bounds inside the actual stage')
      expect(fixture.captures).toEqual([])
      expect(fixture.receipt.visual.lastCaptureObservation.nativeFrame.owners).toHaveLength(preview === 'duplicate-source' ? 2 : 1)
    } finally { await fixture.close() }
  })

  it('binds an explicit detail URL to its original stage while preserving the existing reader', async () => {
    const fixture = captureDocument({ content: 'operations' })
    try {
      await fixture.capture()
      const observation = fixture.receipt.visual.frames[0].observation
      expect(observation.selectedStageBrowserId).toBe('target')
      expect(observation.stage).toEqual({ x: 300, y: 50, width: 500, height: 600 })
      expect(observation.rows.map((row: { sequence: string }) => row.sequence)).toEqual(['old'])
      expect(observation.traceMode).toBe('floating')
    } finally { await fixture.close() }
  })

  it.each([{ content: 'operations', reader: 'unrelated' }, { content: 'empty-operations', reader: 'empty' }])('preserves existing multi-Browser no-URL reader capture, including an empty metadata-free portal: %j', async options => {
    const fixture = captureDocument({ ...options, pageUrl: false })
    try {
      await fixture.capture()
      const observation = fixture.receipt.visual.frames[0].observation
      expect(observation.browserSurface).toBeUndefined()
      expect(observation.traceMode).toBe('floating')
      expect(observation.rows.map((row: { sequence: string }) => row.sequence)).toEqual(options.reader === 'empty' ? [] : ['old'])
      if (options.reader === 'empty') expect(observation.emptyHistory).toMatchObject({ histories: 1, timelines: 0, errors: 0 })
    } finally { await fixture.close() }
  })

  it.each([{ nativeVisible: false }, { outsideStage: true }])('retains actual native owner geometry and still rejects an invalid page frame: %j', async options => {
    const fixture = captureDocument(options)
    try {
      await expect(fixture.capture()).rejects.toThrow('native page bounds inside the actual stage')
      const observed = fixture.receipt.visual.lastCaptureObservation
      expect(observed.observation.browserSurface.browserId).toBe('target')
      expect(observed.nativeFrame.owners).toHaveLength(1)
      expect(observed.nativeFrame.owners[0]).toMatchObject({ webContentsId: 30, visible: options.nativeVisible ?? true,
        x: options.outsideStage ? 1300 : 300, browserUrl: 'http://127.0.0.1:9912/effect' })
      expect(observed.failureWindow).toMatchObject({ pid: 41000, windows: [{ size: [1024, 768], contentSize: [1024, 768], visible: true, focused: true, zoom: 1 }] })
      expect(observed.failureDocument.visibilityState).toBe('visible')
      expect(observed.failureDocument.observedAt).toBeGreaterThanOrEqual(observed.observation.observedAt)
      expect(observed.failureDocument.stages).toEqual([{ browserId: 'target', bounds: { x: 300, y: 50, width: 500, height: 600 }, checkVisibility: true }])
      expect(fixture.captures).toEqual([])
    } finally { await fixture.close() }
  })

  it('binds every static production source identity to an existing repository file', () => {
    const file = ts.createSourceFile('canonical.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const identity = file.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'identity')
    expect(identity).toHaveLength(1)
    const paths = new Set<string>()
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) && /^(apps|packages)\/.*\/src\//.test(node.text)) paths.add(node.text)
      ts.forEachChild(node, visit)
    }
    visit(identity[0]!)
    expect(paths.size).toBeGreaterThan(0)
    for (const path of paths) expect(existsSync(new URL(`../../../${path}`, import.meta.url)), path).toBe(true)
  })

  it('joins the actual error document by original visible Region geometry without navigating it', async () => {
    const regions = [{ regionId: 'original', browserId: 'browser-a', url: 'http://fixture/disconnected' }, { regionId: 'sibling', browserId: 'browser-b', url: 'http://fixture/b' }]
    const stages = regions.map((region, i) => ({ regionId: region.regionId, x: i * 240, y: 50, width: 234.5, height: 300 }))
    const loadURL = vi.fn()
    const views = stages.map((stage, i) => ({ getVisible: (): boolean => true, getBounds: () => ({ x: stage.x * 1.25, y: stage.y * 1.25, width: stage.width * 1.25, height: stage.height * 1.25 }), webContents: {
      id: i + 3, isDestroyed: () => false, isLoading: () => false, getURL: () => i ? regions[1]!.url : '', getTitle: () => i ? 'Sibling' : 'Unavailable page', loadURL,
      capturePage: async () => ({ isEmpty: () => false, getSize: () => ({ width: 293, height: 375 }) }), executeJavaScript: async () => i ? 'Actual sibling page' : 'Original failed destination'
    } }))
    const main = { evaluate: async (expression: string) => JSON.parse(JSON.stringify(await runInNewContext(expression, { process: { getBuiltinModule: () => ({ createRequire: () => () => ({ BrowserWindow: { getAllWindows: () => [{ webContents: { getZoomFactor: () => 1.25 }, contentView: { children: views } }] } }) }) } }))) }
    const cdp = { evaluate: vi.fn(async () => stages) }
    const waitFor = async (_label: string, read: () => unknown) => read()
    const read = canonical('nativeRegionPages', { waitFor, desktopRoot: _hygiene_fixturePath("private-candidate"), join: (...parts: string[]) => parts.join('/') })
    const result = await read({ cdp, main }, regions)
    expect(result).toHaveLength(2)
    expect(result.map((page: { regionId: string; url: string; visible: boolean }) => [page.regionId, page.url, page.visible])).toEqual([['original', '', true], ['sibling', regions[1]!.url, true]])
    expect(result[0].text).toBe('Original failed destination')
    expect(loadURL).not.toHaveBeenCalled()
    views[0]!.getVisible = () => false
    expect(await read({ cdp, main }, regions)).toBeNull()
    views[0]!.getVisible = () => true
    views[0]!.getBounds = () => ({ x: 900, y: 900, width: 293, height: 375 })
    expect(await read({ cdp, main }, regions)).toBeNull()
  })

  it('signals only positively discovered private PIDs through the ownership recheck', async () => {
    const listProbeProcesses = vi.fn().mockResolvedValueOnce([41001]).mockResolvedValue([])
    const signalOwnedProbeProcess = vi.fn(async () => true)
    const cleanup = canonical('cleanupOwnedProbes', { assert, listProbeProcesses, signalOwnedProbeProcess, delay: async () => {} })
    expect(await cleanup(_hygiene_fixturePath("tmp/unique-browser-root"))).toEqual({ remaining: [], errors: [] })
    expect(listProbeProcesses.mock.calls.length).toBeGreaterThan(0)
    expect(listProbeProcesses.mock.calls).toEqual(Array.from({ length: listProbeProcesses.mock.calls.length }, () => [0, _hygiene_fixturePath("tmp/unique-browser-root")]))
    expect(signalOwnedProbeProcess.mock.calls).toEqual([[41001, _hygiene_fixturePath("tmp/unique-browser-root"), 'SIGTERM']])
  })

  it('keeps unknown identity failure honest and never signals a guessed group or sentinel', async () => {
    const listProbeProcesses = vi.fn().mockResolvedValueOnce([41001]).mockResolvedValue([])
    const signalOwnedProbeProcess = vi.fn(async () => { throw new Error('Private process identity changed') })
    const cleanup = canonical('cleanupOwnedProbes', { assert, listProbeProcesses, signalOwnedProbeProcess, delay: async () => {} })
    expect(await cleanup(_hygiene_fixturePath("tmp/unique-browser-root"))).toEqual({ remaining: [], errors: ['Private process identity changed'] })
    expect(signalOwnedProbeProcess.mock.calls).toEqual([[41001, _hygiene_fixturePath("tmp/unique-browser-root"), 'SIGTERM']])
  })

  it('rejects two retained Regions that both claim the same unique geometry owner', async () => {
    const regions = [{ regionId: 'original', browserId: 'browser-a' }, { regionId: 'sibling', browserId: 'browser-b' }]
    const bounds = { x: 10, y: 50, width: 234.5, height: 300 }
    const stages = regions.map(region => ({ regionId: region.regionId, ...bounds }))
    const view = { getVisible: () => true, getBounds: () => bounds, webContents: {
      id: 30, isDestroyed: () => false, isLoading: () => false, getURL: () => '', getTitle: () => 'Original error document',
      capturePage: async () => ({ isEmpty: () => false, getSize: () => ({ width: 235, height: 300 }) }),
      executeJavaScript: async () => 'Original failed destination'
    } }
    const main = { evaluate: async (expression: string) => JSON.parse(JSON.stringify(await runInNewContext(expression, {
      process: { getBuiltinModule: () => ({ createRequire: () => () => ({ BrowserWindow: {
        getAllWindows: () => [{ webContents: { getZoomFactor: () => 1 }, contentView: { children: [view] } }]
      } }) }) }
    }))) }
    const read = canonical('nativeRegionPages', { waitFor: async (_label: string, read: () => unknown) => read(),
      desktopRoot: _hygiene_fixturePath("private-candidate"), join: (...parts: string[]) => parts.join('/') })
    expect(await read({ main, cdp: { evaluate: async () => stages } }, regions)).toBeNull()
  })

  it('keeps EPERM honest while still attempting the other positively owned PID', async () => {
    const temporaryRoot = _hygiene_fixturePath("tmp/unique-browser-root"), remaining = new Set([41001, 41002])
    const listProbeProcesses = vi.fn(async () => [...remaining])
    const signalOwnedProbeProcess = vi.fn(async (pid: number) => {
      if (pid === 41001) throw Object.assign(new Error('EPERM: private PID could not be signalled'), { code: 'EPERM' })
      remaining.delete(pid); return true
    })
    let tick = 0
    const cleanup = canonical('cleanupOwnedProbes', { assert, listProbeProcesses, signalOwnedProbeProcess,
      delay: async () => {}, Date: { now: () => ++tick * 1_000 } })
    const result = await cleanup(temporaryRoot)
    expect(signalOwnedProbeProcess.mock.calls).toEqual([[41001, temporaryRoot, 'SIGTERM'], [41002, temporaryRoot, 'SIGTERM'], [41001, temporaryRoot, 'SIGKILL']])
    expect(result.remaining).toEqual([41001])
    expect(result.errors).toEqual(expect.arrayContaining(['EPERM: private PID could not be signalled']))
  })

  it('rechecks unique geometry at actual pixel capture after the successful preflight', async () => {
    async function execute(duplicate: boolean) {
      const stage = { x: 10, y: 50, width: 234.5, height: 300 }, captures: number[] = []
      const image = { isEmpty: () => false, getSize: () => ({ width: 235, height: 300 }), toPNG: () => Buffer.from([1, 2, 3]) }
      const view = (id: number) => ({ getVisible: () => true, getBounds: () => stage, webContents: {
        id, isDestroyed: () => false, isLoading: () => false, getURL: () => '',
        capturePage: async () => { captures.push(id); return image }
      } })
      const children = [view(30)]
      const window = { webContents: { getZoomFactor: () => 1, capturePage: async () => image }, contentView: { children } }
      const main = { evaluate: async (expression: string) => JSON.parse(JSON.stringify(await runInNewContext(expression, {
        process: { getBuiltinModule: (name: string) => name === 'module' ? { createRequire: () => () => ({ BrowserWindow: { getAllWindows: () => [window] } }) }
          : name === 'fs' ? { writeFileSync: () => {} } : name === 'crypto' ? { createHash: () => ({ update: () => ({ digest: () => 'fake-captured-bytes-hash' }) }) } : null }
      }))) }
      const observation = { viewport: { width: 1000, height: 720 }, rows: [{ sequence: '1', status: 'failed' }], stage,
        trace: { x: 10, y: 400, width: 234.5, height: 200 } }
      const cdp = { evaluate: async (expression: string) => expression.startsWith('new Promise') ? undefined : JSON.parse(JSON.stringify(observation)) }
      const receipt = { visual: { frames: [] } }
      const capture = canonical('capture', { assert, waitFor: async (_label: string, read: () => unknown) => read(),
        desktopRoot: _hygiene_fixturePath("private-candidate"), join: (...parts: string[]) => parts.join('/'), receipt,
        captureDirectory: _hygiene_fixturePath("private-captures"), localRecoveryCase: true,
        captureOsWindow: async () => { if (duplicate) children.push(view(31)) } })
      await capture({ main, cdp }, 'actual-error-view', 'operations', '')
      return { receipt, captures }
    }
    const single = await execute(false)
    expect(single.captures).toEqual([30]); expect(single.receipt.visual.frames).toHaveLength(1)
    await expect(execute(true)).rejects.toThrow()
  })
})
