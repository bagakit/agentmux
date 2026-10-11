import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url))
const { build } = require('esbuild'), ts = require('typescript')
const sourcePath = 'packages/core/src/client.ts', source = await readFile(join(root, sourcePath), 'utf8')
const output = join(root, 'packages/core/.tmp/post-start-availability')
await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'attempt-'))
const packageRoot = join(attempt, 'package')
await mkdir(join(packageRoot, 'dist'), { recursive: true })
for (const name of ['vendor', 'bin', 'package.json']) await symlink(join(root, 'packages/core', name), join(packageRoot, name))
const sha = data => createHash('sha256').update(data).digest('hex')
const paths = [sourcePath, 'packages/core/test/agent-post-start-availability.test.ts',
  'packages/core/test/agent-post-start-availability.config.mts', 'packages/core/test/agent-start-failure-recovery.test.ts', 'packages/core/scripts/verify-agent-post-start-availability.mjs']
const pins = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha(await readFile(join(root, path)))])))
const before = await pins(), alias = {}
for (const name of await readdir(join(root, 'packages'))) {
  const manifest = join(root, 'packages', name, 'package.json')
  let pkg; try { pkg = JSON.parse(await readFile(manifest, 'utf8')) } catch { continue }
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const entry = typeof value === 'string' ? value : value.import
    if (!entry?.startsWith('./dist/')) continue
    const path = resolve(dirname(manifest), entry.replace(/^\.\/dist\/(?:src\/)?/, './src/').replace(/\.js$/, '.ts'))
    try { await stat(path); alias[key === '.' ? pkg.name : pkg.name + key.slice(1)] = path } catch {}
  }
}
const variants = [
  { name: 'candidate' },
  { name: 'rollback-committed-create',
    from: "      } catch (error) {\n        if (error instanceof AgentMuxError && error.code === AGENT_TERMINAL_HANDSHAKE_FAILED) {",
    to: "      } catch (error) {\n        await this.retireUncommittedRun(run.runId); throw error;\n        if (error instanceof AgentMuxError && error.code === AGENT_TERMINAL_HANDSHAKE_FAILED) {",
    target: 'keeps_committed_create_usable' },
  { name: 'rollback-committed-resume', from: '(persisted || reopening || continuity?.operationId === input.operationId)) {',
    to: '(reopening || continuity?.operationId === input.operationId)) {', target: 'keeps_committed_resume_usable' },
  { name: 'pretend-hook-binding-recovered', from: '            await retained.bindRun(session.run.runId)', to: '            /* Binding was not re-observed. */',
    target: 'after_hook_observation_failure' },
  { name: 'swallow-confirmed-create-exit',
    from: "        if (error instanceof AgentMuxError && error.code === AGENT_TERMINAL_HANDSHAKE_FAILED) {",
    to: "        if (false && error instanceof AgentMuxError && error.code === AGENT_TERMINAL_HANDSHAKE_FAILED) {",
    target: 'exposes generic bounded startup output' },
  { name: 'swallow-confirmed-resume-exit',
    from: "if (!(error instanceof AgentMuxError && error.code === AGENT_TERMINAL_HANDSHAKE_FAILED) &&",
    to: "if (true &&",
    target: 'successful durable rollback' },
  { name: 'swallow-exit-after-commit-recheck', from: '                  await rollbackFailedResume(readError)',
    to: '                  /* The fatal recheck was swallowed. */', target: 'after recovering an applied commit' }
]
const receipt = { schema: 'agentmux.post-start-availability-proof.v1', before, results: [], callers: [], passed: false,
  scope: 'Private real Native processes, Core lifecycle/FileStore/Hook owner and raw input; controlled post-commit Hook/terminal observation failures. No user Runtime or upstream Provider claim.' }
