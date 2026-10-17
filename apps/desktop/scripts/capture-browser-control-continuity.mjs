import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
assert.ok(args.length % 2 === 0 && args.every((value, index) => index % 2 !== 0 || ['--receipt', '--recapture-phases'].includes(value)), 'Use an explicit receipt or bounded phase recapture')
const take = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
const recapture = take('--recapture-phases')?.split(',')
assert.ok(!recapture || recapture.length > 0 && new Set(recapture).size === recapture.length && recapture.every(phase => ['waiting', 'navigation', 'script', 'observe', 'completed', 'human'].includes(phase)), 'Recapture only explicit original Renderer phases')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')))
const { transform } = createRequire(require.resolve('vite/package.json'))('esbuild')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const base = join(root, '.tmp/browser-control-continuity/renderer'); await mkdir(base, { recursive: true })
const out = await mkdtemp(join(base, 'attempt-')), source = join(out, 'source'), fixture = 'apps/desktop/scripts/fixtures/browser-control-continuity'
const receiptFile = take('--receipt') ? resolve(take('--receipt')) : join(out, 'receipt.json')
try { await stat(receiptFile); throw new Error('Preserve the original receipt; use a new explicit output') } catch (error) { if (error.code !== 'ENOENT') throw error }
await mkdir(source); await mkdir(dirname(receiptFile), { recursive: true })
const git = values => execFileSync('git', values, { cwd: root, maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
const candidate = git(['rev-parse', 'HEAD']).toString().trim()
const owners = [
  'apps/desktop/src/renderer/src/components/BrowserPane.tsx', 'apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx',
  'apps/desktop/src/renderer/src/components/BrowserControlBoundary.tsx', 'apps/desktop/src/renderer/src/components/BrowserOperationSurface.tsx',
  'apps/desktop/src/renderer/src/styles/browser-operation-surface.css', 'apps/desktop/src/shared/browser-agent-control.ts'
]
const receipt = { schema: 'agentmux.browser-control-continuity.renderer.v1', candidate, passed: false, out,
  scope: recapture ? { kind: 'phase-recapture', phases: recapture } : { kind: 'complete' },
  overlays: {}, sources: {}, assets: {}, runs: [], driverSha256: sha(await readFile(import.meta.filename)),
  boundary: 'Actual BrowserPane, StableWorkbenchView, BrowserPresentationStage, BrowserControlBoundary, operation chrome, media acquisition hook and real video playback. Maintained typed mock API seam and one private canvas.captureStream replace native IPC, operation/control facts and OS capture. PNGs are original complete Renderer WebContents frames, not native child composition, physical input, a live Agent or installation.',
  independentVisualReview: 'required' }
const save = () => writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
const from = 'control={tab.control} preferences={resolveBrowserAgentControl(agentAppearance)}', to = 'control={undefined} preferences={resolveBrowserAgentControl(agentAppearance)}'
async function bind(file) {
  if (!file.startsWith(source + '/') || file.includes('/node_modules/')) return
  const key = relative(source, file), digest = sha(await readFile(file))
  assert.ok(!receipt.sources[key] || receipt.sources[key] === digest, 'Frozen Renderer source remains unchanged: ' + key)
  receipt.sources[key] = digest
}
async function rendererScene() {
  const { app, BrowserWindow } = require('electron'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto')
  const output = process.env.AGENTMUX_CONTINUITY_RENDERER_OUTPUT, entry = process.env.AGENTMUX_CONTINUITY_RENDERER_ENTRY
  const phases = process.env.AGENTMUX_CONTINUITY_RENDERER_PHASES ? JSON.parse(process.env.AGENTMUX_CONTINUITY_RENDERER_PHASES) : null
  const result = { passed: false, cases: [], images: [], cleanup: [], errors: [], pid: process.pid,
    boundary: 'Actual complete Renderer with controlled typed API facts and canvas stream. No native page, actual Agent, OS screenshot or hardware input.' }
  let window
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const write = () => fs.writeFile(path.join(output, 'renderer.json'), JSON.stringify(result, null, 2) + '\n')
  const evaluate = code => window.webContents.executeJavaScript(code)
  async function facts() { return evaluate('window.continuityRenderer.facts()') }
  async function until(name, read) { const end = performance.now() + 7000; while (performance.now() < end) { const value = await read(); if (value) return value; await delay(20) } throw new Error('Renderer scene prerequisite not observed: ' + name) }
  function boundary(stage) {
    assert.ok(stage.boundary, 'Actual BrowserPane passes original control to the mirrored stage: ' + stage.id)
    assert.equal(stage.boundary.viewBox, '0 0 960 540')
    const box = stage.bounds, matrix = stage.boundary.matrix, scale = Math.min(box.width / 960, box.height / 540)
    assert.ok(matrix && Math.abs(matrix.a - scale) < 0.002 && Math.abs(matrix.d - scale) < 0.002, 'The original boundary uses pageAspectFit rather than the whole stage')
    assert.ok(Math.abs(matrix.e - (box.x + (box.width - 960 * scale) / 2)) < 1)
    assert.ok(Math.abs(matrix.f - (box.y + (box.height - 540 * scale) / 2)) < 1)
  }
  const matches = (sample, expected) => Boolean(sample && expected && expected.every((value, index) => Math.abs(value - sample[index]) < 24))
  async function image(name, observed) {
    // DOM commit and the two actual video receivers must describe this scenario,
    // then an original Renderer compositor frame must contain those same pixels.
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const captured = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.webContents.endFrameSubscription(); reject(new Error('The original Renderer compositor did not deliver the declared page phase')) }, 5000)
      window.webContents.beginFrameSubscription(false, frame => {
        if (frame.isEmpty()) return
        const size = frame.getSize(), bitmap = frame.toBitmap(), ratio = size.width / observed.viewport.width
        const painted = observed.stages.every(stage => {
          const box = stage.bounds, scale = Math.min(box.width / 960, box.height / 540)
          const x = Math.floor((box.x + (box.width - scale * 960) / 2 + 938 * scale) * ratio)
          const y = Math.floor((box.y + (box.height - scale * 540) / 2 + 22 * scale) * ratio)
          if (x < 0 || y < 0 || x >= size.width || y >= size.height) return false
          const offset = (y * size.width + x) * 4
          return matches([bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]], observed.sourceMarker)
        })
        if (!painted) return
        clearTimeout(timer); window.webContents.endFrameSubscription(); resolve(frame)
      })
    })
    assert.equal(captured.isEmpty(), false)
    const bytes = captured.toPNG(), file = name + '.png'
    await fs.writeFile(path.join(output, file), bytes)
    result.images.push({ name, file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), pixels: captured.getSize(), facts: observed,
      boundary: 'Unmodified complete original Renderer frame subscription image, accepted only when both page-phase pixel markers match. No OS or native child composition.' })
    await write()
  }
  app.on('window-all-closed', () => {})
  try {
    await app.whenReady()
    app.setActivationPolicy?.('accessory')
    window = new BrowserWindow({ width: 1440, height: 840, useContentSize: true, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    window.webContents.on('render-process-gone', (_event, details) => result.errors.push(details))
    await window.loadFile(entry); window.showInactive()
    await until('fixture mounted', () => evaluate('Boolean(window.continuityRenderer)'))
    await evaluate('window.continuityRenderer.setup()')
    await until('both actual video receivers have their original dimensions', async () => { const read = await facts(); return read.stages.length === 2 && read.stages.every(stage => stage.video?.width === 960 && stage.video.height === 540 && stage.video.readyState >= 2) })
    for (const [phase, expectedPhase, label] of [['waiting', 'waiting', 'Waiting'], ['navigation', 'running', 'Navigating'], ['script', 'running', 'Script'], ['observe', 'running', 'Observing'], ['completed', 'completed', 'Done'], ['human', 'human', 'Your turn']].filter(([phase]) => !phases || phases.includes(phase))) {
      await evaluate(`window.continuityRenderer.phase(${JSON.stringify(phase)})`)
      await until('actual operation chrome and video phase ' + phase, async () => { const read = await facts(); return read.sourcePhase === phase && read.stages.length === 2 && read.stages.every(stage => stage.chrome.phase === expectedPhase && stage.chrome.text?.toLowerCase().includes(label.toLowerCase()) && matches(stage.video?.marker, read.sourceMarker)) })
      const read = await facts(), active = !['completed', 'human'].includes(phase)
      assert.equal(read.stages.length, 2)
      for (const stage of read.stages) {
        if (active) { boundary(stage); assert.equal(stage.chrome.owner, 'agent'); assert.equal(stage.chrome.operation, 'continuity-operation') }
        else { assert.equal(stage.boundary, null, 'An ended operation leaves no mirrored input boundary'); assert.equal(stage.chrome.owner, 'human') }
      }
      assert.equal(read.acquisitions, 1, 'Both actual Stage receivers share the original media acquisition')
      assert.equal(new Set(read.stages.map(stage => stage.video.streamId)).size, 1)
      assert.ok(read.stages.every(stage => stage.video.streamId))
      assert.deepEqual(read.errors, [])
      await image('normal-' + phase, read)
      result.cases.push({ name: 'actual-pane-chrome-' + phase, passed: true })
    }
    if (phases) { assert.equal(result.cases.length, phases.length); assert.equal(result.images.length, phases.length); result.scope = { kind: 'phase-recapture', phases }; result.passed = true; return }
    await evaluate('window.continuityRenderer.phase("waiting")')
    for (const [shape, width, height, theme] of [['narrow', 390, 850, 'dark'], ['short', 1160, 440, 'light']]) {
      window.setContentSize(width, height)
      await evaluate(`window.continuityRenderer.theme(${JSON.stringify(theme)})`)
      await until('actual stage resized ' + shape, async () => { const read = await facts(); return read.viewport.width === width && read.viewport.height === height && read.stages.length === 2 && read.stages.every(stage => stage.bounds.width > 50 && stage.bounds.height > 40 && matches(stage.video?.marker, read.sourceMarker)) })
      const read = await facts(); for (const stage of read.stages) boundary(stage)
      assert.ok(read.stages.every(stage => stage.chrome.phase === 'waiting' && stage.chrome.owner === 'agent'))
      await image(shape + '-waiting', read)
      result.cases.push({ name: 'page-aspect-fit-' + shape, passed: true })
    }
    window.setContentSize(1440, 840)
    await evaluate('window.continuityRenderer.theme("light")')
    for (const owner of ['space-continuity', 'survey-continuity']) {
      await evaluate(`window.continuityRenderer.coverage(${JSON.stringify(owner)})`)
      await until('exact native coverage handoff ' + owner, async () => { const read = await facts(); return read.stages.length === 2 && read.stages.every(stage => stage.id === owner ? stage.boundary === null && stage.video.paused && stage.video.streamId === null : Boolean(stage.boundary) && Boolean(stage.video.streamId) && stage.video.readyState >= 2 && !stage.video.paused) })
      const read = await facts(), mirror = read.stages.find(stage => stage.id !== owner)
      boundary(mirror)
      assert.equal(read.acquisitions, 1)
      assert.equal(read.calls.filter(call => call.method === 'arm').length, 1)
      assert.equal(read.calls.filter(call => call.method === 'ack' && call.ack.outcome === 'ready').length, 1)
      await image('coverage-' + owner, read)
      result.cases.push({ name: 'exact-covered-owner-' + owner, passed: true })
    }
    assert.equal(result.cases.length, 10); assert.equal(result.images.length, 10)
    result.passed = true
  } catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
  finally {
    if (window && !window.isDestroyed()) {
      try { result.disposal = await evaluate('window.continuityRenderer?.dispose()'); if (result.disposal) { assert.equal(result.disposal.listenerCount, 0); assert.deepEqual(result.disposal.trackStates, ['ended']); assert.deepEqual(result.disposal.errors, []) } }
      catch (error) { result.cleanup.push(String(error)) }
      window.destroy()
    }
    result.cleanupComplete = !window || window.isDestroyed()
    await write(); app.exit(result.passed && result.cleanup.length === 0 && result.cleanupComplete ? 0 : 1)
  }
}
try {
  const paths = ['package.json', 'apps/desktop/package.json', 'apps/desktop/src', 'apps/desktop/resources']
  for (const name of await readdir(join(root, 'packages'))) for (const leaf of ['src', 'package.json']) {
    const file = 'packages/' + name + '/' + leaf
    try { git(['cat-file', '-e', candidate + ':' + file]); paths.push(file) } catch {}
  }
  execFileSync('tar', ['-x', '-C', source], { input: git(['archive', candidate, ...paths]) })
  for (const file of [...owners, fixture + '/renderer.tsx']) {
    const bytes = await readFile(join(root, file)), target = join(source, file)
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); receipt.overlays[file] = sha(bytes)
  }
  const aliases = []
  for (const folder of ['', 'apps/desktop', ...paths.filter(file => file.startsWith('packages/') && file.endsWith('/package.json')).map(dirname)]) {
    await symlink(join(root, folder, 'node_modules'), join(source, folder, 'node_modules')).catch(error => { if (error.code !== 'EEXIST') throw error })
    if (!folder.startsWith('packages/')) continue
    const pkg = JSON.parse(await readFile(join(source, folder, 'package.json')))
    for (const [key, value] of Object.entries(pkg.exports ?? {})) {
      const target = typeof value === 'string' ? value : value.browser ?? value.import
      if (typeof target !== 'string') continue
      const name = pkg.name + (key === '.' ? '' : key.slice(1)), wildcard = name.includes('*')
      let replacement = resolve(source, folder, target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
      if (!wildcard) { try { await stat(replacement) } catch { replacement = replacement.replace(/\.ts$/u, '.tsx'); try { await stat(replacement) } catch { continue } } }
      aliases.push({ name, wildcard, find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\*', '(.+)') + '$'), replacement: replacement.replace('*', '$1') })
    }
  }
  aliases.sort((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.name.length - a.name.length)
  const pane = await readFile(join(source, owners[0]), 'utf8'); assert.equal(pane.split(from).length, 2)
  await transform(pane.replace(from, to), { loader: 'tsx', jsx: 'automatic' })
  const html = join(source, fixture, 'renderer.html')
  await writeFile(html, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser control continuity · Renderer proof</title><div id="root"></div><script type="module" src="./renderer.tsx"></script>')
  for (const mutation of recapture ? [false] : [false, true]) {
    const label = mutation ? 'omit-pane-control' : 'baseline', directory = join(out, label)
    await build({ configFile: false, root: dirname(html), base: './', logLevel: 'error', esbuild: { jsx: 'automatic' }, worker: { format: 'es' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'false' }, resolve: { dedupe: ['react', 'react-dom'], alias: aliases },
      css: { postcss: { plugins: [{ postcssPlugin: 'original-continuity-css', async OnceExit(_sheet, { result }) {
        for (const message of result.messages) if (message.type === 'dependency' && typeof message.file === 'string') await bind(message.file)
      } }] } },
      plugins: [{ name: 'original-pane-typed-io-and-private-mutation', enforce: 'pre', async transform(code, id) {
        const file = id.split('?')[0]; if (!file.includes('inline-css')) await bind(file)
        if (file === join(source, 'apps/desktop/src/renderer/src/lib/api.ts')) {
          const entry = 'export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()'
          assert.equal(code.split(entry).length, 2, 'One maintained typed IO fixture seam')
          return { code: code.replace(entry, 'export const api = mockApi'), map: null }
        }
        if (mutation && file === join(source, owners[0])) return { code: code.replace(from, to), map: null }
      } }], build: { outDir: join(directory, 'dist'), minify: false, rollupOptions: { input: html } } })
    const files = {}
    async function collect(folder) { for (const entry of await readdir(folder, { withFileTypes: true })) { const file = join(folder, entry.name); if (entry.isDirectory()) await collect(file); else files[relative(directory, file)] = sha(await readFile(file)) } }
    await collect(directory); receipt.assets[label] = { directory, files }
  }
  for (const file of [...owners, 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx']) assert.ok(receipt.sources[file], 'Actual Renderer consumer is nonempty: ' + file)
  receipt.engine = { executable: require('electron'), version: require('electron/package.json').version, sha256: sha(await readFile(require('electron'))) }
  await save()
  for (const label of recapture ? ['baseline'] : ['baseline', 'omit-pane-control', 'restored']) {
    const directory = join(out, label); await mkdir(directory, { recursive: true })
    const assets = receipt.assets[label === 'restored' ? 'baseline' : label]
    for (const [file, digest] of Object.entries(assets.files)) assert.equal(sha(await readFile(join(assets.directory, file))), digest)
    const privateRoot = await mkdtemp(join(tmpdir(), 'amx-continuity-renderer-'))
    const bootstrap = join(privateRoot, 'bootstrap.cjs')
    await writeFile(bootstrap, `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');for(const key of ['home','appData','userData','sessionData']){const dir=path.join(${JSON.stringify(privateRoot)},key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}(${rendererScene.toString()})().catch(e=>{console.error(e);app.exit(1)});`)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { HOME: join(privateRoot, 'home'), XDG_CACHE_HOME: join(privateRoot, 'cache'), AGENTMUX_CONTINUITY_RENDERER_OUTPUT: directory,
      AGENTMUX_CONTINUITY_RENDERER_ENTRY: join(assets.directory, 'dist/renderer.html') })
    if (recapture) env.AGENTMUX_CONTINUITY_RENDERER_PHASES = JSON.stringify(recapture)
    const row = { label, privateRoot, process: null, remaining: null }, logs = []; receipt.runs.push(row); await save()
    try { row.process = await runProbeProcess(receipt.engine.executable, [bootstrap], { cwd: privateRoot, env, timeoutMs: 60000, onLine: line => logs.push(line) }) }
    catch (error) { row.process = error.probe; throw error }
    finally {
      await writeFile(join(directory, 'process.log'), logs.join('\n')); await writeFile(join(directory, 'process.json'), JSON.stringify(row.process, null, 2) + '\n'); await save()
      if (row.process?.originalPid) {
        await stopProbeProcesses(row.process.originalPid, privateRoot); row.remaining = await listProbeProcesses(row.process.originalPid, privateRoot)
        if (row.process.exitConfirmed && row.remaining.length === 0) {
          try { row.openFiles = execFileSync('lsof', ['+D', privateRoot], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 }) }
          catch (error) { if (error.status === 1 && !String(error.stdout ?? '').trim() && !String(error.stderr ?? '').trim()) { await rm(privateRoot, { recursive: true }); row.privateDataRemoved = true } else row.openFileUnknown = String(error) }
        }
      }
      await save()
    }
    const file = join(directory, 'renderer.json'), bytes = await readFile(file), actual = JSON.parse(bytes)
    Object.assign(row, { actual, renderer: { file, sha256: sha(bytes) } }); await save()
    assert.equal(row.process.timedOut, false); assert.equal(row.process.exitConfirmed, true); assert.equal(row.process.exitSignal, null)
    assert.deepEqual(row.remaining, []); assert.deepEqual(actual.cleanup, []); assert.equal(actual.cleanupComplete, true)
    if (label === 'omit-pane-control') {
      assert.equal(row.process.exitCode, 1); assert.equal(actual.failure?.name, 'AssertionError')
      assert.ok(actual.failure.message.includes('Actual BrowserPane passes original control to the mirrored stage:'))
      row.owningAssertion = 'AssertionRED'
    } else { assert.equal(row.process.exitCode, 0, JSON.stringify(actual.failure)); assert.equal(actual.passed, true); assert.equal(actual.images.length, recapture?.length ?? 10); assert.equal(actual.cases.length, recapture?.length ?? 10) }
  }
  for (const [file, digest] of Object.entries(receipt.sources)) assert.equal(sha(await readFile(join(source, file))), digest)
  for (const [file, digest] of Object.entries(receipt.overlays)) assert.equal(sha(await readFile(join(root, file))), digest, 'Current exact Renderer owner retains consumed bytes: ' + file)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { await save() }
console.log(JSON.stringify({ passed: receipt.passed, receipt: receiptFile }))
