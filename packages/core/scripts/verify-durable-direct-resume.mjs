import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile, copyFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url))
const { build } = require('esbuild')
const output = join(root, 'packages/core/.tmp/durable-direct-resume')
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
for (const path of ['packages/core/src/client.ts', 'packages/core/src/agent-session-registry.ts', 'packages/core/src/agent-session-store.ts',
  'packages/core/src/agent-session-continuity.ts', 'packages/core/src/ctxmux-run-adapter.ts',
  'packages/core/test/durable-direct-resume.test.ts', 'packages/core/test/durable-direct-resume.config.mts',
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
const variants = [
  { name: 'candidate' },
  { name: 'skip-direct-prepare', path: 'packages/core/src/client.ts',
    from: "if (reservation.kind === 'resume' && continuity?.operationId === input.operationId)",
    to: "if (reservation.kind === 'resume' && continuity?.operationId === input.operationId && continuity.trigger !== 'input')",
    target: 'freezes direct native resume input', expected: 'expected undefined to match object' },
  { name: 'forget-unknown-start', path: 'packages/core/src/client.ts',
    from: '          preserveUnconfirmedRun = true\n          throw new AgentMuxError(`Continue start is unconfirmed.',
    to: '          preserveUnconfirmedRun = false\n          throw new AgentMuxError(`Continue start is unconfirmed.',
    target: 'reconciles an applied direct Start', expected: 'expected undefined' },
  { name: 'stop-after-commit-failure', path: 'packages/core/src/client.ts',
    from: "            preserveUnconfirmedRun = true\n            this.pendingLifecycleBindings.set(lifecycleOperationId, hookBinding)\n            if (reservation.kind !== 'resume') throw error",
    to: "            await this.retireUncommittedRun(run.runId)\n            throw error\n            preserveUnconfirmedRun = true\n            this.pendingLifecycleBindings.set(lifecycleOperationId, hookBinding)\n            if (reservation.kind !== 'resume') throw error",
    target: 'keeps acknowledged direct resume work', expected: 'to not have property "error"' },
  { name: 'change-frozen-request', path: 'packages/core/src/client.ts',
    from: 'prior.requestDigest !== requestDigest || !isDeepStrictEqual(prior.nativeTarget, canonical.nativeHandle)',
    to: '!isDeepStrictEqual(prior.nativeTarget, canonical.nativeHandle)',
    target: 'rejects changed direct input', expected: 'promise resolved' },
  { name: 'replace-healthy-operation', path: 'packages/core/src/client.ts',
    from: "      if (oldRun?.state.type === 'running')", to: '      if (false)',
    target: 'serializes same-client original operation', expected: 'promise resolved' },
  { name: 'claim-foreign-lifecycle', path: 'packages/core/src/client.ts',
    from: 'const candidates = runs.filter(run => run.lifecycleOperationId === reservation.operationId)\n    if (!prepared || candidates.length !== 1) return null',
    to: "const candidates = runs.filter(run => run.lifecycleOperationId === 'foreign-operation')\n    if (!prepared || candidates.length !== 1) return null",
    target: 'does not claim a foreign lifecycle', expected: 'promise resolved' },
  { name: 'lose-started-projection', path: 'packages/core/src/client.ts',
    from: 'const durable = await Promise.all((await loadAgentSessionMetadata(this.store)).map(session => this.registry.readStartedResume(session)))',
    to: 'const durable = await loadAgentSessionMetadata(this.store)',
    target: 'keeps acknowledged direct resume work', expected: 'expected' },
  { name: 'freeze-provider-plan', path: 'packages/core/src/client.ts',
    from: 'this.kernel.launchIdentity({ program: plan.command, args: plan.args, env: launchEnvironment })',
    to: "{ program: plan.command, argsDigest: createHash('sha256').update(JSON.stringify(plan.args)).digest('base64url') }",
    target: 'reconciles an applied direct Start', expected: 'promise rejected' },
  { name: 'lose-original-fatal-operation', path: 'packages/core/src/client.ts',
    from: "              if (next.continuity) {\n                const failed = { ...next.continuity, kind: 'unavailable' as const, reason: 'process-exited',",
    to: "              if (false) {\n                const failed = { ...next.continuity, kind: 'unavailable' as const, reason: 'process-exited',",
    target: 'retains the typed original direct-resume fatal operation', expected: 'expected undefined to match object' }
]
const receipt = { schema: 'agentmux.durable-direct-resume-proof.v1', passed: false, sourceStable: false, results: [],
  scope: { actual: 'Private Native Runtime + two input carriers + FileStore/Core direct resume/Hosted/public compiled CLI and fatal regression owner',
    controlled: 'Start/commit ACK loss and rejection, exact prepared-operation contention and unknown input receipt', userRuntimeTouched: false,
    publicContract: 'Existing direct resume and Session inspect; Hosted/Desktop retain the same Core owner; no new capability or Store' } }
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
      ...(variant.from ? ['export const AGENTMUX_DURABLE_RESUME_MUTANT = ' + JSON.stringify(variant.name)] : [])].join('\n')
    await bundle({ stdin: { contents: source, resolveDir: root, loader: 'ts' }, outfile: file }, variant)
    const args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/durable-direct-resume.config.mts',
      '--reporter=default', '--reporter=json', '--outputFile=' + report]
    if (variant.target) args.push('-t', variant.target)
    const result = await new Promise((yes, no) => {
      const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, AGENTMUX_TEST_DURABLE_RESUME_ENTRY: pathToFileURL(file).href, AGENTMUX_POST_START_ENTRY: pathToFileURL(file).href, AGENTMUX_TEST_OBJECT_CLI: join(cli, 'bin/amux'),
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
    if (!variant.from) assert.ok(result.code === 0 && tests.numPassedTests === 34 && tests.success, 'Actual nonempty direct resume baseline failed: ' + report)
    else assert.ok(semanticRed, 'Loaded mutation did not produce its business failure: ' + variant.name)
  }
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
  receipt.inputs = Object.fromEntries(inputs); receipt.sourceStable = true; receipt.passed = true; await save()
  await writeFile(join(output, 'latest.json'), JSON.stringify({ receipt: relative(root, join(attempt, 'receipt.json')) }))
  console.log(relative(root, join(attempt, 'receipt.json')))
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; await save(); throw error }
