import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), evidence = resolve(root, '.local/pre-admission-resource-recovery/core')
const require = createRequire(new URL('../package.json', import.meta.url)), { build } = require('esbuild')
const config = 'packages/core/test/agent-creation-pre-admission-recovery.config.mts'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const client = 'packages/core/src/client.ts', retry = 'packages/core/src/agent-creation-resource-retry.ts'
const variants = [
  { name: 'baseline' },
  { name: 'read-before-cid-owner', file: client, from: '    const cid = frozen.createOperationId\n',
    to: '    const cid = frozen.createOperationId\n    await this.resolveAgentCreationSessionId(cid)\n', target: 'owns the original CID before omitted-SID store' },
  { name: 'retry-causal-creation-receipt', file: retry,
    from: 'input.signal.aborted || hasCreationFailure(error) || !capacityFailure(error)', to: 'input.signal.aborted || !capacityFailure(error)',
    target: 'preserves the entire original unknown creation receipt tree' },
  { name: 'share-changed-cid-request', file: client,
    from: "if (active.kind !== kind || !isDeepStrictEqual(active.input, frozen)) throw conflict()", to: 'if (false) throw conflict()',
    target: 'owns the original CID before omitted-SID store' },
  { name: 'skip-final-caller-qualification', file: client,
    from: '        await readCallers()\n', to: '', target: 'rechecks the original caller immediately before Start' },
  { name: 'skip-frozen-host-qualification', file: client,
    from: '        await execution.assertHostCurrent?.()\n', to: '', target: 'keeps the first Host config and rejects its changed revision' },
  { name: 'keep-authority-across-wait', file: client,
    from: '} while (checkedRevision !== execution.waitRevision())', to: '} while (false)',
    target: 'rechecks earlier author permission when the final second-caller qualification itself waited' }
]
const required = ['packages/core/src/index.ts', client, retry, 'packages/core/src/executor-owner.ts', 'packages/core/src/agent-creation-authority.ts',
  'packages/core/src/agent-global-message-queue.ts', 'packages/core/src/agent-session-store.ts', 'packages/core/src/agent-session-registry.ts',
  'packages/core/test/agent-creation-pre-admission-recovery.test.ts', 'packages/core/test/agent-creation-resource-retry.test.ts', config,
  'packages/core/test/durable-local-creation.config.mts', 'packages/core/test/hook-postcommit-observation.vitest.config.mts',
  'packages/core/test/helpers/hosted-runtime-port.ts', 'packages/core/scripts/verify-agent-creation-pre-admission-recovery.mjs',
  `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`]
