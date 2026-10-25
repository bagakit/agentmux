import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, relative, resolve, extname } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), evidence = resolve(root, '.local/creation-resource-wake/core')
const require = createRequire(new URL('../package.json', import.meta.url)), { build } = require('esbuild')
const config = 'packages/core/test/creation-resource-wake.config.mts'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const client = 'packages/core/src/client.ts', retry = 'packages/core/src/agent-creation-resource-retry.ts'
const variants = [
  { name: 'baseline' },
  { name: 'no-current-wait-release', file: retry,
    from: '      sleep.abort()\n      return true', to: '      return true', target: 'current wait wake cancels its timer and listeners' },
  { name: 'ignore-known-sid', file: client,
    from: 'if (request.agentSessionId !== undefined && request.agentSessionId !== entry.agentSessionId) throw new AgentMuxError(',
    to: 'if (false) throw new AgentMuxError(', target: 'wakes only the exact current CID and SID wait' },
  { name: 'skip-public-owner-wake', file: 'packages/core/src/public-rpc-service.ts',
    from: ': parseCreationContinueReceipt(await scope.client.continueAgentCreation(input), input)',
    to: ": parseCreationContinueReceipt({ createOperationId: input.createOperationId, status: 'unknown' }, input)", target: 'actual public CLI wakes the retained long wait' },
  { name: 'skip-current-device-proof', file: 'packages/core/src/public-rpc-service.ts',
    from: "      context.signal?.throwIfAborted(); await this.inputCallContext(context).assertCurrent?.()\n      context.signal?.throwIfAborted()\n      const scope = scopes[0]!",
    to: "      context.signal?.throwIfAborted()\n      const scope = scopes[0]!", target: 'public service checks current device authority' },
  { name: 'skip-hosted-current-proof', file: 'packages/core/src/hosted-runtime-service.ts',
    from: "      if (invocation.method === 'continueAgentCreation') {\n        await context.assertCurrent?.()",
    to: "      if (invocation.method === 'continueAgentCreation') {", target: 'revoked device authority rejects both' }
]
const required = ['packages/core/src/index.ts', client, retry, 'packages/core/src/agent-creation-continue.ts',
  'packages/core/src/hosted-client-contract.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-runtime-service.ts',
  'packages/core/src/public-rpc.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/rpc-native-codec.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux.ts', 'packages/core/guides/modules/agent.md',
  'packages/core/src/generated/agentmux-guides.ts', 'packages/core/src/generated/agentmux-guides-index.ts',
  'packages/core/test/fixtures/creation-resource-wake-source.ts', 'packages/core/test/creation-resource-wake.test.ts', 'packages/core/test/creation-resource-wake-helper.test.ts',
  'packages/core/test/agent-creation-resource-retry.test.ts', config, 'packages/core/test/agent-creation-pre-admission-recovery.config.mts',
  'packages/core/test/durable-local-creation.config.mts', 'packages/core/test/hook-postcommit-observation.vitest.config.mts',
  'packages/core/test/helpers/hosted-runtime-port.ts', 'packages/core/scripts/verify-creation-resource-wake.mjs',
  `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`]
