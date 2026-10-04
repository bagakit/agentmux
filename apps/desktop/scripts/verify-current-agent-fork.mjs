import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../../..'), run = promisify(execFile)
const { build } = createRequire(join(root, 'packages/core/package.json'))('esbuild')
const evidence = process.argv[2] ? resolve(root, process.argv[2]) : join(root, '.bagakit/feature-tracker/features/f-2qy8fxfgc/artifacts/core-verification')
const temporary = await mkdtemp(join(tmpdir(), 'amx-fork-gate-'))
const sha = data => createHash('sha256').update(data).digest('hex')
const workspaceAliases = {}
for (const name of ['core', 'demand', 'relay']) {
  const manifest = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'))
  for (const [key, value] of Object.entries(manifest.exports)) workspaceAliases[key === '.' ? '@agentmux/' + name : '@agentmux/' + name + '/' + key.slice(2)] =
    join(root, 'packages', name, value.import.replace('./dist/', name === 'demand' ? './' : './src/').replace(/\.js$/, '.ts'))
}
const receipt = { passed: false, source: 'current production Provider/Core/space owner plus private actual CLI',
  userRuntimeTouched: false, sourceCandidates: {}, mutations: [], isolation: [
    'Two different native protocol file/launch fixtures use actual Provider builders in a real private ctxmux PTY. No authenticated upstream Agent request is sent.',
    'Managed native hook config installation is isolated in the fixture. Core creation, environment, reservation, Session store, guide, input and Runtime controls are actual source.',
    'The original Renderer spatial business owner is consumed through a real public service, Client and CLI. No replacement creation or position owner is introduced.',
    'Spatial save consumes the actual Desktop graph converter and Core filesystem spatial owner; an independent process rereads both native Session store and exact durable topology. Full Electron presentation is consumed by the subsequent UI gate.',
    'File business is not exercised; the production spatial owner and its actual source imports remain in the loaded graph.'
  ] }
