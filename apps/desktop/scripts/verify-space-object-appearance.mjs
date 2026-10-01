import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(desktop, '../..')
const fixture = path.join(desktop, 'scripts/fixtures/space-object-appearance')
const generatedAt = Date.now()
const folderRecencyOnly = process.argv.slice(3).includes('--folder-recency-only')
const recencyAssets = {
  signal: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#49b7f1" d="M1 2h6v12H1z"/><path fill="#ef9865" d="M9 2h6v12H9z"/></svg>',
  orbit: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle fill="#a78ae8" cx="8" cy="8" r="7"/><circle fill="#72c9a1" cx="8" cy="8" r="3"/></svg>'
}
const folderRecency = [
  { tone: 'full', age: 30 * 60_000, label: '≤1h' }, { tone: 'subdued', age: 6 * 60 * 60_000, label: '1–12h' },
  { tone: 'quiet', age: 24 * 60 * 60_000, label: '>12h' }, { tone: 'unknown', age: null, label: 'unknown' }
].flatMap(({ tone, age, label }, index) => (folderRecencyOnly ? [index % 2 ? 'orbit' : 'signal', 'notes', 'package'] : Object.keys(recencyAssets)).map(asset => ({
  id: `private-recency-${tone}-${asset}`, name: `${{ signal: 'Signal', orbit: 'Orbit', notes: 'Notebook', package: 'Package' }[asset]} · ${label}`,
  directory: `recency/${index + 1}-${tone}-${asset}`, tone, asset,
  observedAt: age === null ? null : generatedAt - age, source: asset === 'signal' ? 'native-hook' : 'acp'
})))
const generation = { id: `space-appearance-${generatedAt}`, createdAt: new Date(generatedAt).toISOString(), folderRecency,
  ...(folderRecencyOnly ? { manualFolder: { id: 'private-recency-manual', name: 'Manual · unchanged', directory: 'recency/5-manual', manualIcon: 'code' } } : {}) }
const output = path.resolve(process.argv[2] ?? path.join(root, '.tmp/space-object-appearance', generation.id))
const persistenceOnly = process.argv.slice(3).includes('--persistence-only')
assert.ok(process.argv.slice(3).every(argument => ['--persistence-only', '--folder-recency-only'].includes(argument)), 'Unknown native appearance option')
assert.ok(!(persistenceOnly && folderRecencyOnly), 'Select one bounded appearance scenario')
const require = createRequire(path.join(desktop, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')).href)
const execFileAsync = promisify(execFile)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true }))
  .map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
let inputs = [fileURLToPath(import.meta.url), path.join(desktop, 'scripts/probe-process.mjs'),
  ...['main.ts', 'entry.mjs', 'preload.cjs', 'index.html', 'scenario.md'].map(name => path.join(fixture, name)),
  ...(await files(path.join(desktop, 'src/renderer/src/styles'))).filter(file => file.endsWith('.css'))]
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file =>
  [path.relative(root, file), hash(await fs.readFile(file))])))
const sourcePlugin = { name: 'bind-space-appearance-source', buildEnd() {
  inputs = [...new Set([...inputs, ...this.getModuleIds()].filter(file =>
    file.startsWith(root + '/') && !file.includes('/node_modules/') && !file.includes('?')))]
} }
const receipt = { schema: 'agentmux.space-object-appearance-native.v1', passed: false,
  captureOnly: true, aestheticReview: 'not-performed', generation, candidate: null,
  mode: folderRecencyOnly ? 'folder-recency-presentation' : persistenceOnly ? 'persistence-mutation' : 'complete-behavior',
  inputs: null, compiledOutputs: {}, generatedInputs: {}, phases: [], images: [], cleanup: null,
  compiledArtifacts: { preserved: true, recordOnly: false, pathBase: 'receipt-directory' },
  limitations: ['Actual production Renderer, Store initialize, Workbench persistence and private Chromium profile are exercised.',
    'Sessions and attachment use controlled public API facts; no actual Core/ctxmux Run survival is claimed.',
    'Automatic Folder appearance and ScratchTopics use production filesystem owners inside the private root.',
    'The original workface is initially seeded; every subsequent process restores it through production initialize.',
    'No user application, profile, Session or Run is read or controlled.'] }
