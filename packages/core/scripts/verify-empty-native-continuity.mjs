// Run the "no native conversation to continue" cases unmutated, then once per loaded mutant.
// The unmutated run must pass every case; each mutant must fail its designated case.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(new URL('../package.json', import.meta.url))
const { build, transform } = require('esbuild')
const config = 'packages/core/test/agent-session-continuity-empty-native.mutation.config.mts'
const focused = process.argv.includes('--startup-observation')
assert.ok(process.argv.slice(2).every(arg => arg === '--startup-observation'), 'Unknown proof option')
const variants = [
  { name: 'candidate' },
  { name: 'startup-no-reuse', target: 'converges equal startup observations without metadata writes' },
  { name: 'startup-explicit-merged', target: 'keeps explicit manual and input identities' },
  { name: 'startup-fence-unconfirmed', target: 'does not confirm reuse when the original observation Store fence failed' },
  { name: 'admission-before-fact', target: 'answers a startup recovery' },
  { name: 'fact-skips-authorization', target: 'still refuses a revoked standing source' },
  { name: 'ignore-candidates', target: 'keeps native candidates awaiting selection' },
  { name: 'ignore-durability', target: 'keeps an unconfirmed identity save' },
  { name: 'stale-absence-at-commit', target: 'committed before the no-conversation receipt' },
  { name: 'stale-absence-fence-retained', target: 'after a rejected no-conversation receipt fence' },
  { name: 'ignore-identity-channel', target: 'whose identity channel Core does not install' },
  { name: 'ignore-run-input', target: 'accepted typed input beyond the handshake' },
  { name: 'ignore-first-prompt', target: 'holds an authored first prompt' },
  { name: 'ignore-initialization', target: 'a native initialization may have created an object' },
  { name: 'ignore-native-activity', target: 'holds a native Hook receipt' },
  { name: 'parked-root-retained', target: 're-decides at the next startup' },
  { name: 'public-pending', target: 'reports the dedicated reason through the public' }
]
// Every case, including the compiled CLI one, must run unmutated: a skipped case proves nothing.
const CASES = 38
const output = join(root, 'packages/core/.tmp/empty-native-continuity')
await mkdir(output, { recursive: true })
const attempt = await mkdtemp(join(output, 'attempt-'))
const receipt = { schema: 'agentmux.empty-native-continuity-proof.v1', passed: false, focused, sources: {}, results: [] }
const sources = ['packages/core/src/agent-session-recovery/continuity-attempt.ts', 'packages/core/src/agent-session-recovery/continuity-policy.ts',
  'packages/core/src/agent-session-recovery/supervisor.ts', 'packages/core/test/agent-session-continuity-empty-native.test.ts',
  'packages/core/test/fixtures/empty-native-observation-worker.ts', 'packages/core/test/agent-session-continuity-empty-native.mutation.config.mts',
  'packages/core/scripts/verify-empty-native-continuity.mjs']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
for (const path of sources) receipt.sources[path] = hash(await readFile(join(root, path)))
const save = () => writeFile(join(attempt, 'receipt.json'), JSON.stringify(receipt, null, 2))
// A private compiled CLI from this checkout's source; the candidate run drives it as the real consumer.
const alias = {}
for (const name of await readdir(join(root, 'packages'))) {
  let pkg; try { pkg = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8')) } catch { continue }
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const entry = typeof value === 'string' ? value : value.import
    if (!entry?.startsWith('./dist/')) continue
    const source = resolve(root, 'packages', name, entry.replace(/^\.\/dist\/(?:src\/)?/, './src/').replace(/\.js$/, '.ts'))
    try { await stat(source); alias[key === '.' ? pkg.name : pkg.name + key.slice(1)] = source } catch {}
  }
}
alias['@agentmux/identity/runtime-source'] = join(root, 'packages/identity/dist/runtime-source.js')
const cli = join(attempt, 'cli')
await mkdir(join(cli, 'bin'), { recursive: true }); await mkdir(join(cli, 'dist'), { recursive: true })
await writeFile(join(cli, 'package.json'), '{"type":"module"}')
await copyFile(join(root, 'packages/core/bin/amux'), join(cli, 'bin/amux'))
const buildOptions = { bundle: true, platform: 'node', format: 'esm',
  target: 'node24', packages: 'external', alias, logLevel: 'warning', plugins: [{ name: 'existing-dependencies', setup(plugin) {
    // External dependencies resolve through their own package exports, as the installed CLI loads them.
    plugin.onResolve({ filter: /^[^./]/ }, async args => {
      if (isBuiltin(args.path) || alias[args.path]) return null
      const resolver = createRequire(args.importer || join(root, 'packages/core/package.json'))
      const parts = args.path.split('/'), name = args.path.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
      for (const directory of resolver.resolve.paths(name) ?? []) {
        try {
          const manifest = join(directory, name, 'package.json'), pkg = JSON.parse(await readFile(manifest, 'utf8'))
          const shape = pkg.exports?.[parts.length ? './' + parts.join('/') : '.'] ?? (parts.length ? undefined : pkg.exports)
          const value = typeof shape === 'string' ? shape : shape?.import ?? shape?.default
          if (typeof value !== 'string') continue
          const entry = resolve(dirname(manifest), value); await stat(entry); return { path: entry, external: true }
        } catch {}
      }
      return { path: resolver.resolve(args.path), external: true }
    })
  } }] }