await mkdir(evidence, { recursive: true })
receipt.verificationInputs = Object.fromEntries(await Promise.all([
  'apps/desktop/test/current-agent-fork.test.ts', 'apps/desktop/scripts/fixtures/current-agent-fork/vitest.config.mts',
  'apps/desktop/scripts/verify-current-agent-fork.mjs', 'packages/core/test/current-fork-lifecycle.test.ts',
  'packages/core/test/fixtures/current-fork-lifecycle/vitest.owning.config.mts',
  ...['core', 'demand', 'relay', 'client-ui'].map(name => 'packages/' + name + '/package.json')
].map(async path => [path, sha(await readFile(join(root, path)))])))
try {
  const sourcePlugin = { name: 'fork-current-workspace-source', setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
      const file = relative(root, args.path)
      if (!/^packages\/(?:core|demand|relay)\/src\//.test(file)) return
      const code = await readFile(args.path, 'utf8'), hash = sha(code)
      if (receipt.sourceCandidates[file]) assert.equal(receipt.sourceCandidates[file], hash, 'Unchanged bundled source: ' + file)
      receipt.sourceCandidates[file] = hash
      return { contents: code, loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js' }
    })
  } }
  await mkdir(join(temporary, 'bin')); await mkdir(join(temporary, 'dist'))
  await mkdir(join(temporary, 'node_modules'))
  const linked = new Set()
  for (const name of ['core', 'demand', 'relay']) {
    const manifest = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'))
    for (const dependency of [...Object.keys(manifest.dependencies ?? {}), ...(name === 'core' ? ['@ctxmux/sdk'] : [])]) {
      if (dependency.startsWith('@agentmux/') || linked.has(dependency)) continue
      if (dependency.startsWith('@')) await mkdir(join(temporary, 'node_modules', dependency.split('/')[0]), { recursive: true })
      await symlink(join(root, 'packages', name, 'node_modules', dependency), join(temporary, 'node_modules', dependency))
      linked.add(dependency)
    }
  }
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}\n')
  await writeFile(join(temporary, 'bin/agentmux'), "#!/usr/bin/env node\nimport '../dist/agentmux.js'\n")
  const cli = await build({ entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: join(temporary, 'dist/agentmux.js'),
    bundle: true, format: 'esm', platform: 'node', packages: 'external', alias: workspaceAliases, plugins: [sourcePlugin], metafile: true })
  for (const file of ['agentmux-cli-commands.ts', 'agent-fork.ts', 'space-control-parser.ts']) assert.ok(Object.keys(cli.metafile.inputs).some(path => path.endsWith('/' + file)), 'Actual CLI source: ' + file)
  const store = await build({ entryPoints: [join(root, 'packages/core/src/agent-session-store.ts')], outfile: join(temporary, 'dist/store.js'),
    bundle: true, format: 'esm', platform: 'node', packages: 'external', alias: workspaceAliases, plugins: [sourcePlugin], metafile: true,
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(join(root, 'packages/core/src/agent-session-store.ts')).href) } })
  const spatial = await build({ entryPoints: [join(root, 'packages/core/src/spatial-state.ts')], outfile: join(temporary, 'dist/spatial.js'),
    bundle: true, format: 'esm', platform: 'node', packages: 'external', alias: workspaceAliases, plugins: [sourcePlugin], metafile: true,
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(join(root, 'packages/core/src/spatial-state.ts')).href) } })
  receipt.bundles = { cli: { sha256: sha(await readFile(join(temporary, 'dist/agentmux.js'))), sources: Object.keys(cli.metafile.inputs) },
    store: { sha256: sha(await readFile(join(temporary, 'dist/store.js'))), sources: Object.keys(store.metafile.inputs) },
    spatial: { sha256: sha(await readFile(join(temporary, 'dist/spatial.js'))), sources: Object.keys(spatial.metafile.inputs) } }
  const suites = [
    { name: 'space', config: 'apps/desktop/scripts/fixtures/current-agent-fork/vitest.config.mts', mutationKey: 'AMX_FORK_MUTATION', loadedKey: 'AMX_FORK_LOADED',
      mutants: ['drop-fork-launch', 'drop-new-identity', 'disconnect-fork-space', 'use-server-local-fork-route', 'use-server-local-agent-fact', 'drop-admitted-fork-source'], required: ['packages/core/src/client.ts', 'packages/core/src/agent-fork.ts', 'apps/desktop/src/renderer/src/lib/space-agent-control.ts'] },
    { name: 'lifecycle', config: 'packages/core/test/fixtures/current-fork-lifecycle/vitest.owning.config.mts', mutationKey: 'AMX_FORK_LIFECYCLE_MUTATION', loadedKey: 'AMX_FORK_LIFECYCLE_LOADED',
      mutants: ['kill-healthy-fork', 'ignore-fork-intent', 'skip-fork-preparation', 'kill-prepared-recovery', 'skip-replay-auth'], required: ['packages/core/src/client.ts', 'packages/core/src/agent-session-registry.ts', 'packages/core/src/agent-session-store.ts'] }
  ]
  for (const suite of suites) for (const [index, mutation] of ['', ...suite.mutants, ''].entries()) {
    const name = suite.name + '-' + (mutation || (index ? 'control-after' : 'control')), loadedPath = join(evidence, name + '.loaded.ndjson')
    await writeFile(loadedPath, '')
    let result
    try { const actual = await run(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', suite.config], {
      cwd: root, env: { ...process.env, AGENTMUX_TEST_OBJECT_CLI: join(temporary, 'bin/agentmux'), AMX_FORK_STORE_MODULE: join(temporary, 'dist/store.js'),
        AMX_FORK_SPATIAL_MODULE: join(temporary, 'dist/spatial.js'),
        [suite.mutationKey]: mutation, [suite.loadedKey]: loadedPath }, timeout: 150000, maxBuffer: 4 * 1024 * 1024 }); result = { code: 0, output: actual.stdout + actual.stderr } }
    catch (error) { result = { code: error.code, output: (error.stdout ?? '') + (error.stderr ?? '') } }
    await writeFile(join(evidence, name + '.log'), result.output)
    const loads = (await readFile(loadedPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(loads.length > 0)
    for (const path of suite.required) assert.ok(loads.some(fact => fact.path === path), 'Actual source loaded: ' + path)
    for (const fact of loads) {
      if (receipt.sourceCandidates[fact.path]) assert.equal(receipt.sourceCandidates[fact.path], fact.originalSHA256, 'Same source candidate: ' + fact.path)
      receipt.sourceCandidates[fact.path] = fact.originalSHA256
    }
    if (mutation) { assert.ok(loads.some(fact => fact.mutation === mutation), 'Loaded source mutant'); assert.ok(Number.isInteger(result.code) && result.code > 0, result.output); assert.match(result.output, /AssertionError/); assert.match(result.output, /Tests\s+[1-9]\d* failed/) }
    else { assert.equal(result.code, 0, result.output); assert.match(result.output, /Tests\s+[1-9]\d* passed/) }
    receipt.mutations.push({ name, code: result.code, loadedMutants: loads.filter(fact => fact.mutation) })
    process.stdout.write(name + ': ' + (result.code === 0 ? 'green' : 'red') + '\n')
  }
  const scan = await run('rg', ['-n', 'buildForkLaunch|forkSource|fork-agent|forkedFrom', 'packages/core/src', 'apps/desktop/src'], { cwd: root })
  const consumers = scan.stdout.trim().split('\n').filter(row => !/\/types.ts:|\/index.ts:|\/space-control.ts:|\/agent-fork.ts:|\/contracts.ts:/u.test(row))
  for (const path of ['packages/core/src/client.ts:', 'packages/core/src/agentmux-cli-commands.ts:', 'apps/desktop/src/main/runtime-controller.ts:', 'apps/desktop/src/renderer/src/lib/space-agent-control.ts:']) assert.ok(consumers.some(row => row.startsWith(path)), 'Nonempty production consumers: ' + path)
  await writeFile(join(evidence, 'production-consumers.txt'), consumers.join('\n') + '\n'); receipt.productionConsumers = consumers.length
  for (const [path, hash] of Object.entries(receipt.sourceCandidates)) assert.equal(sha(await readFile(join(root, path))), hash, 'Candidate unchanged: ' + path)
  for (const [path, hash] of Object.entries(receipt.verificationInputs)) assert.equal(sha(await readFile(join(root, path))), hash, 'Verification inputs unchanged: ' + path)
  receipt.redLines = { physicalCapability: 'Only an unsupported, stale or unconfirmed exact fork is refused; both original raw input and workbench remain available.',
    processVsFlow: 'Source fences protect the exact fork intent, never classify a healthy original Run as dead.',
    inBandRecovery: 'Refresh or explicitly confirm the existing source; reconcile the original operation after partial creation without replay.',
    obtainablePrerequisite: 'The Provider must contribute a true current-session native fork and an exact current witness; historical points remain unsupported unless truly declared.' }
  receipt.passed = true
} finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); await rm(temporary, { recursive: true, force: true }) }
