import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, registerHooks } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'
import { privatePackageSmokeEnvironment } from './package-smoke-context.mjs'
import { candidateResolve, candidateAlias, candidateModule } from './candidate-package-resolve.mjs'
import { sceneNames } from './fixtures/conversation-progressive-reading/scene.mjs'
import { immediateFirstMount, compareReadingCosts } from './fixtures/conversation-progressive-reading/cost-comparison.mjs'

const root = path.resolve(import.meta.dirname, '../../..'), fixture = path.join(import.meta.dirname, 'fixtures/conversation-progressive-reading')
const args = process.argv.slice(2), compileOnly = args.includes('--compile-only')
const costPairs = args.includes('--cost-pairs')
const anchorAttempts = Number(args.find(value => value.startsWith('--anchor-attempts='))?.slice('--anchor-attempts='.length) ?? 0)
assert.ok(Number.isInteger(anchorAttempts) && anchorAttempts >= 0 && anchorAttempts <= 10, 'Use at most ten sequential anchor attempts')
const preparation = args.includes('--prepare') || compileOnly || anchorAttempts > 0
const sceneOption = args.find(value => value.startsWith('--scene='))?.slice('--scene='.length)
const mobileFixture = args.find(value => value.startsWith('--mobile-fixture='))?.slice('--mobile-fixture='.length) ?? path.join(root, 'apps/mobile/scripts/fixtures/conversation-progressive-reading')
const scenes = sceneOption ? [sceneOption] : costPairs ? ['dense', 'longbody'] : sceneNames
assert.ok(scenes.length && scenes.every(scene => sceneNames.includes(scene)), 'Select a known nonempty scene')
if (anchorAttempts) assert.deepEqual(scenes, ['dense'], 'Anchor attempts exercise only the dense counterexample')
if (costPairs) { assert.equal(anchorAttempts, 0); assert.deepEqual(scenes, ['dense', 'longbody'], 'Cost comparison keeps both approved transcript inputs') }
const evidence = path.resolve(args.find(value => !value.startsWith('--')) ?? path.join(root, '.tmp/conversation-progressive-reading-' + crypto.randomUUID()))
const require = createRequire(path.join(root, 'apps/desktop/package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href)
const electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'amux-r-'))
const hash = value => createHash('sha256').update(value).digest('hex')
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
const inputPaths = [...await files(fixture), path.join(import.meta.dirname, 'verify-conversation-progressive-reading.mjs'),
  ...await files(mobileFixture), ...await files(path.join(root, 'apps/mobile/src')),
  path.join(import.meta.dirname, 'candidate-package-resolve.mjs'),
  path.join(import.meta.dirname, 'probe-process.mjs'), path.join(import.meta.dirname, 'package-smoke-context.mjs'),
  path.join(root, 'apps/desktop/test/helpers/local-runtime-connector.ts'), path.join(root, 'test/fixture-values.mjs'),
  path.join(root, 'vitest.dist-freshness.ts'), path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(root, 'pnpm-lock.yaml'),
  ...['package.json', 'tsconfig.base.json', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json',
    'apps/mobile/package.json', 'apps/mobile/tsconfig.json'].map(file => path.join(root, file)),
  ...await files(path.join(root, 'apps/desktop/src')), ...await files(path.join(root, 'packages/client-ui/src')), ...await files(path.join(root, 'packages/core/src')),
  ...await files(path.join(root, 'packages/core/dist')), ...await files(path.join(root, 'packages/layout/src')),
  ...(await Promise.all(['identity', 'demand', 'relay', 'git', 'diagnostic-evidence', 'connectors', 'capsule'].flatMap(pkg => ['src', 'dist'].map(directory => files(path.join(root, 'packages', pkg, directory)))))).flat()]
