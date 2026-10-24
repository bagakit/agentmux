import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url))
const { build } = require('esbuild')
const output = join(root, 'packages/core/.tmp/durable-local-creation')
await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'attempt-')), packageRoot = join(attempt, 'package')
await mkdir(join(packageRoot, 'dist'), { recursive: true })
for (const name of ['vendor', 'package.json']) await symlink(join(root, 'packages/core', name), join(packageRoot, name))
const sha = value => createHash('sha256').update(value).digest('hex'), inputs = new Map()
async function bind(path) {
  const absolute = resolve(root, path), hash = sha(await readFile(absolute))
  if (inputs.has(absolute)) assert.equal(inputs.get(absolute), hash, 'Source changed during qualification: ' + path)
  inputs.set(absolute, hash)
}
for (const path of ['packages/core/src/client.ts', 'packages/core/src/agent-session-recovery/service.ts', 'packages/core/src/agent-session-recovery/continuity-attempt.ts', 'packages/core/src/agent-session-recovery/lifecycle.ts', 'packages/core/src/agent-session-recovery/reconciliation.ts', 'packages/core/src/agent-session-recovery/ports.ts', 'packages/core/src/agent-session-recovery.ts', 'packages/core/src/agent-runtime-helpers.ts', 'packages/core/src/agent-session-registry.ts', 'packages/core/src/agent-session-store.ts',
  'packages/core/src/ctxmux-run-adapter.ts', 'packages/core/test/hook-postcommit-observation.vitest.config.mts',
  'packages/core/test/durable-local-creation.test.ts', 'packages/core/test/durable-local-creation.config.mts',
  'packages/core/test/agent-creation-delivery-fact.test.ts', 'packages/core/test/agent-start-failure-recovery.test.ts',
  'packages/core/test/agent-creation-operation-identity.test.ts', 'packages/core/test/agent-creation-operation-identity.config.mts',
  'apps/desktop/src/main/runtime-controller.ts',
  'packages/core/scripts/verify-durable-local-creation.mjs',
  `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/manifest.json`,
  `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`]) await bind(path)