await build({ ...buildOptions, entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: join(cli, 'dist/agentmux.js') })
const worker = join(cli, 'dist/observation-owner.js')
// Preserve each imported module's own URL in the flattened observer. Otherwise an imported
// executable's is-main guard sees the worker URL and incorrectly runs as a separate CLI.
await build({ ...buildOptions, entryPoints: [join(root, 'packages/core/test/fixtures/empty-native-observation-worker.ts')], outfile: worker,
  plugins: [...buildOptions.plugins, { name: 'original-module-identity', setup(plugin) {
    plugin.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8')
      if (!source.includes('import.meta.url')) return
      const result = await transform(source, { loader: 'ts', format: 'esm', target: 'node24',
        define: { 'import.meta.url': JSON.stringify(pathToFileURL(path).href) } })
      return { contents: result.code, loader: 'js', resolveDir: dirname(path) }
    })
  } }] })
const selected = focused ? variants.filter(variant => ['candidate', 'startup-no-reuse', 'startup-explicit-merged', 'startup-fence-unconfirmed',
  'stale-absence-at-commit', 'stale-absence-fence-retained'].includes(variant.name)) : variants
for (const variant of selected) {
  const report = join(attempt, variant.name + '.json'), loaded = join(attempt, variant.name + '.loaded.ndjson')
  const args = [require.resolve('vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile=' + report]
  if (focused && variant.target) args.push('-t', variant.target)
  const result = await new Promise((yes, no) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      // The private CLI is unmutated; mutants are loaded in-process, so only the public-pending one reaches it.
      env: { ...process.env, AMX_EMPTY_NATIVE_LOADED: loaded, AGENTMUX_TEST_OBJECT_CLI: join(cli, 'bin/amux'),
        AGENTMUX_TEST_EMPTY_NATIVE_OBSERVATION_WORKER: worker, AGENTMUX_TEST_EMPTY_NATIVE_OBSERVATION_RECEIPT: join(attempt, 'owner-processes.json'),
        ...(variant.name === 'candidate' ? {} : { AMX_EMPTY_NATIVE_MUTATION: variant.name }) } })
    let text = ''; child.stdout.on('data', d => { text += d }); child.stderr.on('data', d => { text += d })
    child.once('error', no); child.once('close', code => yes({ code, text }))
  })
  await writeFile(join(attempt, variant.name + '.log'), result.text)
  const tests = JSON.parse(await readFile(report, 'utf8')), assertions = tests.testResults.flatMap(test => test.assertionResults)
  const failed = assertions.filter(test => test.status === 'failed').map(test => test.fullName)
  const loadedMutation = variant.name === 'candidate' ? true : (await readFile(loaded, 'utf8').catch(() => '')).includes(`"mutation":"${variant.name}"`)
  receipt.results.push({ name: variant.name, code: result.code, passed: tests.numPassedTests, failed: tests.numFailedTests, loadedMutation, failures: failed })
  await save()
  if (variant.name === 'candidate') assert.ok(result.code === 0 && tests.numPassedTests === CASES && tests.numFailedTests === 0 && tests.numPendingTests === 0,
    `Unmutated empty-native cases must all run and pass (${tests.numPassedTests}/${CASES}, ${tests.numPendingTests} skipped)`)
  else {
    assert.ok(loadedMutation, 'Mutation was not loaded: ' + variant.name)
    assert.ok(result.code === 1 && failed.some(name => name.includes(variant.target)), 'Loaded mutation did not fail its designated case: ' + variant.name)
  }
}
receipt.processRestart = JSON.parse(await readFile(join(attempt, 'owner-processes.json'), 'utf8'))
assert.equal(new Set(receipt.processRestart.pids).size, 2)
for (const path of sources) assert.equal(hash(await readFile(join(root, path))), receipt.sources[path], 'Proof source changed: ' + path)
receipt.compiledCli = join(cli, 'dist/agentmux.js'); await rm(cli, { recursive: true, force: true })
receipt.passed = true; await save()
console.log('Empty-native continuity proof passed: ' + join(attempt, 'receipt.json'))
