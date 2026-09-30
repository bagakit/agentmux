import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const validationRoot = path.resolve(import.meta.dirname, '../../..')
const sourceRoot = path.resolve(process.env.AGENTMUX_FOCUS_RULER_SOURCE_ROOT ?? validationRoot)
const fixture = path.join(validationRoot, 'apps/desktop/scripts/fixtures/focus-timeline-join')
const index = process.argv.indexOf('--evidence')
assert.ok(index >= 0 && process.argv[index + 1], 'Use --evidence with an explicit output directory')
const evidence = path.resolve(process.argv[index + 1]), counterOnly = process.argv.includes('--counter-only')
const hash = value => createHash('sha256').update(value).digest('hex')
const candidate = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).stdout.trim()
const actualRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: sourceRoot, encoding: 'utf8' }).stdout.trim()
assert.equal(path.resolve(actualRoot), sourceRoot, 'An empty directory must not discover an ancestor workspace')
assert.ok((await fs.readFile(path.join(sourceRoot, 'package.json'))).length > 0)
assert.ok((await fs.readFile(path.join(sourceRoot, 'pnpm-workspace.yaml'))).length > 0)
const desktop = path.join(sourceRoot, 'apps/desktop'), require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href), electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const { runProbeProcess, listProbeProcesses } = await import(pathToFileURL(path.join(sourceRoot, 'apps/desktop/scripts/probe-process.mjs')).href)
const renderer = 'apps/desktop/src/renderer/src/'
const sourcePaths = [`${renderer}lib/focus-timeline-ruler.ts`, `${renderer}components/RecentFocusTimeline.tsx`, `${renderer}components/FocusMessagePreview.tsx`, `${renderer}components/FocusTimelineRulerSettings.tsx`, `${renderer}components/ConversationMessage.tsx`, `${renderer}store.ts`, `${renderer}styles/focus-timeline-ruler.css`, `${renderer}lib/focus-timeline-name-width.ts`, `${renderer}hooks/useSidebarResize.ts`, `${renderer}lib/focus-time-window.ts`, 'apps/desktop/package.json', 'pnpm-lock.yaml', `${renderer}styles/index.css`, `${renderer}styles/focus.css`, `${renderer}lib/session-user-messages.ts`]
const binding = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async p => [p, hash(await fs.readFile(path.join(sourceRoot, p)))])))
const validationPaths = ['capture-focus-timeline-join.mjs', 'fixtures/focus-timeline-join/entry.mjs', 'fixtures/focus-timeline-join/main.mjs', 'fixtures/focus-timeline-join/index.html']
const validationBinding = async () => Object.fromEntries(await Promise.all(validationPaths.map(async p => [p, hash(await fs.readFile(path.join(validationRoot, 'apps/desktop/scripts', p)))])))
const privateRoot = await fs.mkdtemp('/tmp/amux-focus-ruler-')
const receipt = { schema: 'agentmux.focus-timeline-join-compiled-scene.v1', passed: false, axisQualified: false, phase:'join', candidate, sourceRoot, validationRoot, inputs: await binding(), validationInputs: await validationBinding(), actualLoadedModules: [], compiled: {}, images: [], cleanup: null, boundary: 'Actual production Timeline/Settings/API/Store, compiled by the existing Vite and run in isolated Electron with typed navigation transport. Not a public Reader/Human/Provider Writer, ordinary App restart, physical input, healthy Run or installation qualification.' }
await fs.mkdir(evidence, { recursive: true })
try {
  const freshness = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(path.join(sourceRoot, 'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(sourceRoot)});`], { cwd: sourceRoot, encoding: 'utf8' })
  await fs.writeFile(path.join(evidence, 'freshness.log'), freshness.stdout + freshness.stderr); assert.equal(freshness.status, 0)
  const exactFixtureImports = Object.fromEntries(Object.entries({ 'components/RecentFocusTimeline': 'components/RecentFocusTimeline.tsx', store: 'store.ts', 'lib/api': 'lib/api.ts', 'styles/index.css': 'styles/index.css' }).map(([request, file]) => [`../../../src/renderer/src/${request}`, path.join(sourceRoot, renderer, file)]))
  const publicProjectorPath = await fs.realpath(fileURLToPath(import.meta.resolve('@agentmux/core/session-user-messages')))
  const loaded = [], binder = { name: 'actual-ruler-production-source-binding', enforce: 'pre',
    resolveId(source, importer) { if (importer === path.join(fixture, 'entry.mjs') && exactFixtureImports[source]) return exactFixtureImports[source] },
    transform(code, id) { const file = id.split('?')[0]; if (file.startsWith(`${sourceRoot}/apps/desktop/src/`) && /\.[cm]?[jt]sx?$/.test(file)) loaded.push({ path: path.relative(sourceRoot, file), sha256: hash(code), bytes: Buffer.byteLength(code) })
      if(file===publicProjectorPath){const needle='export function projectSessionUserMessages(params) {';assert.equal(code.split(needle).length,2);const instrumented=code.replace(needle,needle+'\n globalThis.joinProjectorCount=(globalThis.joinProjectorCount??0)+1;');receipt.projectorCounter={actualModule:file,sourceSHA256:hash(code),consumedSHA256:hash(instrumented),purpose:'Invocation count only; unchanged public projector facts'};return{code:instrumented,map:null}} }
  }
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', plugins: [binder], resolve: { alias: [{ find: /^react$/, replacement: require.resolve('react') }, { find: /^react-dom\/client$/, replacement: require.resolve('react-dom/client') }] }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true, rollupOptions: { input: path.join(fixture, 'index.html') } } })
  assert.ok(loaded.some(m => m.path === `${renderer}components/RecentFocusTimeline.tsx`))
  assert.ok(loaded.some(m => m.path === `${renderer}components/FocusTimelineRulerSettings.tsx`))
  receipt.actualLoadedModules = loaded
  for (const module of loaded) assert.equal(module.sha256, hash(await fs.readFile(path.join(sourceRoot, module.path))), 'Compiled owner is actual fixed Source')
  await fs.copyFile(path.join(fixture, 'main.mjs'), path.join(privateRoot, 'main.mjs'))
  await fs.mkdir(path.join(privateRoot, 'node_modules')); await fs.symlink(path.join(desktop, 'node_modules/electron'), path.join(privateRoot, 'node_modules/electron'))
  const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(e => e.isDirectory() ? files(path.join(directory, e.name)) : [path.join(directory, e.name)]))).flat()
  for (const file of await files(path.join(privateRoot, 'renderer'))) receipt.compiled[path.relative(privateRoot, file)] = hash(await fs.readFile(file))
  receipt.compiled['main.mjs'] = hash(await fs.readFile(path.join(privateRoot, 'main.mjs')))
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: path.join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'state') }; delete env.ELECTRON_RUN_AS_NODE
  const lines = [], result = await runProbeProcess(electron, [path.join(privateRoot, 'main.mjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, evidence, String(counterOnly)], { temporaryRoot: privateRoot, cwd: sourceRoot, env, timeoutMs: 90_000, onLine: line => lines.push(line) })
  await fs.writeFile(path.join(evidence, 'scene.log'), lines.join('\n'))
  receipt.actual = JSON.parse(await fs.readFile(path.join(evidence, 'scene.json'), 'utf8')); receipt.result = result
  assert.equal(result.timedOut, false); assert.equal(result.exitCode, 0, receipt.actual.failure?.message); assert.equal(receipt.actual.passed, true)
  for (const frame of receipt.actual.frames) receipt.images.push({ path: frame.image, width: frame.width, sha256: hash(await fs.readFile(path.join(evidence, frame.image))) })
  assert.deepEqual(receipt.actual.controls, [])
  assert.deepEqual(await binding(), receipt.inputs); assert.deepEqual(await validationBinding(), receipt.validationInputs)
  receipt.passed = true; receipt.axisQualified = !counterOnly
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const remaining = await listProbeProcesses(-1, privateRoot); receipt.cleanup = { remaining, privateRootRemoved: false }
  if (!remaining.length) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateRootRemoved = true }
  receipt.sourceAfter = await binding(); receipt.validationAfter = await validationBinding()
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message); assert.equal(receipt.cleanup.privateRootRemoved, true)
console.log(JSON.stringify({ passed: receipt.passed, axisQualified: receipt.axisQualified, receipt: path.join(evidence, 'receipt.json'), images: receipt.images }))
