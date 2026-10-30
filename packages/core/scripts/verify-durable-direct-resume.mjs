import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile, copyFile, rm } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url))
const { build } = require('esbuild')
const resolutionMode = process.argv.includes('--resolution'), dispatchMode = process.argv.includes('--dispatch'), compileOnly = process.argv.includes('--compile-only')
const output = join(root, 'packages/core/.tmp', resolutionMode ? 'prepared-resume-resolution' : dispatchMode ? 'prepared-resume-dispatch' : 'durable-direct-resume')
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
  'packages/core/src/agent-session-recovery/continuity-contract.ts', 'packages/core/src/agent-session-recovery/continuity-policy.ts', 'packages/core/src/ctxmux-run-adapter.ts',
  'packages/core/test/helpers/prepared-resume-fixture.ts', 'packages/core/test/durable-direct-resume.test.ts', 'packages/core/test/durable-direct-resume.config.mts',
  'packages/core/src/prepared-run.ts', 'packages/core/src/terminal-preparation.ts',
  ...(dispatchMode ? ['packages/core/test/prepared-resume-dispatch.test.ts', 'packages/core/test/prepared-resume-dispatch.config.mts',
    'packages/core/test/fixtures/prepared-resume-process.mjs', 'packages/core/scripts/verify-prepared-resume-recovery.mjs'] : []),
  ...(resolutionMode ? ['packages/core/test/prepared-resume-resolution.test.ts', 'packages/core/test/prepared-resume-resolution.config.mts',
    'packages/core/test/fixtures/prepared-resume-process.mjs', 'packages/core/scripts/verify-prepared-resume-recovery.mjs',
    'apps/desktop/test/session-recovery-lost-receipt.config.mts', 'apps/desktop/test/session-recovery-lost-receipt.test.tsx',
    'apps/desktop/scripts/pending-edit-restart-proof.mjs', 'apps/desktop/scripts/prepared-resume-restart-proof.mjs', 'apps/desktop/scripts/verify-workbench-persistence-restart.mjs'] : []),
  'packages/core/test/agent-start-failure-recovery.test.ts', 'apps/desktop/src/main/runtime-controller.ts',
  'packages/core/src/hosted-runtime-service.ts', 'packages/core/src/hosted-client-contract.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/scripts/verify-durable-direct-resume.mjs',
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
// This generated module is built from this checkout, never resolved through another tree's dist.
const identity = join(root, 'packages/identity')
await new Promise((yes, no) => {
  const child = spawn(process.execPath, [join(identity, 'scripts/build.mjs')], { cwd: identity, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: 'inherit' })
  child.once('error', no); child.once('close', code => code === 0 ? yes() : no(new Error('Current identity runtime build failed')))
})
alias['@agentmux/identity/runtime-source'] = join(identity, 'dist/runtime-source.js')
for (const name of await readdir(join(identity, 'src'))) await bind(join(identity, 'src', name))
for (const name of ['build.mjs', 'runtime-bundle.mjs']) await bind(join(identity, 'scripts', name))
const directVariants = [
  { name: 'candidate' },
  { name: 'skip-direct-prepare', path: "packages/core/src/agent-session-recovery/lifecycle.ts",
    from: "      if (reservation.kind === 'resume') {",
    to: "      if (reservation.kind === 'resume' && continuity?.trigger !== 'input') {",
    target: 'freezes direct native resume input', expected: 'Original native resume request is not prepared' },
  { name: 'forget-unknown-start', path: "packages/core/src/agent-session-recovery/lifecycle.ts",
    from: "          preserveUnconfirmedRun = true\n          const failure = new AgentMuxError(`Continue start is unconfirmed.",
    to: "          preserveUnconfirmedRun = false\n          const failure = new AgentMuxError(`Continue start is unconfirmed.",
    target: 'reconciles an applied direct Start', expected: 'expected undefined' },
  { name: 'stop-after-commit-failure', path: "packages/core/src/agent-session-recovery/lifecycle.ts",
    from: "            preserveUnconfirmedRun = true\n            this.ports.hooks.retainBinding(lifecycleOperationId, hookBinding)\n            if (reservation.kind !== 'resume') throw error",
    to: "            await this.ports.runtime.retireUncommittedRun(run.runId)\n            throw error\n            preserveUnconfirmedRun = true\n            this.ports.hooks.retainBinding(lifecycleOperationId, hookBinding)\n            if (reservation.kind !== 'resume') throw error",
    target: 'keeps acknowledged direct resume work', expected: 'to not have property "error"' },
  { name: 'change-frozen-request', path: "packages/core/src/agent-session-recovery/lifecycle.ts",
    from: "prior.requestDigest !== requestDigest || !matchesProviderNativeSessionTarget(prior.nativeTarget, canonical.nativeHandle)",
    to: "!matchesProviderNativeSessionTarget(prior.nativeTarget, canonical.nativeHandle)",
    target: 'rejects changed direct input', expected: 'promise resolved' },
  { name: 'replace-healthy-operation', path: "packages/core/src/agent-session-recovery/lifecycle.ts",
    from: "      if (oldRun?.state.type === 'running' && !restartReservation)", to: "      if (false)",
    target: 'serializes same-client original operation', expected: 'AGENT_SESSION_STILL_RUNNING' },
  { name: 'claim-foreign-lifecycle', path: "packages/core/src/agent-session-recovery/lifecycle.ts",
    from: "if (!prepared || !run || run.lifecycleOperationId !== reservation.operationId) return null",
    to: "if (!prepared || !run || run.lifecycleOperationId !== 'foreign-operation') return null",
    target: 'does not claim a foreign lifecycle', expected: 'promise resolved' },
  { name: 'lose-started-projection', path: 'packages/core/src/client.ts',
    from: 'const durable = await Promise.all((await loadAgentSessionMetadata(this.store)).map(session => this.registry.readStartedResume(session)))',
    to: 'const durable = await loadAgentSessionMetadata(this.store)',
    target: 'keeps acknowledged direct resume work', expected: 'expected' },
  { name: 'freeze-provider-plan', path: "packages/core/src/agent-session-recovery/lifecycle.ts",
    from: "if (continuity.launchInput) continuity.launchInput.launchPlan = identity",
    to: "if (continuity.launchInput) continuity.launchInput.launchPlan = { program: plan.command, argsDigest: createHash('sha256').update(JSON.stringify(plan.args)).digest('base64url') }",
    target: 'reconciles an applied direct Start', expected: 'promise rejected' },
  { name: 'lose-original-fatal-operation', path: "packages/core/src/agent-session-recovery/lifecycle.ts",
    from: "              if (next.continuity) {\n                const failed = { ...next.continuity, kind: 'unavailable' as const, reason: 'process-exited',",
    to: "              if (false) {\n                const failed = { ...next.continuity, kind: 'unavailable' as const, reason: 'process-exited',",
    target: 'retains the typed original direct-resume fatal operation', expected: 'expected undefined to match object' }
]
const dispatchVariants = [
  { name: 'candidate' },
  { name: 'dispatch-without-durable-prepare', path: 'packages/core/src/agent-session-recovery/lifecycle.ts',
    from: ': await this.ports.sessions.registry.prepareResume(reservation, prepared, dispatch)',
    to: ': await (async () => ({ ...reservation, preparedSession: prepared, preparedDispatch: dispatch }))()',
    target: 'freezes direct native resume input', expected: 'Original native resume request is not prepared' },
  { name: 'cross-runtime-dispatch', path: 'packages/core/src/ctxmux-run-adapter.ts',
    from: 'if (expected && (parseCreationRuntime(expected).runtimeId !== this.creationRuntimeIdentity().runtimeId ||',
    to: 'if (false && (parseCreationRuntime(expected).runtimeId !== this.creationRuntimeIdentity().runtimeId ||',
    target: 'different real Runtime after durable prepare', expected: 'promise resolved' },
  { name: 'ignore-retained-full-request', path: 'packages/core/src/ctxmux-run-adapter.ts',
    from: 'if (!isDeepStrictEqual(observed.spec, request)) throw new AgentMuxError(',
    to: 'if (false) throw new AgentMuxError(',
    target: 'mismatching actual RunSpec', expected: 'promise resolved' },
  directVariants.find(variant => variant.name === 'forget-unknown-start')
]
const resolutionVariants = [
  { name: 'candidate' },
  { name: 'missing-is-retired', path: 'packages/core/src/agent-session-recovery/lifecycle.ts',
    from: "const retirement = observed.outcome === 'retired' ? observed : await ports.runtime.kernel.retirePreparedStart(",
    to: "const retirement = true ? { ...observed, outcome: 'retired' as const } : await ports.runtime.kernel.retirePreparedStart(",
    target: 'without old input: file positional', expected: 'to be called 1 times' },
  { name: 'observer-spends-manual-authorization', path: 'packages/core/src/agent-session-recovery/continuity-attempt.ts',
    from: 'return await lifecycle.resolvePreparedResume(input, reservation)',
    to: "return await lifecycle.resolvePreparedResume({ ...input, trigger: 'manual', operationId: reservation.resolution?.receipt.operationId ?? input.operationId }, reservation)",
    target: 'pre-send owner exit', expected: "to be 'pending'" },
  { name: 'never-redrive-admitted-retirement', path: 'packages/core/src/agent-session-recovery/lifecycle.ts',
    from: "      // Durable admission is authorization to redrive this same idempotent fence after a pre-send crash.",
    to: "      if (observed.outcome === 'not_retired') return result(ports.sessions.registry.get(input.agentSessionId))",
    target: 'actual admitted-owner process death', expected: "to be 'resumed'" },
  { name: 'late-original-metadata-overwrites-manual', path: 'packages/core/src/agent-session-store.ts',
    from: 'if (current && next && resolution && current.continuity!.previousRun.runId === current.run.runId) {',
    to: 'if (false && current && next && resolution && current.continuity!.previousRun.runId === current.run.runId) {',
    target: 'pre-send owner exit', expected: 'promise resolved' },
  { name: 'handoff-loses-successor-reservation', path: 'packages/core/src/agent-session-store.ts',
    from: '  return { reservation, session: next }', to: '  return { reservation: current, session: next }',
    target: 'after atomic handoff never resends', expected: 'to be' },
  { name: 'handoff-replays-unknown-input', path: 'packages/core/src/agent-session-recovery/lifecycle.ts',
    from: 'const launch = { program: plan.command, args: plan.args, cwd: current.workspacePath, env: launchEnvironment,',
    to: "const launch = { program: plan.command, args: resolutionHandoff ? [...plan.args, resolutionHandoff.reservation.preparedSession?.continuity?.launchInput?.input.prompt ?? ''] : plan.args, cwd: current.workspacePath, env: launchEnvironment,",
    target: 'without old input: file positional', expected: 'to not include' },
  { name: 'lose-public-resolution-relation', path: 'packages/core/src/control-codec.ts',
    from: '...(result.resolution === undefined ? {} : { resolution: parseResumeResolution(result.resolution) })',
    to: '...{}', target: 'Hosted, public RPC, compiled CLI', expected: 'to match object' }
]
const variants = compileOnly ? [{ name: 'candidate' }] : (resolutionMode ? resolutionVariants : dispatchMode ? dispatchVariants : directVariants).flatMap(variant => variant.from
  ? [variant, { name: 'restore-' + variant.name, target: variant.target }] : [variant])
