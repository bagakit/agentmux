import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile, copyFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url))
const { build } = require('esbuild')
const output = join(root, 'packages/core/.tmp/initial-continuity-cancellation')
await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'attempt-')), packageRoot = join(attempt, 'package')
await mkdir(join(packageRoot, 'dist'), { recursive: true })
const consumerDirectory = join(attempt, 'consumers'); await mkdir(consumerDirectory)
for (const name of ['vendor', 'package.json']) await symlink(join(root, 'packages/core', name), join(packageRoot, name))
const sha = value => createHash('sha256').update(value).digest('hex'), inputs = new Map()
async function bind(path) {
  const absolute = resolve(root, path), hash = sha(await readFile(absolute))
  if (inputs.has(absolute)) assert.equal(inputs.get(absolute), hash, 'Source changed during qualification: ' + path)
  inputs.set(absolute, hash)
}
for (const file of ['packages/core/src/client.ts', 'packages/core/src/agent-session-recovery/service.ts', 'packages/core/src/agent-session-recovery/continuity-attempt.ts', 'packages/core/src/agent-session-recovery/lifecycle.ts', 'packages/core/src/agent-session-recovery/reconciliation.ts', 'packages/core/src/agent-session-recovery/ports.ts', 'packages/core/src/agent-session-recovery.ts', 'packages/core/src/agent-runtime-helpers.ts', 'packages/core/src/agent-session-recovery/control-contract.ts',
  'packages/core/src/agent-session-recovery/continuity-contract.ts', 'packages/core/src/agent-session-recovery/continuity-policy.ts', 'packages/core/src/agent-session-recovery/supervisor.ts', 'packages/core/src/agent-session-store.ts',
  'packages/core/src/hosted-client-contract.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-runtime-service.ts',
  'packages/core/src/public-rpc.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/rpc-native-codec.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux-cli-module-skills.ts',
  'packages/core/test/initial-continuity-cancellation.test.ts', 'packages/core/test/initial-continuity-cancellation.config.mts',
  'packages/core/test/hook-postcommit-observation.vitest.config.mts', 'packages/core/test/helpers/object-cli-rpc.ts',
  'packages/core/src/agent-session-recovery/executor.ts', 'packages/core/src/agent-session-identity.ts', 'packages/core/src/types.ts', 'packages/core/scripts/verify-initial-continuity-cancellation.mjs',
  `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/manifest.json`,
  `packages/core/vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`]) await bind(file)
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
  {
    "name": "candidate"
  },
  {
    "name": "drop-initial-intent",
    "path": "packages/core/src/agent-session-recovery/continuity-attempt.ts",
    "from": "if (result.kind === 'pending' && current && !receipt.intentOperationId && !receipt.supervision && !['manual', 'input'].includes(receipt.trigger))",
    "to": "if (false && current && !receipt.intentOperationId && !receipt.supervision && !['manual', 'input'].includes(receipt.trigger))",
    "target": "cancels the configured initial delay and keeps the same zero-count receipt across Core process Hosted and compiled CLI",
    "expected": "to match object"
  },
  {
    "name": "count-before-admission",
    "path": "packages/core/src/agent-session-recovery/continuity-attempt.ts",
    "from": "attemptCount: 0, attemptLimit: Math.min(Number.MAX_SAFE_INTEGER, 1 + policy.retryMaxAttempts)",
    "to": "attemptCount: 1, attemptLimit: Math.min(Number.MAX_SAFE_INTEGER, 1 + policy.retryMaxAttempts)",
    "target": "cancels the configured initial delay and keeps the same zero-count receipt across Core process Hosted and compiled CLI",
    "expected": "to match object"
  },
  {
    "name": "require-native-target-before-cancel",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": "const waiting = root && supervision?.attemptCount === 0",
    "to": "const waiting = false && root && supervision?.attemptCount === 0",
    "target": "cancels an unknown original Runtime observation without Native target while its healthy raw Run survives",
    "expected": "promise rejected"
  },
  {
    "name": "claim-ignores-cancellation",
    "path": "packages/core/src/agent-session-store.ts",
    "from": "['cancelled', 'settled', 'paused'].includes(root.supervision.phase)",
    "to": "['settled', 'paused'].includes(root.supervision.phase)",
    "target": "the same Store claim refuses a cancelled initial attempt before any Native Start",
    "expected": "to not be called"
  },
  {
    "name": "fresh-startup-replaces-paused-intent",
    "path": "packages/core/src/agent-session-recovery/supervisor.ts",
    "from": "supervision.phase === 'settled' || root.intentOperationId",
    "to": "['settled', 'paused'].includes(supervision.phase) || root.intentOperationId",
    "target": "a fresh automatic startup joins the original paused intent without resetting its budget or input",
    "expected": "to match object"
  },
  {
    "name": "control-codec-rejects-zero",
    "path": 'packages/core/src/agent-session-recovery/control-contract.ts',
    "from": "attemptCount = count(p.attemptCount)",
    "to": "attemptCount = count(p.attemptCount, 1)",
    "target": "strict codecs accept truthful initial zero counts and reject impossible negative fractional or admitted-zero facts",
    "expected": "to not throw"
  },
  {
    "name": "zero-count-accepts-admitted-run",
    "path": 'packages/core/src/agent-session-recovery/continuity-contract.ts',
    "from": "supervision.attemptCount === 0 && (op.intentOperationId !== undefined",
    "to": "false && (op.intentOperationId !== undefined",
    "target": "strict codecs accept truthful initial zero counts and reject impossible negative fractional or admitted-zero facts",
    "expected": "to throw"
  },
  {
    "name": "accept-changed-control-packet",
    "path": 'packages/core/src/agent-session-recovery/control-contract.ts',
    "from": "a.action === b.action && a.additionalAttempts === b.additionalAttempts",
    "to": "true",
    "target": "wrong Run root Host and changed original packet refuse only that control",
    "expected": "promise resolved"
  },
  {
    "name": "continue-without-reobservation",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": "if (waiting && outcome === 'continued') {",
    "to": "if (false && outcome === 'continued') {",
    "target": "explicit continuation rechecks the original zero-count paused observation without replacing its intent",
    "expected": "to be called 1 times"
  },
  {
    "name": "refresh-without-reobservation",
    "path": "packages/core/src/agent-session-recovery/supervisor.ts",
    "from": "...(supervision.attemptCount === 0 ? { nextActionAt: Date.now() } : {})",
    "to": "...{}",
    "target": "explicit public refresh reobserves the original zero-count Provider wait and admits its first Native attempt",
    "expected": "to be called 1 times"
  }
]
const receipt = { schema: 'agentmux.initial-continuity-cancellation-proof.v1', passed: false, sourceStable: false, results: [],
  scope: { actual: 'Private Native + FileStore + independent Core process + Hosted/public compiled CLI zero-count control',
    controlled: 'Initial delay/Runtime/Provider uncertainty, status/claim cancellation races, fresh automatic identities and unknown admitted Start', userRuntimeTouched: false,
    publicContract: 'Existing inspect/control owners and strict zero-count Session/receipt codecs; no new public method' } }
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
      ...(variant.from ? ['export const AGENTMUX_INITIAL_CONTINUITY_MUTANT = ' + JSON.stringify(variant.name)] : [])].join('\n')
    await bundle({ stdin: { contents: source, resolveDir: root, loader: 'ts' }, outfile: file }, variant)
    const args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/initial-continuity-cancellation.config.mts',
      '--reporter=default', '--reporter=json', '--outputFile=' + report]
    if (variant.target) args.push('-t', variant.target)
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_TEST_INITIAL_CONTINUITY_ENTRY: pathToFileURL(file).href, AGENTMUX_POST_START_ENTRY: pathToFileURL(file).href, AGENTMUX_TEST_OBJECT_CLI: join(cli, 'bin/amux'), AGENTMUX_TEST_INITIAL_CONTINUITY_EVIDENCE: consumerDirectory,
        ...(variant.from ? { AGENTMUX_TEST_INITIAL_CONTINUITY_MUTANT: variant.name } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''; child.stdout.on('data', d => { text += d }); child.stderr.on('data', d => { text += d })
      child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, text }))
    })
    await writeFile(join(attempt, variant.name + '.log'), result.text)
    const tests = JSON.parse(await readFile(report, 'utf8')), assertions = tests.testResults.flatMap(test => test.assertionResults)
    const failed = assertions.filter(test => test.status === 'failed')
    assert.equal(assertions.length, tests.numTotalTests, 'All declared assertion rows must be present')
    assert.equal(assertions.filter(test => test.status === 'passed').length, tests.numPassedTests, 'Passed total must match its raw rows')
    assert.equal(failed.length, tests.numFailedTests, 'Failed total must match its raw rows')
    assert.equal(assertions.filter(test => ['skipped', 'pending', 'todo'].includes(test.status)).length, tests.numPendingTests, 'Skipped total must match its raw rows')
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
    if (!variant.from) assert.ok(result.code === 0 && tests.numPassedTests === 12 && tests.numPendingTests === 0 && tests.success, 'Actual nonempty initial continuity baseline failed: ' + report)
    else assert.ok(semanticRed, 'Loaded mutation did not produce its business failure: ' + variant.name)
  }
  const consumerNames = ['delay-cancel-public-restart', 'runtime-unknown-healthy-raw', 'unknown-admitted-start']
  receipt.consumerEvidence = []
  for (const name of consumerNames) {
    const path = join(consumerDirectory, name + '.json'), bytes = await readFile(path), proof = JSON.parse(bytes)
    assert.equal(proof.schema, 'agentmux.initial-continuity-consumer.v1'); assert.equal(proof.name, name); assert.equal(proof.userRuntimeTouched, false)
    receipt.consumerEvidence.push({ name, path: relative(root, path), sha256: sha(bytes) })
  }
  receipt.consumers = ['actual-native-initial-delay', 'filestore-independent-core-process', 'hosted-zero-count-cancel', 'actual-compiled-cli-control-inspect', 'healthy-native-runtime-unknown', 'original-store-claim', 'fresh-automatic-rejoin', 'unknown-admitted-start-original-reconcile'];
  for (const path of inputs.keys()) await bind(path)
  receipt.inputs = Object.fromEntries(inputs); receipt.sourceStable = true; receipt.passed = true; await save()
  await writeFile(join(output, 'latest.json'), JSON.stringify({ receipt: relative(root, join(attempt, 'receipt.json')) }))
  console.log(relative(root, join(attempt, 'receipt.json')))
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; await save(); throw error }
