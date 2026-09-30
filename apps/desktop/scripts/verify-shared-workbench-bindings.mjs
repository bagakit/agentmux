import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../../..')
const fixture = join(root, 'apps/desktop/scripts/fixtures/shared-workbench-bindings')
assert.deepEqual(process.argv.slice(2), ['--slice', 'relations'], 'Only the owning relations slice is implemented; presentation/native/join are separate tasks.')
const evidence = join(root, '.tmp/shared-workbench-bindings/relations')
const compiled = join(evidence, 'compiled')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const spatial = 'apps/desktop/src/renderer/src/lib/space-agent-control.ts'
const addresses = 'apps/desktop/src/shared/space-addresses.ts'
const persistence = 'apps/desktop/src/renderer/src/lib/workbench-persistence.ts'
const caller = 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx'
const focus = 'apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts'
const mutations = [
  { label: 'drop-default', file: addresses, before: 'addZone(workspaceZoneId(spaceId, workspace.id), workspace.id, spaceId)', after: '/* loaded mutation: drop default seed */', test: 'retains default' },
  { label: 'drop-saved-edge', file: addresses, before: "if (binding && typeof binding.spaceId === 'string' && typeof binding.workspaceId === 'string') addZone(zoneId, binding.workspaceId, binding.spaceId)", after: '/* loaded mutation: drop original saved binding */', test: 'retains default' },
  { label: 'first-group', file: spatial, before: 'for (const group of layout.groups) {', after: 'for (const group of layout.groups.slice(0, 1)) {', test: 'enumerates and removes' },
  { label: 'foreign-restore', file: persistence, before: 'keepTabsInLayout(input.persisted.layouts[workspaceId]!, new Set(Object.keys(tabs)))', after: 'keepTabsInLayout(input.persisted.layouts[workspaceId]!, new Set(Object.values(tabs).filter(tab => tab.workspaceId === workspaceId).map(tab => tab.id)))', test: 'enumerates and removes' },
  { label: 'unbind-closes-entity', file: spatial, before: 'ports.patch({ layouts: { ...state.layouts, [target.displayWorkspaceId]: next } })', after: 'ports.patch({ layouts: { ...state.layouts, [target.displayWorkspaceId]: next }, ...(!linked ? { tabs: Object.fromEntries(Object.entries(state.tabs).filter(([id]) => id !== target.tabId)) } : {}) })', test: 'enumerates and removes' },
  { label: 'display-filter-leaks', file: spatial, before: ' && (!locationConstrained || locationTabIds.has(tab.tabId))', after: '', test: 'joins display selectors' },
  { label: 'shared-move-unsafe', file: spatial, before: 'if (new Set(occurrences.map(location => JSON.stringify([location.displayWorkspaceId, location.groupId, location.tabId, location.regionId]))).size > 1)', after: 'if (false && new Set(occurrences.map(location => JSON.stringify([location.displayWorkspaceId, location.groupId, location.tabId, location.regionId]))).size > 1)', test: 'rejects a shared Region move' },
  { label: 'default-launcher-requires-override', file: 'apps/desktop/src/renderer/src/store.ts', before: "if (!zone || zone.workspaceId !== workspaceId || zone.kind === 'unknown')", after: "if (!zone || !state.spaceZoneBindings[zoneId] || zone.workspaceId !== workspaceId || zone.kind === 'unknown')", test: 'explicit original default Zone' },
  { label: 'scratch-inherits-active-topic', file: 'apps/desktop/src/renderer/src/store.ts', before: "topicId = zone.kind === 'home' ? catalog.spaces.find(item => item.spaceId === spaceId)?.topicId : undefined", after: "topicId = inheritedTopicIdForNewTab(workspaceId, layout, state.tabs, targetTabGroupId)", test: 'explicit temporary Scratch Zone' },
  { label: 'foreign-launcher-wrong-layout', file: 'apps/desktop/src/renderer/src/store.ts', before: 'const displayId = displayWorkspaceId ?? workspaceId', after: 'const displayId = workspaceId', test: 'Zone Launcher directly' },
  { label: 'phantom-display-admitted', file: spatial, before: "if (!layout || groupId && (!groupIds(layout.root).includes(groupId) || !layout.groups.some(group => group.id === groupId))) {\n    failure('SPACE_LOCATION_UNKNOWN', 'The requested display Workspace or Group is not available.')\n  }\n  return layout", after: "return layout ?? createWorkspaceLayout(groupId ?? 'mutation-phantom')", test: 'phantom display' },
  { label: 'home-container-resource', file: addresses, before: "    const resourcePath = homePath ?? (originalHome && zoneId === homeZoneId(spaceId) && workspace?.id === SCRATCH_WORKSPACE_ID &&\n      Array.isArray(directoryContext) && directoryContext.length === 2 && directoryContext[0] === workspace.hostId &&\n      typeof directoryContext[1] === 'string' && (directoryContext[1].startsWith('/') || /^[A-Za-z]:[\\\\/]/.test(directoryContext[1]) || directoryContext[1].startsWith('\\\\\\\\')) ? directoryContext[1] : undefined)\n    const fact: AgentMuxZoneFact = workspace && (!originalHome || resourcePath) ?", after: '    const resourcePath = homePath\n    const fact: AgentMuxZoneFact = workspace ?', test: 'exact original home' },
  { label: 'close-relabels-peer-zone', file: focus, before: " || !choice.zoneId || activeTab.space?.zoneId !== choice.zoneId", after: '', test: 'neutral parent after Close' },
  { label: 'cui-topic-becomes-resource', file: spatial, before: "const sourceTopic = zone.kind === 'home' ? catalog.spaces.find(item => item.spaceId === sourceSpaceId)?.topicId : undefined", after: "const sourceTopic = catalog.spaces.find(item => item.spaceId === address.spaceId)?.topicId", test: 'existing Agent presentation in a linked temporary Zone' },
  { label: 'menu-zero-action', file: caller, before: 'await useAppStore.getState().setTabDisplayPlacement(tab.id, displayWorkspaceId, groupId, linked)', after: 'await Promise.resolve()', test: 'real Tab menu' }
]
const exec = promisify(execFile)
const run = async (label, executable, args, extraEnv = {}) => {
  let result
  try { const output = await exec(executable, args, { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', ...extraEnv }, maxBuffer: 16 * 1024 * 1024, timeout: 120000 }); result = { code: 0, signal: null, output: output.stdout + output.stderr } }
  catch (error) { result = { code: error.code, signal: error.signal, output: (error.stdout ?? '') + (error.stderr ?? '') } }
  await writeFile(join(evidence, `${label}.log`), result.output)
  return { ...result, log: `${label}.log` }
}
const inputs = [...new Set([...mutations.map(item => item.file),
  'apps/desktop/src/renderer/src/store.ts', 'packages/core/src/space-control.ts', 'packages/core/src/space-control-parser.ts', 'packages/core/src/control-host.ts',
  'packages/core/src/agentmux.ts', 'packages/layout/src/workbench-layout.ts', 'apps/desktop/test/shared-workbench-bindings.test.ts',
  'apps/desktop/test/space-agent-control.test.ts', 'apps/desktop/src/renderer/src/components/WorkbenchTabContextMenu.tsx'])]
const originals = new Map(await Promise.all(inputs.map(async file => [file, await readFile(join(root, file))])))
const sourceHashes = () => Object.fromEntries([...originals].map(([file, bytes]) => [file, hash(bytes)]))
const receipt = { schema: 'agentmux.shared-workbench-relations.v1', passed: false, sourceBefore: sourceHashes(), mutations: [], compiled: null,
  boundary: 'Actual Store, production Tab menu, Core typed Unix control and CLI; separate private Node process restore. No Native GUI, mounted multi-presentation, Run control, user profile or shared dist claim.', sharedSourceWrites: 0 }
await mkdir(evidence, { recursive: true })
try {
  const vitest = join(root, 'node_modules/.bin/vitest')
  const config = join(fixture, 'vitest.relations.config.mts')
  const baseline = await run('baseline', vitest, ['run', '--config', config])
  assert.equal(baseline.code, 0, baseline.output)
  assert.match(baseline.output, /Tests\s+34 passed/)
  for (const item of mutations) {
    const source = originals.get(item.file).toString()
    assert.equal(source.split(item.before).length - 1, 1, `Unique source mutation: ${item.label}`)
    const descriptor = join(evidence, 'current-mutation.json'), loaded = join(evidence, `${item.label}-loaded.json`)
    await rm(loaded, { force: true })
    await writeFile(descriptor, JSON.stringify({ ...item, loaded }))
    const red = await run(`${item.label}-red`, vitest, ['run', '--config', config, '-t', item.test], { AGENTMUX_BINDING_MUTATION_PATH: descriptor })
    const load = JSON.parse(await readFile(loaded, 'utf8'))
    assert.equal(load.source, hash(originals.get(item.file)))
    assert.equal(load.loaded, hash(source.replace(item.before, item.after)))
    assert.ok(typeof red.code === 'number' && red.code > 0 && red.signal === null, red.output)
    assert.match(red.output, /AssertionError/)
    assert.match(red.output, /Tests\s+[1-9]\d* failed/)
    const green = await run(`${item.label}-restored`, vitest, ['run', '--config', config, '-t', item.test])
    assert.equal(green.code, 0, green.output)
    receipt.mutations.push({ ...item, red: { code: red.code, log: red.log }, green: { code: green.code, log: green.log }, load })
    console.log(JSON.stringify({ mutation: item.label, red: red.code, restored: green.code }))
  }
  await rm(join(evidence, 'current-mutation.json'), { force: true })
  const manifest = JSON.parse(await readFile(join(root, 'packages/core/package.json'), 'utf8'))
  const paths = Object.fromEntries(Object.entries(manifest.exports).map(([key, value]) => [key === '.' ? '@agentmux/core' : `@agentmux/core/${key.slice(2)}`,
    [join('packages/core', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))]]))
  paths['@agentmux/layout'] = ['packages/layout/src/index.ts']
  const typeConfig = join(evidence, 'tsconfig.owning.json')
  await writeFile(typeConfig, JSON.stringify({ extends: join(root, 'apps/desktop/tsconfig.json'), compilerOptions: { baseUrl: root, paths, types: ['node'] },
    include: [join(root, 'apps/desktop/src/**/*.ts'), join(root, 'apps/desktop/src/**/*.tsx'), join(root, 'apps/desktop/node_modules/vite/client.d.ts'), join(root, 'packages/core/src/agentmux.ts'), join(root, 'apps/desktop/test/shared-workbench-bindings.test.ts')] }))
  const types = await run('types', join(root, 'node_modules/.bin/tsc'), ['--noEmit', '-p', typeConfig])
  assert.equal(types.code, 0, types.output); receipt.types = { code: types.code, log: types.log }
  await mkdir(compiled, { recursive: true })
  const require = createRequire(join(root, 'packages/core/package.json'))
  const { build } = await import(pathToFileURL(require.resolve('esbuild')).href)
  const aliases = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, join(root, value[0])]))
  const plugin = { name: 'owning-source-exports', setup(builder) {
    builder.onResolve({ filter: /^@agentmux\/(core|layout)(\/|$)/ }, args => aliases[args.path] ? { path: aliases[args.path] } : undefined)
    builder.onResolve({ filter: /^[^./]/ }, async args => {
      if (args.pluginData?.ownedExternal) return
      if (args.path.startsWith('node:')) return { path: args.path, external: true }
      const dependency = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { ownedExternal: true } })
      if (dependency.errors.length) return { errors: dependency.errors }
      return { path: dependency.path, external: true }
    })
  } }
  const outputs = []
  for (const [name, entry] of [['consumer', join(fixture, 'consumer.ts')], ['agentmux', join(root, 'packages/core/src/agentmux.ts')]]) {
    const outfile = join(compiled, `${name}.mjs`)
    const result = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, platform: 'node', target: 'node24', format: 'esm',
      outfile, metafile: true, plugins: [plugin], define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, logLevel: 'error' })
    const consumed = Object.keys(result.metafile.inputs)
    assert.ok(consumed.includes('packages/core/src/space-control-parser.ts'), `${name} must consume the owning ABI parser`)
    if (name === 'consumer') assert.ok(consumed.includes('apps/desktop/src/renderer/src/lib/space-agent-control.ts'))
    await writeFile(join(evidence, `${name}-metafile.json`), JSON.stringify(result.metafile))
    outputs.push({ name, sha256: hash(await readFile(outfile)), bytes: result.metafile.outputs[outfile]?.bytes ?? Object.values(result.metafile.outputs)[0].bytes,
      sourceInputs: Object.fromEntries(await Promise.all(consumed.filter(file => !file.startsWith('node_modules/')).map(async file => [file, hash(await readFile(resolve(root, file)))]))) })
  }
  for (const phase of ['seed', 'restore']) {
    const result = await run(`compiled-${phase}`, process.execPath, [join(fixture, 'compiled-consumer.mjs'), root, compiled, evidence, phase])
    assert.equal(result.code, 0, result.output)
    assert.equal(JSON.parse(await readFile(join(evidence, `compiled-${phase}.json`), 'utf8')).passed, true)
  }
  const [seed, restored] = await Promise.all(['seed', 'restore'].map(async phase => JSON.parse(await readFile(join(evidence, `compiled-${phase}.json`), 'utf8'))))
  assert.notEqual(seed.pid, restored.pid)
  receipt.compiled = { outputs, phases: [{ phase: 'seed', pid: seed.pid }, { phase: 'restore', pid: restored.pid }] }
  receipt.sourceAfter = Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await readFile(join(root, file)))])))
  assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  // These are product consumers, not the action definitions or this fixture's assertions.
  const filesIn = async directory => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry =>
    entry.isDirectory() ? filesIn(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : []))).flat()
  const productFiles = await filesIn(join(root, 'apps/desktop/src/renderer/src'))
  assert.ok(productFiles.length > 0)
  const definitions = 'apps/desktop/src/renderer/src/store.ts'
  receipt.callers = Object.fromEntries(await Promise.all(['createWorkbenchZone', 'setZoneSpaceRelation', 'setTabDisplayPlacement'].map(async symbol => {
    const found = (await Promise.all(productFiles.filter(file => file !== join(root, definitions)).map(async file =>
      new RegExp(`\\b${symbol}\\b`).test(await readFile(file, 'utf8')) ? file.slice(root.length + 1) : null))).filter(Boolean)
    return [symbol, found]
  })))
  receipt.remainingCallers = Object.entries(receipt.callers).filter(([, files]) => files.length === 0).map(([symbol]) => symbol)
  assert.deepEqual(receipt.remainingCallers, [], 'The data/interface draft is not Task done until the real Survey Zone creation/relation caller joins this candidate.')
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  await rm(compiled, { recursive: true, force: true })
  await rm(join(evidence, 'current-mutation.json'), { force: true })
  receipt.cleanup = { compiledRemoved: true, privateControlSocketsRemovedByConsumer: true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, mutations: receipt.mutations.length, receipt: join(evidence, 'receipt.json') }))