async function inputsMatch(inputs) {
  for (const file of required) assert.match(inputs[file] ?? '', /^[a-f0-9]{64}$/, 'Required exact input: ' + file)
  for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Candidate input changed: ' + file)
}
async function cleanupMatches(file, requireNative) {
  const value = await json(file)
  assert.equal(value.privateCleanup, true); assert.deepEqual(value.cleanupErrors, [], 'No private cleanup failures'); if (requireNative) assert.ok(value.resources.length > 0, 'Real private Native resources')
  for (const child of value.cliChildren) { assert.equal(child.exited, true); assert.ok(Number.isInteger(child.pid)); assert.throws(() => process.kill(child.pid, 0), 'Exact CLI child exited') }
  for (const resource of value.resources) {
    assert.equal(resource.privateCleanup, true)
    await assert.rejects(access(resource.root), 'Private root removed')
    for (const pid of [resource.daemonPid, ...resource.runPids, ...resource.listenerPids]) {
      assert.ok(Number.isInteger(pid) && pid > 1)
      assert.throws(() => process.kill(pid, 0), 'Exact private process exited')
    }
  }
}
async function resultMatches(result, variant, inputs) {
  for (const key of ['report', 'loaded', 'resources']) assert.equal(hash(await readFile(resolve(root, result[key]))), result[key + 'SHA256'])
  const suite = await json(resolve(root, result.report)), loaded = await json(resolve(root, result.loaded))
  assert.equal(suite.numRuntimeErrorTestSuites ?? 0, 0, 'Loading failures are not semantic proof')
  assert.equal(result.passed, suite.numPassedTests); assert.equal(result.failed, suite.numFailedTests)
  const tests = suite.testResults.flatMap(row => row.assertionResults)
  assert.ok(tests.some(row => ['passed', 'failed'].includes(row.status)), 'Nonempty actual consumer assertions')
  assert.equal(loaded.publicClient, true); assert.equal(loaded.loadedSHA256, result.bundleSHA256)
  assert.equal(loaded.mutation, variant.file ? variant.name : null)
  assert.equal((await json(resolve(root, result.resources))).cliSHA256, result.cliSHA256)
  assert.match(result.cliSHA256, /^[a-f0-9]{64}$/)
  assert.deepEqual((await json(resolve(root, result.resources))).cliModules, result.cliModules)
  assert.ok(Object.keys(result.cliModules).length > 1, 'Actual CLI has distinct static ESM modules')
  if (!variant.file) assert.ok(loaded.hostedOwners?.length > 0 && loaded.hostedOwners.every(value => value.selected), 'Actual selected Hosted constructors consumed')
  assert.equal(result.privateCleanup, true); await cleanupMatches(resolve(root, result.resources), variant.name !== 'no-current-wait-release')
  if (variant.file) {
    assert.ok(result.failed > 0)
    assert.ok(result.sourceChange && result.sourceChange.file === variant.file && result.sourceChange.sourceSHA256 !== result.sourceChange.loadedSHA256)
    assert.equal(result.sourceChange.sourceSHA256, inputs[variant.file])
    assert.ok(tests.some(row => row.status === 'failed' && row.fullName.includes(variant.target) && row.failureMessages.some(message => /AssertionError|expected|promise resolved/iu.test(message))), 'Designated semantic mutation was killed: ' + variant.name)
  } else {
    const causal = (await json(resolve(root, result.resources))).wakeTimeline
    assert.ok(causal.some(value => value.wakeAt >= value.registeredAt && value.wakeAt < value.deadline && !value.naturallyReleased && value.startedAt >= value.wakeAt && value.starts === 1 && value.inputCalls === 0 && value.acceptedInputBytes === 0), 'Actual action released the installed timer before its natural deadline, with one original Native creation')
    assert.equal(suite.success, true); assert.equal(result.failed, 0); assert.ok(result.passed >= 26)
    for (const name of ['actual public CLI wakes the retained long wait', 'revoked device authority rejects both', 'keeps unresolved SID unknown', 'current wait wake cancels its timer', 'actual CLI help and module guide'])
      assert.ok(tests.some(row => row.status === 'passed' && row.fullName.includes(name)), 'Actual selected consumer passed: ' + name)

  }
}
if (!process.argv.includes('--run')) {
  const receipt = await json(resolve(evidence, 'receipt.json'))
  assert.equal(receipt.schema, 'agentmux.creation-resource-wake-proof.v1'); assert.equal(receipt.status, 'passed')
  await inputsMatch(receipt.inputs)
  assert.deepEqual(receipt.results.map(row => row.name), variants.map(row => row.name))
  for (let index = 0; index < variants.length; index++) await resultMatches(receipt.results[index], variants[index], receipt.inputs)
  process.stdout.write('Creation resource wake: exact candidate, actual Native/Hosted/public CLI, loaded mutations and cleanup verified\n')
} else {
  await mkdir(evidence, { recursive: true })
  const temporary = await mkdtemp(resolve(evidence, 'owner-')), packageRoot = resolve(temporary, 'package')
  try {
  await mkdir(resolve(packageRoot, 'dist'), { recursive: true })
  for (const name of ['vendor', 'bin', 'node_modules', 'package.json']) await symlink(resolve(root, 'packages/core', name), resolve(packageRoot, name))
  const inputs = {}, alias = { '@agentmux/identity/runtime-source': resolve(root, 'packages/identity/dist/runtime-source.js') }
  async function bind(file, contents) {
    const absolute = resolve(root, file), key = relative(root, absolute), digest = hash(contents ?? await readFile(absolute))
    if (inputs[key]) assert.equal(inputs[key], digest, 'Input changed while producing: ' + key)
    inputs[key] = digest
  }
  const loadedSource = (variant, transformed = () => {}) => ({ name: 'actual-source-inputs', setup(plugin) {
    plugin.onLoad({ filter: /\.(?:[cm]?[jt]s|tsx|json)$/ }, async args => {
      const source = await readFile(args.path, 'utf8')
      await bind(args.path, source)
      let contents = source
      if (variant?.file && args.path === resolve(root, variant.file)) {
        assert.equal(source.split(variant.from).length, 2, 'Unique production decision: ' + variant.name)
        contents = source.replace(variant.from, variant.to)
        transformed({ file: variant.file, sourceSHA256: hash(source), loadedSHA256: hash(contents) })
      }
      const extension = extname(args.path)
      return { contents, loader: extension === '.json' ? 'json' : extension === '.ts' ? 'ts' : extension === '.tsx' ? 'tsx' : 'js', resolveDir: dirname(args.path) }
    })
  } })
  const existingDependencies = { name: 'existing-dependencies', setup(plugin) { plugin.onResolve({ filter: /^[^./]/ }, async args => {
            if (isBuiltin(args.path) || alias[args.path] || args.pluginData?.resolving) return null
            const value = await plugin.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: { resolving: true } })
            assert.equal(value.errors.length, 0, 'Existing dependency resolved: ' + args.path); await bind(value.path)
            return { path: value.path, external: true }
          }) } }
  for (const file of required) await bind(file)
  for (const name of await readdir(resolve(root, 'packages'))) {
    const manifest = resolve(root, 'packages', name, 'package.json')
    let pkg; try { pkg = await json(manifest) } catch { continue }
    await bind(manifest)
    for (const [key, value] of Object.entries(pkg.exports ?? {})) {
      const entry = typeof value === 'string' ? value : value.import
      if (!entry?.startsWith('./dist/')) continue
      const file = resolve(dirname(manifest), entry.replace(/^\.\/dist\/(?:src\/)?/, './src/').replace(/\.js$/, '.ts'))
      try { await stat(file); alias[key === '.' ? pkg.name : pkg.name + key.slice(1)] = file } catch {}
    }
  }
  alias['@agentmux/identity/runtime-source'] = resolve(root, 'packages/identity/dist/runtime-source.js')
  const cli = resolve(packageRoot, 'dist', 'agentmux.mjs')
  const cliBuild = await build({ entryPoints: [resolve(root, 'packages/core/src/agentmux.ts'),
    resolve(root, 'packages/core/src/providers/codex-execution-run.ts'), resolve(root, 'packages/core/src/providers/claude-execution-run.ts')],
    outdir: resolve(packageRoot, 'dist'), outExtension: { '.js': '.mjs' }, bundle: true, splitting: true,
    platform: 'node', format: 'esm', target: 'node24', alias, metafile: true, logLevel: 'silent', plugins: [existingDependencies, loadedSource()] })
  // Node links this static ESM graph; helper entry guards retain a module URL distinct from CLI argv[1].
  const cliModules = {}, modulePaths = new Set()
  const visit = async file => {
    if (modulePaths.has(file)) return
    modulePaths.add(file)
    cliModules[relative(resolve(packageRoot, 'dist'), resolve(root, file))] = hash(await readFile(resolve(root, file)))
    for (const dependency of cliBuild.metafile.outputs[file]?.imports ?? []) if (!dependency.external && dependency.kind === 'import-statement') await visit(dependency.path)
  }
  await visit(relative(root, cli))
  const cliModuleManifest = resolve(temporary, 'cli-modules.json')
  await writeFile(cliModuleManifest, JSON.stringify([...modulePaths].map(file => resolve(root, file))))
  await writeFile(resolve(evidence, 'cli-modules.json'), JSON.stringify({ modules: cliModules, scope: 'Actual CLI static ESM import graph only; helper launch artifacts and release packaging are not qualified.' }, null, 2))
  const workerBuild = await build({ entryPoints: [resolve(root, 'packages/core/src/control-endpoint-listener-worker.ts')],
    outfile: resolve(packageRoot, 'dist/control-endpoint-listener-worker.js'), bundle: true, platform: 'node', format: 'esm', target: 'node24',
    metafile: true, logLevel: 'silent', plugins: [loadedSource()] })
  for (const source of Object.keys(workerBuild.metafile.inputs)) await bind(source)
  for (const source of Object.keys(cliBuild.metafile.inputs)) await bind(source)
  const cliSHA256 = hash(await readFile(cli))
  const results = []
    for (const variant of variants) {
      const file = resolve(packageRoot, 'dist', variant.name + '.mjs'), report = resolve(evidence, variant.name + '.json')
      const loaded = resolve(evidence, variant.name + '-loaded.json'), resources = resolve(evidence, variant.name + '-resources.json')
      let sourceChange
      const built = await build({ stdin: { contents: `export * from './packages/core/test/fixtures/creation-resource-wake-source.ts';
        export { retryAgentCreationResources } from './packages/core/src/agent-creation-resource-retry.ts';
        ${variant.file ? 'export const AGENTMUX_CREATION_WAKE_MUTANT = ' + JSON.stringify(variant.name) + ';' : ''}`, resolveDir: root, loader: 'ts' },
        outfile: file, bundle: true, platform: 'node', format: 'esm', target: 'node24', alias, metafile: true, logLevel: 'silent', plugins: [
          existingDependencies, loadedSource(variant, value => { sourceChange = value })] })
      for (const source of Object.keys(built.metafile.inputs)) if (source !== '<stdin>') await bind(source)
      if (variant.file) assert.ok(sourceChange, 'Selected production source transformed')
      await writeFile(resolve(evidence, variant.name + '-inputs.json'), JSON.stringify(inputs))
      const bundleSHA256 = hash(await readFile(file)), args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile=' + report]
      if (variant.target) args.push('-t', variant.target)
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env,
        AGENTMUX_TEST_CREATION_WAKE_ENTRY: pathToFileURL(file).href, AGENTMUX_TEST_CREATION_WAKE_MUTANT: variant.file ? variant.name : '',
        AGENTMUX_TEST_CREATION_WAKE_LOADED: loaded, AGENTMUX_TEST_CREATION_WAKE_RESOURCES: resources, AGENTMUX_TEST_CREATION_WAKE_CLI: cli, AGENTMUX_TEST_CREATION_WAKE_CLI_MODULES: cliModuleManifest }, stdio: ['ignore', 'pipe', 'pipe'] })
      let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
      const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
      await writeFile(resolve(evidence, variant.name + '.log'), log)
      assert.equal(code, variant.file ? 1 : 0, log)
      const suite = await json(report)
      const result = { name: variant.name, cliSHA256, cliModules, passed: suite.numPassedTests, failed: suite.numFailedTests,
        report: relative(root, report), reportSHA256: hash(await readFile(report)), loaded: relative(root, loaded), loadedSHA256: hash(await readFile(loaded)),
        resources: relative(root, resources), resourcesSHA256: hash(await readFile(resources)), bundleSHA256, sourceChange, privateCleanup: true }
      await resultMatches(result, variant, inputs)
      results.push(result)
      await rm(file, { force: true })
      process.stdout.write(variant.name + ': ' + (variant.file ? 'semantic mutation rejected' : 'actual public creation recovered') + '\n')
    }
    await inputsMatch(inputs)
    await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.creation-resource-wake-proof.v1', status: 'passed', inputs, results,
      scope: 'Only the exact active creation current wait is woken. Real private Native/FileStore, Hosted and public CLI, no future credit, current authorization and strict receipt identity. No user runtime touched.' }, null, 2) + '\n')
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
