import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

assert.equal(process.argv.length, 2, 'This source verification has no optional skipped scenarios')
const retryMutation = process.env.SCREENSHOT_SOURCE_RETRY_MUTATION === '1'
assert.ok(process.env.SCREENSHOT_SOURCE_RETRY_MUTATION === undefined || retryMutation, 'The retry counterexample must be selected explicitly')
const root = process.cwd(), require = createRequire(resolve('apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(resolve('.local/screenshot-sources'), { recursive: true })
const out = await mkdtemp(resolve('.local/screenshot-sources/run-')), work = await mkdtemp(join(tmpdir(), 'amux-source-'))
const receipt = { schema: 'agentmux.screenshot-sources-proof.v1', passed: false, sourceHashes: {}, loadedSources: {}, native: null,
  boundary: 'Real production source selection windows and trusted Renderer actions with a controlled native discovery port. OS pixel capture, independent visual approval and complete Composer delivery remain separate.' }
const consumed = new Map(), loadedSources = new Map()
const sources = { name: 'record-exact-source-consumption', setup(builder) {
  builder.onLoad({ filter: /\.(?:[cm]?[jt]sx?|css)$/ }, async args => {
    if (!args.path.startsWith(root + '/') || args.path.includes('/node_modules/')) return
    let contents = await readFile(args.path, 'utf8')
    const path = relative(root, args.path), sha = hash(contents)
    if (consumed.has(path)) assert.equal(consumed.get(path), sha, 'A production source changed between private build consumers: ' + path)
    consumed.set(path, sha)
    const mutate = retryMutation && path === 'apps/desktop/src/renderer/screenshot-editor/ScreenshotSourceView.tsx'
    if (mutate) {
      const anchor = 'load(requestedApp.current)'
      assert.equal(contents.split(anchor).length, 2, 'The exact original retry target consumer exists once')
      contents = contents.replace(anchor, 'load(app)')
    }
    loadedSources.set(path, { source: sha, consumed: hash(contents), mutation: mutate ? 'retry-displayed-stage' : null })
    const extension = args.path.split('.').at(-1), loader = extension === 'css' ? 'css' : extension === 'tsx' || extension === 'jsx' ? extension : extension === 'ts' || extension === 'mts' || extension === 'cts' ? 'ts' : 'js'
    return { contents, loader }
  })
} }
const manifest = JSON.parse(await readFile('packages/core/package.json', 'utf8'))
const coreModules = { name: 'original-unbundled-core', setup(builder) {
  builder.onResolve({ filter: /^@agentmux\/core(?:\/.*)?$/ }, args => {
    const key = args.path === '@agentmux/core' ? '.' : '.' + args.path.slice('@agentmux/core'.length), target = manifest.exports[key]?.import
    assert.equal(typeof target, 'string', 'Use an actual exported Core module')
    return { path: resolve('packages/core', target), external: true }
  })
} }
try {
  const appRoot = join(work, 'app'), mainRoot = join(appRoot, 'out/main'), preloadRoot = join(appRoot, 'out/preload'), rendererRoot = join(appRoot, 'out/renderer/screenshot-editor')
  for (const directory of [mainRoot, preloadRoot, rendererRoot]) await mkdir(directory, { recursive: true })
  await symlink(resolve('apps/desktop/node_modules'), join(appRoot, 'node_modules'))
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ type: 'module', main: 'out/main/main.js' }))
  const alias = { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
    '@agentmux/client-ui/theme': resolve('packages/client-ui/src/theme/index.ts') }
  await build({ entryPoints: ['apps/desktop/scripts/fixtures/screenshot-sources/main.ts'], outfile: join(mainRoot, 'main.js'), bundle: true, platform: 'node', format: 'esm',
    external: ['electron'], plugins: [coreModules, sources], alias, logLevel: 'silent' })
  await build({ entryPoints: ['apps/desktop/src/preload/screenshot-source.ts'], outfile: join(preloadRoot, 'screenshot-source.cjs'), bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], plugins: [sources], logLevel: 'silent' })
  await build({ entryPoints: ['apps/desktop/src/preload/screenshot-countdown.ts'], outfile: join(preloadRoot, 'screenshot-countdown.cjs'), bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], plugins: [sources], logLevel: 'silent' })
  await build({ entryPoints: ['apps/desktop/src/renderer/screenshot-editor/entry.tsx'], outfile: join(rendererRoot, 'entry.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic',
    conditions: ['browser'], plugins: [sources], alias, logLevel: 'silent' })
  const htmlPath = 'apps/desktop/src/renderer/screenshot-editor/index.html', html = await readFile(htmlPath, 'utf8')
  consumed.set(htmlPath, hash(html))
  await writeFile(join(rendererRoot, 'index.html'), html.replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="./entry.css" /></head>'))
  for (const path of ['apps/desktop/scripts/fixtures/screenshot-sources/scenario.md', 'apps/desktop/scripts/verify-screenshot-sources.mjs']) consumed.set(path, hash(await readFile(path)))
  receipt.sourceHashes = Object.fromEntries(consumed)
  receipt.loadedSources = Object.fromEntries(loadedSources)
  assert.ok(consumed.has('apps/desktop/src/main/screenshot-source-picker.ts') && consumed.has('apps/desktop/src/preload/screenshot-source.ts') && consumed.has('apps/desktop/src/renderer/screenshot-editor/ScreenshotSourceView.tsx'), 'Consume all three real product owners')
  const result = await new Promise((done, reject) => {
    const env = { ...process.env, SCREENSHOT_SOURCES_OUT: out, ELECTRON_RENDERER_URL: '' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(require('electron'), [appRoot], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timedOut = false
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log += data; process.stdout.write(data) })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 45000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); done({ code, signal, log, timedOut }) })
  })
  await writeFile(join(out, 'native.log'), result.log)
  assert.equal(result.timedOut, false, 'An infrastructure timeout is not a source selection result')
  assert.equal(result.signal, null, 'A terminated private process is not behavior proof')
  receipt.native = JSON.parse(await readFile(join(out, 'native.json'), 'utf8'))
  assert.equal(result.code, 0, JSON.stringify(receipt.native.failure) + result.log)
  assert.equal(receipt.native.passed, true)
  assert.deepEqual(receipt.native.cases.map(row => row.name), ['exact-second-display-with-partial-discovery', 'same-label-application-filter-and-exact-window', 'failed-window-discovery-retries-exact-original-application', 'failed-discovery-retry-and-escape', 'pending-discovery-cancel-late-read-and-next-selection', 'delayed-capture-countdown-cancel-and-elapse'])
  assert.deepEqual(receipt.native.screenshots.map(row => row.file), ['displays-dark.png', 'displays-narrow-dark.png', 'applications-light.png', 'applications-narrow-light.png', 'windows-light.png', 'windows-narrow-light.png', 'discovery-failure-dark.png', 'countdown-dark.png', 'countdown-light.png'])
  for (const [path, sha] of consumed) assert.equal(hash(await readFile(path)), sha, 'Source selection candidate changed during proof: ' + path)
  receipt.passed = true
} finally {
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await rm(work, { recursive: true, force: true })
}
console.log(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json'), screenshots: receipt.native?.screenshots }))