const receipt = { schema: resolutionMode ? 'agentmux.prepared-resume-resolution-proof.v1' : 'agentmux.durable-direct-resume-proof.v1', passed: false, sourceStable: false, results: [],
  scope: { actual: 'Private Native Runtime + two input carriers + FileStore/Core direct resume/Hosted/public compiled CLI and fatal regression owner',
    controlled: 'Start/commit ACK loss and rejection, exact prepared-operation contention and unknown input receipt', userRuntimeTouched: false,
    publicContract: resolutionMode ? 'Explicit no-input manual resume, exact safe pending/retained/retired correlation, same-intent retry through existing Hosted/RPC/CLI/Desktop; no new top-level API or Store; legacy source gap remains unknown' : 'Existing direct resume and Session inspect; Hosted/Desktop retain the same Core owner; no new capability or Store' } }
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
          const parts = args.path.split('/'), name = args.path.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
          // Node's import branch can differ from require (for example ws named exports).
          for (const directory of resolver.resolve.paths(name) ?? []) {
            try {
              const manifest = join(directory, name, 'package.json'), pkg = JSON.parse(await readFile(manifest, 'utf8'))
              const shape = pkg.exports?.[parts.length ? './' + parts.join('/') : '.'] ?? (parts.length ? undefined : pkg.exports), value = typeof shape === 'string' ? shape : shape?.import
              if (typeof value !== 'string') continue
              entry = resolve(dirname(manifest), value); await stat(entry); await bind(manifest); break
            } catch {}
          }
          entry ??= resolver.resolve(args.path)
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
    const file = join(packageRoot, 'dist', variant.name.startsWith('restore-') ? 'candidate.mjs' : variant.name + '.mjs'), report = join(attempt, variant.name + '.json')
    const source = ['export * from "./packages/core/src/index.ts"',
      'export { AgentMuxControlServer } from "./packages/core/src/public-rpc-server.ts"',
      'export { AgentMuxHostedRuntimeService } from "./packages/core/src/hosted-runtime-service.ts"',
      ...(variant.from ? ['export const AGENTMUX_DURABLE_RESUME_MUTANT = ' + JSON.stringify(variant.name)] : [])].join('\n')
    if (!variant.name.startsWith('restore-')) await bundle({ stdin: { contents: source, resolveDir: root, loader: 'ts' }, outfile: file }, variant)
    if (compileOnly) {
      await writeFile(join(output, 'compile-only.json'), JSON.stringify({ qualified: false, entry: pathToFileURL(file).href, cli: join(cli, 'bin/amux') }))
      console.log('Compile only; no verification result: ' + join(output, 'compile-only.json')); process.exit(0)
    }
    const args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', resolutionMode ? 'packages/core/test/prepared-resume-resolution.config.mts' : dispatchMode ? 'packages/core/test/prepared-resume-dispatch.config.mts' : 'packages/core/test/durable-direct-resume.config.mts',
      '--reporter=default', '--reporter=json', '--outputFile=' + report]
    if (variant.target) args.push('-t', variant.target)
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_TEST_DURABLE_RESUME_ENTRY: pathToFileURL(file).href, AGENTMUX_POST_START_ENTRY: pathToFileURL(file).href, AGENTMUX_TEST_OBJECT_CLI: join(cli, 'bin/amux'),
        ...(resolutionMode ? { AGENTMUX_TEST_RESOLUTION_HANDOFF_RECEIPT: join(attempt, 'handoff-receipt.json') } : {}),
        ...(variant.from ? { AGENTMUX_TEST_DURABLE_RESUME_MUTANT: variant.name } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''; child.stdout.on('data', d => { text += d }); child.stderr.on('data', d => { text += d })
      child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, text }))
    })
    await writeFile(join(attempt, variant.name + '.log'), result.text)
    const tests = JSON.parse(await readFile(report, 'utf8')), assertions = tests.testResults.flatMap(test => test.assertionResults)
    const failed = assertions.filter(test => test.status === 'failed')
    const semanticRed = result.code === 1 && !result.signal && failed.some(test => test.fullName.includes(variant.target) &&
      (test.failureMessages.join('\n') + result.text).includes(variant.expected))
    if (variant.name === 'freeze-provider-plan') {
      assert.match(result.text, /AssertionError: promise rejected/)
      assert.match(result.text, /CONTINUITY_OPERATION_MISMATCH/)
      assert.match(result.text, /launch arguments are unconfirmed/)
    }
    receipt.results.push({ name: variant.name, code: result.code, signal: result.signal, passed: tests.numPassedTests,
      failed: tests.numFailedTests, total: assertions.filter(test => test.status !== 'pending').length, semanticRed,
      bundleSha256: sha(await readFile(file)), failures: failed.map(test => ({ name: test.fullName, messages: test.failureMessages })) })
    await save()
    if (!variant.from) assert.ok(result.code === 0 && tests.numPassedTests > 0 && (variant.target || tests.numPassedTests === (resolutionMode ? 20 : dispatchMode ? 60 : 57)) && tests.success, 'Actual nonempty direct resume baseline failed: ' + report)
    else assert.ok(semanticRed, 'Loaded mutation did not produce its business failure: ' + variant.name)
  }
  if (resolutionMode) await verifyResolutionDesktop()
  const ts = require('typescript'), consumers = []
  const desktop = 'apps/desktop/src/main/runtime-controller.ts', desktopText = await readFile(join(root, desktop), 'utf8')
  const tree = ts.createSourceFile(desktop, desktopText, ts.ScriptTarget.Latest, true)
  function walk(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resumeAgent') {
      const statement = node.arguments[0]
      assert.ok(statement && ts.isObjectLiteralExpression(statement) && statement.properties.some(value => value.name?.getText(tree) === 'operationId'), 'Desktop must pass its original resume operation')
      consumers.push({ path: desktop, call: node.expression.getText(tree), line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1 })
    }
    ts.forEachChild(node, walk)
  }
  walk(tree)
  assert.ok(consumers.length > 0, 'No actual Desktop direct-resume consumer was found')
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
  assert.ok(methods.length > 0 && methods.includes('resumeAgent'), 'The actual Hosted contract must retain its direct resume owner')
  receipt.consumers = consumers
  for (const path of inputs.keys()) await bind(path)
  await rm(packageRoot, { recursive: true, force: true }); await rm(cli, { recursive: true, force: true })
  receipt.cleanup = { privateBundlesRemoved: true, fixtureProcessesAndDirectories: resolutionMode || dispatchMode ? 'verified by exact private Stop/PID and teardown assertions' : 'verified by private fixture teardown assertions' }
  receipt.inputs = Object.fromEntries(inputs); receipt.sourceStable = true; receipt.passed = true; await save()
  await writeFile(join(output, 'latest.json'), JSON.stringify({ receipt: relative(root, join(attempt, 'receipt.json')) }))
  console.log(relative(root, join(attempt, 'receipt.json')))
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; await save(); throw error }


