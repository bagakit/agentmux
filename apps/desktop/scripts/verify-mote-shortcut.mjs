import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'vite'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const fixture = join(desktop, 'scripts/fixtures/mote-shortcut'), require = createRequire(join(desktop, 'package.json'))
const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-mote-shortcut-'))
const evidence = join(repository, '.tmp/mote-shortcut', `attempt-${Date.now()}`)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = new Map(), styles = new Set(), watchedStyles = new Set(), compiledSdkInputs = new Map()
let coreSdkDist
const compiledCoreSdk = file => file.startsWith(coreSdkDist + '/') && /\.(?:js|json)$/.test(file)
const localStylesheet = file => file?.startsWith(repository + '/') && file.endsWith('.css') && !file.includes('/node_modules/')
// PostCSS retains the exact input of each imported stylesheet. Observe those consumed bytes,
// rather than reading a hand-written list or hashing imports only after compilation has ended.
const stylesheetBinding = { postcssPlugin: 'bind-mote-proof-consumed-stylesheets', async Once(root) {
  const consumed = new Map()
  const remember = node => {
    const input = node.source?.input
    if (localStylesheet(input?.file)) consumed.set(input.file, input.css)
  }
  remember(root); root.walk(remember)
  for (const [file, css] of consumed) {
    const digest = hash(css)
    assert.equal(hash(await readFile(file)), digest, `Consumed stylesheet changed during compilation: ${relative(repository, file)}`)
    if (inputs.has(file)) assert.equal(inputs.get(file), digest, 'Stylesheet input agrees with the original loader bytes')
    inputs.set(file, digest); styles.add(file)
  }
} }
let controlledApiTransforms = 0
const binding = {
  name: 'bind-mote-proof-source', enforce: 'pre', async load(id) {
    const file = id.split('?')[0]
    if (compiledCoreSdk(file)) {
      const code = compiledSdkInputs.get(file) ?? await readFile(file, 'utf8')
      compiledSdkInputs.set(file, code)
      return code
    }
    // Bind original bytes before asset loaders or the private API-boundary transform.
    if (file.startsWith(repository + '/') && !file.includes('/node_modules/') && !inputs.has(file)) inputs.set(file, hash(await readFile(file)))
    return null
  }, buildEnd() {
    // Vite records transitive PostCSS @import dependencies as watched files, even when they are
    // absent from the JavaScript module graph. Every local stylesheet must have consumed bytes.
    for (const file of this.getWatchFiles()) if (localStylesheet(file)) {
      watchedStyles.add(file)
      assert.ok(styles.has(file), `Missing consumed stylesheet input: ${relative(repository, file)}`)
    }
  }
}
const result = { schema: 'agentmux.mote-shortcut-proof.v1', passed: false, captureOnly: true, aestheticReview: 'not-performed', userRunTouched: false,
  phases: [], privateProfile: join(privateRoot, 'user-data'), limitations: ['Session snapshots, attachment and recovery use a controlled public API boundary. The second process receives a retained ended Session with fresh native idle-entry evidence, and ordinary initialization asks recovery for its exact original identity; the controlled API returns it as reattachable. These receipts do not claim actual Core/ctxmux Run survival or whole-product acceptance.'], cleanup: null }
