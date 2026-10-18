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
const ownershipScope = args.includes('--ownership-scope'), returnControlScope = args.includes('--return-control-scope')
const pairedArgs = args.filter(value => !['--ownership-scope', '--return-control-scope'].includes(value))
assert.ok(pairedArgs.length % 2 === 0 && pairedArgs.every((value, index) => index % 2 !== 0 || ['--receipt', '--recapture-phases'].includes(value)), 'Use an explicit receipt, ownership/return-control scope or bounded phase recapture')
const take = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
const recapture = take('--recapture-phases')?.split(',')
assert.ok(Number(ownershipScope) + Number(returnControlScope) + Number(Boolean(recapture)) <= 1, 'Ownership, direct-return and image-only recapture have separate scopes')
const selectedPhases = returnControlScope ? ['human'] : ownershipScope ? ['waiting', 'completed', 'failed', 'stopped', 'human'] : recapture
assert.ok(!recapture || recapture.length > 0 && new Set(recapture).size === recapture.length && recapture.every(phase => ['waiting', 'navigation', 'script', 'observe', 'completed', 'failed', 'stopped', 'human'].includes(phase)), 'Recapture only explicit original Renderer phases')
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
  'apps/desktop/src/renderer/src/styles/browser-operation-surface.css', 'apps/desktop/src/shared/browser-agent-control.ts', 'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/shared/contracts.ts'
]
const receipt = { schema: 'agentmux.browser-control-continuity.renderer.v1', candidate, passed: false, out,
  scope: recapture ? { kind: 'phase-recapture', phases: recapture } : returnControlScope ? { kind: 'direct-return-normal-narrow-short-and-pane-callbacks', phases: selectedPhases, mutations: 'not-repeated' } : ownershipScope ? { kind: 'ownership-with-layout-and-button-mutations', phases: selectedPhases } : { kind: 'complete' },
  overlays: {}, sources: {}, assets: {}, runs: [], driverSha256: sha(await readFile(import.meta.filename)),
  boundary: 'Actual BrowserPane, StableWorkbenchView, BrowserPresentationStage, BrowserControlBoundary, operation chrome, media acquisition hook and real video playback. Maintained typed mock API seam and one private canvas.captureStream replace native IPC, operation/control facts and OS capture. PNGs are original complete Renderer WebContents frames, not native child composition, physical input, a live Agent or installation.',
  independentVisualReview: 'required' }
