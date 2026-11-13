import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { copyFile, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), core = join(root, 'packages/core')
const output = resolve(process.argv[2] ?? join(root, '.local/mobile-link-proof'))
const { build } = createRequire(join(core, 'package.json'))('esbuild')
const alias = {}, sourceHashes = new Map(), runs = []
const sha = value => createHash('sha256').update(value).digest('hex')
await mkdir(output, { recursive: true })
for (const name of await readdir(join(root, 'packages'))) {
  let manifest
  try { manifest = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8')) } catch { continue }
  for (const [key, spec] of Object.entries(manifest.exports ?? {})) {
    const target = typeof spec === 'string' ? spec : spec.import
    if (!target?.startsWith('./dist/') || key.includes('*')) continue
    const file = join(root, 'packages', name, target.replace(/^\.\/dist\/(?:src\/)?/u, 'src/').replace(/\.js$/u, '.ts'))
    try { await stat(file); alias[key === '.' ? manifest.name : manifest.name + key.slice(1)] = file } catch {}
  }
}
alias['@agentmux/identity/runtime-source'] = join(root, 'packages/identity/dist/runtime-source.js')

async function compile(mode) {
  const directory = join(output, mode), artifact = join(directory, 'dist/agentmux.js')
  await mkdir(join(directory, 'bin'), { recursive: true }); await mkdir(join(directory, 'dist'), { recursive: true })
  await writeFile(join(directory, 'package.json'), '{"type":"module"}\n')
  await copyFile(join(core, 'bin/amux'), join(directory, 'bin/amux'))
  for (const [source, target] of [['node_modules', 'node_modules'], ['guides', 'dist/guides']]) {
    await symlink(join(core, source), join(directory, target), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
  }
  let mutation = null
  const compiled = await build({ entryPoints: [join(core, 'src/agentmux.ts')], outfile: artifact,
    bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', alias, metafile: true, logLevel: 'warning',
    plugins: [{ name: 'current-mobile-link-cli', setup(plugin) {
      plugin.onResolve({ filter: /^[^./]/ }, async args => {
        if (isBuiltin(args.path) || alias[args.path]) return null
        const resolver = createRequire(args.importer || join(core, 'package.json'))
        // Resolve ESM-only external packages with their import export, preserving their installed code.
        const parts = args.path.split('/'), name = args.path.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift()
        for (const directory of resolver.resolve.paths(name) ?? []) {
          try {
            const manifest = join(directory, name, 'package.json'), pkg = JSON.parse(await readFile(manifest, 'utf8'))
            const spec = pkg.exports?.[parts.length ? './' + parts.join('/') : '.']
            const target = typeof spec === 'string' ? spec : spec?.import
            if (typeof target !== 'string') continue
            const entry = resolve(dirname(manifest), target); await stat(entry)
            return { path: entry, external: true }
          } catch {}
        }
        return { path: resolver.resolve(args.path), external: true }
      })
      plugin.onLoad({ filter: /public-rpc-client\.ts$/ }, async args => {
        if (mode !== 'endpoint-mutant') return null
        const original = await readFile(args.path, 'utf8'), before = 'if (hasConnectionOffer(value)) {'
        assert.equal(original.split(before).length, 2, 'One actual endpoint selection branch')
        const loaded = original.replace(before, 'if (false) {')
        mutation = { path: 'packages/core/src/public-rpc-client.ts', sourceSHA256: sha(original), loadedSHA256: sha(loaded) }
        return { contents: loaded, loader: 'ts', resolveDir: dirname(args.path) }
      })
      plugin.onLoad({ filter: /connection-offer\.ts$/ }, async args => {
        if (mode !== 'legacy-intent-mutant') return null
        const original = await readFile(args.path, 'utf8'), before = "fragment.startsWith('offer=') || "
        assert.equal(original.split(before).length, 2, 'One actual legacy input classification')
        const loaded = original.replace(before, '')
        mutation = { path: 'packages/relay/src/connection-offer.ts', sourceSHA256: sha(original), loadedSHA256: sha(loaded) }
        return { contents: loaded, loader: 'ts', resolveDir: dirname(args.path) }
      })
    } }] })
  const inputs = {}
  for (const file of Object.keys(compiled.metafile.inputs)) {
    const hash = sha(await readFile(resolve(root, file))); inputs[file] = hash
    if (sourceHashes.has(file)) assert.equal(hash, sourceHashes.get(file), 'Same source across private CLI variants: ' + file)
    sourceHashes.set(file, hash)
  }
  for (const required of ['packages/core/src/agentmux.ts', 'packages/core/src/agentmux-cli-commands.ts',
    'packages/core/src/public-rpc-client.ts', 'packages/relay/src/connection-offer.ts']) {
    assert.ok(Object.keys(inputs).some(file => file.endsWith(required)), 'Actual compiled CLI source: ' + required)
  }
  if (mode !== 'candidate') assert.ok(mutation && mutation.sourceSHA256 !== mutation.loadedSHA256)
  await writeFile(join(directory, 'compiled.json'), JSON.stringify({ artifactSHA256: sha(await readFile(artifact)), inputs, mutation }, null, 2))
  return join(directory, 'bin/amux')
}

async function run(name, config, env, filter, expectedTests, red = false, sourceMutant = '') {
  const directory = join(output, name); await mkdir(directory, { recursive: true })
  const report = join(directory, 'tests.json'), loaded = join(directory, 'loaded.jsonl'); await writeFile(loaded, '')
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile=' + report]
  if (filter) args.push('-t', filter)
  const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env,
    AGENTMUX_CONNECTION_LINK_MUTANT: sourceMutant, AGENTMUX_CONNECTION_LINK_LOADED: loaded }, stdio: ['ignore', 'pipe', 'pipe'] })
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
  let log = ''; child.stdout.on('data', value => { log += value }); child.stderr.on('data', value => { log += value })
  const code = await new Promise((yes, no) => { child.once('error', no); child.once('close', yes) }).finally(() => clearTimeout(timer))
  await writeFile(join(directory, 'test.log'), log)
  const result = JSON.parse(await readFile(report, 'utf8'))
  const sources = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(sources.length, 'Nonempty current production source loads')
  for (const source of sources) {
    if (source.mutation) { assert.equal(source.mutation, sourceMutant); assert.notEqual(source.sourceSHA256, source.loadedSHA256) }
    else assert.equal(source.sourceSHA256, source.loadedSHA256, 'Unchanged current source')
    if (sourceHashes.has(source.file)) assert.equal(sourceHashes.get(source.file), source.sourceSHA256)
    sourceHashes.set(source.file, source.sourceSHA256)
  }
  assert.equal(sources.filter(source => source.mutation).length, sourceMutant ? 1 : 0, 'One actual source mutation, or normal sources')
  assert.equal(result.numPassedTests + result.numFailedTests, expectedTests, 'Exact nonempty behavioral case count')
  if (!filter) assert.equal(result.numPendingTests, 0, 'Required consumer evidence cannot skip')
  assert.equal(code, red ? 1 : 0, log)
  assert.equal(result.numFailedTests, red ? 1 : 0)
  if (red) {
    const failures = result.testResults.flatMap(suite => suite.assertionResults).filter(test => test.status === 'failed')
    const expected = name === 'legacy-cli-selection' ? 'previous link format' : name === 'legacy-mobile-selection' ? 'legacy link' : 'same original Host facts'
    assert.equal(failures.length, 1)
    assert.ok(failures[0].fullName.includes(expected) && failures[0].failureMessages.some(message => message.includes('AssertionError')),
      'Mutation fails at its actual consumer assertion, not preparation')
  }
  runs.push({ name, exitCode: code, passed: result.numPassedTests, failed: result.numFailedTests })
  process.stdout.write(name + ': ' + (red ? 'expected assertion red' : 'green') + '\n')
}