if (process.env.AGENTMUX_TEST_CTXMUXD) await bind(process.env.AGENTMUX_TEST_CTXMUXD)
const alias = process.env.CTXMUX_TEST_SDK_SOURCE ? { '@ctxmux/sdk': resolve(process.env.CTXMUX_TEST_SDK_SOURCE) } : {}
for (const name of await readdir(join(root, 'packages'))) {
  const manifest = join(root, 'packages', name, 'package.json')
  let pkg; try { pkg = JSON.parse(await readFile(manifest, 'utf8')) } catch { continue }
  await bind(manifest)
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const entry = typeof value === 'string' ? value : value.import
    if (!entry?.startsWith('./dist/')) continue
    const path = resolve(dirname(manifest), entry.replace(/^\.\/dist\/(?:src\/)?/, './src/').replace(/\.js$/, '.ts'))
    try { await stat(path); alias[key === '.' ? pkg.name : pkg.name + key.slice(1)] = path } catch {}
  }
}
// This generated public export has no TypeScript source file and must outrank the package alias.
alias['@agentmux/identity/runtime-source'] = join(root, 'packages/identity/dist/runtime-source.js')
const variants = [
  { name: 'candidate' },
  { name: 'stale-query-uses-unrelated-inventory', path: 'packages/core/src/client.ts',
    from: 'try { await this.completePreparedCreate(reservation, await this.kernel.inspectCreation(reservation.operationId)) }',
    to: 'try { await this.completePreparedCreate(reservation, (await this.kernel.list()).find(run => run.lifecycleOperationId === reservation.operationId) ?? null) }',
    target: 'isolates original creation observation failures', expected: 'AssertionError' },
  { name: 'one-original-observation-aborts-neighbors', path: 'packages/core/src/client.ts',
    from: 'try { await this.completePreparedCreate(reservation, await this.kernel.inspectCreation(reservation.operationId)) }\n        catch (error) { this.publisher.publish',
    to: 'try { await this.completePreparedCreate(reservation, await this.kernel.inspectCreation(reservation.operationId)) }\n        catch (error) { throw error; this.publisher.publish',
    target: 'isolates original creation observation failures', expected: 'promise rejected' },
  { name: 'mint-another-session', path: 'packages/core/src/client.ts',
    from: "input.agentSessionId ?? await this.resolveAgentCreationSessionId(createOperationId)", to: 'input.agentSessionId ?? mintAgentSessionId()',
    target: 'prepares the immutable ordinary creation', expected: 'expected undefined' },
  { name: 'skip-ordinary-prepare', path: 'packages/core/src/client.ts',
    from: "let preparedCreation: AgentMuxPreparedCreation | undefined\n      if (reservation.kind === 'create')", to: "let preparedCreation: AgentMuxPreparedCreation | undefined\n      if (forkSource && reservation.kind === 'create')",
    target: 'prepares the immutable ordinary creation', expected: 'expected undefined' },
  { name: 'forget-unknown-start', path: 'packages/core/src/client.ts',
    from: 'preservePreparedCreation = true\n      const run = await this.kernel.start', to: 'preservePreparedCreation = false\n      const run = await this.kernel.start',
    target: 'reconciles an applied Start with lost ACK', expected: 'expected undefined' },
  { name: 'stop-after-commit-failure', path: 'packages/core/src/client.ts',
    from: '        if (!persisted) {\n          try {\n            const canonical = (await this.store.readMetadata(agentSessionId))',
    to: '        if (!persisted) {\n          await this.retireUncommittedRun(run.runId)\n          throw error\n          try {\n            const canonical = (await this.store.readMetadata(agentSessionId))',
    target: 'keeps acknowledged native work', expected: 'to not have property "error"' },
  { name: 'claim-foreign-start', path: 'packages/core/src/client.ts',
    from: '!seed || !run || run.lifecycleOperationId !== reservation.operationId || run.workspacePath !== seed.workspacePath',
    to: '!seed || !run || run.workspacePath !== seed.workspacePath',
    target: 'does not replace or claim foreign lifecycle', expected: 'promise resolved' },
  { name: 'ignore-frozen-intent', path: 'packages/core/src/agent-session-store.ts',
    from: "current.kind !== 'create' || current.operationId !== operationId || current.preparedCreation?.creation?.intentDigest !== intentDigest",
    to: "current.kind !== 'create' || current.operationId !== operationId",
    target: 'rejects a changed body', expected: 'promise resolved' },
  { name: 'lose-confirmed-not-applied', path: 'packages/core/src/client.ts',
    from: "if (!(error instanceof AgentMuxError && error.creationFailure?.operationId === lifecycleOperationId &&\n          error.creationFailure.disposition === 'not_applied')) {",
    to: "if (true) {",
    target: 'releases only unused preparation', expected: 'not_applied' },
  { name: 'trust-foreign-creation-receipt', path: 'packages/core/src/client.ts',
    from: 'error.creationFailure?.operationId === lifecycleOperationId &&',
    to: 'error.creationFailure !== undefined &&',
    target: 'retains original creation when the negative receipt belongs to another-operation', expected: 'AGENT_CREATION_UNCONFIRMED' },
  { name: 'lose-confirmed-input-on-projection-failure', path: 'packages/core/src/client.ts',
    from: 'const inputConfirmed = observedInputConfirmed ||', to: 'const inputConfirmed =',
    target: 'returns the actual Input confirmation and leaves durable unknown', expected: 'promptConfirmed' }
]
const receipt = { schema: 'agentmux.durable-local-creation-proof.v1', passed: false, sourceStable: false, results: [],
  scope: { actual: 'Private Native Runtime + live child processes + FileStore/Core creation/public SDK; existing delivery and fatal regression owners',
    controlled: 'Start/commit ACK loss and rejection, prepared-operation contention', userRuntimeTouched: false,
    publicContract: 'Existing create methods/receipts; Hosted and Desktop keep the same Core owner; no new schema or Store' } }
