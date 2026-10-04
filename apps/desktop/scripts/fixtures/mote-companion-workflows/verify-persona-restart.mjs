import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve, relative, dirname } from 'node:path'
import { runProbeProcess } from '../../probe-process.mjs'

const root = resolve(import.meta.dirname, '../../../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const capturePath = resolve(root, process.argv[2] ?? ''), capture = JSON.parse(await readFile(capturePath, 'utf8'))
assert.equal(capture.passed, true, 'A failed Renderer candidate cannot supply qualified input')
const renderer = JSON.parse(await readFile(join(dirname(capturePath), 'renderer-result.json'), 'utf8'))
const behaviorOnly = capture.captureSubset === 'behavior-only'
const required = behaviorOnly ? ['behavior-saved-reopened', 'cooperation-new-launcher-no-executor', 'cooperation-later-input-kept'] : ['cooperation-new-launcher-no-executor', 'cooperation-later-input-kept', 'ideas-context-unknown', 'ideas-mote-aba-input-kept']
const cases = renderer.restartInputs.map(item => ({ ...item, captureFile: capturePath }))
const captureOwners = new Map([[capturePath, capture]])
let reusedCooperationSource = {}
// A wording-only Ideas recapture can reuse unchanged cooperation observations, with an explicit
// per-case Source receipt rather than claiming those older frames came from this new process.
if (!behaviorOnly && !required.every(name => cases.some(item => item.name === name))) {
  const cooperationOwners = [
    'apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', 'apps/desktop/src/renderer/src/lib/mote-materials-actions.ts',
    'apps/desktop/src/renderer/src/lib/mote-cooperation.ts', 'apps/desktop/src/renderer/src/store.ts',
    'apps/desktop/src/renderer/src/lib/launcher-state.ts', 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts',
    'apps/desktop/src/renderer/src/lib/workbench-persistence.ts', 'apps/desktop/src/shared/space-addresses.ts',
    'apps/desktop/src/shared/scratch-topics.ts', 'packages/core/src/public-rpc-files.ts'
  ]
  const hashes = Object.fromEntries(await Promise.all(cooperationOwners.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
  const names = (await readdir(dirname(dirname(capturePath)))).filter(name => /^persona-renderer-\d+$/.test(name)).sort((a, b) => Number(b.slice('persona-renderer-'.length)) - Number(a.slice('persona-renderer-'.length)))
  for (const name of names) {
    const file = join(dirname(dirname(capturePath)), name, 'receipt.json')
    if (file === capturePath) continue
    let previous
    try { previous = JSON.parse(await readFile(file, 'utf8')) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (!previous.passed || cooperationOwners.some(owner => previous.source[owner] !== hashes[owner])) continue
    const observation = JSON.parse(await readFile(join(dirname(file), 'renderer-result.json'), 'utf8'))
    const original = (observation.restartInputs ?? []).filter(item => required.slice(0, 2).includes(item.name))
    if (original.length !== 2) continue
    cases.push(...original.map(item => ({ ...item, captureFile: file }))); captureOwners.set(file, previous); reusedCooperationSource = hashes; break
  }
}
assert.deepEqual(cases.map(item => item.name).sort(), [...required].sort(), 'The complete nonempty original Renderer cases are required')
const directory = join(root, '.tmp/mote-companion/persona-restart-' + globalThis.crypto.randomUUID()), compiled = join(directory, 'compiled')
await mkdir(compiled, { recursive: true })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { passed: false, source: {}, rendererCapture: relative(root, capturePath), rendererCaptureSha: sha(await readFile(capturePath)), cases: [],
  reusedCooperationSource,
  captures: await Promise.all([...captureOwners.keys()].map(async file => ({ file: relative(root, file), sha256: sha(await readFile(file)) }))),
  boundary: 'Exact original Renderer-created Launcher/Space/Zone/Group/Region and unsent bytes, saved and initialized again by the original Workbench/LauncherState and real filesystem Core Spatial owner in distinct Node processes. Reused cooperation observations identify their unchanged Source and original capture separately. Behavior-only case also uses original Store.saveDocument to the original Main WorkspaceFiles atomic filesystem owner, then reads canonical saved block/full revision in two fresh processes. No live Session, Run, Native, model or installed App qualification.' }
try {
  const alias = { '@agentmux/layout': join(root, 'packages/layout/src/index.ts') }
  for (const name of ['core', 'demand']) {
    const folder = join(root, 'packages', name), manifest = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8'))
    for (const [key, target] of Object.entries(manifest.exports)) {
      if (!target.import || key.includes('*')) continue
      alias['@agentmux/' + name + (key === '.' ? '' : key.slice(1))] = join(folder, target.import.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts'))
    }
  }
  const lazyBrowserInputs = {}
  const worker = join(compiled, 'worker.mjs')
  const built = await build({ absWorkingDir: root, entryPoints: [join(import.meta.dirname, 'persona-restart-entry.ts')], outfile: worker, bundle: true, platform: 'node', format: 'esm', alias, metafile: true,
    plugins: [{ name: 'original-lazy-browser-source', setup(plugin) {
      plugin.onResolve({ filter: /components\/(?:FileSurfaceView|FileSourceEditor)$/ }, async args => {
        const original = resolve(args.resolveDir, args.path + '.tsx')
        lazyBrowserInputs[relative(root, original)] = sha(await readFile(original))
        return { path: original, external: true }
      })
    } }, { name: 'current-client-ui-source', setup(plugin) {
      plugin.onResolve({ filter: /^@agentmux\/client-ui\// }, args => ({ path: join(root, 'packages/client-ui/src/lib', args.path.slice('@agentmux/client-ui/'.length) + '.ts') }))
    } }, { name: 'installed-dependencies', setup(plugin) {
      plugin.onResolve({ filter: /^[^./]/ }, args => {
        if (Object.hasOwn(alias, args.path)) return { path: alias[args.path] }
        if (args.path.startsWith('node:')) return { path: args.path, external: true }
        const installed = createRequire(join(args.resolveDir, 'package.json')).resolve(args.path)
        return { path: args.path.startsWith('@tiptap/') ? installed.replace(/\.cjs$/, '.js') : installed, external: true }
      })
    } }], define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, loader: { '.css': 'empty' }, logLevel: 'error' })
  for (const file of Object.keys(built.metafile.inputs).filter(file => /^(apps|packages)\//.test(file))) receipt.source[file] = sha(await readFile(join(root, file)))
  Object.assign(receipt.source, lazyBrowserInputs)
  receipt.lazyBrowserInputs = lazyBrowserInputs // Retained original import, not executed by this data-owner process. Renderer capture qualifies its UI separately.
  receipt.source[relative(root, import.meta.filename)] = sha(await readFile(import.meta.filename))
  for (const file of ['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/launcher-state.ts', 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts']) {
    assert.ok(receipt.source[file])
    for (const candidate of captureOwners.values()) assert.equal(receipt.source[file], candidate.source[file], 'The process owner must match each captured original Renderer Source')
  }
  receipt.compiledSha = sha(await readFile(worker))
  for (const captured of cases) {
    const stateDirectory = join(directory, captured.name); await mkdir(stateDirectory)
    const inputFile = join(stateDirectory, 'renderer-input.json'); await writeFile(inputFile, JSON.stringify({ ...captured.state, privateRoot: dirname(captured.captureFile) }, null, 2))
    const outputs = []
    for (const mode of ['write', 'read', 'read']) {
      const lines = [], process = await runProbeProcess(globalThis.process.execPath, [worker, mode, stateDirectory, inputFile],
        { temporaryRoot: directory, cwd: root, env: { ...globalThis.process.env, NODE_PATH: join(root, 'packages/core/node_modules') }, timeoutMs: 30000, onLine: line => lines.push(line) })
      await writeFile(join(stateDirectory, mode + '-' + outputs.length + '.log'), lines.join('\n'))
      assert.equal(process.exitCode, 0, lines.join('\n'))
      const output = JSON.parse(await readFile(join(stateDirectory, mode + '-output.json'), 'utf8'))
      outputs.push(output)
      assert.equal(output.fileWrites, captured.state.behavior && mode === 'write' ? 1 : 0);
      if (captured.state.behavior) {
        assert.equal(output.behavior.document.path, captured.state.behavior.path); assert.equal(output.behavior.document.content, captured.state.behavior.content)
        assert.equal(output.behavior.document.revision, 'sha256:' + sha(Buffer.from(captured.state.behavior.content)))
        assert.equal(output.behavior.block.status, 'valid'); assert.equal(output.behavior.block.code, 'INFJ')
        assert.equal(output.behavior.block.preferences.custom, 'Use concrete examples and ask before changing the scope.')
      }
       assert.equal(output.warning, null); assert.equal(output.launcherIssue, null)
      assert.deepEqual(output.tabs, captured.state.tabs); assert.deepEqual(output.layouts, captured.state.layouts)
      assert.deepEqual(output.selection, captured.state.selection); assert.deepEqual(output.agentComposerDrafts, captured.state.agentComposerDrafts)
      assert.deepEqual(output.launcherState, captured.state.launcherState)
      assert.ok(output.spatial.revision > 0); assert.ok(output.spatial.graph.tabs.length > 0)
      assert.deepEqual(output.savedWorkbench.state.agentComposerDrafts, captured.state.agentComposerDrafts)
      if (Object.keys(captured.state.launcherState.drafts).length) assert.deepEqual(output.savedLauncher.state, captured.state.launcherState)
    }
    assert.equal(new Set(outputs.map(output => output.pid)).size, 3, 'Readback must run in fresh processes')
    assert.deepEqual(outputs[1].behavior, outputs[0].behavior); assert.deepEqual(outputs[2].behavior, outputs[0].behavior)
    assert.deepEqual(outputs[1].spatial.graph, outputs[0].spatial.graph); assert.deepEqual(outputs[2].spatial.graph, outputs[0].spatial.graph)
    await writeFile(join(stateDirectory, 'process-results.json'), JSON.stringify(outputs, null, 2))
    receipt.cases.push({ name: captured.name, capture: relative(root, captured.captureFile), passed: true, pids: outputs.map(output => output.pid), inputSha: sha(await readFile(inputFile)), results: relative(root, join(stateDirectory, 'process-results.json')) })
  }
  for (const [file, digest] of Object.entries(receipt.source)) assert.equal(sha(await readFile(join(root, file))), digest, 'Source changed during the readback qualification')
  for (const [file, digest] of Object.entries(reusedCooperationSource)) assert.equal(sha(await readFile(join(root, file))), digest, 'A reused cooperation owner changed during the readback qualification')
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await rm(compiled, { recursive: true, force: true }); receipt.cleanup = { compiledRemoved: true }
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(relative(root, join(directory, 'receipt.json')))
}
if (!receipt.passed) console.error(receipt.error)