const candidate = await compile('candidate'), handoff = join(output, 'host-link.json')
const base = { AGENTMUX_TEST_OBJECT_CLI: candidate, AGENTMUX_TEST_MOBILE_LINK_HANDOFF: handoff }
await run('host', 'apps/host/test/mobile-link-public.config.mts', base, null, 10)
await run('mobile', 'apps/mobile/test/connection-link.config.mts', base, null, 11)
const mutant = await compile('endpoint-mutant')
await run('endpoint-selection', 'apps/host/test/mobile-link-public.config.mts', { ...base, AGENTMUX_TEST_OBJECT_CLI: mutant }, 'same original Host facts', 1, true)
const legacyMutant = await compile('legacy-intent-mutant')
await run('legacy-cli-selection', 'apps/host/test/mobile-link-public.config.mts', { ...base, AGENTMUX_TEST_OBJECT_CLI: legacyMutant }, 'previous link format', 1, true)
await run('legacy-mobile-selection', 'apps/mobile/test/connection-link.config.mts', base, 'legacy link', 1, true, 'legacy-as-absent')
await run('restored-host', 'apps/host/test/mobile-link-public.config.mts', base, 'same original Host facts', 1)
await run('restored-mobile', 'apps/mobile/test/connection-link.config.mts', base, 'same Host link', 1)
await run('restored-legacy-cli', 'apps/host/test/mobile-link-public.config.mts', base, 'previous link format', 1)
await run('restored-legacy-mobile', 'apps/mobile/test/connection-link.config.mts', base, 'legacy link', 1)
for (const [file, hash] of sourceHashes) assert.equal(sha(await readFile(resolve(root, file))), hash, 'Source preserved: ' + file)
const verificationInputs = Object.fromEntries(await Promise.all(['apps/host/scripts/verify-mobile-link.mjs', 'apps/host/test/mobile-link-public.config.mts',
  'apps/host/test/mobile-link.test.ts', 'apps/host/test/mobile-link-label-cache.test.ts', 'apps/mobile/test/connection-link-entry.test.tsx',
  'apps/mobile/test/connection-link.config.mts', 'packages/relay/test/connection-offer.test.ts'].map(async file => [file, sha(await readFile(join(root, file)))])))
const receipt = { passed: true, sourceHashes: Object.fromEntries(sourceHashes), verificationInputs, runs,
  handoffSHA256: sha(await readFile(handoff)),
  boundary: 'Current source Host assembly/public RPC and privately compiled CLI use a real private encrypted Relay. Native process I/O is controlled. The same public URL reaches actual Mobile startup through a controlled outgoing connection port. No user Session/Run, physical phone, installed App or visual acceptance claim.' }
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
process.stdout.write(JSON.stringify({ passed: true, receipt: join(output, 'receipt.json') }) + '\n')
