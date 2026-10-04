import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { runProbeProcess } from './probe-process.mjs'
const root = path.resolve(import.meta.dirname, '../../..')
const fixture = path.join(root, 'apps/desktop/scripts/fixtures/new-project-workface')
const evidence = path.resolve(process.argv[2] ?? path.join(root, '.tmp/new-project-workface', String(globalThis.crypto.randomUUID())))
const privateRoot = await fs.mkdtemp(_hygiene_fixturePath("tmp/amux-new-project-"))
const run = promisify(execFile)
const desktopRequire = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build: buildRenderer } = await import(pathToFileURL(desktopRequire.resolve('vite')).href)
const { build: buildNode } = createRequire(path.join(root, 'packages/core/package.json'))('esbuild')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const ownedFiles = ['apps/desktop/src/renderer/src/lib/desktop-focus-navigation.ts',
  'apps/desktop/src/renderer/src/hooks/useWorkbenchObjectLayout.ts', 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
  'apps/desktop/src/renderer/src/styles/workbench.css']
const receipt = { schema: 'agentmux.new-project-workface.v1', passed: false, evidence, mutations: [], processes: [],
  visualReview: 'pending-independent-review', isolation: [
    'Actual App, Store initialization, openProjectFolder/selectWorkspace/openLauncher, Workbench, Launcher and shared Composer consume current source aliases.',
    'openProjectFolder registers/selects the Workspace and displays the existing empty-Group virtual Launcher; a separately recorded openLauncher action creates the durable Tab for restart verification.',
    'Actual ConfigOwner/registerWorkspace and Core spatial filesystem owner; three independent Electron processes share one private profile and state file.',
    'Existing public spatial/navigation contracts are reused. The old null choice and original descriptor observation gap plus two Space bindings are explicit fault inputs, not a claim of the user profile cause. A bounded private spatial ACK hold permits stable unknown capture; Core durable origin is retained and released before save. Restart may confirm that original origin.',
    'Runtime execution and warm Terminal are isolated; no lifecycle/send request is admitted. No real Agent/Run recovery, user App restart, installed package or full production-build claim.',
    'Chromium flush request alone is not disk ACK; subsequent independent process readback proves the nonempty draft and exact client selection.'
  ] }
