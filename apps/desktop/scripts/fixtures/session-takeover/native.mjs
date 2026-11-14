import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentWorkspaceAliases } from './workspace-aliases.mjs'
import { listProbeProcesses, signalOwnedProbeProcess, runProbeProcess } from '../../probe-process.mjs'

const fixture = fileURLToPath(new URL('./', import.meta.url)), repo = resolve(fixture, '../../../../..')
const desktop = join(repo, 'apps/desktop'), core = join(repo, 'packages/core')
const require = createRequire(join(desktop, 'package.json'))
const coreRequire = createRequire(join(core, 'package.json'))
const { assertStopForkScenarios, assertMotionScenarios } = createRequire(import.meta.url)('./agent-operations-main.cjs')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(done => setTimeout(done, ms))
const nativeMutations = {
  'hidden-motion-runs': { file: 'components/AgentOperationFeedback.tsx', before: `visible && decoration.phase === 'pending'`, after: `decoration.phase === 'pending'` },
  'tooltip-reorders-host': { file: 'components/WindowOverlayHost.tsx', before: `if (node.getAttribute('role') !== 'tooltip') opened = true`, after: 'opened = true' }
}
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
  assert.ok(!options.motionOnly || options.agentOperations, 'Motion-only requires the original Agent operation consumers')
  assert.ok(!options.workloadPreflight || options.motionOnly && !options.nativeMutant && !options.preflight, 'Workload preflight uses the unmutated original motion consumers and its own qualification')
  assert.ok(!(options.liveAdoption && options.agentOperations), 'Live adoption and Stop/Fork have distinct native qualifications')
  if (!options.liveAdoption && !options.agentOperations) {
    assert.ok(!options.nativeMutant && !options.preflight && (!options.frameScope || options.frameScope === 'all'),
      'Public Takeover uses its complete original capture; Stop/Fork mutation, preflight and terminal-only options require an explicit qualification')
    const { runTakeoverFlow } = await import('../takeover-flow/capture.mjs')
    return runTakeoverFlow(requestedEvidence)
  }
  assert.ok(!options.nativeMutant || options.agentOperations, 'Native feedback mutations require the Stop/Fork qualification')
  if (options.nativeMutant !== undefined) assert.ok(Object.hasOwn(nativeMutations, options.nativeMutant), 'A native source mutation must be explicitly supported')
  const evidence = resolve(repo, requestedEvidence ?? ".tmp/session-takeover-fixture/native")
  await mkdir(evidence, { recursive: true })
  const privateRoot = await realpath(await mkdtemp(_hygiene_fixturePath("tmp/amx-takeover-renderer-")))
  const out = join(privateRoot, 'renderer'), sourceBefore = {}, styleBefore = {}, logs = []
  const receipt = { schema: options.workloadPreflight ? 'agentmux.agent-operation-workload-preflight-native.v1' : options.motionOnly ? 'agentmux.agent-operation-local-motion-native.v1' : options.agentOperations ? 'agentmux.stop-fork-feedback-native.v1' : 'agentmux.session-takeover-native.v1', qualification: options.workloadPreflight ? 'agent-operation-workload-preflight-v1' : options.motionOnly ? 'agent-operation-local-motion-v1' : options.liveAdoption ? 'live-adoption-v1' : options.nativeMutant ? 'stop-fork-feedback-mutation-v1' : 'stop-fork-feedback-v1', sourceMutations: [], passed: false, frames: [], processes: [],
    userSessionTouched: false, independentVisualReview: 'pending',
    scope: options.workloadPreflight ? 'Diagnostic execution of the original matched-work producer and sampler with real cards, input, ordered bytes and Chromium traces. No full local-motion, finite result, visual, restart or user Runtime qualification.' : options.motionOnly ? 'One source-built production Renderer, exact original Stop/Fork controllers and read-only details, local animation and related-consumer cost. Controlled Native transport; no Runtime execution, ordinary restart or vendor/user qualification.' : options.agentOperations
      ? 'Actual production cards, Stop/Fork controllers, SessionPane, xterm, feedback motion and product styles in two ordinary Electron processes. Real public Core spatial file owner and Chromium profile storage. Exact original Stop/Fork references, created partial Fork, sessions, Runs, drafts and workfaces survive restart without replay. Native launch/stop/input/ordered bytes are controlled; this does not qualify public Takeover, live adoption, vendor CLI or ctxmux process execution.'
      : 'Independent original live-adoption fixture with controlled Native reattachment. It does not qualify public Takeover or Stop/Fork feedback.',
    controlledRecovery: 'The same exact Native snapshot owns refresh/recover. For a matching healthy running Host/Session/Run it returns the Core reattachable protocol (packages/core/src/client.ts, recoverAgentSession running branch); the generic apps/desktop/src/renderer/src/lib/api.ts preview recover unconditionally mints a Run and is not the Native owner of this fixture. Per-process nativeReads record request and returned identities; unknown or mismatched targets fail.', }
  let failure
  try {
    receipt.fixtureBefore = Object.fromEntries(await Promise.all((await readdir(fixture)).filter(name => /\.(tsx|cjs|mjs|html|md)$/.test(name)).map(async name => [name, hash(await readFile(join(fixture, name)))])))
    await symlink(join(core, 'node_modules'), join(privateRoot, 'node_modules'))
    const { build: nodeBuild } = await import(coreRequire.resolve('esbuild'))
    const spatialModule = join(privateRoot, 'spatial-store.mjs')
    const identityManifest = JSON.parse(await readFile(join(repo, 'packages/identity/package.json'), 'utf8'))
    const generatedIdentity = await realpath(resolve(repo, 'packages/identity', identityManifest.exports['./runtime-source'].import))
    sourceBefore[relative(repo, generatedIdentity)] = hash(await readFile(generatedIdentity))
    receipt.generatedIdentitySource = { file: relative(repo, generatedIdentity), sha256: sourceBefore[relative(repo, generatedIdentity)],
      qualification: 'Existing generated-only identity source-text artifact, resolved from its current public package export; not rebuilt or replaced by this fixture.' }
    const workspace = await currentWorkspaceAliases(repo)
    for (const path of workspace.manifests) sourceBefore[path.slice(repo.length + 1)] = hash(await readFile(path))
    const workspaceCode = path => workspace.directories.some(directory => path.startsWith(directory + '/')) || path.startsWith(desktop + '/')
    const workspaceEscape = /\/(?:packages\/[^/]+|apps\/(?:desktop|host))\/(?:src|dist|test|scripts|brand)\//
    const assertOwnWorkspace = async path => {
      const actual = await realpath(path)
      if (workspaceEscape.test(actual)) assert.ok(actual.startsWith(repo + '/'), 'Workspace code escaped the current checkout: ' + actual)
      return actual
    }
    const spatialBuild = await nodeBuild({ absWorkingDir: repo, entryPoints: [join(core, 'src/spatial-state.ts')], outfile: spatialModule,
      platform: 'node', format: 'esm', bundle: true, packages: 'external',
      plugins: [{ name: 'original-identity-source', setup(builder) {
        builder.onResolve({ filter: /^@agentmux\/identity(?:\/runtime-source)?$/ }, ({ path }) => path === '@agentmux/identity'
          ? { path: join(repo, 'packages/identity/src/index.ts') } : { path: generatedIdentity, external: true })
      } }], metafile: true, logLevel: 'silent' })
    receipt.coreSpatialInputs = Object.fromEntries(await Promise.all(Object.keys(spatialBuild.metafile.inputs).map(async path => { await assertOwnWorkspace(resolve(repo, path)); return [path, hash(await readFile(resolve(repo, path)))] })))
    receipt.coreSpatialModuleSha256 = hash(await readFile(spatialModule))
    const { build } = await import(require.resolve('vite'))
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error',
      resolve: { dedupe: ['react', 'react-dom'], alias: workspace.aliases },
      worker: { format: 'es' },
      plugins: [{ name: 'bind-current-takeover-renderer-inputs', enforce: 'pre', async transform(_source, id) {
        const file = id.split('?')[0]
        if (!file.startsWith('\0') && workspaceEscape.test(file)) await assertOwnWorkspace(file)
        if (!file.startsWith('\0') && workspaceCode(file) && existsSync(file)) {
          const actual = await assertOwnWorkspace(file)
          sourceBefore[actual.slice(repo.length + 1)] = hash(await readFile(actual))
        }
        const mutation = options.nativeMutant && nativeMutations[options.nativeMutant]
        if (mutation && file.endsWith('/renderer/src/' + mutation.file)) {
          assert.equal(_source.split(mutation.before).length - 1, 1, 'Native mutation targets one actual production owner')
          const code = _source.replace(mutation.before, mutation.after)
          receipt.sourceMutations.push({ mutant: options.nativeMutant, file: file.slice(repo.length + 1), source: hash(_source), loaded: hash(code) })
          return { code, map: null }
        }
      }, async generateBundle() {
        for (const path of this.getWatchFiles()) if (path.endsWith('.css') && workspaceCode(path)) {
          const actual = await assertOwnWorkspace(path)
          styleBefore[actual.slice(repo.length + 1)] = hash(await readFile(actual))
        }
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
    if (options.agentOperations) {
      for (const path of ['components/FocusContextRow.tsx', 'components/AgentOperationFeedback.tsx', 'components/AgentCurrentForkControls.tsx', 'lib/agent-operation-feedback.ts', 'lib/session-stop-background.ts']) assert.ok(sourceBefore['apps/desktop/src/renderer/src/' + path], 'Agent-operation qualification actually consumes ' + path)
      assert.ok(styleBefore['apps/desktop/src/renderer/src/styles/agent-operation-feedback.css'])
      assert.ok(sourceBefore['apps/desktop/scripts/fixtures/session-takeover/operation-output-stream.mjs'], 'The actual Renderer consumes the exact controlled output producer')
    }
    if (options.preflight) { receipt.preflight = { compiled: true, finalCandidateExecuted: false }; await writeFile(join(evidence, 'preflight.json'), JSON.stringify(receipt, null, 2)); return receipt }
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'ELECTRON_RUN_AS_NODE' && !name.startsWith('AGENTMUX_') && !name.startsWith('CTXMUX_')))
    for (const mode of options.nativeMutant || options.motionOnly ? ['first'] : ['first', 'second']) {
      const lines = []
      const outcome = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(out, 'index.html'), privateRoot, evidence, mode, spatialModule, options.frameScope ?? 'all', options.workloadPreflight ? 'operation-workload' : options.motionOnly ? 'operation-motion' : options.liveAdoption ? 'live-adoption' : 'agent-operations', options.nativeMutant ?? ''], {
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
    if (options.nativeMutant) {
      assert.equal(receipt.sourceMutations.length, 1, 'Native mutation was consumed by the actual production bundle')
      throw new Error('Native source mutation survived its actual production-consumer oracle')
    }
    if (!options.motionOnly) {
      assert.notEqual(receipt.processes[0].rendered.processId, receipt.processes[1].rendered.processId)
      assert.ok(receipt.processes[1].rendered.restart.noWorkfaceReseed)
    }
    if (options.motionOnly) {
      assert.equal(receipt.processes.length, 1)
      const actual = receipt.processes[0].rendered.agentOperations
      if (options.workloadPreflight) {
        assert.equal(actual.qualification, 'agent-operation-workload-preflight-v1')
        assert.deepEqual([...actual.scenarios].sort(), ['production-card-source-identities', 'independent-confirmed-stops', 'native-browser-related-consumer-scale'].sort())
        assert.equal(actual.costSamples.length, 6)
        assert.equal(actual.projectionComparison.pairs.length, 3)
      } else {
        assert.equal(actual.qualification, 'agent-operation-local-motion-v1')
        assertMotionScenarios(actual.scenarios)
        assert.ok(actual.costSamples.length >= 6 && actual.motion.length >= 5)
      }
    } else if (options.liveAdoption) {
      assert.equal(receipt.processes[0].rendered.liveReattached.noLaunch, true)
      assert.equal(receipt.processes[1].rendered.restart.noReplay, true)
      assert.equal(receipt.processes[0].rendered.liveReattached.agentSessionId,
        receipt.processes[1].rendered.restart.inspection.request.report.agent.agentSessionId)
    } else if (options.agentOperations) {
      for (const process of receipt.processes) {
        assert.equal(process.rendered.agentOperations?.qualification, 'stop-fork-feedback-v1')
        assertStopForkScenarios(process.rendered.agentOperations.scenarios, process.mode)
      }
      assert.ok(receipt.processes[0].rendered.agentOperations.costSamples.length >= 6)
      assert.ok(receipt.processes[0].rendered.agentOperations.motion.length >= 5)
      assert.ok(receipt.processes[1].rendered.agentOperations.restart.operationReferencesPreserved)
      assert.ok(receipt.processes[1].rendered.agentOperations.restart.noReplay)
    }
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
  try { const receipt = await runNative(evidence, { frameScope: process.argv.includes('--terminal-only') ? 'terminal' : 'all', liveAdoption: process.argv.includes('--live-adoption'), agentOperations: process.argv.includes('--agent-operations'), motionOnly: process.argv.includes('--motion-only'), workloadPreflight: process.argv.includes('--workload-preflight'), preflight: process.argv.includes('--preflight'), nativeMutant: process.argv.find(value => value.startsWith('--native-mutant='))?.slice('--native-mutant='.length) }); console.log(JSON.stringify({ passed: receipt.passed, frames: receipt.frames.length, processes: receipt.processes.length })) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