function run(args, env) {
  return new Promise((yes, no) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''; child.stdout.on('data', d => { text += d }); child.stderr.on('data', d => { text += d })
    child.once('error', no); child.once('close', (code, signal) => yes({ code, signal, text }))
  })
}
try {
  for (const variant of variants) {
    const file = join(packageRoot, 'dist', variant.name + '.mjs'), report = join(attempt, variant.name + '.json')
    let transformed
    const compiled = await build({ stdin: { contents: 'export * from "./packages/core/src/index.ts"', resolveDir: root, loader: 'ts' },
      outfile: file, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', alias, metafile: true,
      logLevel: 'warning', plugins: [{ name: 'private-dependencies', setup(plugin) {
        plugin.onResolve({ filter: /^[^./]/ }, async args => {
          if (isBuiltin(args.path) || alias[args.path]) return null
          const resolver = createRequire(args.importer || join(root, 'packages/core/package.json'))
          try { return { path: resolver.resolve(args.path), external: true } }
          catch (error) {
            const parts = args.path.split('/'), name = args.path.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
            for (const directory of resolver.resolve.paths(name) ?? []) {
              try {
                const manifest = join(directory, name, 'package.json'), pkg = JSON.parse(await readFile(manifest, 'utf8'))
                const entry = pkg.exports?.[parts.length ? './' + parts.join('/') : '.']
                const selected = typeof entry === 'string' ? entry : entry?.import
                if (!selected) continue
                const path = resolve(dirname(manifest), selected); await stat(path)
                return { path, external: true }
              } catch {}
            }
            throw error
          }
        })
      } }, ...(variant.from ? [{ name: variant.name, setup(plugin) {
        plugin.onLoad({ filter: /client\.ts$/ }, args => {
          if (args.path !== join(root, sourcePath)) return null
          assert.equal(source.split(variant.from).length, 2, 'Unique owning mutation anchor: ' + variant.name)
          transformed = source.replace(variant.from, variant.to) + '\nexport const AGENTMUX_POST_START_MUTANT = ' + JSON.stringify(variant.name)
          return { contents: transformed, loader: 'ts', resolveDir: dirname(args.path) }
        })
      } }] : [])] })
    assert.ok(Object.keys(compiled.metafile.inputs).some(path => path.endsWith('/src/client.ts')), 'Owning source was not bundled.')
    const args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', 'packages/core/test/agent-post-start-availability.config.mts',
      '--reporter=json', '--outputFile=' + report]
    if (variant.target) args.push('-t', variant.target)
    const result = await run(args, { AGENTMUX_POST_START_ENTRY: pathToFileURL(file).href,
      ...(variant.from ? { AGENTMUX_POST_START_MUTANT: variant.name } : {}) })
    await writeFile(join(attempt, variant.name + '.log'), result.text)
    const tests = JSON.parse(await readFile(report, 'utf8')), assertions = tests.testResults.flatMap(test => test.assertionResults)
    const failed = assertions.filter(test => test.status === 'failed')
    const semanticRed = result.code === 1 && result.signal === null && failed.length > 0 &&
      failed.every(test => test.failureMessages.some(message => /AssertionError|expected .+ to |promise resolved .+ instead of rejecting/su.test(message)))
    receipt.results.push({ name: variant.name, code: result.code, signal: result.signal, total: assertions.filter(test => test.status !== 'pending').length,
      passed: tests.numPassedTests, failed: tests.numFailedTests, semanticRed, bundleSha256: sha(await readFile(file)),
      ...(transformed ? { transformedSha256: sha(transformed) } : {}) })
    await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    if (!variant.from) assert.ok(result.code === 0 && tests.numPassedTests === 12 && tests.success, 'Candidate did not pass four real-process cases and eight authoritative-exit counterexamples: ' + result.text)
    else assert.ok(semanticRed, 'Mutation did not produce owning assertion RED: ' + variant.name + '\n' + result.text)
  }
  for (const [path, methods] of [
    ['apps/desktop/src/main/runtime-controller.ts', ['createAgentWithDelivery', 'ensureAgentContinuity']],
    ['packages/core/src/public-rpc-service.ts', ['createHostAgentWithDelivery', 'refreshAgentSession']]
  ]) {
    const tree = ts.createSourceFile(path, await readFile(join(root, path), 'utf8'), ts.ScriptTarget.Latest, true)
    const calls = []
    const walk = node => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && methods.includes(node.expression.name.text)) {
      calls.push({ method: node.expression.name.text, line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1 })
    }; ts.forEachChild(node, walk) }
    walk(tree); assert.ok(calls.length, 'Production consumer set is empty: ' + path)
    receipt.callers.push({ path, calls })
  }
  assert.deepEqual(await pins(), before, 'Sources changed during qualification.')
  receipt.passed = true
  await writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await writeFile(join(output, 'latest.json'), JSON.stringify({ receipt: relative(root, join(attempt, 'receipt.json')) }) + '\n')
  console.log(relative(root, join(attempt, 'receipt.json')))
} catch (error) {
  await writeFile(join(attempt, 'failure.json'), JSON.stringify({ message: String(error.stack), receipt }, null, 2) + '\n')
  throw error
}