await fs.mkdir(evidence, { recursive: true })
const sourceBefore = Object.fromEntries(await Promise.all(ownedFiles.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
receipt.sourceBefore = sourceBefore
const command = async (label, executable, args, environment = {}) => {
  let value
  try { const result = await run(executable, args, { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', ...environment }, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }); value = { code: 0, signal: null, output: result.stdout + result.stderr } }
  catch (error) { value = { code: error.code, signal: error.signal, output: (error.stdout ?? '') + (error.stderr ?? '') } }
  await fs.writeFile(path.join(evidence, label + '.log'), value.output)
  return value
}
try {
  const config = path.join(fixture, 'vitest.config.mts'), vitest = path.join(root, 'node_modules/.bin/vitest')
  const baseline = await command('baseline', vitest, ['run', '--config', config])
  assert.equal(baseline.code, 0, baseline.output); assert.match(baseline.output, /Tests\s+[1-9]\d* passed/)
  const focus = ownedFiles[0], hook = ownedFiles[1]
  const mutations = [
    { label: 'unbound-body-removed', file: focus, before: 'if (choice.spaceId === null && choice.zoneId === null && choice.tabId) {', after: 'if (false && choice.spaceId === null && choice.zoneId === null && choice.tabId) {', test: 'exact first unbound' },
    { label: 'duplicate-exact-fact-admitted', file: focus, before: 'matching.length === 1 && choice.groupId', after: 'matching.length >= 0 && choice.groupId', test: 'duplicated exact facts' },
    { label: 'stale-unbound-choice-never-resolved', file: focus, before: 'catalog.tabs.some(tab => tab.tabId === choice!.tabId && tab.zoneId !== null)', after: 'false', test: 'normal project discovery' },
    { label: 'same-original-local-occurrence-blocked', file: focus, before: '!within && !sameUnboundOccurrence && intent', after: '!within && intent', test: 'normal project discovery' },
    { label: 'unknown-cold-body-removed', file: focus, before: 'layout: original.layout, choice, confirmed: false,', after: 'layout: null, choice, confirmed: false,', test: 'multiple Space bindings' },
    { label: 'different-unbound-tab-borrows-old-body', file: hook, before: '? [choice.groupId, choice.tabId, choice.regionId] : []', after: '? [] : []', test: 'different exact Tab' }
  ]
  for (const item of mutations) {
    const descriptor = path.join(evidence, 'mutation.json'), loaded = path.join(evidence, item.label + '-loaded.ndjson')
    const source = await fs.readFile(path.join(root, item.file), 'utf8')
    assert.equal(source.split(item.before).length - 1, 1, item.label + ' unique anchor')
    await fs.writeFile(descriptor, JSON.stringify(item))
    const red = await command(item.label + '-red', vitest, ['run', '--config', config, '-t', item.test],
      { AGENTMUX_WORKFACE_MUTATION_PATH: descriptor, AGENTMUX_WORKFACE_LOADED_PATH: loaded })
    assert.equal(red.signal, null); assert.ok(typeof red.code === 'number' && red.code > 0, red.output)
    assert.match(red.output, /Tests\s+[1-9]\d* failed/); assert.match(red.output, /AssertionError/)
    const loads = (await fs.readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const actual = loads.filter(value => value.path === item.file && value.mutated)
    assert.ok(actual.length > 0, item.label + ' actually loaded')
    assert.equal(actual[0].sourceSHA256, hash(source)); assert.equal(actual[0].loadedSHA256, hash(source.replace(item.before, item.after)))
    const green = await command(item.label + '-control', vitest, ['run', '--config', config, '-t', item.test])
    assert.equal(green.code, 0, green.output); assert.match(green.output, /Tests\s+[1-9]\d* passed/)
    receipt.mutations.push({ ...item, red: red.code, restored: green.code, loaded: actual[0] })
    console.log('new-project mutation=' + item.label + ' killed')
  }
  await fs.rm(path.join(evidence, 'mutation.json'))
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'packages/core/package.json'), 'utf8'))
  const aliases = Object.entries(manifest.exports).map(([key, value]) => ({
    find: new RegExp('^' + (key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
    replacement: path.join(root, 'packages/core', value.import.replace('./dist/', './src/').replace(/\.js$/, '.ts'))
  }))

  const clientUiExports = JSON.parse(await fs.readFile(path.join(root, 'packages/client-ui/package.json'), 'utf8')).exports
  for (const [key, value] of Object.entries(clientUiExports).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)) {
    const target = typeof value === 'string' ? value : value.browser
    const name = key === '.' ? '@agentmux/client-ui' : '@agentmux/client-ui/' + key.slice(2)
    const pattern = name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)')
    aliases.push({ find: new RegExp('^' + pattern + '$'), replacement: path.join(root, 'packages/client-ui', target).replace('*', '$1') })
  }
  aliases.push({ find: /^@agentmux\/layout$/, replacement: path.join(root, 'packages/core/src/spatial-layout.ts') })
  const consumed = new Map()
  const guardPlugin = { name: 'explicit-unused-missing-leaves', enforce: 'pre',
    transform(code, id) { if (id.startsWith(root + '/apps/desktop/src/') || id.startsWith(root + '/packages/core/src/') || id.startsWith(root + '/packages/client-ui/src/')) consumed.set(path.relative(root, id.split('?')[0]), hash(code)) }
  }
  const renderer = path.join(evidence, 'renderer')
  await buildRenderer({ configFile: false, root: fixture, base: './', logLevel: 'error', define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
    resolve: { alias: aliases }, plugins: [guardPlugin], build: { outDir: renderer, emptyOutDir: true, minify: false } })
  for (const file of [...ownedFiles.filter(file => file.endsWith('.ts') || file.endsWith('.tsx')),
    'apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/NewTabSurface.tsx'])
    assert.ok(consumed.has(file), 'Actual compiled product consumer: ' + file)
  receipt.compiledSource = Object.fromEntries(consumed)
  const main = path.join(evidence, 'main.cjs')
  const nodeAliases = Object.fromEntries(aliases.filter(value => String(value.find).includes('@agentmux') && !value.find.source.includes('(')).map(value => [value.find.source.slice(1, -1).replaceAll('\\/', '/').replaceAll('\\.', '.'), value.replacement]))
  await buildNode({ absWorkingDir: root, entryPoints: [path.join(fixture, 'main.ts')], outfile: main,
    bundle: true, format: 'cjs', platform: 'node', external: ['electron'], alias: nodeAliases, logLevel: 'error',
    // Retain the spatial owner's source-module resolution for its native filesystem lock.
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(root, 'packages/core/src/spatial-state.ts')).href) } })
  const rendererFiles = await fs.readdir(path.join(renderer, 'assets'))
  receipt.artifacts = { main: hash(await fs.readFile(main)), renderer: Object.fromEntries(await Promise.all(rendererFiles.map(async file => [file, hash(await fs.readFile(path.join(renderer, 'assets', file)))]))) }
  await fs.mkdir(path.join(privateRoot, 'project'))
  const electronEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !name.startsWith('AGENTMUX_') && !name.startsWith('CTXMUX_') && name !== 'ELECTRON_RUN_AS_NODE'))
  for (const phase of ['seed', 'restore', 'unknown-restore']) {
    const stderr = []
    const processResult = await runProbeProcess(desktopRequire('electron'), [main, path.join(renderer, 'index.html'), privateRoot,
      phase, path.join(fixture, 'preload.cjs'), evidence], { temporaryRoot: privateRoot, cwd: root,
      env: electronEnvironment, timeoutMs: 45000, onLine: line => { stderr.push(line); process.stderr.write(phase + ': ' + line.slice(0, 700) + '\n') } })
    await fs.writeFile(path.join(evidence, phase + '-stderr.log'), stderr.join('\n'))
    assert.ok(await fs.stat(path.join(evidence, phase + '.json')).catch(() => null),
      'Electron process did not emit a phase receipt: ' + JSON.stringify(processResult) + '\n' + stderr.join('\n'))
    const result = JSON.parse(await fs.readFile(path.join(evidence, phase + '.json'), 'utf8'))
    receipt.processes.push({ ...processResult, ...result })
    assert.equal(processResult.exitCode, 0, JSON.stringify(result.failure)); assert.equal(result.passed, true)
    console.log('new-project ordinary-process=' + phase + ' passed pid=' + result.pid)
  }
  assert.equal(new Set(receipt.processes.map(value => value.pid)).size, 3)
  const sourceRoot = path.join(root, 'apps/desktop/src/renderer/src')
  const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory()
    ? files(path.join(directory, entry.name)) : /\.tsx?$/.test(entry.name) ? [path.join(directory, entry.name)] : []))).flat()
  const scanned = await files(sourceRoot); assert.ok(scanned.length > 0)
  const callers = []
  for (const [symbol, definition] of [['workbenchObjectLayout', focus], ['useWorkbenchObjectLayout', hook]]) {
    const found = []
    for (const file of scanned.filter(file => file !== path.join(root, definition))) {
      const content = await fs.readFile(file, 'utf8')
      if (new RegExp('\\b' + symbol + '\\(').test(content)) found.push(path.relative(root, file))
    }
    assert.ok(found.length > 0, 'Nonempty production consumer set for ' + symbol); callers.push({ symbol, callers: found })
  }
  receipt.productionConsumers = { scanned: scanned.length, callers }
  receipt.sourceAfter = Object.fromEntries(await Promise.all(ownedFiles.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
  assert.deepEqual(receipt.sourceAfter, sourceBefore)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; throw error }
finally { await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2)); await fs.rm(privateRoot, { recursive: true, force: true }); console.log('new-project evidence=' + evidence) }