const save = () => writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2))
await save()
try {
  for (const variant of variants) {
    const file = join(packageRoot, 'dist', variant.name + '.mjs'), report = join(attempt, variant.name + '.json')
    let transformed = false
    const compiled = await build({ stdin: { contents: 'export * from "./packages/core/src/index.ts"', resolveDir: root, loader: 'ts' },
      outfile: file, bundle: true, platform: 'node', format: 'esm', target: 'node24', alias, metafile: true,
      logLevel: 'warning', plugins: [{ name: 'existing-dependencies', setup(plugin) {
        plugin.onResolve({ filter: /^[^./]/ }, async args => {
          if (isBuiltin(args.path) || alias[args.path] || args.pluginData?.resolvingDependency) return null
          const resolved = await plugin.resolve(args.path, { kind: args.kind, importer: args.importer,
            resolveDir: args.resolveDir, pluginData: { resolvingDependency: true } })
          assert.equal(resolved.errors.length, 0, 'Dependency resolution failed: ' + args.path)
          await bind(resolved.path)
          return { path: resolved.path, external: true }
        })
      } }, ...(variant.from ? [{ name: 'loaded-' + variant.name, setup(plugin) {
        plugin.onLoad({ filter: /\.ts$/ }, async args => {
          if (args.path !== join(root, variant.path)) return null
          const text = await readFile(args.path, 'utf8')
          assert.equal(text.split(variant.from).length, 2, 'Unique owning anchor: ' + variant.name)
          transformed = true
          return { contents: text.replace(variant.from, variant.to) + '\nexport const AGENTMUX_DURABLE_CREATE_MUTANT = ' + JSON.stringify(variant.name), loader: 'ts', resolveDir: dirname(args.path) }
        })
      } }] : [])] })
    if (variant.from) assert.ok(transformed, 'Mutation was not loaded: ' + variant.name)
    for (const path of Object.keys(compiled.metafile.inputs)) if (path !== '<stdin>') await bind(path)
    const args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/durable-local-creation.config.mts',
      '--reporter=default', '--reporter=json', '--outputFile=' + report]
    if (variant.target) args.push('-t', variant.target)
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_TEST_DURABLE_CREATE_ENTRY: pathToFileURL(file).href,
        AGENTMUX_TEST_CREATION_CLIENT: pathToFileURL(file).href, AGENTMUX_POST_START_ENTRY: pathToFileURL(file).href,
        ...(variant.from ? { AGENTMUX_TEST_DURABLE_CREATE_MUTANT: variant.name } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''; child.stdout.on('data', d => { text += d }); child.stderr.on('data', d => { text += d })
      child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, text }))
    })
    await writeFile(join(attempt, variant.name + '.log'), result.text)
    const tests = JSON.parse(await readFile(report, 'utf8')), assertions = tests.testResults.flatMap(test => test.assertionResults)
    const failed = assertions.filter(test => test.status === 'failed')
    const semanticRed = result.code === 1 && !result.signal && failed.some(test => test.fullName.includes(variant.target) &&
      (test.failureMessages.join('\n') + result.text).includes(variant.expected))
    receipt.results.push({ name: variant.name, code: result.code, signal: result.signal, passed: tests.numPassedTests,
      failed: tests.numFailedTests, total: assertions.filter(test => test.status !== 'pending').length, semanticRed,
      bundleSha256: sha(await readFile(file)), failures: failed.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
    await save()
    if (!variant.from) assert.ok(result.code === 0 && tests.numPassedTests === 42 && tests.success, 'Actual nonempty creation baseline failed: ' + report)
    else assert.ok(semanticRed, 'Loaded mutation did not produce its business failure: ' + variant.name)
  }
  for (const path of inputs.keys()) await bind(path)
  receipt.inputs = Object.fromEntries(inputs); receipt.sourceStable = true; receipt.passed = true; await save()
  await writeFile(join(output, 'latest.json'), JSON.stringify({ receipt: relative(root, join(attempt, 'receipt.json')) }))
  console.log(relative(root, join(attempt, 'receipt.json')))
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; await save(); throw error }
