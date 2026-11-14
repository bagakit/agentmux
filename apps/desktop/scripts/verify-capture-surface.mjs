import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const flags = process.argv.slice(2)
assert.ok(flags.length === 0 || (flags.length === 1 && flags[0] === '--mutations'), 'Usage: verify-capture-surface.mjs [--mutations]')
const withMutations = flags.includes('--mutations')
const root = process.cwd(), require = createRequire(resolve('apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const surface = 'apps/desktop/src/main/capture-surface.ts'
const originalSurface = await readFile(surface, 'utf8')
const mutations = [
  { id: 'host-opacity-write', from: '    const excluded = active.visibleHosts > 0 ? await freeze(false) : included',
    to: '    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed() && window.isVisible() && !window.isMinimized() && window.getOpacity() > 0) window.setOpacity(0)\n    const excluded = active.visibleHosts > 0 ? await freeze(false) : included',
    expected: 'the visible host keeps its exact prior opacity while editing', reached: native => native.grabs.length === 2 && native.cases.length === 1 },
  { id: 'swapped-background-sources', from: '        backgrounds: { included: includedFrame, excluded: included === excluded ? includedFrame : background(excluded) },',
    to: '        backgrounds: { included: background(excluded), excluded: background(included) },',
    expected: 'the actual editor image is the requested frozen source', reached: native => native.grabs.length === 2 && native.cases.length === 1 },
  { id: 'cross-request-recall', edits: [
    { from: '      const initialCrop = this.continued(frame, active.session.continuation)',
      to: '      const initialCrop = this.continued(frame, active.session.continuation ?? (this as any).recall)' },
    { from: "    active.end({ state: 'completed' })\n    return { status: 'completed' } satisfies SystemScreenshotEditorFinish",
      to: "    ;(this as any).recall = this.continuation(frameInput, source.rect)\n    active.end({ state: 'completed' })\n    return { status: 'completed' } satisfies SystemScreenshotEditorFinish" }
  ], expected: 'every fresh capture starts without initialCrop', reached: native => native.grabs.length >= 4 && native.cases.length >= 2 }
]
const mutated = (source, mutation) => (mutation?.edits ?? (mutation ? [{ from: mutation.from, to: mutation.to }] : [])).reduce((text, edit) => text.replace(edit.from, edit.to), source)
for (const mutation of mutations) for (const edit of mutation.edits ?? [mutation]) assert.equal(originalSurface.split(edit.from).length, 2, 'Unique production mutation anchor: ' + mutation.id)

await mkdir(resolve('.local/capture-surface'), { recursive: true })
const out = await mkdtemp(resolve('.local/capture-surface/run-'))
const work = await mkdtemp(join(tmpdir(), 'agentmux-capture-surface-'))
const receipt = { schema: 'agentmux.capture-surface-product-proof.v1', passed: false, withMutations, inputs: {}, native: null, build: [], variants: [], mutations: [], log: join(out, 'electron.log') }
try {
  const appRoot = join(work, 'app'), mainRoot = join(appRoot, 'out/main'), preloadRoot = join(appRoot, 'out/preload'), rendererRoot = join(appRoot, 'out/renderer/screenshot-editor')
  for (const directory of [mainRoot, preloadRoot, rendererRoot, join(mainRoot, 'user-data')]) await mkdir(directory, { recursive: true })
  await symlink(resolve('apps/desktop/node_modules'), join(appRoot, 'node_modules'))
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ type: 'module', main: 'out/main/main.js' }))
  const alias = { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
    '@agentmux/client-ui/theme': resolve('packages/client-ui/src/theme/index.ts'), '@agentmux/native-desktop/image': resolve('packages/native-desktop/src/image.ts') }
  const results = []
  for (const name of ['capture-surface', 'screenshot-editor']) results.push(await build({ entryPoints: ['apps/desktop/src/preload/' + name + '.ts'], outfile: join(preloadRoot, name + '.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], metafile: true, logLevel: 'silent' }))
  results.push(await build({ entryPoints: ['apps/desktop/src/renderer/screenshot-editor/entry.tsx'], outfile: join(rendererRoot, 'entry.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', alias,
    conditions: ['browser'], metafile: true, logLevel: 'silent' }))
  const htmlFile = 'apps/desktop/src/renderer/screenshot-editor/index.html', html = await readFile(htmlFile, 'utf8')
  await writeFile(join(rendererRoot, 'index.html'), html.replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="./entry.css" /></head>'))

  for (const mutation of withMutations ? [null, ...mutations] : [null]) {
    const label = mutation?.id ?? 'baseline', sceneOut = mutation ? join(out, label) : out
    if (mutation) await mkdir(sceneOut)
    const consumed = []
    const result = await build({ entryPoints: ['apps/desktop/scripts/fixtures/capture-surface/main.ts'], outfile: join(mainRoot, 'main.js'), bundle: true, platform: 'node', format: 'esm',
      external: ['electron', '@agentmux/core', '@agentmux/core/*', '@agentmux/host/*'], banner: { js: "import { createRequire as fixtureRequire } from 'node:module';const require=fixtureRequire(import.meta.url);" }, alias, metafile: true, logLevel: 'silent',
      plugins: [{ name: 'exact-capture-surface-production-source', setup(builder) { builder.onLoad({ filter: /\/apps\/desktop\/src\/main\/capture-surface\.ts$/ }, async args => {
        assert.equal(args.path, resolve(surface))
        const original = await readFile(args.path, 'utf8')
        assert.equal(original, originalSurface, 'CaptureSurface changed while the proof was building')
        const contents = mutated(original, mutation)
        consumed.push({ file: surface, original: sha(original), consumed: sha(contents), mutation: mutation?.id ?? null })
        return { contents, loader: 'ts', resolveDir: dirname(args.path) }
      }) } }] })
    assert.equal(consumed.length, 1, label + ': the production CaptureSurface must actually load once')
    assert.equal(consumed[0].consumed, mutation ? sha(mutated(originalSurface, mutation)) : sha(originalSurface), label + ': exact consumed source')
    results.push(result)
    receipt.build.push({ label, outputs: result.metafile.outputs })

    const processResult = await new Promise((done, reject) => {
      const env = { ...process.env, AGENTMUX_CAPTURE_SURFACE_OUT: sceneOut, ELECTRON_RENDERER_URL: '' }; delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(require('electron'), [appRoot], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let log = '', timeout = false, kill
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; process.stdout.write(bytes) })
      const timer = setTimeout(() => { timeout = true; child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 3000) }, 45000)
      child.once('error', reject)
      child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(kill); done({ code, signal, timeout, log }) })
    })
    await writeFile(join(sceneOut, 'electron.log'), processResult.log)
    assert.equal(processResult.timeout, false, label + ': a timed-out process is infrastructure failure, not a behavior kill')
    assert.equal(processResult.signal, null, label + ': external termination is not an owning assertion')
    const native = JSON.parse(await readFile(join(sceneOut, 'native.json'), 'utf8'))
    receipt.variants.push({ label, consumed, code: processResult.code, native })
    if (!mutation) {
      receipt.native = native
      assert.equal(processResult.code, 0, JSON.stringify(native.failure) + processResult.log)
      assert.equal(native.passed, true)
      assert.equal(native.cases.length, 15, 'all initial backgrounds, compositions, Tab/geometry/history, cancellation, expansion and same-capture continuation must actually execute')
      assert.equal(native.screenshots.length, 9)
      assert.equal(native.grabs.length, 16)
      assert.equal(native.opacityChanges.length, 0, 'the unmodified lifecycle never writes host opacity')
    } else {
      assert.notEqual(processResult.code, 0, label + ': the production mutant survived')
      assert.equal(native.passed, false)
      assert.equal(native.failure?.name, 'AssertionError', label + ': compilation or infrastructure failure is not a behavior kill')
      assert.ok(native.failure.message.includes(mutation.expected), label + ': owning assertion required; got ' + native.failure.message)
      assert.ok(mutation.reached(native), label + ': the owning nonempty Electron scene must actually execute')
      receipt.mutations.push({ id: mutation.id, killedBy: mutation.expected, failure: native.failure.message, consumed, grabs: native.grabs.length, cases: native.cases.length })
    }
    process.stdout.write(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN') + '\n')
  }

  const files = new Set(results.flatMap(result => Object.keys(result.metafile.inputs)).filter(file => !file.startsWith('<')))
  files.add(htmlFile); files.add('apps/desktop/scripts/verify-capture-surface.mjs'); files.add('apps/desktop/scripts/fixtures/capture-surface/scenario.md')
  receipt.inputs = Object.fromEntries(await Promise.all([...files].map(async file => [file, sha(await readFile(file))])))
  for (const [file, hash] of Object.entries(receipt.inputs)) assert.equal(sha(await readFile(file)), hash, 'Candidate changed during proof: ' + file)
  if (withMutations) assert.equal(receipt.mutations.length, 3, 'all three exact production mutations must be killed')
  receipt.passed = true
} finally {
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await rm(work, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json'), screenshots: receipt.native.screenshots, mutations: receipt.mutations }) + '\n')
