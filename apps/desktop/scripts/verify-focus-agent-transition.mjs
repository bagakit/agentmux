import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), argument = process.argv.indexOf('--evidence')
const evidenceRoot = argument < 0 ? join(root, '.tmp/focus-agent-transition') : resolve(process.argv[argument + 1])
const component = name => `apps/desktop/src/renderer/src/components/${name}.tsx`
const lib = name => `apps/desktop/src/renderer/src/lib/${name}.ts`
await verifyRendererSourceMutations({ name: 'focus-agent-transition', evidenceRoot,
  owningConfig: 'apps/desktop/test/vitest.focus-agent-transition.config.mts',
  tests: ['apps/desktop/test/focus-agent-transition.test.tsx', 'apps/desktop/test/current-agent-fork-ui.test.tsx', 'apps/desktop/test/current-fork-direction-contract.test.ts'],
  sources: ['vitest.config.ts', 'test/fixture-values.mjs', component('FocusContextMenu'), component('AgentCurrentForkControls'),
    component('SessionTakeoverSurface'), lib('agent-current-fork'), lib('session-takeover'), lib('agent-new-tab-destination')],
  mutations: [
    { label: 'fork-must-use-canonical-source', file: lib('agent-current-fork'), before: 'agentSessionId: session.control.agentSessionId, expectedRun:', after: 'agentSessionId: session.id, expectedRun:' },
    { label: 'takeover-must-keep-reviewed-run', file: lib('session-takeover'), before: 'current.control.run.runId === source.expectedRun.runId &&', after: 'true &&' },
    { label: 'destination-must-still-exist', file: lib('agent-new-tab-destination'),
      before: "  if (!exact) throw new Error('The chosen Space, Zone or Group changed. The original Agent is kept; choose an existing destination again.')\n  return { ...exact.destination }",
      after: '  return { ...destination }' },
    { label: 'focus-must-consume-original-fork-control', file: component('FocusContextMenu'), before: 'controls: forkAt(), workspace:', after: 'controls: null, workspace:' },
    { label: 'fork-candidates-must-use-source-host', file: component('AgentCurrentForkControls'), before: 'current.layouts, { hostId: session.control.hostId })', after: 'current.layouts)' },
    { label: 'fork-dispatch-must-recheck-source-host', file: component('AgentCurrentForkControls'), before: 'current.layouts, { hostId: review.hostId })', after: 'current.layouts)' }
  ] })

