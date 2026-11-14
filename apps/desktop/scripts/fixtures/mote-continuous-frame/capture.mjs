import { browserSourceBuild } from '../../../../../packages/browser/scripts/source-build.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { listProbeProcesses, runProbeProcess, stopProbeProcesses } from '../../probe-process.mjs'
import { radixOverlayAliases } from '../../../../../packages/client-ui/scripts/radix-overlay-aliases.ts'
const fixture = import.meta.dirname, root = path.resolve(fixture, '../../../../..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build } = browserSourceBuild(createRequire(require.resolve('vite'))('esbuild'))
const conversationOnly = process.argv.includes('--conversation-only')
const evolutionOnly = process.argv.includes('--evolution-only')
assert.ok(!(conversationOnly && evolutionOnly), 'Select one bounded real App scene set')
const directory = path.join(root, '.bagakit/mote-frame-rethink/frame-ui', 'capture-' + crypto.randomUUID())
const compiled = path.join(directory, 'compiled')
await fs.mkdir(compiled, { recursive: true }); await fs.mkdir(path.join(directory, 'userData'))
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', captureSubset: evolutionOnly ? 'mote-conversation-evolution-full-app' : conversationOnly ? 'mote-conversation-presence-full-app' : 'mote-continuous-frame-full-app', source: {}, images: {},
  boundary: 'Original App/PmoTeamsTopicFloatingPanel/MoteSpaceFrame/WorkspaceWorkbench/SessionPane/Composer/Store and CSS in private Electron. Original Core conversation projector/codec consumes controlled typed source pages. Exact private Sessions/Run/Space bindings and finite API/native ports only; no real user App/Run, Provider, model, package, install or native recovery claim.' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
try {
  const alias = { ...radixOverlayAliases }
  const clientFolder = path.join(root, 'packages/client-ui')
  const clientExports = Object.entries(JSON.parse(await fs.readFile(path.join(clientFolder, 'package.json'), 'utf8')).exports)
    .sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)
  const clientSources = { name: 'original-client-ui-source', setup(plugin) {
    plugin.onResolve({ filter: /^@agentmux\/client-ui(?:\/.*)?$/ }, args => {
      const subpath = args.path === '@agentmux/client-ui' ? '.' : '.' + args.path.slice('@agentmux/client-ui'.length)
      for (const [key, target] of clientExports) {
        const [prefix, suffix = ''] = key.split('*')
        if (key.includes('*') ? !subpath.startsWith(prefix) || !subpath.endsWith(suffix) : subpath !== key) continue
        const source = typeof target === 'string' ? target : target.browser
        // Brand art ships as files, not source; it resolves to the same file the App bundles.
        if (source?.startsWith('./brand/')) return { path: path.join(clientFolder, source.replace('*', subpath.slice(prefix.length, suffix ? -suffix.length : undefined))) }
        assert.ok(source?.startsWith('./src/'), 'Original browser Source export required')
        return { path: path.join(clientFolder, source.replace('*', subpath.slice(prefix.length, suffix ? -suffix.length : undefined))) }
      }
      throw new Error('Missing actual client-ui Source export: ' + subpath)
    })
  } }
  const workerInputs = {}
  const workers = { name: 'original-monaco-workers', setup(plugin) {
    plugin.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'original-raw' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-raw' }, async args => { workerInputs[args.path] = {}; return { loader: 'js', contents: 'export default ' + JSON.stringify(await fs.readFile(args.path, 'utf8')) } })
    plugin.onResolve({ filter: /\?url$/ }, args => ({ path: require.resolve(args.path.replace(/\?url$/, '')), namespace: 'original-url' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-url' }, async args => {
      workerInputs[args.path] = {}; return { loader: 'file', contents: await fs.readFile(args.path) }
    })
    plugin.onResolve({ filter: /\?worker$/ }, args => ({ path: require.resolve(args.path.replace(/\?worker$/, '')), namespace: 'original-worker' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-worker' }, async args => {
      const output = await build({ absWorkingDir: root, entryPoints: [args.path], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'esnext', metafile: true, logLevel: 'error' })
      Object.assign(workerInputs, output.metafile.inputs)
      return { loader: 'js', contents: `export default class OriginalMonacoWorker extends Worker {constructor(){super(URL.createObjectURL(new Blob([${JSON.stringify(output.outputFiles[0].text)}],{type:'text/javascript'})))}}` }
    })
  } }
  for (const name of ['core', 'layout', 'demand', 'identity']) {
    const folder = path.join(root, 'packages', name), manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'))
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (subpath.includes('*')) continue
      const source = target.import.replace('./dist/', ['core', 'identity'].includes(name) ? './src/' : './').replace(/\.js$/, '.ts')
      alias['@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))] = path.join(folder, source)
    }
  }
  for (const [subpath, target] of Object.entries(JSON.parse(await fs.readFile(path.join(root, 'apps/host/package.json'), 'utf8')).exports)) {
    if (subpath.includes('*')) continue
    alias['@agentmux/host' + (subpath === '.' ? '' : subpath.slice(1))] = path.join(root, 'apps/host', target.import.replace('./dist/', './src/').replace(/\.js$/u, '.ts'))
  }
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'entry.tsx')], outdir: compiled, bundle: true,
    format: 'esm', platform: 'browser', conditions: ['browser', 'production'], target: 'esnext', jsx: 'automatic', logLevel: 'error', metafile: true, alias, plugins: [clientSources, workers],
    loader: { '.png': 'file', '.gif': 'file', '.svg': 'file', '.avif': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' } })
  for (const file of Object.keys({ ...built.metafile.inputs, ...workerInputs }).filter(file => !file.startsWith('original-worker:') && !file.startsWith('original-url:') && !file.startsWith('original-raw:'))) receipt.source[file] = sha(await fs.readFile(path.resolve(root, file)))
  for (const file of [import.meta.filename, path.join(fixture, 'renderer-main.cjs')]) receipt.source[path.relative(root, file)] = sha(await fs.readFile(file))
  for (const file of ['apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/PmoTeamsTopicFloatingPanel.tsx', 'apps/desktop/src/renderer/src/components/MoteSpaceFrame.tsx', 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'apps/desktop/src/renderer/src/components/SessionPane.tsx', 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'apps/desktop/src/renderer/src/components/MoteCooperation.tsx'])
    assert.ok(receipt.source[file], 'Nonempty original product consumer is required: ' + file)
  await fs.writeFile(path.join(compiled, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="entry.css"></head><body><div id="root"></div><script>window.closedTabSetup={phase:"module-loading",errors:[]};window.addEventListener("error",e=>window.closedTabSetup.errors.push(String(e.error?.stack||e.message)));window.addEventListener("unhandledrejection",e=>window.closedTabSetup.errors.push(String(e.reason?.stack||e.reason)));</script><script type="module" src="entry.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  receipt.process = await runProbeProcess(require('electron'), [path.join(fixture, 'renderer-main.cjs'), path.join(compiled, 'index.html'), directory, directory, ...(evolutionOnly ? ['--evolution-only'] : conversationOnly ? ['--conversation-only'] : process.argv.includes('--unknown-only') ? ['--unknown-only'] : [])],
    { cwd: root, env, timeoutMs: 300000, onLine: line => logs.push(line) })
  await fs.writeFile(path.join(directory, 'renderer.log'), logs.join('\n'))
  assert.notEqual(receipt.process.timedOut, true, 'The private Renderer observation timed out; captured partial images do not sign completion')
  receipt.renderer = JSON.parse(await fs.readFile(path.join(directory, 'renderer-result.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0); assert.equal(receipt.renderer.passed, true)
  if (evolutionOnly) {
    assert.deepEqual(receipt.renderer.scenes, ['floating-main', 'switcher-opening', 'switcher-open', 'member-a', 'member-b', 'main-return', 'switcher-closing', 'switcher-closed', 'no-search-results', 'unknown-retained', 'thread-detail', 'space-conversation', 'narrow-long-light', 'reduced-motion', 'new-round', 'confirmed-empty'], 'Every current evolution scenario must actually execute')
    assert.ok(receipt.renderer.images.length >= receipt.renderer.scenes.length, 'Each named scene has a complete real frame')
    assert.ok(receipt.renderer.motion.some(frame => frame.phase === 'opening' && frame.mode === 'animated' && frame.active.length > 0), 'Opening includes actual active production animation observations')
    assert.ok(receipt.renderer.motion.some(frame => frame.phase === 'closing' && frame.mode === 'instant' && !frame.after.present), 'The intended immediate closing is observed without inventing exit motion')
    for (const file of ['apps/desktop/src/renderer/src/components/MoteWorkface.tsx', 'apps/desktop/src/renderer/src/components/MoteCooperation.tsx', 'packages/client-ui/src/components/MoteConversationThreads.tsx'])
      assert.ok(receipt.source[file], 'Original evolution product consumer required: ' + file)
  } else assert.equal(receipt.renderer.images.length, conversationOnly ? 9 : process.argv.includes('--unknown-only') ? 1 : 8, 'Every named real product scene must be captured')
  if (conversationOnly) for (const file of ['apps/desktop/src/renderer/src/components/MoteConversationIdentity.tsx', 'packages/client-ui/src/components/ConversationView.tsx', 'packages/client-ui/src/components/CapturedConversationMessage.tsx', 'packages/client-ui/src/components/ConversationMessage.tsx', 'packages/client-ui/src/components/ConversationSubmissionMetadata.tsx'])
    assert.ok(receipt.source[file], 'Original conversation presence consumer required: ' + file)
  for (const file of receipt.renderer.images) receipt.images[path.relative(root, path.join(directory, file))] = sha(await fs.readFile(path.join(directory, file)))
  receipt.sourceDrift = []
  for (const [file, expected] of Object.entries(receipt.source)) if (sha(await fs.readFile(path.resolve(root, file))) !== expected) receipt.sourceDrift.push(file)
  assert.deepEqual(receipt.sourceDrift, [], 'Renderer inputs changed during capture; the receipt cannot sign a different candidate')
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
receipt.compiled = Object.fromEntries(await Promise.all((await fs.readdir(compiled)).map(async file => [file, sha(await fs.readFile(path.join(compiled, file)))])))
const group = receipt.process?.originalPid
if (group && (await listProbeProcesses(group, directory)).length) await stopProbeProcesses(group, directory)
receipt.cleanup = { remaining: group ? await listProbeProcesses(group, directory) : [] }
if (!receipt.cleanup.remaining.length) {
  await fs.rm(path.join(directory, 'userData'), { recursive: true, force: true })
  await fs.rm(path.join(directory, 'sessionData'), { recursive: true, force: true })
  receipt.cleanup.privateProfileRemoved = true
}
await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await fs.writeFile(path.join(directory, 'review.md'), '# Mote continuous frame — full Renderer images\n\nCapture only; independent aesthetic review has not been performed.\n\n' + receipt.boundary + '\n\n' + Object.keys(receipt.images).map(file => '- [' + path.basename(file) + '](' + path.basename(file) + ')').join('\n') + '\n')
if (receipt.passed) await fs.rm(compiled, { recursive: true, force: true })
console.log(path.relative(root, path.join(directory, 'receipt.json')))
if (receipt.passed) await fs.writeFile(path.join(directory, '..', 'latest.json'), JSON.stringify({ receipt: path.join(directory, 'receipt.json'), capturedAt: new Date().toISOString() }, null, 2) + '\n')
else { console.error(receipt.error); process.exitCode = 1 }
