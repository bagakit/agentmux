import { radixOverlayAliases } from '../../radix-overlay-aliases.ts'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runProbeProcess } from '../../probe-process.mjs'
const fixture = import.meta.dirname, root = path.resolve(fixture, '../../../../..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const terminalRestartOnly = process.argv.includes('--terminal-restart-only')
const directory = path.join(path.resolve(root, '../..'), (".local/state/mote-surface-repair/" + (terminalRestartOnly ? 'terminal-restart' : 'renderer') + "-" + (globalThis.crypto.randomUUID()) + "")), compiled = path.join(directory, 'compiled')
const selectFields = process.argv.includes('--select-fields')
const recoveryPolicy = process.argv.includes('--recovery-policy')
const executorPicker = process.argv.includes('--executor-picker')
const quickMode = true, sourceFixture = fixture
const entry = 'entry', main = 'main.cjs'
const behaviorOnly = process.argv.includes('--behavior-only')
const ideasOnly = process.argv.includes('--ideas-only')
const feedbackOnly = process.argv.includes('--feedback-only')
await fs.mkdir(compiled, { recursive: true }); await fs.mkdir(path.join(directory, 'userData'))
const receipt = { passed: false, captureOnly: true, captureSubset: terminalRestartOnly ? 'pinned-terminal-restart-and-explicit-open' : recoveryPolicy ? 'recovery-policy' : executorPicker ? 'executor-picker' : selectFields ? 'select-fields' : quickMode ? 'quick-mode' : behaviorOnly ? 'behavior-only' : feedbackOnly ? 'feedback-only' : ideasOnly ? 'ideas-only' : 'full', aestheticReview: 'not-performed', source: {}, images: {},
  boundary: quickMode ? 'Original Profile, WorkspaceWorkbench, SessionPane, Composer and Editor in an isolated Electron Renderer. Controlled original Files/Session replies and actual configured identities; trusted mouse/keyboard through original menu selection. No live App/Run, native lifecycle, model, package or install claim.' : 'Original Profile/Editor/NewTabSurface/Store and Desktop styles in an isolated Electron Renderer. Controlled filesystem/history/Goal API replies, synthetic exact Session reference and no configured Executor; no live user App/Run, Core native lifecycle, model, package or install claim.' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
try {
  const alias = { ...radixOverlayAliases, ...Object.fromEntries(['delivery-diagnostics','composer-file-reference','composer-semantic-reference','error-presentation'].map(name => ['@agentmux/client-ui/'+name,path.join(root,'packages/client-ui/src/lib/'+name+'.ts')])) }
  const workerInputs = {}
  const workers = { name: 'original-monaco-workers', setup(plugin) {
    plugin.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'original-raw' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-raw' }, async args => {
      workerInputs[args.path] = {}; return { loader: 'js', contents: 'export default ' + JSON.stringify(await fs.readFile(args.path, 'utf8')) }
    })
    plugin.onResolve({ filter: /\?url$/ }, args => ({ path: require.resolve(args.path.replace(/\?url$/, '')), namespace: 'original-url' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-url' }, async args => {
      workerInputs[args.path] = {}; return { loader: 'file', contents: await fs.readFile(args.path) }
    })
    plugin.onResolve({ filter: /\?worker$/ }, args => ({ path: require.resolve(args.path.replace(/\?worker$/, '')), namespace: 'original-worker' }))
    plugin.onLoad({ filter: /.*/, namespace: 'original-worker' }, async args => {
      const output = await build({ absWorkingDir: root, entryPoints: [args.path], bundle: true, minify: true, write: false, platform: 'browser', format: 'iife', target: 'esnext', metafile: true, logLevel: 'error' })
      Object.assign(workerInputs, output.metafile.inputs)
      return { loader: 'js', contents: `export default class OriginalMonacoWorker extends Worker {constructor(){super(URL.createObjectURL(new Blob([${JSON.stringify(output.outputFiles[0].text)}],{type:'text/javascript'})))}}` }
    })
  } }
  for (const name of ['core', 'layout', 'demand']) {
    const folder = path.join(root, 'packages', name), manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'))
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (subpath.includes('*')) continue
      const source = target.import.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts')
      alias['@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))] = path.join(folder, source)
    }
  }
  const clientUiRoot = path.join(root, 'packages/client-ui'), clientUiManifest = JSON.parse(await fs.readFile(path.join(clientUiRoot, 'package.json'), 'utf8'))
  const clientUiSource = { name: 'original-client-ui-source', setup(plugin) { plugin.onResolve({ filter: /^@agentmux\/client-ui(?:\/.*)?$/ }, args => { const key = args.path === '@agentmux/client-ui' ? '.' : '.' + args.path.slice('@agentmux/client-ui'.length); const entries = Object.entries(clientUiManifest.exports).sort(([a],[b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length-a.length); for (const [sub, target] of entries) { const [before,after] = sub.split('*'); if (sub !== key && (!sub.includes('*') || !key.startsWith(before) || !key.endsWith(after))) continue; const source = typeof target === 'string' ? target : target.browser; if (!source) throw Error('Missing current Source export'); return { path: path.join(clientUiRoot, source.replace('*', sub.includes('*') ? key.slice(before.length, key.length-after.length) : '')) } } throw Error('Unknown original UI export '+key) }) } }
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(sourceFixture, entry + '.tsx')], outdir: compiled, bundle: true, minify: true,
    format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', logLevel: 'error', metafile: true, alias, plugins: [clientUiSource, workers],
    loader: { '.png': 'file', '.gif': 'file', '.svg': 'file', '.woff2': 'file', '.ttf': 'file' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' } })
  for (const file of Object.keys({ ...built.metafile.inputs, ...workerInputs }).filter(file => !file.startsWith('original-worker:') && !file.startsWith('original-url:') && !file.startsWith('original-raw:'))) receipt.source[file] = sha(await fs.readFile(path.resolve(root, file)))
  if (selectFields) {
    receipt.overlayModules = Object.fromEntries(['react-dismissable-layer', 'react-focus-scope'].map(name => {
      const entries = Object.keys(built.metafile.inputs).filter(file => file.includes('/@radix-ui/' + name + '/dist/'))
      assert.equal(entries.length, 1, 'Each shared overlay primitive must have one compiled module owner: ' + name)
      return [name, entries]
    }))
  }
  for (const file of [import.meta.filename, path.join(sourceFixture, main), path.join(root, 'apps/desktop/scripts/radix-overlay-aliases.ts')]) receipt.source[path.relative(root, file)] = sha(await fs.readFile(file))
  for (const file of ['apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', 'apps/desktop/src/renderer/src/lib/mote-cooperation.ts', 'apps/desktop/src/renderer/src/lib/mote-materials-actions.ts', 'apps/desktop/src/renderer/src/components/FileSurfaceView.tsx']) assert.ok(receipt.source[file], 'Nonempty original product inputs are required')
  await fs.writeFile(path.join(compiled, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="' + entry + '.css"></head><body><div id="root"></div><script type="module" src="' + entry + '.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  receipt.process = await runProbeProcess(require('electron'), [path.join(sourceFixture, main), path.join(compiled, 'index.html'), directory, directory, ...(terminalRestartOnly ? ['--terminal-restart-only'] : []), ...(recoveryPolicy ? ['--recovery-policy'] : executorPicker ? ['--executor-picker'] : selectFields ? ['--select-fields'] : behaviorOnly ? ['--behavior-only'] : feedbackOnly ? ['--feedback-only'] : ideasOnly ? ['--ideas-only'] : [])],
    { temporaryRoot: directory, cwd: root, env, timeoutMs: 90000, onLine: line => logs.push(line) })
  await fs.writeFile(path.join(directory, 'renderer.log'), logs.join('\n'))
  receipt.renderer = JSON.parse(await fs.readFile(path.join(directory, 'renderer-result.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0); assert.equal(receipt.renderer.passed, true)
  const restartLogs=[]
  receipt.restartProcess=await runProbeProcess(require('electron'),[path.join(sourceFixture, main),path.join(compiled,'index.html'),directory,directory,'--restart-read',...(terminalRestartOnly ? ['--terminal-restart-only'] : [])],{temporaryRoot: directory,cwd: root,env,timeoutMs: 30000,onLine: line => restartLogs.push(line)})
  await fs.writeFile(path.join(directory,'renderer-restart.log'),restartLogs.join('\n'))
  receipt.restart=JSON.parse(await fs.readFile(path.join(directory,'renderer-restart-result.json'),'utf8'))
  assert.equal(receipt.restartProcess.exitCode,0);assert.equal(receipt.restart.passed,true)
  assert.notEqual(receipt.renderer.pid,receipt.restart.pid)
  receipt.renderer.images.push(...receipt.restart.images)
  for (const file of receipt.renderer.images) receipt.images[path.relative(root, path.join(directory, file))] = sha(await fs.readFile(path.join(directory, file)))
  if (behaviorOnly) {
    const frame = name => receipt.renderer.operations.find(item => item.name === name)
    for (const surface of ['profile', 'studio']) for (const width of ['wide', 'narrow']) {
      const dark = `${surface}-${width}-dark`, light = `${surface}-${width}-light`
      assert.notEqual(frame(dark).background, frame(light).background, 'Actual dark/light theme backgrounds must differ')
      assert.notEqual(receipt.images[path.relative(root, path.join(directory, dark + '.png'))], receipt.images[path.relative(root, path.join(directory, light + '.png'))], 'Actual dark/light PNG bytes must differ')
    }
  }
  receipt.sourceDrift=[]
  for (const [file,hash] of Object.entries(receipt.source)) if(sha(await fs.readFile(path.resolve(root,file)))!==hash) receipt.sourceDrift.push(file)
  assert.deepEqual(receipt.sourceDrift,[], 'Product Source changed after capture; affected qualification must be repeated')
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
receipt.compiled = Object.fromEntries(await Promise.all((await fs.readdir(compiled)).map(async file => [file, sha(await fs.readFile(path.join(compiled, file)))])))
await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await fs.rm(compiled, { recursive: true, force: true })
console.log(path.relative(root, path.join(directory, 'receipt.json')))
if (!receipt.passed) { console.error(receipt.error); process.exitCode = 1 }