async function verifyResolutionDesktop() {
  const target = 'second manual GUI|fresh explicit intent|actual original Pane'
  receipt.renderer = []
  for (const mutation of [null, 'lose-pending-resolution-id', 'reuse-handed-off-resolution-id']) {
    for (const restored of mutation ? [false, true] : [false]) {
      const name = restored ? 'restore-' + mutation : mutation ?? 'candidate'
      const report = join(attempt, 'renderer-' + name + '.json')
      const result = await new Promise((yes, no) => {
        const env = { ...process.env, AGENTMUX_TEST_RESOLUTION_HANDOFF_RECEIPT: join(attempt, 'handoff-receipt.json') }; delete env.AGENTMUX_DESKTOP_RECOVERY_MUTATION
        if (mutation && !restored) env.AGENTMUX_DESKTOP_RECOVERY_MUTATION = mutation
        const child = spawn(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/session-recovery-lost-receipt.config.mts',
          '-t', target, '--reporter=default', '--reporter=json', '--outputFile=' + report], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
        let text = ''; child.stdout.on('data', data => { text += data }); child.stderr.on('data', data => { text += data })
        child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, text }))
      })
      await writeFile(join(attempt, 'renderer-' + name + '.log'), result.text)
      const tests = JSON.parse(await readFile(report, 'utf8')), assertions = tests.testResults.flatMap(test => test.assertionResults), failures = assertions.filter(test => test.status === 'failed')
      const actualMutation = mutation && !restored
      const semanticRed = result.code === 1 && !result.signal && result.text.includes('loaded-desktop-recovery-mutation=' + mutation) && failures.some(test =>
        test.fullName.includes(mutation === 'lose-pending-resolution-id' ? 'second manual GUI' : 'fresh explicit intent') && test.failureMessages.join(' ').includes('AssertionError'))
      receipt.renderer.push({ name, code: result.code, signal: result.signal, passed: tests.numPassedTests, failed: tests.numFailedTests, semanticRed, failures })
      await save()
      assert.ok(actualMutation ? semanticRed : result.code === 0 && tests.success && tests.numPassedTests === 3, 'Current Renderer recovery proof failed: ' + name)
    }
  }
  let desktopReceipt = process.env.AGENTMUX_TEST_PREPARED_RESUME_DESKTOP_RECEIPT
  if (!desktopReceipt) {
    desktopReceipt = join(attempt, 'desktop.json')
    await new Promise((yes, no) => {
      const child = spawn(process.execPath, [join(root, 'apps/desktop/scripts/verify-workbench-persistence-restart.mjs'), '--prepared-resume', '--receipt-path=' + desktopReceipt],
        { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: 'inherit' })
      child.once('error', no); child.once('close', (code, signal) => code === 0 && !signal ? yes() : no(new Error('Private current-source Desktop restart proof failed')))
    })
  }
  desktopReceipt = resolve(desktopReceipt)
  const proof = JSON.parse(await readFile(desktopReceipt, 'utf8')), buildPath = proof.buildReceipt, build = JSON.parse(await readFile(buildPath, 'utf8'))
  const summaryPath = join(dirname(buildPath), 'summary.json'), summary = JSON.parse(await readFile(summaryPath, 'utf8'))
  assert.ok(proof.passed && proof.preparedResume.passed && summary.passed && summary.qualifiedScope === 'prepared-resume')
  assert.equal(resolve(summary.receiptPath), desktopReceipt); assert.equal(resolve(summary.buildReceiptPath), resolve(buildPath))
  assert.ok(proof.firstPid !== proof.secondPid && proof.before.split === 70 && proof.after.split === 70)
  assert.ok(proof.explicitProbe.originalAndNewContextConfirmed && proof.explicitProbe.unknownInputAbsent && proof.inputRequests === 2)
  assert.ok(proof.originalHandshake.acknowledged && proof.originalHandshake.run.runId === proof.nativeRun.runId)
  assert.ok(proof.nativeRun.acceptedInputBytes >= proof.originalHandshake.inputByteRange.endByte)
  assert.equal(proof.afterRun.acceptedInputBytes, proof.nativeRun.acceptedInputBytes)
  assert.ok(proof.explicitPromptReceipt.acknowledged && proof.explicitPromptReceipt.intent.admissionIntent.kind === 'manual-actor')
  assert.equal(proof.explicitPromptReceipt.inputKey.expectedRun.runId, proof.nativeRun.runId)
  assert.equal(proof.explicitPromptReceipt.submissionId, proof.explicitProbe.operationId)
  assert.ok(proof.httpRequests.length >= proof.totalTransportRequests && proof.httpRequests.every(request => request.unknownInputPresent === false))
  assert.ok(proof.cleanup.privateServiceAbsent && proof.cleanup.privateHostExited && proof.cleanup.exactNativeStopped && proof.cleanup.privateProcessesReaped && proof.cleanup.privateRootRemoved && build.privateRootRemoved)
  assert.deepEqual(build.sharedSourceChangesDuringProof, [])
  assert.ok(build.privateWindowObservations.length === 2 && build.privateWindowObservations.every(window => window.focusable === false && window.focusedEver === false))
  const commands = build.commands ?? []
  for (const name of ['private-core-build', 'private-host-build', 'private-desktop-build']) assert.ok(commands.some(command => command.name === name && command.exitCode === 0), 'Current-source typing/build receipt: ' + name)
  // These two scripts orchestrate this oracle; they are not compiler inputs to the already qualified App.
  const orchestration = new Set(['packages/core/scripts/verify-durable-direct-resume.mjs', 'packages/core/scripts/verify-prepared-resume-recovery.mjs'])
  assert.ok(Object.keys(build.sources).length > 100 && Object.keys(build.compiled).length > 100)
  for (const [path, hash] of Object.entries(build.sources)) if (!orchestration.has(path)) {
    await bind(path); assert.equal(inputs.get(resolve(root, path)), hash, 'The saved Desktop proof consumed another candidate: ' + path)
  }
  for (const path of ['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/SessionPane.tsx', 'apps/desktop/src/renderer/src/lib/continuity-presentation.ts']) {
    assert.equal(build.desktopSourceClosure[path], build.sources[path])
  }
  receipt.desktop = { receipt: desktopReceipt, receiptSHA256: sha(await readFile(desktopReceipt)), buildReceipt: buildPath,
    buildSHA256: sha(await readFile(buildPath)), summarySHA256: sha(await readFile(summaryPath)), compiled: build.compiled,
    consumedExactPriorProof: Boolean(process.env.AGENTMUX_TEST_PREPARED_RESUME_DESKTOP_RECEIPT), scope: proof.scope }
  await save()
}
