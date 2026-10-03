import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listProbeProcesses, signalOwnedProbeProcess, runProbeProcess } from '../../probe-process.mjs'

const fixture = fileURLToPath(new URL('./', import.meta.url)), repo = resolve(fixture, '../../../../..')
const desktop = join(repo, 'apps/desktop'), core = join(repo, 'packages/core')
const require = createRequire(join(desktop, 'package.json'))
const coreRequire = createRequire(join(core, 'package.json'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(done => setTimeout(done, ms))
async function artifacts(directory) {
  const files = {}
  for (const file of await readdir(directory, { recursive: true, withFileTypes: true })) if (file.isFile()) {
    const path = join(file.parentPath, file.name)
    files[path.slice(directory.length + 1)] = hash(await readFile(path))
  }
  assert.ok(Object.keys(files).length > 0, 'Actual private Renderer output collection is nonempty')
  return files
}
export async function runNative(requestedEvidence, options = {}) {
  const evidence = resolve(repo, requestedEvidence ?? ".tmp/session-takeover-fixture/native")
  await mkdir(evidence, { recursive: true })
  const privateRoot = await realpath(await mkdtemp(_hygiene_fixturePath("tmp/amx-takeover-renderer-")))
  const out = join(privateRoot, 'renderer'), sourceBefore = {}, styleBefore = {}, logs = []
  const receipt = { schema: 'agentmux.session-takeover-native.v1', passed: false, frames: [], processes: [],
    userSessionTouched: false, independentVisualReview: 'pending',
    scope: 'Actual production WorkspaceWorkbench, SessionPane, shared picker and product styles in two ordinary Electron processes. Real public Core spatial file owner and Chromium profile storage. Native session facts/creation API remain controlled preview; actual Core/ctxmux Agent processes are proved separately.',
    fixtureAssetCompatibility: 'A deleted unrelated settings-banner.png import is privately aliased to existing icon-128.png. Region takeover scenes never render that banner; this proof makes no full application build/install claim.' }
  let failure
  try {
    receipt.fixtureBefore = Object.fromEntries(await Promise.all(['entry.tsx', 'main.cjs', 'preload.cjs', 'index.html', 'native.mjs'].map(async name => [name, hash(await readFile(join(fixture, name)))])))
    await symlink(join(core, 'node_modules'), join(privateRoot, 'node_modules'))
    const { build: nodeBuild } = await import(coreRequire.resolve('esbuild'))
    const spatialModule = join(privateRoot, 'spatial-store.mjs')
    const spatialBuild = await nodeBuild({ absWorkingDir: repo, entryPoints: [join(core, 'src/spatial-state.ts')], outfile: spatialModule,
      platform: 'node', format: 'esm', bundle: true, packages: 'external', metafile: true, logLevel: 'silent' })
    receipt.coreSpatialInputs = Object.fromEntries(await Promise.all(Object.keys(spatialBuild.metafile.inputs).map(async path => [path, hash(await readFile(resolve(repo, path)))])))
    receipt.coreSpatialModuleSha256 = hash(await readFile(spatialModule))
    const { build } = await import(require.resolve('vite'))
    const banner = join(desktop, 'resources/settings-banner.png'), icon = join(desktop, 'resources/icon-128.png')
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
      resolve: { alias: [{ find: /^.*settings-banner\.png$/, replacement: icon }], dedupe: ['react', 'react-dom'] },
      plugins: [{ name: 'bind-current-takeover-renderer-inputs', enforce: 'pre', async transform(_source, id) {
        if (!id.includes('?') && (id.startsWith(join(desktop, 'src') + '/') || id.startsWith(join(repo, 'packages/client-ui/src') + '/') || id.startsWith(join(core, 'dist') + '/') || id.startsWith(fixture)))
          sourceBefore[id.slice(repo.length + 1)] = hash(await readFile(id))
      }, async generateBundle() {
        for (const path of this.getWatchFiles()) if (path.endsWith('.css') && (path.startsWith(join(desktop, 'src') + '/') || path.startsWith(join(repo, 'packages/client-ui/src') + '/')))
          styleBefore[path.slice(repo.length + 1)] = hash(await readFile(path))
      } }],
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' },
      build: { outDir: out, emptyOutDir: true, commonjsOptions: { include: [/node_modules/, /xterm-locked-925/] } } })
    const compiled = await artifacts(out)
    receipt.compiledFiles = compiled
    receipt.sourceBefore = sourceBefore; receipt.stylesBefore = styleBefore
    assert.ok(Object.keys(sourceBefore).length > 0)
    for (const path of ['components/SessionTakeoverSurface.tsx', 'components/AgentExecutorPicker.tsx', 'components/SessionPane.tsx', 'lib/session-takeover.ts'])
      assert.ok(sourceBefore['apps/desktop/src/renderer/src/' + path], 'Actual private bundle consumes production ' + path)
    assert.ok(styleBefore['apps/desktop/src/renderer/src/styles/session-takeover.css'])
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'ELECTRON_RUN_AS_NODE' && !name.startsWith('AGENTMUX_') && !name.startsWith('CTXMUX_')))
    for (const mode of ['first', 'second']) {
      const lines = []
      const outcome = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(out, 'index.html'), privateRoot, evidence, mode, spatialModule, options.frameScope ?? 'all'], {
        temporaryRoot: privateRoot, cwd: repo, env, timeoutMs: 115000, onLine: line => lines.push(line)
      })
      await writeFile(join(evidence, mode + '-process.log'), lines.join('\n'))
      logs.push({ mode, outcome })
      const rendered = JSON.parse(await readFile(join(evidence, `${mode}-render.json`), 'utf8'))
      receipt.processes.push({ mode, outcome, rendered })
      assert.equal(outcome.timedOut, false, 'Actual Electron operation did not exceed the isolated fixture watchdog')
      assert.equal(outcome.interruption, null)
      assert.equal(outcome.exitCode, 0, JSON.stringify(rendered.failure))
      assert.equal(rendered.passed, true, JSON.stringify(rendered.failure))
      receipt.frames.push(...rendered.frames)
    }
    assert.notEqual(receipt.processes[0].rendered.processId, receipt.processes[1].rendered.processId)
    assert.ok(receipt.processes[1].rendered.restart.noWorkfaceReseed)
    receipt.sourceAfter = Object.fromEntries(await Promise.all(Object.keys(sourceBefore).map(async path => [path, hash(await readFile(join(repo, path)))])))
    receipt.stylesAfter = Object.fromEntries(await Promise.all(Object.keys(styleBefore).map(async path => [path, hash(await readFile(join(repo, path)))])))
    assert.deepEqual(receipt.sourceAfter, sourceBefore, 'Actual product and fixture inputs did not change during capture')
    assert.deepEqual(receipt.stylesAfter, styleBefore)
    receipt.coreSpatialInputsAfter = Object.fromEntries(await Promise.all(Object.keys(receipt.coreSpatialInputs).map(async path => [path, hash(await readFile(resolve(repo, path)))])))
    assert.deepEqual(receipt.coreSpatialInputsAfter, receipt.coreSpatialInputs, 'Private real Core spatial source stayed unchanged during both Renderer processes')
    receipt.fixtureAfter = Object.fromEntries(await Promise.all(Object.keys(receipt.fixtureBefore).map(async name => [name, hash(await readFile(join(fixture, name)))])))
    assert.deepEqual(receipt.fixtureAfter, receipt.fixtureBefore)
    for (const frame of receipt.frames) assert.equal(hash(await readFile(join(evidence, frame.file))), frame.sha256)
    receipt.passed = true
  } catch (error) { failure = { name: error.name, message: error.message, stack: error.stack }; receipt.failure = failure }
  finally {
    const errors = [], observations = []
    for (const pid of await listProbeProcesses(-1, privateRoot)) {
      try { await signalOwnedProbeProcess(pid, privateRoot, 'SIGTERM') } catch (error) {
        if ((await listProbeProcesses(-1, privateRoot)).includes(pid)) errors.push(String(error)); else observations.push({ pid, resolved: String(error) })
      }
    }
    const deadline = Date.now() + 4000
    while (Date.now() < deadline && (await listProbeProcesses(-1, privateRoot)).length) await delay(25)
    const remaining = await listProbeProcesses(-1, privateRoot)
    receipt.cleanup = { errors, observations, remaining, privateRootRemoved: !remaining.length && !errors.length }
    if (receipt.cleanup.privateRootRemoved) await rm(privateRoot, { recursive: true, force: true })
    else receipt.passed = false
    await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  if (!receipt.passed) throw new Error('Actual takeover Renderer proof failed: ' + JSON.stringify(failure ?? receipt.cleanup))
  return receipt
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = process.argv.find(value => value.startsWith('--evidence='))?.slice('--evidence='.length)
  try { const receipt = await runNative(evidence, { frameScope: process.argv.includes('--terminal-only') ? 'terminal' : 'all' }); console.log(JSON.stringify({ passed: receipt.passed, frames: receipt.frames.length, processes: receipt.processes.length })) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
