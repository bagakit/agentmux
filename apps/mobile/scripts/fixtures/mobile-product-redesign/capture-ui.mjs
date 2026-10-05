import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runProbeProcess } from '../../../../desktop/scripts/probe-process.mjs'
const fixture = import.meta.dirname, root = path.resolve(fixture, '../../../../..')
const require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const directory = path.join(root, `.tmp/mobile-product-redesign/renderer-${randomUUID()}`), compiled = path.join(directory, 'compiled')

await fs.mkdir(compiled, { recursive: true }); await fs.mkdir(path.join(directory, 'userData'))
const receipt = { passed: false, captureOnly: true, captureSubset: 'mobile-product-redesign', aestheticReview: 'not-performed', source: {}, images: {},
  boundary: 'Actual MobileApp, DeviceWorkface, original ConversationSurface and shared Composer in private Electron Chromium; controlled original SDK/Space/Mote/Goal facts and acknowledgements. Real CDP touch events and browser insertText are simulation, not a physical phone, OS keyboard, live Relay/Host/model/Run, package or install claim.' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
try {
  const mutationId = process.argv.find(value => value.startsWith('--mutation='))?.slice('--mutation='.length)
  const variants = {
    'duplicate-connection': { file: 'apps/mobile/src/MobileApp.tsx', before: '!conversationVisible ? connection.issue', after: 'true ? connection.issue' },
    'hide-unknown': { file: 'apps/mobile/src/conversation/MobileConversationSurface.tsx', before: "{attempt && attempt.phase !== 'confirmed' ? <aside", after: "{attempt && attempt.phase === 'sending' ? <aside" },
    'missing-palette': { file: 'apps/mobile/src/mobile.css', before: "@import '@agentmux/client-ui/styles/palette.css';", after: '' }
  }
  const variant = mutationId ? variants[mutationId] : null
  if (mutationId) assert.ok(variant, 'Known bounded Mobile presentation mutation is required')
  const overrides = []
  if (variant) {
    const original = await fs.readFile(path.join(root, variant.file), 'utf8')
    assert.equal(original.split(variant.before).length - 1, 1, 'Actual production mutation anchor is unique')
    const source = original.replace(variant.before, variant.after)
    receipt.sourceOverride = { id: mutationId, file: variant.file, originalSha256: sha(original), sha256: sha(source) }
    overrides.push({ name: 'bounded-mobile-presentation-mutation', setup(plugin) {
      plugin.onLoad({ filter: /\.(?:tsx|css)$/ }, args => args.path === path.join(root, variant.file)
        ? { contents: source, loader: variant.file.endsWith('.css') ? 'css' : 'tsx', resolveDir: path.dirname(args.path) } : undefined)
    } })
  }
  const alias = {}
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
        assert.ok(source?.startsWith('./src/'), 'Original browser Source export required')
        return { path: path.join(clientFolder, source.replace('*', subpath.slice(prefix.length, suffix ? -suffix.length : undefined))) }
      }
      throw new Error('Missing actual client-ui Source export: ' + subpath)
    })
  } }
  const workerInputs = {}
  const workers = { name: 'original-monaco-workers', setup(plugin) {
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
  for (const name of ['core', 'layout', 'demand', 'relay']) {
    const folder = path.join(root, 'packages', name), manifest = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'))
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      if (subpath.includes('*')) continue
      const source = target.import.replace('./dist/', ['core', 'relay'].includes(name) ? './src/' : './').replace(/\.js$/, '.ts')
      alias['@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))] = path.join(folder, source)
    }
  }
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'product-entry.tsx')], outdir: compiled, bundle: true,
    format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', logLevel: 'error', metafile: true, alias, plugins: [...overrides, clientSources, workers],
    loader: { '.png': 'file', '.gif': 'file', '.svg': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' } })
  for (const file of Object.keys({ ...built.metafile.inputs, ...workerInputs }).filter(file => !file.startsWith('original-worker:') && !file.startsWith('original-url:') && !file.startsWith('(disabled):'))) receipt.source[file] = sha(await fs.readFile(path.resolve(root, file)))
  if (receipt.sourceOverride) {
    assert.equal(receipt.source[receipt.sourceOverride.file], receipt.sourceOverride.originalSha256, 'Mutation targets an actual nonempty production input')
    receipt.source[receipt.sourceOverride.file] = receipt.sourceOverride.sha256
  }
  receipt.virtualInputs = Object.fromEntries(Object.entries(built.metafile.inputs).filter(([name]) => name.startsWith('(disabled):')))
  for (const name of ['capture-ui.mjs', 'product-main.cjs']) receipt.source[path.relative(root, path.join(fixture, name))] = sha(await fs.readFile(path.join(fixture, name)))
  for (const file of ['apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/conversation/MobileAttachments.tsx', 'apps/mobile/src/platform/native/device.ts', 'apps/mobile/src/recovery/device-workface.ts', 'apps/mobile/src/conversation/MobileConversationSurface.tsx']) assert.ok(receipt.source[file], 'Nonempty original product inputs are required')
  await fs.writeFile(path.join(compiled, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="product-entry.css"></head><body><div id="root"></div><script type="module" src="product-entry.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  receipt.process = await runProbeProcess(require('electron'), [path.join(fixture, 'product-main.cjs'), path.join(compiled, 'index.html'), directory, ...(process.argv.includes('--baseline') ? ['baseline'] : process.argv.includes('--navigation') ? ['navigation'] : process.argv.includes('--source-recovery') ? ['source-recovery'] : [])],
    { temporaryRoot: directory, cwd: root, env, timeoutMs: 90000, onLine: line => logs.push(line) })
  await fs.writeFile(path.join(directory, 'renderer.log'), logs.join('\n'))
  receipt.renderer = JSON.parse(await fs.readFile(path.join(directory, 'renderer-result.json'), 'utf8'))
  if (receipt.sourceOverride) assert.equal(sha(await fs.readFile(path.join(root, receipt.sourceOverride.file))), receipt.sourceOverride.originalSha256, 'Private mutation never changes the shared source')
  for (const file of receipt.renderer.images) receipt.images[path.relative(root, path.join(directory, file))] = sha(await fs.readFile(path.join(directory, file)))
  await fs.writeFile(path.join(directory, 'review.md'), '# Mobile product Renderer capture\n\nCapture only; independent aesthetic review has not run. Controlled Chromium is not physical phone validation.\n\nRenderer scenario: ' + (receipt.renderer.passed ? 'completed' : 'failed: ' + receipt.renderer.error?.message) + '\n\n' + receipt.renderer.images.map(file => '- [' + file + '](' + file + ')').join('\n') + '\n')
  assert.equal(receipt.renderer.passed, true, receipt.renderer.error?.message)
  assert.equal(receipt.process.exitCode, 0)
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
receipt.compiled = Object.fromEntries(await Promise.all((await fs.readdir(compiled)).map(async file => [file, sha(await fs.readFile(path.join(compiled, file)))])))
await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await fs.rm(compiled, { recursive: true, force: true })
console.log(path.relative(root, path.join(directory, 'receipt.json')))
if (!receipt.passed) { console.error(receipt.error); process.exitCode = 1 }
