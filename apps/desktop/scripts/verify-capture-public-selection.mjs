import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

assert.equal(process.argv.length, 2, 'This verification has no optional skipped slices')
const root = process.cwd(), require = createRequire(resolve('apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const sha = value => createHash('sha256').update(value).digest('hex')
const surface = 'apps/desktop/src/main/capture-surface.ts', ipc = 'apps/desktop/src/main/ipc.ts'
const originalSurface = await readFile(surface, 'utf8'), ipcSource = await readFile(ipc, 'utf8')
const adapterStart = "    nativeDesktop: createNativeDesktopPublicOwner(getNativeDesktopOwner(), { hostId: 'local' },"
const adapterEnd = '    images: screenshotPins,'
assert.equal(ipcSource.split(adapterStart).length, 2, 'The production public selection adapter must be unique')
const adapterFrom = ipcSource.indexOf(adapterStart), adapterTo = ipcSource.indexOf(adapterEnd, adapterFrom)
assert.ok(adapterTo > adapterFrom, 'The production public selection adapter must be complete')
const ipcAdapter = ipcSource.slice(adapterFrom, adapterTo)
const mutations = [
  { id: 'cross-request-recall', edits: [
    { from: '      const initialCrop = this.continued(frame, active.session.continuation)',
      to: '      const initialCrop = this.continued(frame, active.session.continuation ?? (this as any).recall)' },
    { from: "    active.end({ state: 'completed' })\n    return { status: 'completed' } satisfies SystemScreenshotEditorFinish",
      to: "    ;(this as any).recall = this.continuation(frameInput, source.rect)\n    active.end({ state: 'completed' })\n    return { status: 'completed' } satisfies SystemScreenshotEditorFinish" }
  ], expected: 'every fresh public capture starts without initialCrop', reached: native => native.grabs.length >= 4 && native.cases.length >= 2 },
  { id: 'public-included-fallback', edits: [{ from: 'active.session.allowBackgroundFallback === false && !usable(first)', to: 'false && !usable(first)' }],
    expected: 'public excluded unavailable must return typed failed instead of offering included pixels', reached: native => native.grabs.length === 10 && native.cases.length >= 4 },
  { id: 'public-background-switch', edits: [{ from: 'active.session.allowBackgroundFallback === false && next !== active.background', to: 'false && next !== active.background' }],
    expected: 'public selection must not switch from excluded to included', reached: native => native.grabs.length >= 6 && native.cases.length >= 3 }
]
const mutated = (source, mutation) => mutation.edits.reduce((text, edit) => text.replace(edit.from, edit.to), source)
for (const mutation of mutations) for (const edit of mutation.edits) assert.equal(originalSurface.split(edit.from).length, 2, 'Unique production mutation anchor: ' + mutation.id)

await mkdir(resolve('.local/capture-public-selection'), { recursive: true })
const out = await mkdtemp(resolve('.local/capture-public-selection/run-'))
const work = await mkdtemp(join(tmpdir(), 'agentmux-capture-public-selection-'))
const receipt = { schema: 'agentmux.capture-public-selection-proof.v1', passed: false, inputs: {}, adapter: { source: ipc, consumed: sha(ipcAdapter) }, build: [], variants: [], mutations: [], native: null }
async function command(label, appRoot) {
  await mkdir(join(out, label), { recursive: true })
  const result = await new Promise((done, reject) => {
    const env = { ...process.env, AGENTMUX_CAPTURE_PUBLIC_SELECTION_OUT: join(out, label),
      AGENTMUX_CAPTURE_PUBLIC_SELECTION_CLI: join(appRoot, '../cli/amux-bin.mjs'), AGENTMUX_CAPTURE_PUBLIC_SELECTION_NODE: process.execPath,
      AGENTMUX_CAPTURE_PUBLIC_SELECTION_IPC: ipcAdapter, ELECTRON_RENDERER_URL: '' }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(require('electron'), [appRoot], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timeout = false, escalation
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; process.stdout.write(bytes) })
    const timer = setTimeout(() => { timeout = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 3000) }, 180000)
    child.once('error', reject)
    child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(escalation); done({ code, signal, timeout, log }) })
  })
  await mkdir(join(out, label), { recursive: true })
  await writeFile(join(out, label, 'electron.log'), result.log)
  assert.equal(result.timeout, false, label + ': timeout is infrastructure failure, not a behavior kill')
  assert.equal(result.signal, null, label + ': external termination is not an owning assertion')
  return result
}
try {
  const appRoot = join(work, 'app'), mainRoot = join(appRoot, 'out/main'), preloadRoot = join(appRoot, 'out/preload'), rendererRoot = join(appRoot, 'out/renderer/screenshot-editor'), cliRoot = join(work, 'cli')
  for (const directory of [mainRoot, preloadRoot, rendererRoot, cliRoot, join(mainRoot, 'user-data')]) await mkdir(directory, { recursive: true })
  await symlink(resolve('apps/desktop/node_modules'), join(appRoot, 'node_modules'))
  await symlink(resolve('packages/core/node_modules'), join(cliRoot, 'node_modules'))
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ type: 'module', main: 'out/main/main.js' }))
  const alias = { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
    '@agentmux/client-ui/theme': resolve('packages/client-ui/src/theme/index.ts'), '@agentmux/native-desktop/image': resolve('packages/native-desktop/src/image.ts') }
  const manifest = JSON.parse(await readFile('packages/core/package.json', 'utf8'))
  const coreModules = { name: 'original-unbundled-core', setup(builder) { builder.onResolve({ filter: /^@agentmux\/core(?:\/.*)?$/ }, args => {
    const key = args.path === '@agentmux/core' ? '.' : '.' + args.path.slice('@agentmux/core'.length)
    const target = manifest.exports[key]?.import
    assert.equal(typeof target, 'string', 'Use the real exported Core module')
    return { path: resolve('packages/core', target), external: true }
  }) } }
  const builds = []
  for (const name of ['capture-surface', 'screenshot-editor']) builds.push(await build({ entryPoints: ['apps/desktop/src/preload/' + name + '.ts'], outfile: join(preloadRoot, name + '.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], metafile: true, logLevel: 'silent' }))
  builds.push(await build({ entryPoints: ['apps/desktop/src/renderer/screenshot-editor/entry.tsx'], outfile: join(rendererRoot, 'entry.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', alias, conditions: ['browser'], metafile: true, logLevel: 'silent' }))
  const htmlFile = 'apps/desktop/src/renderer/screenshot-editor/index.html', html = await readFile(htmlFile, 'utf8')
  await writeFile(join(rendererRoot, 'index.html'), html.replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="./entry.css" /></head>'))
  builds.push(await build({ entryPoints: ['packages/core/src/agentmux.ts'], outfile: join(cliRoot, 'amux.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', metafile: true,
    banner: { js: "import { createRequire as publicSelectionRequire } from 'node:module';const require=publicSelectionRequire(import.meta.url);" }, logLevel: 'silent' }))
  await writeFile(join(cliRoot, 'amux-bin.mjs'), "import './amux.mjs'\n")

  for (const mutation of [null, ...mutations]) {
    const label = mutation?.id ?? 'baseline', consumed = []
    const result = await build({ entryPoints: ['apps/desktop/scripts/fixtures/capture-public-selection/main.ts'], outfile: join(mainRoot, 'main.js'), bundle: true, platform: 'node', format: 'esm',
      external: ['electron'], plugins: [coreModules, { name: 'exact-capture-public-selection-source', setup(builder) { builder.onLoad({ filter: /\/apps\/desktop\/src\/main\/capture-surface\.ts$/ }, async args => {
        assert.equal(args.path, resolve(surface))
        const original = await readFile(args.path, 'utf8')
        assert.equal(original, originalSurface, 'CaptureSurface changed while the public proof was building')
        const contents = mutation ? mutated(original, mutation) : original
        consumed.push({ file: surface, original: sha(original), consumed: sha(contents), mutation: mutation?.id ?? null })
        return { contents, loader: 'ts', resolveDir: dirname(args.path) }
      }) } }], alias, metafile: true, logLevel: 'silent',
      banner: { js: "import { createRequire as fixtureRequire } from 'node:module';const require=fixtureRequire(import.meta.url);" } })
    assert.equal(consumed.length, 1, label + ': production CaptureSurface must load exactly once')
    builds.push(result); receipt.build.push({ label, outputs: result.metafile.outputs })
    const processResult = await command(label, appRoot)
    const native = JSON.parse(await readFile(join(out, label, 'native.json'), 'utf8'))
    receipt.variants.push({ label, consumed, code: processResult.code, native })
    if (!mutation) {
      receipt.native = native
      assert.equal(processResult.code, 0, JSON.stringify(native.failure) + processResult.log)
      assert.equal(native.passed, true)
      assert.equal(native.cases.length, 6)
      assert.equal(native.grabs.length, 10)
    } else {
      assert.notEqual(processResult.code, 0, label + ': production mutant survived')
      assert.equal(native.passed, false)
      assert.equal(native.failure?.name, 'AssertionError', label + ': compilation or infrastructure failure is not a behavior kill')
      assert.ok(native.failure.message.includes(mutation.expected), label + ': owning assertion required; got ' + native.failure.message)
      assert.ok(mutation.reached(native), label + ': the nonempty public CLI/Electron scene must actually execute')
      receipt.mutations.push({ id: mutation.id, killedBy: mutation.expected, failure: native.failure.message, consumed, grabs: native.grabs.length, cases: native.cases.length })
    }
    process.stdout.write(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN') + '\n')
  }
  const files = new Set(builds.flatMap(result => Object.keys(result.metafile.inputs)).filter(file => !file.startsWith('<')))
  for (const file of [htmlFile, ipc, 'apps/desktop/scripts/verify-capture-public-selection.mjs', 'apps/desktop/scripts/fixtures/capture-public-selection/scenario.md']) files.add(file)
  assert.ok([...files].some(file => file.endsWith('apps/desktop/src/main/native-desktop-public.ts')), 'the production public owner must be bundled')
  receipt.inputs = Object.fromEntries(await Promise.all([...files].map(async file => [file, sha(await readFile(file))])))
  for (const [file, hash] of Object.entries(receipt.inputs)) assert.equal(sha(await readFile(file)), hash, 'Candidate changed during proof: ' + file)
  assert.equal(receipt.mutations.length, mutations.length)
  receipt.passed = true
} finally {
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await rm(work, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json'), mutations: receipt.mutations }) + '\n')
