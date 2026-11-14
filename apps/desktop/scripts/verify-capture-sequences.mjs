import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
const require = createRequire(resolve('apps/desktop/package.json')), { build } = createRequire(require.resolve('vite'))('esbuild')
const recordedIndex = process.argv.indexOf('--recorded-native'), recorded = recordedIndex < 0 ? '' : resolve(process.argv[recordedIndex + 1])
const interaction = process.argv.includes('--interaction')
const startRecovery = process.argv.includes('--start-recovery')
const manualInteraction = interaction
const automatic = process.argv.includes('--auto') || interaction
const live = process.argv.includes('--live') || interaction
const mode = process.argv.includes('--scroll') ? 'scroll' : process.argv.includes('--gif') ? 'gif' : null
assert.ok(mode, 'Use --scroll or --gif to run one bounded capture path.')
await mkdir(resolve('.local/capture-sequence-proof', mode), { recursive: true })
const out = await mkdtemp(resolve('.local/capture-sequence-proof', mode, 'run-')), work = await mkdtemp(join(tmpdir(), 'agentmux-capture-sequence-'))
const receipt = { passed: false, mode, live, recorded, automatic, interaction, startRecovery, variants: [], inputs: {}, cleanup: false }
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), inputs = new Map()
try {
  const app = join(work, 'app'), main = join(app, 'out/main'), preload = join(app, 'out/preload'), renderer = join(app, 'out/renderer/screenshot-editor')
  for (const directory of [main, preload, renderer]) await mkdir(directory, { recursive: true })
  await symlink(resolve('apps/desktop/node_modules'), join(app, 'node_modules'))
  await writeFile(join(app, 'package.json'), JSON.stringify({ type: 'module', main: 'out/main/main.js' }))
  const alias = { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')), '@agentmux/client-ui/theme': resolve('packages/client-ui/src/theme/index.ts'), '@agentmux/native-desktop/image': resolve('packages/native-desktop/src/image.ts') }
  async function bundle(options) { const result = await build({ bundle: true, logLevel: 'silent', metafile: true, alias, ...options }); for (const input of Object.keys(result.metafile.inputs)) if (!input.startsWith('<')) { const digest = hash(await readFile(input)); if (inputs.has(input)) assert.equal(inputs.get(input), digest, 'Candidate changed between builds: ' + input); else inputs.set(input, digest) }; return result }
  inputs.set('packages/native-desktop/macos/.build/debug/agentmux-native-macos', hash(await readFile('packages/native-desktop/macos/.build/debug/agentmux-native-macos')))
  async function mainBundle(mutation = false) { await bundle({ entryPoints: ['apps/desktop/scripts/fixtures/capture-sequences/main.ts'], outfile: join(main, 'main.js'), platform: 'node', format: 'esm', external: ['electron', '@agentmux/core', '@agentmux/core/*'], banner: { js: "import { createRequire as fixtureRequire } from 'node:module';const require=fixtureRequire(import.meta.url);" }, plugins: [{ name: 'live-frame-input', setup(builder) { builder.onLoad({ filter: /\/main\/capture-sequence\.ts$/ }, async args => {
    const original = await readFile(args.path, 'utf8')
    const contents = mutation === 'stale-baseline' ? original.replace("record.baselinePending = record.input!.mode === 'scroll' && record.receipt.state === 'ready'", 'record.baselinePending = false')
      : mutation === 'stop-on-overlap' ? original.replace('if (!(error instanceof ScrollOverlapError)) throw error', 'throw error')
      : mutation ? original.replace('frame.setIgnoreMouseEvents(true)', 'frame.setIgnoreMouseEvents(false)').replace("show: false, frame: false, transparent: true", "show: false, frame: false, transparent: false") : original
    if (mutation) assert.notEqual(contents, original, 'the owner mutation must be consumed')
    return { contents, loader: 'ts', resolveDir: dirname(args.path) }
  }) } }] }) }
  await mainBundle()
  await bundle({ entryPoints: ['apps/desktop/src/preload/capture-sequence.ts'], outfile: join(preload, 'capture-sequence.cjs'), platform: 'node', format: 'cjs', external: ['electron'] })
  const productionHtml = 'apps/desktop/src/renderer/screenshot-editor/index.html'
  const html = await readFile(productionHtml, 'utf8'); inputs.set(productionHtml, hash(html))
  await writeFile(join(renderer, 'index.html'), html.replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="entry.css" /></head>'))
  for (const mutant of (startRecovery ? [false, 'stale-baseline', 'stop-on-overlap'] : live && !interaction ? [false] : [false, true])) {
    const label = typeof mutant === 'string' ? mutant : mutant ? interaction ? 'blocked-source' : mode === 'scroll' ? 'wrong-overlap' : 'dropped-keyframes' : 'baseline', scene = join(out, label)
    await mkdir(scene)
    if (interaction || startRecovery) await mainBundle(mutant)
    let consumed = false
    await bundle({ entryPoints: ['apps/desktop/scripts/fixtures/capture-sequences/entry.tsx'], outfile: join(renderer, 'entry.js'), platform: 'browser', format: 'esm', jsx: 'automatic', conditions: ['browser'], plugins: [{ name: 'capture-candidate', setup(builder) {
      builder.onLoad({ filter: /CaptureSequenceView\.tsx$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace("'./gif-encode.worker.ts'", "'./gif-encode.worker.js'"), loader: 'tsx', resolveDir: dirname(args.path) }))
      builder.onLoad({ filter: /scroll-stitch\.ts$/ }, async args => { const original = await readFile(args.path, 'utf8'); consumed = true; return { contents: mutant && mode === 'scroll' && !interaction && !startRecovery ? original.replace('return best', 'return { ...best, shift: best.shift + 1 }') : original, loader: 'ts', resolveDir: dirname(args.path) } })
    } }] })
    assert.ok(consumed, 'the real scroll matcher must be in the renderer consumer')
    await bundle({ entryPoints: ['apps/desktop/src/renderer/screenshot-editor/gif-encode.worker.ts'], outfile: join(renderer, 'gif-encode.worker.js'), platform: 'browser', format: 'esm', plugins: [{ name: 'gif-metadata-candidate', setup(builder) {
      builder.onLoad({ filter: /gif-encode\.worker\.ts$/ }, async args => { const original = await readFile(args.path, 'utf8'); return { contents: mutant && mode === 'gif' ? original.replace('delays: info.delays, keyframes }', 'delays: info.delays, keyframes: [] }') : original, loader: 'ts', resolveDir: dirname(args.path) } })
    } }] })
    const env = { ...process.env, CAPTURE_SEQUENCE_OUT: scene, CAPTURE_START_RECOVERY: startRecovery ? '1' : '0', CAPTURE_INTERACTION_TEST: interaction ? '1' : '0', CAPTURE_INTERACTION_MANUAL: manualInteraction ? '1' : '0',  CAPTURE_SEQUENCE_MODE: mode, CAPTURE_AUTO_TEST: automatic ? '1' : '0', CAPTURE_RECORDED_NATIVE: recorded, CAPTURE_CORE_DIST: resolve('packages/core/dist'), CAPTURE_SEQUENCE_LIVE: live ? '1' : '0', CAPTURE_SEQUENCE_HELPER: resolve('packages/native-desktop/macos/.build/debug/agentmux-native-macos'), ELECTRON_RENDERER_URL: '' }; delete env.ELECTRON_RUN_AS_NODE
    const execution = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [app], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = '', timedOut = false
      child.stdout.on('data', bytes => { log += bytes }); child.stderr.on('data', bytes => { log += bytes })
      const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, manualInteraction ? 180000 : 45000)
      child.once('error', reject); child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, timedOut, log }) })
    })
    await writeFile(join(scene, 'electron.log'), execution.log)
    assert.equal(execution.timedOut, false, 'a timeout is not mutation evidence')
    const result = JSON.parse(await readFile(join(scene, 'result.json'), 'utf8'))
    receipt.variants.push({ label, code: execution.code, result })
    if (!mutant) { assert.equal(execution.code, 0, JSON.stringify(result.failure)); assert.equal(result.passed, true) }
    else { assert.notEqual(execution.code, 0, 'the product consumer must reject this actual mutation'); assert.equal(result.failure.name, 'AssertionError') }
    process.stdout.write(`${mode} ${label}: ${mutant ? 'AssertionRED' : 'GREEN'}\n`)
  }
  for (const [file, digest] of inputs) assert.equal(hash(await readFile(file)), digest, 'Candidate changed during verification: ' + file)
  receipt.inputs = Object.fromEntries(inputs)
  receipt.passed = true
} finally {
  await rm(work, { recursive: true, force: true }); receipt.cleanup = true
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json') }) + '\n')
