import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile, copyFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url))
const { build } = require('esbuild')
const output = join(root, 'packages/core/.tmp/session-continuity-supervision')
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
for (const path of ['packages/core/src/client.ts', 'packages/core/src/agent-session-recovery/service.ts', 'packages/core/src/agent-session-recovery/continuity-attempt.ts', 'packages/core/src/agent-session-recovery/lifecycle.ts', 'packages/core/src/agent-session-recovery/reconciliation.ts', 'packages/core/src/agent-session-recovery/ports.ts', 'packages/core/src/agent-session-recovery.ts', 'packages/core/src/agent-runtime-helpers.ts', 'packages/core/src/agent-session-registry.ts', 'packages/core/src/agent-session-recovery/supervisor.ts', 'packages/core/src/agent-session-recovery/input.ts', 'packages/core/src/agent-session-store.ts',
  'packages/core/src/agent-session-recovery/continuity-contract.ts', 'packages/core/src/agent-session-recovery/continuity-policy.ts', 'packages/core/src/ctxmux-run-adapter.ts',
  'packages/core/test/session-continuity-supervision.test.ts', 'packages/core/test/helpers/continuity-supervision-process.mjs', 'packages/core/test/session-continuity-supervision.config.mts',
  'packages/core/test/agent-start-failure-recovery.test.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/renderer/src/store.ts',
  'packages/core/src/hosted-runtime-service.ts', 'packages/core/src/hosted-client-contract.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/scripts/verify-session-continuity-supervision.mjs',
  `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/manifest.json`,
  `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`]) await bind(path)
const alias = {}
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
const variants = [
  { name: 'candidate' },
  { name: 'trust-stale-registry', path: "packages/core/src/agent-session-recovery/service.ts",
    from: "this.ports.runtime.assertAgentRun(session, run, [session]); return run },\n      watch:",
    to: "this.ports.runtime.assertAgentRun(session, run); return run },\n      watch:",
    target: 'a canonical Store binding protects a healthy Native Run from an earlier Core observer cache', expected: "expected 'unknown' to be 'running'" },
  { name: 'wait-for-disposed-observer', path: 'packages/core/src/agent-session-recovery/supervisor.ts',
    from: 'run = await this.observation(() => this.deps.status(session));', to: 'run = await this.deps.status(session);',
    target: 'dispose cancels a never-replying status observation and ignores its late result without changing the original Run', expected: 'expected false to be true' },
  { name: 'forget-supervision', path: "packages/core/src/agent-session-recovery/continuity-attempt.ts",
    from: "if (!receipt.intentOperationId && !['manual', 'input'].includes(receipt.trigger) && (!receipt.supervision || receipt.supervision.attemptCount === 0))", to: "if (false)",
    target: 'observes a later exact Native exit even when no terminal consumer is attached', expected: 'to be called 2 times' },
  { name: 'replay-later-input', path: "packages/core/src/agent-session-recovery/continuity-attempt.ts",
    from: "} : {})\n    }, input.expectedRun, capability && capabilityContext ? { snapshot: capability, context: capabilityContext } : undefined)",
    to: "} : receipt.intentOperationId ? { prompt: current!.continuityOperations![receipt.intentOperationId]!.launchInput!.input.prompt } : {})\n    }, input.expectedRun, capability && capabilityContext ? { snapshot: capability, context: capabilityContext } : undefined)",
    target: 'supervises the original automatic intent with immediate exit after a confirmed nonzero recovery exit without replaying its input', expected: 'expected 4 to be 3' },
  { name: 'lose-native-lifecycle', path: 'packages/core/src/agent-session-recovery/supervisor.ts',
    from: 'if (this.disposed || this.watches.get(id)?.run === run.runId) return', to: 'if (true) return',
    target: 'observes a later exact Native exit even when no terminal consumer is attached', expected: 'to be called 2 times' },
  { name: 'reset-attempt-budget', path: 'packages/core/src/agent-session-recovery/supervisor.ts',
    from: 'supervision.attemptCount >= supervision.attemptLimit', to: 'supervision.attemptCount > supervision.attemptLimit',
    target: 'pauses at the frozen total attempt limit without resetting input or policy', expected: 'to match object { attemptCount: 3' },
  { name: 'retry-signal-termination', path: 'packages/core/src/agent-session-recovery/supervisor.ts',
    from: " || run.state.signal !== null", to: '',
    target: 'keeps signal-only termination unknown rather than inferring a nonzero crash', expected: "to be 'paused'" },
  { name: 'ignore-cancelled-claim', path: 'packages/core/src/agent-session-store.ts',
    from: "['cancelled', 'settled', 'paused'].includes(root.supervision.phase)", to: "['settled', 'paused'].includes(root.supervision.phase)",
    target: 'cancellation before the atomic prepare claim prevents Start even after controller admission', expected: 'to be called 1 times' },
  { name: 'rollback-supervised-fatal', path: "packages/core/src/agent-session-recovery/lifecycle.ts",
    from: "if (continuity?.supervision || continuity?.intentOperationId) {\n          try {", to: "if (false) {\n          try {",
    target: 'a supervised fast fatal keeps its exact failed new Run while direct resume retains its rollback contract', expected: "expected 'pending' to be 'resumed'" },
  { name: 'forget-runtime-cause', path: 'packages/core/src/agent-session-recovery/supervisor.ts',
    from: "message: error instanceof Error ? error.message : String(error), observedAt: Date.now() } }, undefined,",
    to: "message: 'Observation unavailable', observedAt: Date.now() } }, undefined,",
    target: 'explicit refresh reobserves unavailable Runtime without changing its frozen budget', expected: 'Original runtime observation cause' }
]
const receipt = { schema: 'agentmux.session-continuity-supervision-proof.v1', passed: false, sourceStable: false, results: [],
  scope: { actual: 'Private Native Runtime + two exit shapes + FileStore/new Core process/Hosted/public compiled CLI and direct fatal regression owner',
    controlled: 'Original Start uncertainty, exact claim cancellation, signal termination, Runtime observation and frozen retry budget', userRuntimeTouched: false,
    publicContract: 'Existing automatic continuity and Session inspect/refresh; Hosted/Desktop retain the same Core supervisor and Store' } }