const evidence = join(evidenceRoot, 'original-owner-durability')
await mkdir(evidence, { recursive: true })
const run = promisify(execFile), digest = bytes => createHash('sha256').update(bytes).digest('hex')
if (process.env.AGENTMUX_FOCUS_TRANSITION_DURABILITY_RECEIPT) {
  const path = resolve(process.env.AGENTMUX_FOCUS_TRANSITION_DURABILITY_RECEIPT), bytes = await readFile(path), saved = JSON.parse(bytes)
  assert.equal(saved.schema, 'agentmux.focus-transition-durability.v1'); assert.equal(saved.passed, true)
  assert.equal(saved.privateRuntime, true); assert.equal(saved.userRuntimeTouched, false); assert.equal(saved.newProcess, true)
  for (const name of ['packages/core/src/agent-fork.ts', 'packages/core/src/agent-session-store.ts', 'packages/core/src/spatial-state.ts', 'apps/desktop/src/renderer/src/lib/space-agent-control.ts']) {
    assert.ok(saved.source[name], 'The actual original lifecycle/spatial owner is present: ' + name)
    assert.equal(digest(await readFile(join(root, name))), saved.source[name], 'The original lifecycle/spatial owner is unchanged: ' + name)
    assert.ok(saved.loaded.some(item => item.path === name && item.originalSHA256 === saved.source[name] && item.loadedSHA256 === saved.source[name]))
  }
  const subsequentOwnerChanges = []
  for (const [name, hash] of Object.entries(saved.source)) if (digest(await readFile(join(root, name))) !== hash) subsequentOwnerChanges.push(name)
  const logs = {}
  for (const name of ['original-takeover-green.log', 'private-fork-process-green.log']) logs[name] = digest(await readFile(join(resolve(path, '..'), name)))
  const consumed = { passed: true, originalReceipt: path, sha256: digest(bytes), logs, subsequentOwnerChanges,
    boundary: 'Consume the original bounded process/restart proof with its exact lifecycle/spatial owners. Current Renderer controls have their own fresh source mutants above. Changes in other original bundle inputs are disclosed rather than requalified.' }
  await writeFile(join(evidenceRoot, 'durability-consumption.json'), JSON.stringify(consumed, null, 2) + '\n')
  console.log(JSON.stringify(consumed)); process.exit(0)
}
const adjacent = await run(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/vitest.focus-agent-transition.config.mts', 'apps/desktop/test/session-takeover.test.tsx'], { cwd: root, timeout: 90000, maxBuffer: 4 * 1024 * 1024 })
await writeFile(join(evidence, 'original-takeover-green.log'), adjacent.stdout + adjacent.stderr)
assert.match(adjacent.stdout, /Tests\s+[1-9]\d* passed/)
const temporary = await mkdtemp(join(tmpdir(), 'amx-focus-transition-'))
const receipt = { schema: 'agentmux.focus-transition-durability.v1', passed: false, userRuntimeTouched: false,
  privateRuntime: true, originalTakeoverTests: 35, newProcess: true, source: {}, bundles: {}, loaded: [] }
try {
  const { build } = createRequire(join(root, 'packages/core/package.json'))('esbuild')
  const aliases = {}, linked = new Set()
  await mkdir(join(temporary, 'node_modules')); await writeFile(join(temporary, 'package.json'), '{"type":"module"}\n')
  for (const name of ['core', 'demand', 'relay', 'identity']) {
    const manifest = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'))
    for (const [entry, value] of Object.entries(manifest.exports)) aliases[entry === '.' ? '@agentmux/' + name : '@agentmux/' + name + '/' + entry.slice(2)] = join(root, 'packages', name,
      name === 'identity' && entry === './runtime-source' ? value.import : name === 'identity' && entry === './runtime' ? 'src/runtime-entry.ts' : value.import.replace('./dist/', name === 'demand' ? './' : './src/').replace(/\.js$/, '.ts'))
    for (const dependency of [...Object.keys(manifest.dependencies ?? {}), ...(name === 'core' ? ['@ctxmux/sdk'] : [])]) {
      if (dependency.startsWith('@agentmux/') || linked.has(dependency)) continue
      if (dependency.startsWith('@')) await mkdir(join(temporary, 'node_modules', dependency.split('/')[0]), { recursive: true })
      await symlink(join(root, 'packages', name, 'node_modules', dependency), join(temporary, 'node_modules', dependency)); linked.add(dependency)
    }
  }
  const outputs = {}
  for (const [key, file] of [['cli', 'agentmux'], ['store', 'agent-session-store'], ['spatial', 'spatial-state']]) {
    const entry = join(root, 'packages/core/src', file + '.ts'), output = join(temporary, file + '.js')
    const result = await build({ entryPoints: [entry], outfile: output, bundle: true, format: 'esm', platform: 'node', packages: 'external', alias: aliases, metafile: true,
      ...(key !== 'cli' ? { define: { 'import.meta.url': JSON.stringify(pathToFileURL(entry).href) } } : {}) })
    outputs[key] = output; receipt.bundles[key] = { sha256: digest(await readFile(output)), sources: Object.keys(result.metafile.inputs) }
  }
  const cli = join(temporary, 'amux')
  await writeFile(cli, `#!/usr/bin/env node\nimport './agentmux.js'\n`, { mode: 0o700 })
  const loadedPath = join(evidence, 'private-fork.loaded.ndjson'); await writeFile(loadedPath, '')
  const result = await run(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/scripts/fixtures/current-agent-fork/vitest.config.mts', '-t', 'Focus Session-source fork without an occurrence'], {
    cwd: root, env: { ...process.env, TMPDIR: '/tmp', AGENTMUX_TEST_OBJECT_CLI: cli, AMX_FORK_STORE_MODULE: outputs.store,
      AMX_FORK_SPATIAL_MODULE: outputs.spatial, AMX_FORK_LOADED: loadedPath, AMX_FORK_MUTATION: '' }, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }).catch(async error => {
        await writeFile(join(evidence, 'private-fork-process-failure.log'), (error.stdout ?? '') + (error.stderr ?? '') + '\n' + error.message)
        throw error
      })
  await writeFile(join(evidence, 'private-fork-process-green.log'), result.stdout + result.stderr)
  assert.match(result.stdout, /Tests\s+1 passed/)
  const loads = (await readFile(loadedPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  for (const file of ['packages/core/src/agent-fork.ts', 'packages/core/src/agent-session-store.ts', 'apps/desktop/src/renderer/src/lib/space-agent-control.ts']) assert.ok(loads.some(item => item.path === file), `Actual original owner loaded: ${file}`)
  for (const item of loads) {
    assert.equal(item.originalSHA256, item.loadedSHA256)
    assert.equal(digest(await readFile(join(root, item.path))), item.originalSHA256)
    receipt.source[item.path] = item.originalSHA256
  }
  receipt.loaded = loads; receipt.passed = true
} finally {
  await rm(temporary, { recursive: true, force: true })
  receipt.cleanup = { privateBundlesRemoved: true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true)
console.log(JSON.stringify({ passed: true, userRuntimeTouched: false, receipt: join(evidence, 'receipt.json') }))