await fs.mkdir(output, { recursive: true })
assert.equal(await fs.access(path.join(output, 'receipt.json')).then(() => true, () => false), false,
  'Use a new evidence directory; an existing generation must not be overwritten')
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmux-space-appearance-'))
try {
  // The private Main bundle retains Core's external packages; resolve them from this candidate.
  await fs.symlink(path.join(root, 'packages/core/node_modules'), path.join(privateRoot, 'node_modules'))
  const identity = await Promise.all(['HEAD', 'HEAD^{tree}'].map(rev => execFileAsync('git', ['rev-parse', rev], { cwd: root })))
  receipt.candidate = { commit: identity[0].stdout.trim(), tree: identity[1].stdout.trim() }
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', plugins: [sourcePlugin],
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true } })
  await build({ configFile: false, root: fixture, logLevel: 'error', plugins: [sourcePlugin],
    build: { ssr: path.join(fixture, 'main.ts'), target: 'node22', outDir: path.join(privateRoot, 'main'), emptyOutDir: true,
      rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } } })
  const preload = path.join(privateRoot, 'preload.cjs')
  await fs.copyFile(path.join(fixture, 'preload.cjs'), preload)
  receipt.inputs = await hashes()
  for (const name of ['WorkspaceSidebar.tsx', 'SpaceTopicsTree.tsx', 'WorkspaceTopicsPanel.tsx', 'store.ts'])
    assert.ok(Object.keys(receipt.inputs).some(file => file.endsWith('/' + name)), `${name} must actually be loaded`)
  receipt.generatedInputs = Object.fromEntries(Object.entries(receipt.inputs).filter(([file]) => file.startsWith('packages/core/dist/')))
  for (const directory of ['renderer','main'])
    await fs.cp(path.join(privateRoot,directory),path.join(output,'compiled',directory),{recursive:true})
  await fs.copyFile(preload,path.join(output,'compiled/preload.cjs'))
  for (const file of await files(path.join(output,'compiled')))
    receipt.compiledOutputs[path.relative(output, file)] = hash(await fs.readFile(file))
  assert.ok(Object.keys(receipt.compiledOutputs).length > 0)
  for (const [directory, title] of [['topic--view--original', 'Original Topic'], ['topic--view--other', 'Other Topic'], ['topic--launcher--leader', 'Mote']]) {
    const folder = path.join(privateRoot, 'topics', directory)
    await fs.mkdir(path.join(folder, '.agents'), { recursive: true })
    await fs.writeFile(path.join(folder, 'topic.md'), `# ${title}\n\nOriginal shared goal\n`)
  }
  await fs.writeFile(path.join(privateRoot, 'topics/topic--launcher--leader/SOUL.md'), '# Durable Mote identity\n')
  await fs.writeFile(path.join(privateRoot, 'topics/topic--view--original/.agents/codex.private-live-agent.identity.md'), '# Existing private Agent\n')
  await fs.mkdir(path.join(privateRoot, 'folder'), { recursive: true })
  await fs.writeFile(path.join(privateRoot, 'folder/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#586a62" d="M2 2h12v12H2z"/></svg>')
  for (const folder of folderRecency) {
    await fs.mkdir(path.join(privateRoot, folder.directory), { recursive: true })
    if (Object.hasOwn(recencyAssets, folder.asset)) await fs.writeFile(path.join(privateRoot, folder.directory, 'icon.svg'), recencyAssets[folder.asset])
  }
  if (generation.manualFolder) await fs.mkdir(path.join(privateRoot, generation.manualFolder.directory), { recursive: true })
  const durableFiles = [...await files(path.join(privateRoot, 'topics')), ...await files(path.join(privateRoot, 'folder')), ...await files(path.join(privateRoot, 'recency'))]
  const durableHashes = async () => Object.fromEntries(await Promise.all(durableFiles.map(async file =>
    [path.relative(privateRoot, file), hash(await fs.readFile(file))])))
  receipt.filesBefore = await durableHashes()
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of folderRecencyOnly ? ['seed'] : ['seed', 'manual-restore', 'auto-restore']) {
    const log = []
    const exit = await runProbeProcess(require('electron'), [path.join(privateRoot, 'main/main.cjs'),
      path.join(privateRoot, 'renderer/index.html'), privateRoot, phase, preload, output, JSON.stringify(generation),
      receipt.mode],
      { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 45000, onLine: line => log.push(line.slice(0, 2000)) })
    const native = JSON.parse(await fs.readFile(path.join(output, `${phase}.json`), 'utf8'))
    receipt.phases.push({ phase, exit, log, native })
    receipt.images.push(...native.images)
    assert.equal(exit.timedOut, false, `${phase} private fixture watchdog fired`)
    assert.equal(exit.exitCode, 0, native.failure?.message)
    assert.equal(native.passed, true, native.failure?.message)
    assert.deepEqual(native.generation, generation)
  }
  assert.equal(new Set(receipt.phases.map(one => one.native.pid)).size, folderRecencyOnly ? 1 : 3, 'Every selected phase uses a distinct real Electron PID')
  assert.ok(receipt.images.length > 0)
  for (const image of receipt.images) assert.equal(hash(await fs.readFile(path.join(output, image.file))), image.sha256)
  const recencyImages = receipt.images.filter(image => /^(light-)?(normal|narrow)-folder-recency$/.test(image.scene))
  assert.equal(recencyImages.length, folderRecencyOnly ? 4 : 2, 'The same candidate must show the selected facts and identities in full normal/narrow native frames')
  for (const image of recencyImages) {
    assert.equal(image.ui.rail.width, image.scene.includes('normal-') ? 240 : 180, 'The actual Sidebar has normal/narrow geometry in the captured frame')
    const rows = image.ui.targets.filter(target => folderRecency.some(folder => folder.id === target.workspaceId))
    assert.equal(rows.length, folderRecency.length)
    assert.equal(new Set(rows.filter(row => row.detectedImage).map(row => row.detectedImage)).size, 2, 'The actual filesystem appearance owner must supply both colored assets')
    if (folderRecencyOnly) {
      const monograms = rows.filter(row => row.monogram !== null)
      assert.equal(monograms.length, 8, 'Two real absent-image identities expose every recency fact')
      assert.deepEqual([...new Set(monograms.map(row => row.monogram))].sort(), ['N', 'P'])
      assert.equal(image.ui.targets.find(row => row.workspaceId === generation.manualFolder.id)?.source, 'manual')
    }
    for (const folder of folderRecency) assert.equal(rows.find(row => row.workspaceId === folder.id)?.recency, folder.tone)
  }
  receipt.filesAfter = await durableHashes()
  assert.deepEqual(receipt.filesAfter, receipt.filesBefore, 'Presentation must not change Topic/SOUL/Agent content or detected asset')
  assert.deepEqual(await hashes(), receipt.inputs, 'Source changed during this candidate generation')
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  receipt.cleanup = { remaining: await listProbeProcesses(-1, privateRoot), rootRemoved: false }
  if (!receipt.cleanup.remaining.length) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.rootRemoved = true }
  await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
assert.equal(receipt.cleanup.remaining.length, 0)
assert.equal(receipt.cleanup.rootRemoved, true)
assert.equal(receipt.passed, true, receipt.failure?.message)
console.log(JSON.stringify({ passed: true, output, generation, pids: receipt.phases.map(one => one.native.pid), images: receipt.images.length }))