for (const entry of await fs.readdir(path.join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const manifest = path.join(root, 'packages', entry.name, 'package.json')
  try { await fs.access(manifest); inputPaths.push(manifest) } catch (error) { if (error.code !== 'ENOENT') throw error }
}
const hashes = async () => Object.fromEntries(await Promise.all(inputPaths.map(async file => [path.relative(root, file), hash(await fs.readFile(file))])))
const loaded = [], cssInputs = {}, emitted = [], transforms = new Map()
const plugin = (browser, variant = 'scheduled') => ({ name: 'exact-conversation-candidate', enforce: 'pre',
  resolveId(specifier) {
    if (!browser && specifier.endsWith('/packages/core/dist/hosted-runtime-service.js')) return { id: path.join(root, 'packages/core/dist/hosted-runtime-service.js'), external: true }
  },
  async transform(code, id) {
    const file = id.split('?')[0]
    if (!path.isAbsolute(file)) return
    const actual = candidateModule(root, file)
    if (!actual.startsWith(root + path.sep) || actual.includes('/node_modules/')) return
    const key = path.relative(root, actual), query = id.slice(file.length)
    const kind = query === '' && /\.[cm]?[jt]sx?$/.test(actual) ? 'module' : 'resource'
    const fileSHA256 = hash(await fs.readFile(actual)), originalSHA256 = hash(code)
    assert.equal(fileSHA256, receipt.inputs[key], 'An actual first-party build input is absent from or changed after the original inventory: ' + key)
    if (kind === 'module') assert.equal(originalSHA256, fileSHA256, 'An ordinary original module changed before its recorded transform: ' + key)
    let returned = code, mutation = null
    if (variant === 'immediate' && file === path.join(root, 'packages/client-ui/src/components/ConversationProgressiveBody.tsx')) {
      assert.equal(kind, 'module', 'Only the exact ordinary body owner can supply the cost baseline')
      const transformed = immediateFirstMount(code)
      transforms.set(key, { file: key, ...transformed.receipt })
      returned = transformed.code; mutation = 'immediate-first-mount'
    }
    loaded.push({ path: key, query, kind, browser, variant, fileSHA256, originalSHA256,
      loadedSHA256: hash(returned), mutation })
    if (mutation) return returned
  } })
const priorEnvironment = new Map(['AGENTMUX_RUNTIME_DIRECTORY', 'AGENTMUX_STATE_DIRECTORY', 'AGENTMUX_MESSAGE_QUEUE_PATH'].map(name => [name, process.env[name]]))
const receipt = { schema: 'agentmux.conversation-progressive-reading.v1', passed: false, sourceBound: false, preparation, compileOnly, anchorAttempts, costPairs,
  candidate: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), phases: [], loaded: [], cssInputs, visualPaths: [],
  independentVisualReview: 'not-performed', boundary: 'Private real Electron and Runtime; controlled native transcript. This runner records a bounded candidate sample. Repeated baseline comparison, Mobile, physical-device operation and independent aesthetic acceptance are separate evidence.' }