const save = () => writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n')
const takeoverFrom = 'onTakeControl={() => void takeBrowserControl()}', takeoverTo = 'onTakeControl={() => void stopBrowserOperation()}'
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
  const ownershipScope = process.env.AGENTMUX_CONTINUITY_RENDERER_OWNERSHIP === 'true'
  const returnControlScope = process.env.AGENTMUX_CONTINUITY_RENDERER_RETURN === 'true'
  const result = { passed: false, cases: [], images: [], cleanup: [], errors: [], pid: process.pid,
    boundary: 'Actual complete Renderer with controlled typed API facts and canvas stream. No native page, actual Agent, OS screenshot or hardware input.' }
  let window
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const write = () => fs.writeFile(path.join(output, 'renderer.json'), JSON.stringify(result, null, 2) + '\n')
  const evaluate = code => window.webContents.executeJavaScript(code)
  async function facts() { return evaluate('window.continuityRenderer.facts()') }
  async function until(name, read) { const end = performance.now() + 7000; while (performance.now() < end) { const value = await read(); if (value) return value; await delay(20) } throw new Error('Renderer scene prerequisite not observed: ' + name) }
  async function directReturnVisible(name) {
    const buttons = await evaluate(`Array.from(document.querySelectorAll('[data-browser-presentation-id]')).map(stage=>{const button=stage.closest('.browser-surface')?.querySelector('button[aria-label="Return to Agent"]'),r=button?.getBoundingClientRect();return Boolean(button&&!button.closest('[role="menu"]')&&r.width>0&&r.height>0&&r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1)})`)
    assert.equal(buttons.length, 2)
    assert.ok(buttons.every(Boolean), 'Both actual BrowserPane presentations expose Return to Agent directly: ' + name)
  }
  function boundary(stage) {
    assert.ok(stage.boundary, 'Actual BrowserPane passes original control to the mirrored stage: ' + stage.id)
    assert.equal(stage.boundary.viewBox, '0 0 960 540')
    const box = stage.bounds, matrix = stage.boundary.matrix, scale = Math.min(box.width / 960, box.height / 540)
    assert.ok(matrix && Math.abs(matrix.a - scale) < 0.002 && Math.abs(matrix.d - scale) < 0.002, 'The original boundary uses pageAspectFit rather than the whole stage')
    assert.ok(Math.abs(matrix.e - (box.x + (box.width - 960 * scale) / 2)) < 1)
    assert.ok(Math.abs(matrix.f - (box.y + (box.height - 540 * scale) / 2)) < 1)
  }
  const matches = (sample, expected) => Boolean(sample && expected && expected.every((value, index) => Math.abs(value - sample[index]) < 24))
  function compositorMatches(sample, observed) {
    // The page's phase marker is visual capture evidence, never control authority.
    // Decode its declared palette after the real inner glow blends over its pixels.
    const palette = { waiting: [30, 70, 130], navigation: [210, 90, 30], script: [150, 45, 160], observe: [30, 155, 170],
      completed: [40, 145, 55], failed: [185, 50, 50], stopped: [135, 125, 25], human: [155, 100, 45] }
    const ranked = Object.entries(palette).map(([phase, rgb]) => ({ phase, distance: rgb.reduce((sum, value, index) => sum + (value - sample[index]) ** 2, 0) })).sort((a, b) => a.distance - b.distance)
    return ranked[0].phase === observed.sourcePhase && observed.sourceMarker.every((value, index) => Math.abs(value - sample[index]) < 64)
  }
  async function image(name, observed) {
    // DOM commit and the two actual video receivers must describe this scenario,
    // then an original Renderer compositor frame must contain those same pixels.
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const captured = await new Promise((resolve, reject) => {
      let latest, received = 0, samples = []
      const timer = setTimeout(async () => {
        window.webContents.endFrameSubscription()
        result.paintDiagnostic = { name, received, samples, expected: observed.sourceMarker }
        if (latest) await fs.writeFile(path.join(output, name + '-unqualified-compositor.png'), latest.toPNG())
        reject(new Error('The original Renderer compositor did not deliver the declared page phase'))
      }, 5000)
      window.webContents.beginFrameSubscription(false, frame => {
        if (frame.isEmpty()) return
        latest = frame; received++; samples = []
        const size = frame.getSize(), bitmap = frame.toBitmap(), ratio = size.width / observed.viewport.width
        const painted = observed.stages.every(stage => {
          const box = stage.bounds, scale = Math.min(box.width / 960, box.height / 540)
          const x = Math.floor((box.x + (box.width - scale * 960) / 2 + 938 * scale) * ratio)
          const y = Math.floor((box.y + (box.height - scale * 540) / 2 + 22 * scale) * ratio)
          if (x < 0 || y < 0 || x >= size.width || y >= size.height) return false
          const offset = (y * size.width + x) * 4
          const sample = [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]
          samples.push({ id: stage.id, x, y, sample })
          return compositorMatches(sample, observed)
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
    for (const [phase, expectedPhase, label] of [['waiting', 'waiting', 'Waiting'], ['navigation', 'running', 'Navigating'], ['script', 'running', 'Script'], ['observe', 'running', 'Observing'], ['completed', 'completed', 'Done'], ['failed', 'failed', 'Failed'], ['stopped', 'stopped', 'Stopped'], ['human', 'human', 'Your turn']].filter(([phase]) => !phases || phases.includes(phase))) {
      await evaluate(`window.continuityRenderer.phase(${JSON.stringify(phase)})`)
      await until('actual operation chrome and video phase ' + phase, async () => { const read = await facts(); return read.sourcePhase === phase && read.stages.length === 2 && read.stages.every(stage => stage.chrome.phase === expectedPhase && stage.chrome.text?.toLowerCase().includes(label.toLowerCase()) && matches(stage.video?.marker, read.sourceMarker)) })
      const read = await facts(), active = phase !== 'human', terminal = ['completed', 'failed', 'stopped'].includes(phase)
      assert.equal(read.stages.length, 2)
      for (const stage of read.stages) {
        if (active) { boundary(stage); assert.equal(stage.chrome.owner, 'agent'); assert.equal(stage.chrome.operation, 'continuity-operation'); assert.equal(read.currentBrowser.control.activeOperationId, terminal ? null : 'continuity-operation') }
        else { assert.equal(stage.boundary, null, 'Explicit human takeover leaves no mirrored input boundary'); assert.equal(stage.chrome.owner, 'human') }
      }
      assert.equal(read.acquisitions, 1, 'Both actual Stage receivers share the original media acquisition')
      assert.equal(new Set(read.stages.map(stage => stage.video.streamId)).size, 1)
      assert.ok(read.stages.every(stage => stage.video.streamId))
      assert.deepEqual(read.errors, [])
      if (phase === 'human') await directReturnVisible('normal')
      await image('normal-' + phase, read)
      result.cases.push({ name: 'actual-pane-chrome-' + phase, passed: true })
    }
    if (phases && !ownershipScope && !returnControlScope) { assert.equal(result.cases.length, phases.length); assert.equal(result.images.length, phases.length); result.scope = { kind: 'phase-recapture', phases }; result.passed = true; return }
    const layoutPhase = returnControlScope ? 'human' : 'waiting'
    await evaluate(`window.continuityRenderer.phase(${JSON.stringify(layoutPhase)})`)
    for (const [shape, width, height, theme] of [['narrow', 390, 850, 'dark'], ['short', 1160, 440, 'light']]) {
      window.setContentSize(width, height)
      await evaluate(`window.continuityRenderer.theme(${JSON.stringify(theme)})`)
      await until('actual stage resized ' + shape, async () => { const read = await facts(); return read.viewport.width === width && read.viewport.height === height && read.stages.length === 2 && read.stages.every(stage => stage.bounds.width > 50 && stage.bounds.height > 40 && matches(stage.video?.marker, read.sourceMarker)) })
      const read = await facts()
      if (returnControlScope) {
        assert.ok(read.stages.every(stage => stage.boundary === null && stage.chrome.phase === 'human' && stage.chrome.owner === 'human'))
        await directReturnVisible(shape)
      } else {
        for (const stage of read.stages) boundary(stage)
        assert.ok(read.stages.every(stage => stage.chrome.phase === 'waiting' && stage.chrome.owner === 'agent'))
      }
      await image(shape + '-' + layoutPhase, read)
      result.cases.push({ name: 'page-aspect-fit-' + shape, passed: true })
    }
    window.setContentSize(1440, 840)
    await evaluate('window.continuityRenderer.theme("light")')
    for (const owner of returnControlScope ? [] : ['space-continuity', 'survey-continuity']) {
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
    await evaluate('window.continuityRenderer.coverage(null)')
    for (const phase of ['waiting', 'completed']) {
      await evaluate(`window.continuityRenderer.phase(${JSON.stringify(phase)})`)
      const before = await facts()
      const clicked = await evaluate(`(()=>{const button=document.querySelector('button[aria-label="Take control of Browser"]');if(!button)return false;button.click();return true})()`)
      assert.equal(clicked, true, 'Actual BrowserPane exposes an explicit Take control button: ' + phase)
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const after = await facts(), calls = after.calls.slice(before.calls.length)
      assert.ok(calls.some(call => call.method === 'takeControl' && call.browserId === 'continuity-page'), 'Actual BrowserPane Take control uses the trusted Browser API: ' + phase)
      assert.equal(calls.some(call => call.method === 'executeControl'), false, 'Take control cannot dispatch public browser.stop: ' + phase)
      assert.equal(after.currentBrowser.control.owner, 'human')
      assert.equal(after.stages.every(stage => stage.boundary === null), true)
      await directReturnVisible('after-takeover-' + phase)
      assert.equal(await evaluate(`(()=>{const button=document.querySelector('button[aria-label="Return to Agent"]');if(!button)return false;button.click();return true})()`), true, 'Actual BrowserPane returns to Agent with one direct button click: ' + phase)
      await until('actual Pane return callback restores agent projection', async () => {
        const read = await facts()
        return read.calls.slice(before.calls.length).some(call => call.method === 'returnControl' && call.browserId === 'continuity-page') && read.currentBrowser.control.owner === 'agent' && read.stages.every(stage => Boolean(stage.boundary))
      })
      result.cases.push({ name: 'actual-pane-trusted-take-control-' + phase, passed: true,
        boundary: 'Real BrowserPane Take control and direct Return to Agent button.click through callbacks into the maintained typed mock API. Main trusted IPC and hardware-input authorization are separately scoped; this Renderer fixture does not certify them.' })
    }
    assert.equal(result.cases.length, (phases?.length ?? 8) + (returnControlScope ? 4 : 6)); assert.equal(result.images.length, (phases?.length ?? 8) + (returnControlScope ? 2 : 4))
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
  for (const label of recapture || returnControlScope ? ['baseline'] : ['baseline', 'omit-pane-control', 'take-control-uses-stop']) {
    const directory = join(out, label)
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
        if (file === join(source, owners[0]) && label === 'omit-pane-control') return { code: code.replace(from, to), map: null }
        if (file === join(source, owners[0]) && label === 'take-control-uses-stop') { assert.equal(code.split(takeoverFrom).length, 2); return { code: code.replace(takeoverFrom, takeoverTo), map: null } }
      } }], build: { outDir: join(directory, 'dist'), minify: false, rollupOptions: { input: html } } })
    // Mutants share immutable hash-named media instead of multiplying private
    // copies of the same fonts and images. Each original asset hash stays bound.
    if (label !== 'baseline') {
      const folder = join(directory, 'dist/assets')
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const file = join(folder, entry.name), original = join(out, 'baseline/dist/assets', entry.name)
        try {
          if (sha(await readFile(file)) !== sha(await readFile(original))) continue
          await rm(file); await symlink(relative(dirname(file), original), file)
        } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    }
    const files = {}
    async function collect(folder) { for (const entry of await readdir(folder, { withFileTypes: true })) { const file = join(folder, entry.name); if (entry.isDirectory()) await collect(file); else files[relative(directory, file)] = sha(await readFile(file)) } }
    await collect(directory); receipt.assets[label] = { directory, files }
  }
  for (const file of [...owners, 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx']) assert.ok(receipt.sources[file], 'Actual Renderer consumer is nonempty: ' + file)
  receipt.engine = { executable: require('electron'), version: require('electron/package.json').version, sha256: sha(await readFile(require('electron'))) }
  await save()
  for (const label of recapture || returnControlScope ? ['baseline'] : ['baseline', 'omit-pane-control', 'take-control-uses-stop', 'restored']) {
    const directory = join(out, label); await mkdir(directory, { recursive: true })
    const assets = receipt.assets[label === 'restored' ? 'baseline' : label]
    for (const [file, digest] of Object.entries(assets.files)) assert.equal(sha(await readFile(join(assets.directory, file))), digest)
    const privateRoot = await mkdtemp(join(tmpdir(), 'amx-continuity-renderer-'))
    const bootstrap = join(privateRoot, 'bootstrap.cjs')
    await writeFile(bootstrap, `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');for(const key of ['home','appData','userData','sessionData']){const dir=path.join(${JSON.stringify(privateRoot)},key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}(${rendererScene.toString()})().catch(e=>{console.error(e);app.exit(1)});`)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { HOME: join(privateRoot, 'home'), XDG_CACHE_HOME: join(privateRoot, 'cache'), AGENTMUX_CONTINUITY_RENDERER_OUTPUT: directory,
      AGENTMUX_CONTINUITY_RENDERER_ENTRY: join(assets.directory, 'dist/renderer.html') })
    if (selectedPhases) env.AGENTMUX_CONTINUITY_RENDERER_PHASES = JSON.stringify(selectedPhases)
    if (ownershipScope) env.AGENTMUX_CONTINUITY_RENDERER_OWNERSHIP = 'true'
    if (returnControlScope) env.AGENTMUX_CONTINUITY_RENDERER_RETURN = 'true'
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
    if (label === 'omit-pane-control' || label === 'take-control-uses-stop') {
      assert.equal(row.process.exitCode, 1); assert.equal(actual.failure?.name, 'AssertionError')
      assert.ok(actual.failure.message.includes(label === 'omit-pane-control' ? 'Actual BrowserPane passes original control to the mirrored stage:' : 'Actual BrowserPane Take control uses the trusted Browser API:'))
      row.owningAssertion = 'AssertionRED'
    } else { assert.equal(row.process.exitCode, 0, JSON.stringify(actual.failure)); assert.equal(actual.passed, true); assert.equal(actual.images.length, recapture?.length ?? (selectedPhases?.length ?? 8) + (returnControlScope ? 2 : 4)); assert.equal(actual.cases.length, recapture?.length ?? (selectedPhases?.length ?? 8) + (returnControlScope ? 4 : 6)) }
  }
  for (const [file, digest] of Object.entries(receipt.sources)) assert.equal(sha(await readFile(join(source, file))), digest)
  for (const [file, digest] of Object.entries(receipt.overlays)) assert.equal(sha(await readFile(join(root, file))), digest, 'Current exact Renderer owner retains consumed bytes: ' + file)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally { await save() }
console.log(JSON.stringify({ passed: receipt.passed, receipt: receiptFile }))
