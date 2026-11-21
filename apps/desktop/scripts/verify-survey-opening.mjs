import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { candidateResolve } from './candidate-package-resolve.mjs'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'
import { flows, hash, exactMutation, checkRuntimeBoundary, checkTypes } from './fixtures/survey-opening/boundary.mjs'
import { bundleIdentityRuntime } from '../../../packages/identity/scripts/runtime-bundle.mjs'

const root = fileURLToPath(new URL('../../..', import.meta.url)), args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 1 && args[0] === '--checks=boundary', 'Use --checks=boundary')
const checks = args.length ? 'boundary' : 'all'
const output = join(root, '.artifacts/survey-opening-architecture/runs', randomUUID())
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'amux-survey-opening-')))
const identityRuntime = join(temporary, 'identity-runtime.ts')
const require = createRequire(join(root, 'apps/desktop/package.json'))
const ts = require('typescript'), { build } = createRequire(join(root, 'packages/core/package.json'))('esbuild')
const spatialOwner = 'apps/desktop/src/renderer/src/lib/space-agent-control.ts'
const owners = [...flows, spatialOwner, 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/main/system-page-ingress.ts']
const source = Object.fromEntries(owners.map(file => [file, hash(readFileSync(join(root, file)))]))
const verificationFiles = ['apps/desktop/scripts/verify-survey-opening.mjs',
  ...['boundary.mjs', 'boundary.test.ts', 'vitest.config.mts'].map(file => 'apps/desktop/scripts/fixtures/survey-opening/' + file),
  'apps/desktop/test/fixtures/survey-opening-capabilities.ts', 'apps/desktop/scripts/candidate-package-resolve.mjs',
  'apps/desktop/scripts/fixtures/survey-tab-composition/native-listener.setup.ts',
  'packages/identity/scripts/runtime-bundle.mjs', 'packages/identity/src/runtime-entry.ts', 'packages/identity/src/index.ts']
const verificationSource = Object.fromEntries(verificationFiles.map(file => [file, hash(readFileSync(join(root, file)))]))
const proof = { schema: 'agentmux.survey-opening-boundary.v1', passed: false, checks,
  source, verificationSource, structures: [], runs: [], cli: null, identity: null,
  boundary: 'Actual current Source Store/Core, HTTP(S), OS webpage-file/Renderer call sites and original public CLI. Existing typed Native transport and no user App/Run, network performance, installed handler or whole-project typecheck claim.' }
await mkdir(output, { recursive: true })
const save = () => writeFile(join(output, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const changedModule = (rows, mutation) => rows.some(row => row.file === mutation.file && row.sourceSHA256 === mutation.sourceSHA256 && row.loadedSHA256 === mutation.loadedSHA256)

async function run(name, mutation, pattern) {
  const resultPath = join(output, name + '.json'), loadedPath = join(output, name + '-loaded.jsonl')
  const listenerTrace = join(output, name + '-listener.jsonl')
  const env = { ...process.env, SURVEY_OPENING_CLI: join(temporary, 'cli.mjs'), SURVEY_OPENING_LOADED: loadedPath,
    SURVEY_OPENING_IDENTITY_RUNTIME: identityRuntime,
    SURVEY_COMPOSITION_LISTENER_TRACE: listenerTrace, SYSTEM_OPEN_RECEIPT: join(output, name + '-cases.jsonl'),
    ...(mutation ? { SURVEY_OPENING_MUTATION: JSON.stringify(mutation) } : {}) }
  if (!mutation) delete env.SURVEY_OPENING_MUTATION
  const command = [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/scripts/fixtures/survey-opening/vitest.config.mts',
    '--reporter=json', '--outputFile=' + resultPath, ...(pattern ? ['--testNamePattern', pattern] : [])]
  const processResult = await runProbeProcess(process.execPath, command, { cwd: root, env, timeoutMs: 90_000,
    onLine: line => appendFileSync(join(output, name + '.log'), line + '\n') })
  await stopProbeProcesses(processResult.originalPid, temporary)
  const report = await json(resultPath), loaded = (await readFile(loadedPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const tests = report.testResults.flatMap(suite => suite.assertionResults), passed = tests.filter(test => test.status === 'passed'), failed = tests.filter(test => test.status === 'failed')
  const result = { name, process: processResult, passed: passed.length, failed: failed.length,
    classification: mutation ? 'behavior-assertion-mutation' : 'actual-source-consumers', report: relative(root, resultPath), loaded: relative(root, loadedPath),
    ...(mutation ? { mutation } : {}) }
  proof.runs.push(result); await save()
  assert.ok(passed.length + failed.length > 0, 'No actual cases executed: ' + name)
  assert.ok(loaded.length > 0 && !loaded.some(row => /^packages\/[^/]+\/dist\//u.test(row.file)), 'Tests must consume first-party Source, not dist')
  assert.ok(loaded.some(row => row.file === relative(root, identityRuntime) && row.loadedSHA256 === proof.identity.moduleSHA256), 'The tests must load the fresh original identity recipe')
  if (mutation) {
    assert.notEqual(processResult.exitCode, 0, 'Behavior mutation survived: ' + name)
    assert.ok(failed.some(test => test.failureMessages.some(message => /AssertionError/u.test(message))), 'Mutation must fail a business assertion, not import/setup: ' + name)
    assert.ok(changedModule(loaded, mutation), 'Mutated production source was not actually loaded: ' + name)
  } else {
    assert.equal(processResult.exitCode, 0, 'Normal consumer run failed: ' + name)
    assert.equal(report.success, true); assert.equal(report.numFailedTestSuites, 0); assert.equal(failed.length, 0)
    assert.equal(report.numPendingTests, 0, 'Normal cases must all execute')
    for (const file of owners) assert.ok(loaded.some(row => row.file === file && row.sourceSHA256 === source[file] && row.loadedSHA256 === source[file]), 'Missing actual owner: ' + file)
    for (const label of ['system-open:', 'survey-opening boundary:', 'through compiled public presentation'])
      assert.ok(passed.some(test => test.fullName.includes(label)), 'Missing actual product consumer: ' + label)
    assert.ok(passed.filter(test => test.fullName.startsWith('system-open:')).length >= 8)
    for (const file of ['system-web-file.test.ts', 'survey-system-url.test.ts', 'web-url-ingress.test.ts'])
      assert.ok(report.testResults.some(suite => suite.name.endsWith(file) && suite.assertionResults.some(test => test.status === 'passed')), 'Missing exact caller: ' + file)
    const listener = (await readFile(listenerTrace, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(listener.some(row => row.kind === 'fork' && row.source === join(root, 'packages/core/src/control-endpoint-listener-worker.ts')))
    assert.ok(listener.some(row => row.kind === 'message' && row.identity && row.hasHandle), 'Original listener IPC must pass a real socket')
    assert.ok(listener.some(row => row.kind === 'restored' && row.restored))
  }
  return result
}

try {
  const identity = await bundleIdentityRuntime()
  await writeFile(identityRuntime, `export const identityRuntimeSource = ${JSON.stringify(identity.source)};\n`)
  proof.identity = { recipe: 'packages/identity/scripts/runtime-bundle.mjs', moduleSHA256: hash(await readFile(identityRuntime)) }
  const boundary = checkRuntimeBoundary(root)
  assert.deepEqual(boundary.violations, []); proof.structures.push({ name: 'runtime-boundary', ...boundary })
  const types = checkTypes(root, null, false, identityRuntime)
  assert.deepEqual(types.diagnostics, [], 'Scoped contract typecheck failed')
  proof.structures.push({ name: 'types', ...types })
  const negative = checkTypes(root, null, true, identityRuntime)
  assert.ok(negative.diagnostics.filter(row => row.file.endsWith('/survey-opening-capabilities.ts')).length >= negative.negativeCases,
    'The real negative TypeScript cases must fail without their expect-error directives')
  proof.structures.push({ name: 'exposed-negative-cases', ...negative })
  for (const [file, typeName] of [[flows[0], 'SurveyBrowserCreationState'], [flows[1], 'SystemPageState'], [flows[2], 'SurveyPageAdmissionState']]) {
    const text = readFileSync(join(root, file), 'utf8'), ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const alias = ast.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === typeName)
    assert.ok(alias, 'Expected the actual capability alias: ' + typeName)
    const mutation = exactMutation(root, file, alias.getText(ast), alias.getText(ast).replace(alias.type.getText(ast), 'AppState'))
    const result = checkTypes(root, mutation, false, identityRuntime)
    assert.ok(result.diagnostics.some(row => row.code === 2578 && row.file.endsWith('/survey-opening-capabilities.ts')), 'Wide AppState escaped negative consumer: ' + typeName)
    assert.ok(changedModule(result.loaded, mutation)); proof.structures.push({ name: 'wide-' + typeName, mutation, ...result })
  }
  const importMutation = exactMutation(root, flows[0], "import type { AppState } from '../store'", "import { useAppStore } from '../store'\nimport type { AppState } from '../store'")
  const leaked = checkRuntimeBoundary(root, importMutation)
  assert.equal(leaked.violations.length, 1); assert.ok(changedModule(leaked.loaded, importMutation))
  proof.structures.push({ name: 'runtime-store-import', mutation: importMutation, ...leaked }); await save()

  await symlink(join(root, 'packages/core/node_modules'), join(temporary, 'node_modules'), 'dir')
  const compiled = await build({ absWorkingDir: root, entryPoints: ['packages/core/src/agentmux.ts'], outfile: join(temporary, 'cli.mjs'),
    platform: 'node', target: 'node24', format: 'esm', bundle: true, metafile: true, logLevel: 'error',
    banner: { js: "import{createRequire as __createRequire}from'node:module';const require=__createRequire(import.meta.url);" },
    plugins: [{ name: 'survey-opening-original-cli-source', setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, async args => {
        if (args.pluginData?.surveyOpeningDependency) return
        if (args.path === '@agentmux/identity/runtime-source') return { path: identityRuntime }
        if (args.path.startsWith('@agentmux/')) return { path: candidateResolve(root, args.path, { source: true }) }
        if (isBuiltin(args.path)) return { path: args.path, external: true }
        // Bundling workspace sources must retain each original dependency owner's
        // resolution, rather than flatten every package onto Core's node_modules.
        const dependency = await builder.resolve(args.path, { importer: args.importer, resolveDir: args.resolveDir,
          kind: args.kind, namespace: args.namespace, pluginData: { surveyOpeningDependency: true } })
        if (dependency.errors.length) return { errors: dependency.errors }
        return { path: dependency.path, external: true }
      })
    } }] })
  const cliInputs = Object.keys(compiled.metafile.inputs)
  assert.ok(!cliInputs.some(file => /^packages\/[^/]+\/dist\//u.test(file)), 'The CLI must consume first-party Source, not dist')
  assert.ok(cliInputs.some(file => file === relative(root, identityRuntime)), 'The CLI must consume the same fresh identity module')
  const cliSources = Object.fromEntries(cliInputs.filter(file => file.startsWith('packages/')).map(file => [file, hash(readFileSync(join(root, file)))]))
  assert.ok(cliSources['packages/core/src/agentmux.ts'])
  proof.cli = { entry: 'packages/core/src/agentmux.ts', compiledSHA256: hash(await readFile(join(temporary, 'cli.mjs'))), sources: cliSources }
  await run('normal')
  const generic = exactMutation(root, 'apps/desktop/src/renderer/src/store.ts',
    '      prepareZone(workspaceId) {', '      prepareZone(workspaceId) {\n        void get().createWorkbenchZone({ workspaceId, spaceIds: [] })')
  await run('generic-save-reintroduced', generic, '^survey-opening boundary:')
  const parallelCase = '^system-open: navigation and presentation proceed'
  const checkpoint = exactMutation(root, flows[0], '[visible, checkpointPreparation()]', '[visible, Promise.resolve()]')
  await run('required-checkpoint-omitted', checkpoint, parallelCase)
  const sequential = exactMutation(root, flows[0], '  const navigation = attached', '  await checkpointPreparation()\n  const navigation = attached')
  await run('navigation-waits-for-save', sequential, parallelCase)
  const launcherOnly = exactMutation(root, flows[0], '  if (!attached) await checkpointPreparation()', '  // Discard the attached Browser checkpoint.')
  await run('attached-browser-checkpoint-omitted', launcherOnly, '^survey-opening boundary: the actual Store prepares')
  if (checks === 'all') {
    const directory = exactMutation(root, 'apps/desktop/src/renderer/src/store.ts',
      '      checkpointPreparation: checkpointSpatialWorkbench',
      '      checkpointPreparation: async () => { await api.scratch.listTopics(SCRATCH_WORKSPACE_ID); await checkpointSpatialWorkbench() }')
    await run('hidden-directory-wait', directory, '^system-open: (http|https) reaches')
    const preferences = exactMutation(root, 'apps/desktop/src/renderer/src/store.ts',
      '    await checkpointWorkbenchUserDocument()\n    clientStateWritten = true',
      '    await checkpointWorkbenchUserState()\n    clientStateWritten = true')
    await run('unrelated-save-wait', preferences, '^system-open: (http|https) reaches')
    const serial = exactMutation(root, 'apps/desktop/src/main/system-page-ingress.ts',
      'while (this.active.size < 2 && this.pending.length)', 'while (this.active.size < 1 && this.pending.length)')
    await run('slow-first-blocks-next', serial, '^system-open: a slow first Native creation')
    const delayed = exactMutation(root, flows[1], 'onPrepared(value) { preparation = value; reveal(value) }', 'onPrepared(value) { preparation = value }')
    await run('browser-reveal-delayed', delayed, '^system-open: an attached original Browser becomes visible')
    const missingTarget = exactMutation(root, flows[1], '    present(() => get().setSurveyPageOpening(presentation))', '    present(() => {})')
    await run('opening-target-hidden', missingTarget, 'a held default Profile read shows Survey promptly')
    const launcherFlash = exactMutation(root, flows[1], '    if (!page && !(recovering && launcher)) return', '    if (!page && !launcher) return')
    await run('launcher-visible-during-opening', launcherFlash, parallelCase)
    const wholeDirectory = exactMutation(root, spatialOwner, '  const sources = readSpatialSources(state, topics)\n  if (sources.zones.some',
      '  const sources = spatialCatalog(state as SpatialWorkbench, topics)\n  if (sources.zones.some')
    await run('zone-preparation-scans-directory', wholeDirectory, '^system-open: preparing a Survey Zone')
  }
  await run('restored')
  for (const [file, sha] of Object.entries(source)) assert.equal(hash(readFileSync(join(root, file))), sha, 'Candidate changed during qualification: ' + file)
  for (const [file, sha] of Object.entries(verificationSource)) assert.equal(hash(readFileSync(join(root, file))), sha, 'Verification source changed during qualification: ' + file)
  for (const [file, sha] of Object.entries(cliSources)) assert.equal(hash(readFileSync(join(root, file))), sha, 'CLI candidate changed during qualification: ' + file)
  proof.passed = true
} catch (error) {
  proof.failure = { message: error.message, stack: error.stack }; throw error
} finally {
  await stopProbeProcesses(undefined, temporary)
  proof.cleanup = { remaining: await listProbeProcesses(undefined, temporary), temporaryRemoved: false }
  assert.deepEqual(proof.cleanup.remaining, []); await rm(temporary, { recursive: true, force: true }); proof.cleanup.temporaryRemoved = true
  await save()
  process.stdout.write(JSON.stringify({ passed: proof.passed, checks: proof.checks, report: relative(root, join(output, 'receipt.json')) }) + '\n')
}