let client, resolver, mobileBuild
await fs.mkdir(evidence, { recursive: true })
try {
  receipt.inputs = await hashes()
  const dependencies = new Map()
  for (const owner of ['apps/desktop', 'packages/core', 'packages/relay', 'packages/demand', 'packages/identity', 'packages/git', 'packages/connectors']) {
    const metadata = JSON.parse(await fs.readFile(path.join(root, owner, 'package.json'), 'utf8'))
    for (const name of Object.keys(metadata.dependencies ?? {})) if (!name.startsWith('@agentmux/') && !dependencies.has(name)) {
      dependencies.set(name, await fs.realpath(path.join(root, owner, 'node_modules', name)))
    }
  }
  for (const [name, target] of dependencies) {
    const link = path.join(privateRoot, 'node_modules', name)
    await fs.mkdir(path.dirname(link), { recursive: true }); await fs.symlink(target, link)
  }
  const bound = new Set(Object.keys(receipt.inputs)), changed = []
  for (const args of [['diff', '--no-renames', '--name-only', '-z', receipt.candidate, '--'], ['ls-files', '--others', '--exclude-standard', '-z']]) {
    const status = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    assert.equal(status.status, 0)
    changed.push(...status.stdout.split('\0').filter(file => file && bound.has(file)))
  }
  await fs.writeFile(path.join(evidence, 'candidate-status.log'), JSON.stringify([...new Set(changed)], null, 2) + '\n')
  if (!preparation) {
    assert.deepEqual(changed, [], 'Formal qualification requires committed exact candidate inputs; use --prepare for fixture development')
    const { assertWorkspaceDistBuiltFromCurrentSource } = await import(pathToFileURL(path.join(root, 'vitest.dist-freshness.ts')).href)
    await assertWorkspaceDistBuiltFromCurrentSource(root)
  }
  const common = { configFile: false, root: fixture, logLevel: 'error',
    resolve: { alias: [candidateAlias(root)] },
    css: { postcss: { plugins: [{ postcssPlugin: 'bind-actual-conversation-css', async Once(styles) {
      const files = new Set(); styles.walk(node => { if (node.source?.input.file) files.add(node.source.input.file.split('?')[0]) })
      for (const file of files) {
        const actual = candidateModule(root, file)
        if (actual.startsWith(root + path.sep) && !actual.includes('/node_modules/')) {
          const key = path.relative(root, actual), sha256 = hash(await fs.readFile(actual))
          assert.equal(sha256, receipt.inputs[key], 'Actual CSS is a bound candidate input: ' + key)
          if (cssInputs[key]) assert.equal(cssInputs[key], sha256, 'Actual CSS remains fixed: ' + key)
          cssInputs[key] = sha256
        }
      }
    } }] } } }
  for (const [name, format] of [['main', 'es'], ['preload', 'cjs']]) await build({ ...common, plugins: [plugin(false)],
    ...(name === 'preload' ? { ssr: { noExternal: true } } : {}),
    build: { ssr: path.join(fixture, `${name}.ts`), target: 'node24', outDir: path.join(privateRoot, name), emptyOutDir: true,
      rollupOptions: { makeAbsoluteExternalsRelative: false, external: name === 'main' ? ['electron', '@agentmux/core', /^@agentmux\/core\//] : ['electron'], output: { format, entryFileNames: `${name}.${format === 'es' ? 'mjs' : 'cjs'}` } } } })
  const preloadCode = await fs.readFile(path.join(privateRoot, 'preload/preload.cjs'), 'utf8')
  const preloadRequires = [...preloadCode.matchAll(/\brequire\(["\x27]([^"\x27]+)["\x27]\)/gu)].map(match => match[1])
  assert.ok(preloadRequires.length > 0, 'The sandbox preload must consume its original Electron bridge')
  assert.deepEqual([...new Set(preloadRequires)], ['electron'], 'The sandbox preload must bundle workspace dependencies')
  for (const variant of costPairs ? ['scheduled', 'immediate'] : ['scheduled']) await build({ ...common, base: './', resolve: { alias: [candidateAlias(root, { browser: true })] }, plugins: [plugin(true, variant)], worker: { format: 'es', plugins: () => [plugin(true, variant)] }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    build: { target: 'esnext', minify: false, reportCompressedSize: false, outDir: path.join(privateRoot, variant === 'scheduled' ? 'renderer' : 'renderer-immediate'), emptyOutDir: true } })
  for (const specifier of ['@agentmux/client-ui/styles/conversation-message.css', '@agentmux/client-ui/input/styles.css']) {
    const file = candidateResolve(root, specifier, { browser: true })
    assert.ok(cssInputs[path.relative(root, file)], 'Actual shared stylesheet is compiled: ' + specifier)
  }
  receipt.transforms = [...transforms.values()]
  if (costPairs) assert.equal(receipt.transforms.length, 1)
  if (mobileFixture && !anchorAttempts && !costPairs) {
    const { buildMobile } = await import(pathToFileURL(path.resolve(mobileFixture, 'build.mjs')).href)
    mobileBuild = await buildMobile({ root, output: path.join(privateRoot, 'renderer') })
    for (const [file, sha256] of Object.entries(mobileBuild.source)) if (!file.includes('/node_modules/') && !file.startsWith('node_modules/'))
      assert.equal(sha256, receipt.inputs[file], 'Actual Mobile first-party input was absent from or changed after the original inventory: ' + file)
    receipt.mobileBuild = mobileBuild
  }
  for (const name of ['App.tsx', 'SessionPane.tsx', 'ActivityView.tsx']) assert.ok(loaded.some(value => value.kind === 'module' && value.path.endsWith('/' + name)), 'Actual Desktop consumer not compiled: ' + name)
  for (const name of ['ConversationView.tsx', 'ConversationMessage.tsx']) assert.ok(loaded.some(value => value.kind === 'module' && value.path.endsWith('/' + name)), 'Actual shared consumer not compiled: ' + name)
  receipt.loaded = loaded
  for (const directory of ['renderer', 'main', 'preload', ...(costPairs ? ['renderer-immediate'] : [])]) emitted.push(...await files(path.join(privateRoot, directory)))
  receipt.compiled = Object.fromEntries(await Promise.all(emitted.map(async file => [path.relative(privateRoot, file), hash(await fs.readFile(file))])))
  // Register before loading the bundled Main so external Core dependencies obey
  // the same exact checkout instead of following shared node_modules symlinks.
  const bootstrap = path.join(fixture, 'bootstrap.mjs')
  receipt.bootstrap = { path: path.relative(root, bootstrap), sha256: hash(await fs.readFile(bootstrap)) }
  resolver = registerHooks({ resolve(specifier, context, next) { return specifier.startsWith('@agentmux/') ? { url: pathToFileURL(candidateResolve(root, specifier)).href, shortCircuit: true } : next(specifier, context) } })
  const Core = await import(pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href)
  const runs = anchorAttempts ? Array.from({ length: anchorAttempts }, (_, index) => ({ scene: 'dense', attempt: index + 1 }))
    : costPairs ? scenes.flatMap(scene => [1, 2, 3].flatMap(pair => (pair % 2 ? ['scheduled', 'immediate'] : ['immediate', 'scheduled']).map(variant => ({ scene, pair, variant }))))
    : scenes.map(scene => ({ scene }))
  for (const [index, { scene, attempt, pair, variant = 'scheduled' }] of (compileOnly ? [] : runs).entries()) {
    const runName = pair ? `${scene}-pair-${pair}-${variant}` : attempt ? `${scene}-attempt-${attempt}` : scene
    const runEvidence = pair || attempt ? path.join(evidence, runName) : evidence
    await fs.mkdir(runEvidence, { recursive: true })
    // Unix socket paths have a small platform limit; evidence names need not
    // become part of the private Runtime socket address.
    const sceneRoot = path.join(privateRoot, `s${index}`); await fs.mkdir(path.join(sceneRoot, 'workspace'), { recursive: true })
    await fs.copyFile(path.join(root, 'packages/core/test/fixtures/fake-codex-cli.mjs'), path.join(sceneRoot, 'fake-codex-cli.mjs'))
    for (const phase of anchorAttempts || costPairs ? ['seed'] : ['seed', 'restore']) {
      const processRoot = path.join(sceneRoot, 'process-' + phase); await fs.mkdir(processRoot)
      const env = privatePackageSmokeEnvironment(process.env, { userData: path.join(sceneRoot, 'user-data'), runtimeRoot: path.join(sceneRoot, 'runtime') })
      delete env.AGENTMUX_DESKTOP_READY_FILE; delete env.AGENTMUX_DESKTOP_EXIT_AFTER_READY
      Object.assign(env, { AGENTMUX_AGENT_SESSION_STORE: path.join(sceneRoot, 'agent-sessions.json'),
        AGENTMUX_MESSAGE_QUEUE_PATH: path.join(sceneRoot, 'messages.ndjson'), AGENTMUX_SPATIAL_STATE_STORE: path.join(sceneRoot, 'spatial-state.json') })
      const log = [], logFile = path.join(runEvidence, `${scene}-${phase}-stderr.log`)
      await fs.writeFile(logFile, '')
      const resultFile = path.join(runEvidence, `${scene}-${phase}.json`)
      await fs.rm(resultFile, { force: true })
      const exit = await runProbeProcess(electron, [bootstrap, path.join(privateRoot, variant === 'immediate' ? 'renderer-immediate/index.html' : 'renderer/index.html'), sceneRoot, phase,
        path.join(privateRoot, 'preload/preload.cjs'), runEvidence, process.execPath, scene, mobileBuild?.exercise ?? '', mobileBuild?.preload ?? '', costPairs ? 'cost' : anchorAttempts ? 'anchor' : 'acceptance', path.join(privateRoot, 'main/main.mjs'), root],
      { temporaryRoot: processRoot, cwd: root, env, timeoutMs: 180000, onLine: line => { log.push(line); void fs.appendFile(logFile, line + '\n') } })
      await fs.writeFile(logFile, log.join('\n'))
      assert.equal(exit.timedOut, false, `${scene}/${phase}: private watchdog fired; read its stderr log`)
      const actual = JSON.parse(await fs.readFile(resultFile, 'utf8').catch(error => { throw new Error(`${scene}/${phase}: no result from this process (exit ${exit.exitCode}); ${log.join('\n')}`, { cause: error }) }))
      receipt.phases.push({ scene, phase, attempt, pair, variant, exit, actual })
      assert.equal(exit.timedOut, false)
      if (!anchorAttempts) { assert.equal(exit.exitCode, 0, actual.failure?.message); assert.equal(actual.passed, true) }
      else assert.ok(actual.delayedPageSelection && actual.reads?.length, 'An anchor attempt must reach the original earlier-page commit')
      const seed = receipt.phases.find(item => item.scene === scene && item.phase === 'seed').actual
      if (phase === 'restore') { assert.notEqual(actual.pid, seed.pid); assert.deepEqual(actual.runs, seed.runs, 'Exact original Run/PID survives the separate App process'); assert.deepEqual(actual.unrelatedRuns, seed.unrelatedRuns) }
      const images = scene === 'surfaces' ? ['current', 'system', 'collaboration', 'captured-diff', 'captured-original', 'compact-mailbox', 'compact-mailbox-narrow', 'pending-terminal', 'narrow']
        : scene === 'integrity' ? ['current', 'find-loaded', 'find-code', 'ruler-captured', 'ruler-reopened', 'find-captured', 'narrow']
          : ['current', 'earlier', 'selected', 'narrow']
      for (const name of images) receipt.visualPaths.push({ path: path.relative(root, path.join(runEvidence, `${scene}-${phase}-${name}.png`)), sha256: hash(await fs.readFile(path.join(runEvidence, `${scene}-${phase}-${name}.png`))) })
    }
    process.env.AGENTMUX_RUNTIME_DIRECTORY = path.join(sceneRoot, 'runtime'); process.env.AGENTMUX_STATE_DIRECTORY = path.join(sceneRoot, 'runtime/state'); process.env.AGENTMUX_MESSAGE_QUEUE_PATH = path.join(sceneRoot, 'messages.ndjson')
    client = await Core.connectLocalAgentMux({ store: new Core.AgentMuxFileAgentSessionStore(path.join(sceneRoot, 'agent-sessions.json')) })
    for (const run of await client.listRuns()) if (run.state === 'running') await client.stopTerminal({ runId: run.runId })
    await client.dispose(); client = undefined
  }
  assert.ok(receipt.phases.every(item => item.actual.passed), 'One or more original anchor attempts failed; all completed attempts are retained')
  if (costPairs) {
    receipt.costComparison = compareReadingCosts(receipt.phases, receipt.transforms)
    await fs.writeFile(path.join(evidence, 'cost-comparison.json'), JSON.stringify(receipt.costComparison, null, 2) + '\n')
    assert.equal(receipt.costComparison.passed, true, 'The bounded cost comparison requires investigation; read its measured distributions')
  }
  receipt.passed = true
  receipt.sourceBound = !preparation
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  receipt.loaded = loaded; receipt.transforms = [...transforms.values()]
  // Failed interaction evidence still records exactly which compiled inputs
  // stayed unchanged. A missing final hash must never conceal source drift.
  try {
    receipt.inputsAfter = await hashes()
    receipt.inputDrift = Object.keys(receipt.inputs ?? {}).filter(file => receipt.inputs[file] !== receipt.inputsAfter[file])
    if (mobileBuild) {
      receipt.mobileInputsAfter = Object.fromEntries(await Promise.all(Object.keys(mobileBuild.source).map(async file => [file, hash(await fs.readFile(path.resolve(root, file)))])))
      receipt.inputDrift.push(...Object.keys(mobileBuild.source).filter(file => mobileBuild.source[file] !== receipt.mobileInputsAfter[file]))
    }
    if (!preparation && receipt.inputDrift.length) {
      receipt.passed = false; receipt.sourceBound = false
      receipt.failure ??= { name: 'SourceDrift', message: 'Candidate inputs changed during qualification' }
    }
  } catch (error) { receipt.inputVerificationError = error.message; receipt.passed = false; receipt.sourceBound = false }
  receipt.executed = receipt.phases.length > 0
  await client?.dispose().catch(() => {})
  const errors = []
  try { await stopProbeProcesses(process.pid + 1_000_000_000, privateRoot) } catch (error) { errors.push(error.message) }
  receipt.cleanup = { errors, remaining: await listProbeProcesses(-1, privateRoot), privateRootRemoved: false }
  if (!receipt.cleanup.remaining.length) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateRootRemoved = true }
  resolver?.deregister()
  for (const [name, value] of priorEnvironment) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.deepEqual(receipt.cleanup.errors, []); assert.deepEqual(receipt.cleanup.remaining, []); assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: receipt.passed, sourceBound: receipt.sourceBound, receipt: path.relative(root, path.join(evidence, 'receipt.json')), independentVisualReview: receipt.independentVisualReview }))