async function inputsMatch(inputs) {
  for (const file of required) assert.match(inputs[file] ?? '', /^[a-f0-9]{64}$/, 'Required exact input: ' + file)
  for (const [file, digest] of Object.entries(inputs)) assert.equal(hash(await readFile(resolve(root, file))), digest, 'Candidate input changed: ' + file)
}
async function cleanupMatches(file) {
  const value = await json(file)
  assert.equal(value.privateCleanup, true); assert.ok(value.resources.length > 0, 'Real private Native resources')
  for (const resource of value.resources) {
    assert.equal(resource.privateCleanup, true)
    await assert.rejects(access(resource.root), 'Private root removed')
    for (const pid of [resource.daemonPid, ...resource.runPids]) {
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
  assert.equal(result.privateCleanup, true); await cleanupMatches(resolve(root, result.resources))
  if (variant.file) {
    assert.ok(result.failed > 0)
    assert.ok(result.sourceChange && result.sourceChange.file === variant.file && result.sourceChange.sourceSHA256 !== result.sourceChange.loadedSHA256)
    assert.equal(result.sourceChange.sourceSHA256, inputs[variant.file])
    assert.ok(tests.some(row => row.status === 'failed' && row.fullName.includes(variant.target) && row.failureMessages.some(message => /AssertionError|expected|promise resolved/iu.test(message))), 'Designated semantic mutation was killed: ' + variant.name)
  } else {
    assert.equal(suite.success, true); assert.equal(result.failed, 0); assert.ok(result.passed >= 30)
    assert.ok(tests.some(row => row.status === 'passed' && row.fullName.includes('fresh OS reader')), 'Fresh process consumed original durable identity')
    assert.ok(tests.some(row => row.status === 'passed' && row.fullName.includes('public Hosted Host')), 'Actual public Host/Hosted creation')
    assert.ok(tests.some(row => row.status === 'passed' && row.fullName.includes('eight creation owners remain the same public Core exports')), 'Actual public export wiring remains intact')
  }
}
if (!process.argv.includes('--run')) {
  const receipt = await json(resolve(evidence, 'receipt.json'))
  assert.equal(receipt.schema, 'agentmux.creation-pre-admission-core-proof.v1'); assert.equal(receipt.status, 'passed')
  await inputsMatch(receipt.inputs)
  assert.deepEqual(receipt.results.map(row => row.name), variants.map(row => row.name))
  for (let index = 0; index < variants.length; index++) await resultMatches(receipt.results[index], variants[index], receipt.inputs)
  process.stdout.write('Core creation preparation: exact candidate, actual public Native paths, loaded mutations and cleanup verified\n')
} else {
  await mkdir(evidence, { recursive: true })
  const temporary = await mkdtemp(resolve(evidence, 'owner-')), packageRoot = resolve(temporary, 'package')
  await mkdir(resolve(packageRoot, 'dist'), { recursive: true })
  for (const name of ['vendor', 'bin', 'node_modules', 'package.json']) await symlink(resolve(root, 'packages/core', name), resolve(packageRoot, name))
  const inputs = {}, alias = { '@agentmux/identity/runtime-source': resolve(root, 'packages/identity/dist/runtime-source.js') }
  async function bind(file) {
    const absolute = resolve(root, file), key = relative(root, absolute), digest = hash(await readFile(absolute))
    if (inputs[key]) assert.equal(inputs[key], digest, 'Input changed while producing: ' + key)
    inputs[key] = digest
  }
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
  const results = []
  try {
    for (const variant of variants) {
      const file = resolve(packageRoot, 'dist', variant.name + '.mjs'), report = resolve(evidence, variant.name + '.json')
      const loaded = resolve(evidence, variant.name + '-loaded.json'), resources = resolve(evidence, variant.name + '-resources.json')
      let sourceChange
      const built = await build({ stdin: { contents: `export { AgentMuxClient } from './packages/core/src/client.ts';
        export { AgentMuxFileAgentSessionStore } from './packages/core/src/agent-session-store.ts';
        export { defineAgentProvider } from './packages/core/src/agent-provider.ts';
        export { AgentMuxError } from './packages/core/src/errors.ts';
        export { AgentMuxCreationAuthority } from './packages/core/src/agent-creation-authority.ts';
        export { AgentMuxHostExecutorOwner } from './packages/core/src/executor-owner.ts';
        export { hashAgentCapability, issueAgentCapability } from './packages/core/src/agent-capability.ts';
        ${variant.file ? 'export const AGENTMUX_PRE_ADMISSION_MUTANT = ' + JSON.stringify(variant.name) + ';' : ''}`, resolveDir: root, loader: 'ts' },
        outfile: file, bundle: true, platform: 'node', format: 'esm', target: 'node24', alias, metafile: true, logLevel: 'silent', plugins: [
          { name: 'existing-dependencies', setup(plugin) { plugin.onResolve({ filter: /^[^./]/ }, async args => {
            if (isBuiltin(args.path) || alias[args.path] || args.pluginData?.resolving) return null
            const value = await plugin.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: { resolving: true } })
            assert.equal(value.errors.length, 0, 'Existing dependency resolved: ' + args.path); await bind(value.path)
            return { path: value.path, external: true }
          }) } }, ...(variant.file ? [{ name: variant.name, setup(plugin) { plugin.onLoad({ filter: /\.ts$/ }, async args => {
            if (args.path !== resolve(root, variant.file)) return null
            const source = await readFile(args.path, 'utf8')
            assert.equal(source.split(variant.from).length, 2, 'Unique production decision: ' + variant.name)
            const contents = source.replace(variant.from, variant.to)
            sourceChange = { file: variant.file, sourceSHA256: hash(source), loadedSHA256: hash(contents) }
            return { contents, loader: 'ts', resolveDir: dirname(args.path) }
          }) } }] : [])] })
      for (const source of Object.keys(built.metafile.inputs)) if (source !== '<stdin>') await bind(source)
      if (variant.file) assert.ok(sourceChange, 'Selected production source transformed')
      await writeFile(resolve(evidence, variant.name + '-inputs.json'), JSON.stringify(inputs))
      const bundleSHA256 = hash(await readFile(file)), args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile=' + report]
      if (variant.target) args.push('-t', variant.target)
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env,
        AGENTMUX_TEST_PRE_ADMISSION_ENTRY: pathToFileURL(file).href, AGENTMUX_TEST_PRE_ADMISSION_MUTANT: variant.file ? variant.name : '',
        AGENTMUX_TEST_PRE_ADMISSION_LOADED: loaded, AGENTMUX_TEST_PRE_ADMISSION_RESOURCES: resources }, stdio: ['ignore', 'pipe', 'pipe'] })
      let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
      const code = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
      await writeFile(resolve(evidence, variant.name + '.log'), log)
      assert.equal(code, variant.file ? 1 : 0, log)
      const suite = await json(report)
      const result = { name: variant.name, passed: suite.numPassedTests, failed: suite.numFailedTests,
        report: relative(root, report), reportSHA256: hash(await readFile(report)), loaded: relative(root, loaded), loadedSHA256: hash(await readFile(loaded)),
        resources: relative(root, resources), resourcesSHA256: hash(await readFile(resources)), bundleSHA256, sourceChange, privateCleanup: true }
      await resultMatches(result, variant, inputs)
      results.push(result)
      await rm(file, { force: true })
      process.stdout.write(variant.name + ': ' + (variant.file ? 'semantic mutation rejected' : 'actual public creation recovered') + '\n')
    }
    await inputsMatch(inputs)
    await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.creation-pre-admission-core-proof.v1', status: 'passed', inputs, results,
      scope: 'One original CID/SID owner; only exact preparation reads wait. Real private Native/FileStore/queue, public direct/Hosted Host, fresh OS read, source/caller/revision fences. No user runtime touched.' }, null, 2) + '\n')
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
