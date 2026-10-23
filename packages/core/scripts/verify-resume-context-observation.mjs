import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile, copyFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url))
const { build } = require('esbuild')
const output = join(root, 'packages/core/.tmp/resume-context-observation')
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
for (const path of ['packages/core/src/client.ts', 'packages/core/src/agent-session-recovery/service.ts', 'packages/core/src/agent-session-recovery/ports.ts', 'packages/core/src/agent-session-recovery.ts', 'packages/core/src/agent-runtime-helpers.ts', 'packages/core/src/hook-normalizer.ts', 'packages/core/src/types.ts', 'packages/core/src/providers/codex.ts',
  'packages/core/src/agent-native-locator.ts', 'packages/core/src/agent-session-store.ts', 'packages/core/src/agent-session-recovery/supervisor.ts', 'packages/core/src/agent-session-recovery/continuity-contract.ts', 'packages/core/src/agent-session-recovery/continuity-policy.ts',
  'packages/core/test/resume-context-observation.test.ts', 'packages/core/test/resume-context-observation.config.mts',
  'packages/core/test/helpers/object-cli-rpc.ts', 'packages/core/src/hosted-client-contract.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/scripts/verify-resume-context-observation.mjs',
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
  { name: 'delegate-known-witness-normalization', path: 'packages/core/src/client.ts',
    from: 'witnessTargetMismatch ? normalizeNativeHook(provider.hook, envelope, context) : provider.normalizeHook(envelope, context)', to: 'provider.normalizeHook(envelope, context)',
    target: 'keeps an exact conflicting witness neutral before a custom Provider can declare main activity, readiness or cancellation', expected: 'to match object' },
  { name: 'reject-waiting-input-enrichment', path: 'packages/core/src/agent-session-recovery/input.ts',
    from: '!matchesProviderNativeSessionTarget(operation.nativeTarget, session.nativeHandle)', to: '!isDeepStrictEqual(session.nativeHandle, operation.nativeTarget)',
    target: 'delivers the original waiting post-launch input once after Hook locator enrichment and exact native readiness', expected: "expected 'superseded' to be 'accepted'" },
  { name: 'pretend-unknown-input-acknowledged', path: 'packages/core/src/agent-session-recovery/input.ts',
    from: 'const accepted = claim?.acknowledged &&', to: 'const accepted = Boolean(claim) &&',
    target: 'observes the same claimed post-launch input key after an actual Native Input ACK loss without replaying its bytes', expected: "expected 'accepted' to be 'unknown'" },
  { name: 'overwrite-known-witness-locator', path: 'packages/core/src/client.ts',
    from: '!matchesProviderNativeSessionTarget(session.nativeHandle, witness.handle) && !matchesProviderNativeSessionTarget(witness.handle, session.nativeHandle)', to: 'witness.handle.sessionId !== session.nativeHandle.sessionId',
    target: 'preserves a known canonical locator when its exact Native witness reports another locator: codex', expected: 'to deeply equal' },
  { name: 'forget-known-partial-locator', path: 'packages/core/src/client.ts',
    from: 'matchesProviderNativeSessionTarget(promotedHandle, current.nativeHandle) && promotedHandle.transcriptPath === undefined &&', to: 'false &&',
    target: 'retains a known locator and usable Hook context when a verified witness reports its same identity, with locator=false', expected: 'to deeply equal' },
  { name: 'trust-conflicting-hook-main', path: 'packages/core/src/hook-normalizer.ts',
    from: 'if (context.protectedNativeTarget === true && context.nativeTargetMismatch === true)', to: 'if (false)',
    target: 'preserves a known canonical locator when its exact Native witness reports another locator: explicit', expected: 'to match object' },
  { name: 'reject-direct-locator-enrichment', path: "packages/core/src/agent-session-recovery/service.ts",
    from: "!matchesProviderNativeSessionTarget(prior.nativeTarget, canonical.nativeHandle)", to: "!isDeepStrictEqual(prior.nativeTarget, canonical.nativeHandle)",
    target: 'reads the original explicit resume receipt after a verified first locator enrichment without replaying Start or input', expected: 'promise rejected' },
  { name: 'replace-frozen-direct-request', path: "packages/core/src/agent-session-recovery/service.ts",
    from: "prior.requestDigest !== requestDigest || !matchesProviderNativeSessionTarget", to: "!matchesProviderNativeSessionTarget",
    target: 'reads the original explicit resume receipt after a verified first locator enrichment without replaying Start or input', expected: 'promise resolved' },
  { name: 'forget-native-resume-source', path: 'packages/core/src/providers/codex.ts',
    from: " && payload.source === 'resume'", to: '',
    target: 'withholds resume context from other Codex sources while retaining the original main Hook receipt', expected: 'to be undefined' },
  { name: 'trust-flattened-source', path: 'packages/core/src/hook-normalizer.ts',
    from: 'specification.continuity?.(eventName, rawPayload, context)', to: 'specification.continuity?.(eventName, payload, context)',
    target: 'requires the native resume source on the original payload rather than a flattened auxiliary object', expected: 'to be undefined' },
  { name: 'retain-provider-context-alias', path: 'packages/core/src/hook-normalizer.ts',
    from: "continuity = { kind, nativeSessionId }", to: 'continuity = fact',
    target: 'snapshots context evidence before a Provider reuses its return object as cancellation', expected: "to match object { hookReceiptId: 'frozen-context'" },
  { name: 'retain-provider-cancellation-alias', path: 'packages/core/src/hook-normalizer.ts',
    from: 'continuity = { kind, scope, nativeSessionId, nativeOperationId }', to: 'continuity = fact',
    target: 'snapshots original cancellation identity before a Provider reuses its return object as context', expected: 'to match object' },
  { name: 'forget-active-attempt-run', path: 'packages/core/src/client.ts',
    from: '!attempt?.newRun || !sameRun(attempt.newRun, current.run) ||', to: '!attempt?.newRun ||',
    target: 'does not attribute a valid Hook to a superseded root attempt', expected: 'to be undefined' },
  { name: 'replace-native-cancel-identity', path: 'packages/core/src/client.ts',
    from: 'operationId: continuity.nativeOperationId, hookReceiptId:', to: "operationId: 'another-operation', hookReceiptId:",
    target: 'uses a second explicit native protocol to persist cancellation and keep it above later context evidence', expected: 'to match object' },
  { name: 'reject-late-explicit-cancel', path: 'packages/core/src/client.ts',
    from: "if (supervision.phase === 'settled' && supervision.reason !== 'context-observed') continue", to: "if (supervision.phase === 'settled') continue",
    target: 'keeps an exact explicit cancellation authoritative after context observation already settled', expected: "to match object { phase: 'cancelled'" },
  { name: 'reject-first-locator-enrichment', path: 'packages/core/src/agent-native-locator.ts',
    from: '(original.transcriptPath === undefined || original.transcriptPath === observed.transcriptPath)', to: '(original.transcriptPath === observed.transcriptPath)',
    target: 'accepts a verified first locator enrichment without changing the frozen native target or first input', expected: "to match object { phase: 'settled'" },
  { name: 'allow-known-locator-change', path: 'packages/core/src/agent-native-locator.ts',
    from: '(original.transcriptPath === undefined || original.transcriptPath === observed.transcriptPath)', to: 'true',
    target: 'withholds recovery facts for a changed known native target: path-change', expected: 'to be undefined' },
  { name: 'reject-enriched-store-claim', path: 'packages/core/src/agent-session-store.ts',
    from: '!matchesProviderNativeSessionTarget(root.nativeTarget, reservation.preparedSession!.nativeHandle)', to: '!isDeepStrictEqual(root.nativeTarget, reservation.preparedSession!.nativeHandle)',
    target: 'retains the same native intent through locator enrichment and an exact failed Run retry', expected: 'attemptCount: 2' }
]
const receipt = { schema: 'agentmux.resume-context-observation-proof.v1', passed: false, sourceStable: false, results: [],
  scope: { actual: 'Original authenticated Hook HTTP + private Native process + FileStore + Hosted and compiled inspect/refresh CLI',
    controlled: 'Two machine Hook shapes, verified current PID/native identity, contribution alias reuse, exact subject/Run/token and locator enrichment', userRuntimeTouched: false,
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
      ...(variant.from ? ['export const AGENTMUX_RESUME_CONTEXT_MUTANT = ' + JSON.stringify(variant.name)] : [])].join('\n')
    await bundle({ stdin: { contents: source, resolveDir: root, loader: 'ts' }, outfile: file }, variant)
    const args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/resume-context-observation.config.mts',
      '--reporter=default', '--reporter=json', '--outputFile=' + report]
    if (variant.target) args.push('-t', variant.target)
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_TEST_RESUME_CONTEXT_ENTRY: pathToFileURL(file).href, AGENTMUX_TEST_OBJECT_CLI: join(cli, 'bin/amux'),
        ...(variant.from ? { AGENTMUX_TEST_RESUME_CONTEXT_MUTANT: variant.name } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
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
    if (!variant.from) assert.ok(result.code === 0 && tests.numPassedTests === 33 && tests.success, 'Actual nonempty Hook continuity baseline failed: ' + report)
    else assert.ok(semanticRed, 'Loaded mutation did not produce its business failure: ' + variant.name)
  }
  const ts = require('typescript'), consumers = []
  for (const [path, names] of [['packages/core/src/client.ts', ['acceptHookEvent', 'normalizeHook']],
    ['packages/core/src/agent-provider.ts', ['normalizeNativeHook']],
    ['packages/core/src/public-rpc-service.ts', ['statusAgent', 'refreshAgentSession']]]) {
    await bind(path)
    const source = await readFile(join(root, path), 'utf8'), tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
    const counts = Object.fromEntries(names.map(name => [name, 0]))
    function walk(node) {
      if (ts.isCallExpression(node)) {
        const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : ''
        if (name in counts) { counts[name]++; consumers.push({ path, name, line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1 }) }
      }
      ts.forEachChild(node, walk)
    }
    walk(tree)
    for (const name of names) assert.ok(counts[name] > 0, 'The actual consumer must remain present: ' + path + '/' + name)
  }
  const registrationPath = 'packages/core/src/hosted-client-contract.ts'
  await bind(registrationPath)
  const contract = ts.createSourceFile(registrationPath, await readFile(join(root, registrationPath), 'utf8'), ts.ScriptTarget.Latest, true), methods = []
  function registered(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(contract) === 'AGENTMUX_HOSTED_METHODS') {
      let value = node.initializer
      while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression
      assert.ok(value && ts.isArrayLiteralExpression(value), 'The actual Hosted registration must remain inspectable')
      for (const entry of value.elements) if (ts.isStringLiteral(entry)) methods.push(entry.text)
    }
    ts.forEachChild(node, registered)
  }
  registered(contract)
  assert.ok(methods.length > 0 && methods.includes('refreshAgentSession') && methods.includes('statusAgent'), 'The registered Hosted read consumers must remain present')
  receipt.consumers = consumers; receipt.hostedMethods = methods
  for (const path of inputs.keys()) await bind(path)
  receipt.inputs = Object.fromEntries(inputs); receipt.sourceStable = true; receipt.passed = true; await save()
  await writeFile(join(output, 'latest.json'), JSON.stringify({ receipt: relative(root, join(attempt, 'receipt.json')) }))
  console.log(relative(root, join(attempt, 'receipt.json')))
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; await save(); throw error }
