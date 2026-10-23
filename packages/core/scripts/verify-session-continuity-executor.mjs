import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile, copyFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url))
const { build } = require('esbuild')
const output = join(root, 'packages/core/.tmp/session-continuity-executor')
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
for (const file of ['packages/core/src/client.ts', 'packages/core/src/agent-session-recovery/service.ts', 'packages/core/src/agent-session-recovery/ports.ts', 'packages/core/src/agent-session-recovery.ts', 'packages/core/src/agent-runtime-helpers.ts', 'packages/core/src/agent-session-recovery/control.ts',
  'packages/core/src/agent-session-recovery/continuity.ts', 'packages/core/src/agent-session-store.ts',
  'packages/core/src/hosted-client-contract.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-runtime-service.ts',
  'packages/core/src/public-rpc.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/rpc-native-codec.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux-cli-module-skills.ts',
  'packages/core/test/session-continuity-executor.test.ts', 'packages/core/test/session-continuity-executor.config.mts',
  'packages/core/test/hook-postcommit-observation.vitest.config.mts', 'packages/core/test/helpers/object-cli-rpc.ts',
  'packages/core/test/helpers/continuity-executor-process.mjs', 'packages/core/src/agent-session-recovery/executor.ts', 'packages/core/src/agent-session-identity.ts', 'packages/core/src/types.ts', 'packages/core/scripts/verify-session-continuity-executor.mjs',
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
    "name": "lose-sdk-command",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": "{ ...originalInput, ...structuredClone(executor.options) }",
    "to": "{ ...originalInput, ...structuredClone(executor.options), ...(receipt.intentOperationId ? { commandOverride: undefined } : {}) }",
    "target": "retains the exact SDK invocation for the context-only retry with Host owner false",
    "expected": "to be"
  },
  {
    "name": "lose-sdk-args",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": "{ ...originalInput, ...structuredClone(executor.options) }",
    "to": "{ ...originalInput, ...structuredClone(executor.options), ...(receipt.intentOperationId ? { args: undefined } : {}) }",
    "target": "retains the exact SDK invocation for the context-only retry with Host owner false",
    "expected": "to deeply equal"
  },
  {
    "name": "lose-sdk-env",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": "{ ...originalInput, ...structuredClone(executor.options) }",
    "to": "{ ...originalInput, ...structuredClone(executor.options), ...(receipt.intentOperationId ? { env: undefined } : {}) }",
    "target": "retains the exact SDK invocation for the context-only retry with Host owner false",
    "expected": "to be"
  },
  {
    "name": "unrelated-host-takes-sdk-source",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": "if (current.creation?.executorRevision || executor.source === 'host') {",
    "to": "if (current.creation?.executorRevision || executor.source === 'host' || receipt.intentOperationId && this.ports.executors.hostExecutorOwner) {",
    "target": "retains the exact SDK invocation for the context-only retry with Host owner true",
    "expected": "to be"
  },
  {
    "name": "ignore-current-host-source",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": "input = await this.ports.executors.sessionExecutorOptions(current, originalInput)",
    "to": "input = { ...originalInput, commandOverride: this.ports.providers.providers.get(current.providerId).catalog.executable }",
    "target": "keeps current target-owned Host authority with a missing private record",
    "expected": "to be"
  },
  {
    "name": "missing-sdk-uses-default",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": ": readContinuityExecutor(current.continuityExecutors, executorRoot) ?? authoredExecutor",
    "to": ": readContinuityExecutor(current.continuityExecutors, executorRoot) ?? authoredExecutor ?? { providerId: current.providerId, executorId: current.executorId, source: 'provider' as const }",
    "target": "keeps an unconfirmed missing SDK source scoped to its exact recovery",
    "expected": "to match object"
  },
  {
    "name": "private-record-blocks-healthy-store",
    "path": "packages/core/src/agent-session-store.ts",
    "from": "continuityExecutors: structuredClone(source.continuityExecutors)",
    "to": "continuityExecutors: Object.values(source.continuityExecutors as Record<string, any>).some(value => Array.isArray(value?.options?.env)) ? (() => { throw new AgentMuxError('Private options unreadable', 'INVALID_AGENT_SESSION_STORE') })() : structuredClone(source.continuityExecutors)",
    "target": "a damaged private root retains healthy Native inspection raw input and another new recovery root",
    "expected": "promise rejected"
  },
  {
    "name": "forget-initial-pending-source",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": "return { ...retainExecutor(value),\n            continuity:",
    "to": "return { ...value,\n            continuity:",
    "target": "captures the SDK source before initial Runtime uncertainty and rechecks the same original operation",
    "expected": "to match object"
  },
  {
    "name": "change-frozen-sdk-options",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": "if (originalExecutor && ['commandOverride', 'args', 'env'].some",
    "to": "if (false && ['commandOverride', 'args', 'env'].some",
    "target": "rejects an altered args on the frozen original request before its success shortcut",
    "expected": "promise resolved"
  },
  {
    "name": "expose-private-options",
    "path": "packages/core/src/agent-session-identity.ts",
    "from": "continuityExecutors: _executors, ",
    "to": "",
    "target": "Hosted and actual compiled CLI consume the original control without exposing private execution options",
    "expected": "not to contain"
  },
  {
    "name": "replay-original-launch-input",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": "...(receipt.launchInput ? { prompt: receipt.launchInput.input.prompt,\n          ...(receipt.launchInput.input.agentMuxNote === undefined ? {} : { agentMuxNote: receipt.launchInput.input.agentMuxNote }) } : {})",
    "to": "...((receipt.launchInput ?? (receipt.intentOperationId ? current.continuityOperations?.[receipt.intentOperationId]?.launchInput : undefined)) ? { prompt: (receipt.launchInput ?? current.continuityOperations![receipt.intentOperationId!]!.launchInput)!.input.prompt, agentMuxNote: (receipt.launchInput ?? current.continuityOperations![receipt.intentOperationId!]!.launchInput)!.input.agentMuxNote } : {})",
    "target": "retains the exact SDK invocation for the context-only retry with Host owner false",
    "expected": "to deeply equal"
  }
]
const receipt = { schema: 'agentmux.session-continuity-executor-proof.v1', passed: false, sourceStable: false, results: [],
  scope: { actual: 'Two safe Native execution sources + FileStore + independent Core restart + Hosted/public compiled CLI',
    controlled: 'SDK invocation overrides, current Host owner, original Start ACK loss and damaged private records', userRuntimeTouched: false,
    publicContract: 'Existing inspect/control owners; no private options in public Session DTO' } }
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
      ...(variant.from ? ['export const AGENTMUX_CONTINUITY_EXECUTOR_MUTANT = ' + JSON.stringify(variant.name)] : [])].join('\n')
    await bundle({ stdin: { contents: source, resolveDir: root, loader: 'ts' }, outfile: file }, variant)
    const args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/session-continuity-executor.config.mts',
      '--reporter=default', '--reporter=json', '--outputFile=' + report]
    if (variant.target) args.push('-t', variant.target)
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_TEST_CONTINUITY_EXECUTOR_ENTRY: pathToFileURL(file).href, AGENTMUX_POST_START_ENTRY: pathToFileURL(file).href, AGENTMUX_TEST_OBJECT_CLI: join(cli, 'bin/amux'), AGENTMUX_TEST_CONTINUITY_EXECUTOR_EVIDENCE: consumerDirectory,
        ...(variant.from ? { AGENTMUX_TEST_CONTINUITY_EXECUTOR_MUTANT: variant.name } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
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
    if (!variant.from) assert.ok(result.code === 0 && tests.numPassedTests === 16 && tests.numPendingTests === 0 && tests.success, 'Actual nonempty continuity execution baseline failed: ' + report)
    else assert.ok(semanticRed, 'Loaded mutation did not produce its business failure: ' + variant.name)
  }
  const consumerNames = ['sdk-no-owner', 'sdk-unrelated-owner', 'independent-core', 'initial-runtime-unknown', 'delay-restart',
    'host-current-missing', 'host-current-malformed', 'unknown-sdk-missing', 'unknown-sdk-malformed', 'damaged-private-healthy-native', 'unknown-start', 'public-cli-hosted']
  receipt.consumerEvidence = []
  for (const name of consumerNames) {
    const path = join(consumerDirectory, name + '.json'), bytes = await readFile(path), proof = JSON.parse(bytes)
    assert.equal(proof.schema, 'agentmux.continuity-executor-consumer.v1'); assert.equal(proof.name, name); assert.equal(proof.userRuntimeTouched, false)
    receipt.consumerEvidence.push({ name, path: relative(root, path), sha256: sha(bytes) })
  }
  receipt.consumers = ['actual-native-sdk-command-args-env', 'actual-native-current-host-owner', 'independent-core-restart', 'runtime-unknown-same-operation', 'delayed-intent-restart', 'healthy-native-damaged-private-record', 'unknown-start-same-operation', 'hosted-original-control', 'actual-compiled-cli-control-inspect'];
  for (const path of inputs.keys()) await bind(path)
  receipt.inputs = Object.fromEntries(inputs); receipt.sourceStable = true; receipt.passed = true; await save()
  await writeFile(join(output, 'latest.json'), JSON.stringify({ receipt: relative(root, join(attempt, 'receipt.json')) }))
  console.log(relative(root, join(attempt, 'receipt.json')))
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; await save(); throw error }