const save = () => writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2))
await save()
try {
  async function bundle(options, variant) {
    let transformed = false
    const compiled = await build({ ...options, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', alias, metafile: true,
      logLevel: 'warning', plugins: [{ name: 'existing-dependencies', setup(plugin) {
        plugin.onResolve({ filter: /^[^./]/ }, async args => {
          if (isBuiltin(args.path) || alias[args.path]) return null
          const resolver = createRequire(args.importer || join(root, 'packages/core/package.json'))
          let entry
          try { entry = resolver.resolve(args.path) } catch (error) {
            const parts = args.path.split('/'), name = args.path.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
            for (const directory of resolver.resolve.paths(name) ?? []) {
              try {
                const manifest = join(directory, name, 'package.json'), pkg = JSON.parse(await readFile(manifest, 'utf8'))
                const shape = pkg.exports?.[parts.length ? './' + parts.join('/') : '.'], value = typeof shape === 'string' ? shape : shape?.import
                if (!value) continue
                entry = resolve(dirname(manifest), value); await stat(entry); await bind(manifest); break
              } catch {}
            }
            if (!entry) throw error
          }
          // Execute this ESM artifact under plain Node as well as Vitest. A require resolver may
          // choose CommonJS even when the dependency supplies its original import condition.
          for (let directory = dirname(entry); directory !== dirname(directory); directory = dirname(directory)) {
            try {
              const manifest = join(directory, 'package.json'), pkg = JSON.parse(await readFile(manifest, 'utf8'))
              const shape = pkg.exports?.['.'] ?? pkg.exports, imported = shape?.import
              const value = typeof imported === 'string' ? imported : imported?.default
              if (value?.startsWith('./')) { entry = resolve(directory, value); await bind(manifest) }
              break
            } catch {}
          }
          await bind(entry); return { path: entry, external: true }
        })
      } }, ...(variant?.from ? [{ name: 'loaded-' + variant.name, setup(plugin) {
        plugin.onLoad({ filter: /\.ts$/ }, async args => {
          if (args.path !== join(root, variant.path)) return null
          const text = await readFile(args.path, 'utf8')
          assert.equal(text.split(variant.from).length, 2, 'Unique owning anchor: ' + variant.name)
          transformed = true
          return { contents: text.replace(variant.from, variant.to), loader: 'ts', resolveDir: dirname(args.path) }
        })
      } }] : [])] })
    if (variant?.from) assert.ok(transformed, 'Mutation was not loaded: ' + variant.name)
    for (const path of Object.keys(compiled.metafile.inputs)) if (path !== '<stdin>') await bind(path)
    return compiled
  }
  await bundle({ entryPoints: [join(root, 'packages/core/src/control-endpoint-listener-worker.ts')], outfile: join(packageRoot, 'dist/control-endpoint-listener-worker.js') })
  const cli = join(attempt, 'cli')
  await mkdir(join(cli, 'bin'), { recursive: true }); await mkdir(join(cli, 'dist'), { recursive: true })
  await writeFile(join(cli, 'package.json'), '{"type":"module"}')
  await copyFile(join(root, 'packages/core/bin/amux'), join(cli, 'bin/amux')); await bind('packages/core/bin/amux')
  await bundle({ entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: join(cli, 'dist/agentmux.js') })
  for (const variant of variants) {
    const file = join(packageRoot, 'dist', variant.name + '.mjs'), report = join(attempt, variant.name + '.json')
    const source = ['export * from "./packages/core/src/index.ts"',
      'export { AgentMuxControlServer } from "./packages/core/src/public-rpc-server.ts"',
      'export { AgentMuxHostedRuntimeService } from "./packages/core/src/hosted-runtime-service.ts"',
      ...(variant.from ? ['export const AGENTMUX_CONTINUITY_SUPERVISION_MUTANT = ' + JSON.stringify(variant.name)] : [])].join('\n')
    await bundle({ stdin: { contents: source, resolveDir: root, loader: 'ts' }, outfile: file }, variant)
    const args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/session-continuity-supervision.config.mts',
      '--reporter=default', '--reporter=json', '--outputFile=' + report]
    if (variant.target) args.push('-t', variant.target)
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_TEST_CONTINUITY_SUPERVISION_ENTRY: pathToFileURL(file).href, AGENTMUX_POST_START_ENTRY: pathToFileURL(file).href, AGENTMUX_TEST_OBJECT_CLI: join(cli, 'bin/amux'),
        ...(variant.from ? { AGENTMUX_TEST_CONTINUITY_SUPERVISION_MUTANT: variant.name } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''; child.stdout.on('data', d => { text += d }); child.stderr.on('data', d => { text += d })
      child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, text }))
    })
    await writeFile(join(attempt, variant.name + '.log'), result.text)
    const tests = JSON.parse(await readFile(report, 'utf8')), assertions = tests.testResults.flatMap(test => test.assertionResults)
    const failed = assertions.filter(test => test.status === 'failed')
    assert.equal(assertions.length, tests.numTotalTests, 'All declared assertion rows must be present')
    assert.equal(assertions.filter(test => test.status === 'passed').length, tests.numPassedTests, 'Passed total must match its raw rows')
    assert.equal(failed.length, tests.numFailedTests, 'Failed total must match its raw rows')
    const semanticRed = result.code === 1 && !result.signal && failed.some(test => {
      const failure = test.failureMessages.join('\n')
      const assertion = /AssertionError|__VITEST_(?:REJECTS|RESOLVES)__|expected .+ to /su.test(failure)
      return test.fullName === variant.target && assertion && failure.includes(variant.expected)
        && (!variant.cause || (failure + result.text).includes(variant.cause))
    })
    receipt.results.push({ name: variant.name, code: result.code, signal: result.signal, passed: tests.numPassedTests,
      failed: tests.numFailedTests, total: tests.numTotalTests, semanticRed,
      bundleSha256: sha(await readFile(file)), failures: failed.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
    await save()
    if (!variant.from) assert.ok(result.code === 0 && tests.numPassedTests === 37 && tests.success, 'Actual nonempty supervision baseline failed: ' + report)
    else assert.ok(semanticRed, 'Loaded mutation did not produce its business failure: ' + variant.name)
  }
  const ts = require('typescript'), consumers = []
  const desktop = 'apps/desktop/src/main/runtime-controller.ts', desktopText = await readFile(join(root, desktop), 'utf8')
  const tree = ts.createSourceFile(desktop, desktopText, ts.ScriptTarget.Latest, true)
  function walk(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'ensureAgentContinuity') {
      const statement = node.arguments[0]
      assert.ok(statement && ts.isObjectLiteralExpression(statement) && statement.properties.some(value => value.name?.getText(tree) === 'operationId'), 'Desktop must pass its original continuity request')
      consumers.push({ path: desktop, call: node.expression.getText(tree), line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1 })
    }
    ts.forEachChild(node, walk)
  }
  walk(tree)
  assert.ok(consumers.length > 0, 'No actual Desktop continuity consumer was found')
  const hosted = await readFile(join(root, 'packages/core/src/hosted-client-contract.ts'), 'utf8')
  const contract = ts.createSourceFile('hosted-client-contract.ts', hosted, ts.ScriptTarget.Latest, true), methods = []
  function hostedRegistration(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(contract) === 'AGENTMUX_HOSTED_METHODS') {
      let value = node.initializer
      while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression
      assert.ok(value && ts.isArrayLiteralExpression(value), 'The existing Hosted registration must remain inspectable')
      for (const entry of value.elements) if (ts.isStringLiteral(entry)) methods.push(entry.text)
    }
    ts.forEachChild(node, hostedRegistration)
  }
  hostedRegistration(contract)
  assert.ok(methods.length > 0 && methods.includes('ensureAgentContinuity'), 'The actual Hosted contract must retain its continuity owner')
  const startup = 'apps/desktop/src/renderer/src/store.ts', startupTree = ts.createSourceFile(startup, await readFile(join(root, startup), 'utf8'), ts.ScriptTarget.Latest, true)
  let startupCount = 0
  function startupConsumer(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'recoverSession') {
      const request = node.arguments[2]
      if (request && ts.isObjectLiteralExpression(request) && request.properties.some(value => ts.isPropertyAssignment(value) &&
        value.name.getText(startupTree) === 'trigger' && ts.isStringLiteral(value.initializer) && value.initializer.text === 'startup')) startupCount++
    }
    ts.forEachChild(node, startupConsumer)
  }
  startupConsumer(startupTree)
  assert.ok(startupCount > 0, 'The actual startup consumer must request Core continuity')
  receipt.startupConsumers = startupCount
  receipt.consumers = consumers
  for (const path of inputs.keys()) await bind(path)
  receipt.inputs = Object.fromEntries(inputs); receipt.sourceStable = true; receipt.passed = true; await save()
  await writeFile(join(output, 'latest.json'), JSON.stringify({ receipt: relative(root, join(attempt, 'receipt.json')) }))
  console.log(relative(root, join(attempt, 'receipt.json')))
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; await save(); throw error }