await mkdir(evidence, { recursive: true })
result.limitations.push('The Renderer compiles the actual desktop Browser stage branch. Only the single api.ts export is privately transformed to choose its typed data mock; native Browser and overlay methods use a sandboxed preload and the original Main owners. Renderer capturePage excludes native WebContentsViews. Independent original native-page/Chrome images and actual topmost owner/trusted-input receipts verify their separate scopes; they are not an OS-composited window. Exact-PID OS capture is supplementary and retains provider failures. DevTools input is trusted native input, not physical hardware or OS IME.')
result.limitations.push('Native Escape verifies the actual non-composing before-input-event. A separate diagnostic found that DevTools imeSetComposition starts trusted DOM composition, but CDP raw Escape still reports native isComposing=false; it cannot certify the composing key path. Source owning tests and effective mutation verify the isComposing guard; native OS IME remains unverified.')
try {
  coreSdkDist = join(await realpath(join(desktop, 'node_modules/@agentmux/core')), 'dist')
  for (const file of [import.meta.filename, join(desktop, 'scripts/probe-process.mjs'), ...['main.cjs', 'preload.cjs', 'browser.html', 'index.html', 'scenario.md'].map(name => join(fixture, name))]) inputs.set(file, hash(await readFile(file)))
  const outDir = join(privateRoot, 'renderer')
  const nativeDir = join(privateRoot, 'native')
  const nativeBuild = await build({ configFile: false, root: desktop, logLevel: 'error', plugins: [binding], ssr: { noExternal: true }, build: {
    target: 'node22', outDir: nativeDir, emptyOutDir: true, ssr: join(fixture, 'native-browser.ts'),
    rollupOptions: { external: ['electron', /^node:/], output: { format: 'es', entryFileNames: 'native.mjs', inlineDynamicImports: true } }
  } })
  const nativeChunks = (Array.isArray(nativeBuild) ? nativeBuild : [nativeBuild]).flatMap(build => build.output).filter(output => output.type === 'chunk')
  assert.equal(nativeChunks.length, 1)
  assert.equal(nativeChunks[0].fileName, 'native.mjs')
  assert.ok(Object.entries(nativeChunks[0].modules).some(([id, module]) => compiledCoreSdk(id) && module.renderedLength > 0), 'The actual compiled Core SDK is included in the private native bundle')
  const nativeImports = nativeChunks.flatMap(chunk => [...chunk.imports, ...chunk.dynamicImports])
  assert.ok(nativeImports.length > 0, 'The actual native chunk retains its Electron and Node imports')
  assert.ok(nativeImports.every(id => id === 'electron' || isBuiltin(id)), 'The private native bundle loads only Electron and Node builtins outside its bound dependency bytes')
  result.nativeImports = nativeImports
  // Vite embeds maintained SDK dependencies; Electron and Node retain their ordinary resolution.
  await symlink(join(desktop, 'node_modules'), join(nativeDir, 'node_modules'), 'dir')
  const nativeBundle = join(nativeDir, 'native.mjs')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
    css: { postcss: { plugins: [stylesheetBinding] } },
    plugins: [binding, { name: 'private-mote-public-api-boundary', enforce: 'pre', transform(code, id) {
      if (id.split('?')[0] !== join(desktop, 'src/renderer/src/lib/api.ts')) return null
      const anchor = 'export const api = __AGENTMUX_WEB_PREVIEW__ ? mockApi : requireDesktopApi()'
      assert.equal(code.split(anchor).length - 1, 1, 'The controlled public API export must have exactly one actual source anchor')
      controlledApiTransforms += 1
      return { code: code.replace(anchor, 'export const api = mockApi'), map: null }
    } }], build: { target: 'esnext', outDir, emptyOutDir: true } })
  assert.equal(controlledApiTransforms, 1)
  assert.ok(styles.size > 1, 'The actual application imports a nonempty stylesheet dependency set')
  assert.ok(watchedStyles.size > 1, 'Vite reports a nonempty actual stylesheet dependency set')
  assert.deepEqual([...watchedStyles].sort(), [...styles].sort(), 'Consumed stylesheet bytes cover the complete actual Vite dependency set')
  assert.ok(styles.has(join(desktop, 'src/renderer/src/styles/pmo-teams-topic.css')), 'The consumed Mote stylesheet is bound')
  assert.ok([...inputs.keys()].some(file => file.endsWith('/PmoTeamsTopicEntry.tsx')), 'The actual production entry is compiled')
  assert.ok([...inputs.keys()].some(file => file.endsWith('/App.tsx')), 'The complete production App is compiled')
  for (const owner of ['BrowserPane.tsx', 'browser-view-manager.ts', 'native-overlay-surfaces.ts', 'native-overlay-regions.ts']) assert.ok([...inputs.keys()].some(file => file.endsWith('/' + owner)), 'Actual native owner is compiled: ' + owner)
  const compiled = {}
  for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = join(entry.parentPath, entry.name); compiled[relative(outDir, file)] = hash(await readFile(file))
  }
  assert.ok(Object.keys(compiled).length > 0)
  compiled['native/native.mjs'] = hash(await readFile(nativeBundle))
  result.controlledApiTransforms = controlledApiTransforms
  result.inputs = Object.fromEntries([...inputs].map(([file, digest]) => [relative(repository, file), digest]))
  result.stylesheets = Object.fromEntries([...styles].sort().map(file => [relative(repository, file), inputs.get(file)]))
  result.stylesheetDependencies = [...watchedStyles].sort().map(file => relative(repository, file))
  result.compiled = compiled
  assert.ok(compiledSdkInputs.size > 0, 'Compiled SDK dependency bytes are actually consumed')
  result.compiledSdkInputs = Object.fromEntries([...compiledSdkInputs].map(([file, code]) => [relative(repository, file), hash(code)]))
  result.limitations.push('Actual compiled Core SDK dependency bytes are consumed once and included in the private native bundle. Their hashes describe compiled dependencies, not Core Source or Run survival; the two private processes do not load mutable shared Core dist.')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['seed', 'restore']) {
    assert.equal(hash(await readFile(nativeBundle)), compiled['native/native.mjs'], 'Each real process receives the same private native bundle')
    const logs = []
    const exit = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(outDir, 'index.html'), privateRoot, phase, evidence, nativeBundle], {
      temporaryRoot: privateRoot, cwd: repository, env, timeoutMs: 180000, onLine: line => logs.push(line) })
    await writeFile(join(evidence, `${phase}.log`), logs.join('\n'))
    const phaseResult = { phase, exit }
    result.phases.push(phaseResult)
    assert.equal(exit.timedOut, false, 'The private ' + phase + ' process must publish its bounded result')
    const native = JSON.parse(await readFile(join(evidence, `${phase}.json`), 'utf8'))
    phaseResult.native = native
    assert.equal(exit.exitCode, 0, native.failure?.message)
    assert.equal(native.passed, true)
  }
  assert.equal(new Set(result.phases.map(one => one.native.pid)).size, 2, 'Restart uses two distinct real Electron processes')
  for (const [file, digest] of inputs) assert.equal(hash(await readFile(file)), digest, `Compiled source changed during proof: ${relative(repository, file)}`)
  result.passed = true
  await writeFile(join(evidence, 'review.md'), ['# Mote shortcut screenshots — independent review pending', '',
    'Complete production App, desktop Browser stage, footer, floating workbench and CSS. Two ordinary Electron processes use one private profile. Native Main owners use private profiles/ledgers. Controlled public Session facts do not prove Core/ctxmux Run survival; original user App and Runs are untouched. Renderer screenshots exclude native WebContentsViews. Independent native-page/Chrome frames are separate images, not an OS-composited window. Actual topmost owners and trusted original input are recorded in receipt.json; OS captures remain supplementary.', '',
    ...result.phases.flatMap(one => one.native.frames.map(frame => '- ' + one.phase + ' / ' + frame.name + ': [Renderer screenshot; excludes native views](' + frame.file + ')')),
    ...result.phases.flatMap(one => (one.native.native?.nativeFrames ?? []).flatMap(attempt => attempt.frames.map(frame => '- ' + one.phase + ' / ' + attempt.label + ' / ' + frame.kind + ': [Independent original native frame; not OS composition](' + frame.file + ')'))),
    ...result.phases.flatMap(one => (one.native.native?.osFrames ?? []).filter(frame => frame.captured).map(frame => '- ' + one.phase + ' / ' + frame.label + ': [OS window with native composition](' + frame.file + ')')), '',
    'Review the actual full images against the Mote shortcut SSOT. Capture success is not aesthetic approval. Exact imported source/style and compiled identities are in receipt.json.', ''].join('\n'))
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const remaining = await listProbeProcesses(-1, privateRoot)
  result.cleanup = { remaining, privateRootRemoved: false }
  if (remaining.length === 0) { await rm(privateRoot, { recursive: true }); result.cleanup.privateRootRemoved = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ passed: result.passed, receipt: join(evidence, 'receipt.json'), review: join(evidence, 'review.md'), failure: result.failure, cleanup: result.cleanup }))
assert.equal(result.cleanup.remaining.length, 0, 'Only this invocation private processes may remain; preserve the root if cleanup is unconfirmed')
assert.equal(result.passed, true, result.failure?.message)
