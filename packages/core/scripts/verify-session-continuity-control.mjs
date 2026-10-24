import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile, copyFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url))
const { build } = require('esbuild')
const output = join(root, 'packages/core/.tmp/session-continuity-control')
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
for (const file of ['packages/core/src/client.ts', 'packages/core/src/agent-session-recovery/service.ts', 'packages/core/src/agent-session-recovery/continuity-attempt.ts', 'packages/core/src/agent-session-recovery/lifecycle.ts', 'packages/core/src/agent-session-recovery/reconciliation.ts', 'packages/core/src/agent-session-recovery/ports.ts', 'packages/core/src/agent-session-recovery.ts', 'packages/core/src/agent-runtime-helpers.ts', 'packages/core/src/agent-session-recovery/control-contract.ts',
  'packages/core/src/agent-session-recovery/continuity-contract.ts', 'packages/core/src/agent-session-recovery/continuity-policy.ts', 'packages/core/src/agent-session-store.ts',
  'packages/core/src/hosted-client-contract.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-runtime-service.ts',
  'packages/core/src/public-rpc.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/rpc-native-codec.ts',
  'packages/core/src/agentmux-cli-commands.ts', 'packages/core/src/agentmux-cli-module-skills.ts',
  'packages/core/test/session-continuity-control.test.ts', 'packages/core/test/session-continuity-control.config.mts',
  'packages/core/test/helpers/continuity-control-process.mjs', 'packages/core/scripts/verify-session-continuity-control.mjs',
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
    "name": "reject-native-locator-enrichment",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": "!root.nativeTarget || !matchesProviderNativeSessionTarget(root.nativeTarget, current.nativeHandle)",
    "to": "!root.nativeTarget || !isDeepStrictEqual(root.nativeTarget, current.nativeHandle)",
    "target": "accepts retained canonical locator enrichment while rejecting changed or lost known native targets",
    "expected": "promise rejected"
  },
  {
    "name": "accept-changed-attempt-locator",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": "!matchesProviderNativeSessionTarget(active.nativeTarget, current.nativeHandle)",
    "to": "false",
    "target": "accepts retained canonical locator enrichment while rejecting changed or lost known native targets",
    "expected": "promise resolved"
  },
  {
    "name": "changed-control-body",
    "path": 'packages/core/src/agent-session-recovery/control-contract.ts',
    "from": "a.action === b.action && a.additionalAttempts === b.additionalAttempts",
    "to": "true",
    "target": "rejects changed action budget root and Run for an accepted operation while preserving its original result",
    "expected": "promise resolved"
  },
  {
    "name": "forget-retired-receipt",
    "path": "packages/core/src/agent-session-store.ts",
    "from": "retirement?.continuityControlReceipts?.[operationId]",
    "to": "undefined",
    "target": "preserves a control receipt after authoritative Stop and through a fresh FileStore reader",
    "expected": "promise rejected"
  },
  {
    "name": "lose-late-control",
    "path": "packages/core/src/agent-session-store.ts",
    "from": "supervision: structuredClone(previousRoot.supervision)",
    "to": "supervision: structuredClone(next.continuity.supervision)",
    "target": "cancel after claim preserves the healthy admitted Run and its receipt through late original commit",
    "expected": "promise rejected"
  },
  {
    "name": "stale-run-before-receipt",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": "if (original) return original",
    "to": "if (original && original.state === 'active' && sameRun(original.session.run, input.expectedRun)) return original",
    "target": "continues a zero-budget paused intent with one new context-only attempt and one immutable receipt",
    "expected": "promise rejected"
  },
  {
    "name": "reset-control-attempts",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": "next.attemptLimit = limit; next.phase = 'observing'",
    "to": "next.attemptCount = 1; next.attemptLimit = limit; next.phase = 'observing'",
    "target": "extends the original total limit without resetting attempts after multiple confirmed failures",
    "expected": "expected 1 to be 2"
  },
  {
    "name": "continue-closed-control",
    "path": "packages/core/src/agent-session-recovery/service.ts",
    "from": "} else if (input.action === 'continue') {",
    "to": "} else if (input.action === 'continue') { supervision.phase = 'paused'; delete supervision.cancellation;",
    "target": "keeps cancelled and normally settled intents closed to new continuation controls",
    "expected": "promise resolved"
  },
  {
    "name": "wait-for-native-before-cancel",
    "path": "packages/core/src/hosted-client-contract.ts",
    "from": "controlAgentContinuity: 'owner'",
    "to": "controlAgentContinuity: 'runtime'",
    "target": "Hosted cancellation works without Native readiness and reader disposal does not cancel the durable intent",
    "expected": "promise rejected"
  },
  {
    "name": "accept-foreign-control-reply",
    "path": 'packages/core/src/agent-session-recovery/control-contract.ts',
    "from": "if (!sameAgentContinuityControlInput(receipt.request, input)) invalid()",
    "to": "if (false) invalid()",
    "target": "rejects a wire reply for another immutable control packet",
    "expected": "promise resolved"
  },
  {
    "name": "public-control-changes-operation",
    "path": "packages/core/src/public-rpc-service.ts",
    "from": ": await selected.client.controlAgentContinuity(input, { ...this.inputCallContext(context),",
    "to": ": await selected.client.controlAgentContinuity({ ...input, operationId: 'shadow-control' }, { ...this.inputCallContext(context),",
    "target": "keeps healthy raw capability while Hosted and the actual public CLI consume the same control owner",
    "expected": "expected 1 to be +0"
  }
]
const receipt = { schema: 'agentmux.session-continuity-control-proof.v1', passed: false, sourceStable: false, results: [],
  scope: { actual: 'Private Native + FileStore/two Core readers/new process + Hosted/public compiled CLI control',
    controlled: 'Original control ACK loss, exact claim cancellation, pending Stop, retirement, immutable request and explicit budget', userRuntimeTouched: false,
    publicContract: 'One Core control owner, finite Hosted method and native agent.continuity.control with generated actual CLI' } }
const save = () => writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2))
await save()
try {
  const browserFile = join(attempt, 'browser-control.mjs')
  const browser = await build({ stdin: { contents: 'export { parseAgentContinuityControlInput, sameAgentContinuityControlInput } from "@agentmux/core/agent-session-recovery"',
    resolveDir: join(root, 'packages/core'), loader: 'js' }, outfile: browserFile,
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022', metafile: true, logLevel: 'warning' })
  for (const path of Object.keys(browser.metafile.inputs)) if (path !== '<stdin>') await bind(path)
  const browserControl = await import(pathToFileURL(browserFile).href)
  const browserPacket = { agentSessionId: 'browser-session', intentOperationId: 'browser-intent', expectedRun: { runId: 'browser-run' }, operationId: 'browser-control', action: 'continue', additionalAttempts: 1 }
  assert.deepEqual(browserControl.parseAgentContinuityControlInput(browserPacket), browserPacket)
  assert.ok(browserControl.sameAgentContinuityControlInput(browserPacket, browserControl.parseAgentContinuityControlInput(browserPacket)))
  assert.throws(() => browserControl.parseAgentContinuityControlInput({ ...browserPacket, additionalAttempts: 0 }))
  receipt.browser = { publicSubpath: '@agentmux/core/agent-session-recovery', actualBrowserBundle: true,
    parsedOriginalPacket: true, rejectedInvalidBudget: true, bundleSha256: sha(await readFile(browserFile)) }
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
      ...(variant.from ? ['export const AGENTMUX_CONTINUITY_CONTROL_MUTANT = ' + JSON.stringify(variant.name)] : [])].join('\n')
    await bundle({ stdin: { contents: source, resolveDir: root, loader: 'ts' }, outfile: file }, variant)
    const args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/session-continuity-control.config.mts',
      '--reporter=default', '--reporter=json', '--outputFile=' + report]
    if (variant.target) args.push('-t', variant.target)
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_TEST_CONTINUITY_CONTROL_ENTRY: pathToFileURL(file).href, AGENTMUX_POST_START_ENTRY: pathToFileURL(file).href, AGENTMUX_TEST_OBJECT_CLI: join(cli, 'bin/amux'),
        ...(variant.from ? { AGENTMUX_TEST_CONTINUITY_CONTROL_MUTANT: variant.name } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
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
    if (!variant.from) assert.ok(result.code === 0 && tests.numPassedTests === 23 && tests.numPendingTests === 0 && tests.success, 'Actual nonempty continuity control baseline failed: ' + report)
    else assert.ok(semanticRed, 'Loaded mutation did not produce its business failure: ' + variant.name)
  }
  for (const path of inputs.keys()) await bind(path)
  receipt.inputs = Object.fromEntries(inputs); receipt.sourceStable = true; receipt.passed = true; await save()
  await writeFile(join(output, 'latest.json'), JSON.stringify({ receipt: relative(root, join(attempt, 'receipt.json')) }))
  console.log(relative(root, join(attempt, 'receipt.json')))
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; await save(); throw error }
