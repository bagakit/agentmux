import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

// Electron runs in a fresh Node process after the mutation workers have exited.
assert.equal(process.argv.length, 3, 'Keep the exact output directory for this complete native phase')
const out = resolve(process.argv[2]), root = process.cwd(), require = createRequire(resolve('apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const sha = value => createHash('sha256').update(value).digest('hex')
const producer = 'apps/desktop/src/main/screen-capture.ts'
const sources = { [producer]: await readFile(producer, 'utf8') }
const receipt = { schema: 'agentmux.screenshot-editor-native-stage.v1', passed: false, native: null, nativeCaptureMutation: null }
async function command(label, program, args, env = {}) {
  const result = await new Promise((done, reject) => {
    const childEnv = { ...process.env, ...env }
    if (program === require('electron')) delete childEnv.ELECTRON_RUN_AS_NODE
    const child = spawn(program, args, { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timeout = false, terminateTimer
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; if (label === 'native') process.stdout.write(bytes) })
    const timer = setTimeout(() => { timeout = true; child.kill('SIGTERM'); terminateTimer = setTimeout(() => child.kill('SIGKILL'), 3000) }, 45000)
    child.once('error', reject)
    child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(terminateTimer); done({ code, signal, log, timeout }) })
  })
  await writeFile(join(out, label + '.log'), result.log)
  await writeFile(join(out, label + '.process.json'), JSON.stringify({ code: result.code, signal: result.signal, timeout: result.timeout }))
  assert.equal(result.timeout, false, label + ': timed-out infrastructure is not a behavior result')
  assert.equal(result.signal, null, label + ': process termination is not behavior proof')
  return result
}
const work = await mkdtemp(join(tmpdir(), 'agentmux-screenshot-editor-'))
try {
  const appRoot = join(work, 'app'), mainRoot = join(appRoot, 'out/main'), preloadRoot = join(appRoot, 'out/preload'), rendererRoot = join(appRoot, 'out/renderer/screenshot-editor')
  for (const dir of [mainRoot, preloadRoot, rendererRoot]) await mkdir(dir, { recursive: true })
  await mkdir(join(mainRoot, 'user-data'))
  await symlink(resolve('apps/desktop/node_modules'), join(appRoot, 'node_modules'))
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ type: 'module', main: 'out/main/main.js' }))
  const alias = { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
    '@agentmux/client-ui/theme': resolve('packages/client-ui/src/theme/index.ts'), '@agentmux/native-desktop/image': resolve('packages/native-desktop/src/image.ts') }
  const mainOptions = { entryPoints: ['apps/desktop/scripts/fixtures/system-screenshot-editor/main.ts'], outfile: join(mainRoot, 'main.js'), bundle: true, platform: 'node', format: 'esm',
    external: ['electron', '@agentmux/core', '@agentmux/core/*', '@agentmux/host/*'], banner: { js: "import { createRequire as fixtureRequire } from 'node:module';const require=fixtureRequire(import.meta.url);" }, alias, logLevel: 'silent' }
  await build(mainOptions)
  await build({ entryPoints: ['apps/desktop/src/preload/screenshot-editor.ts'], outfile: join(preloadRoot, 'screenshot-editor.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  await build({ entryPoints: ['apps/desktop/src/renderer/screenshot-editor/entry.tsx'], outfile: join(rendererRoot, 'entry.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', alias,
    conditions: ['browser'], logLevel: 'silent' })
  const html = await readFile('apps/desktop/src/renderer/screenshot-editor/index.html', 'utf8')
  await writeFile(join(rendererRoot, 'index.html'), html.replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="./entry.css" /></head>'))
  const pinRoot = join(appRoot, 'out/renderer/screenshot-pin')
  await mkdir(pinRoot, { recursive: true })
  await build({ entryPoints: ['apps/desktop/src/preload/screenshot-pin.ts'], outfile: join(preloadRoot, 'screenshot-pin.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  await build({ entryPoints: ['apps/desktop/src/renderer/screenshot-pin/entry.tsx'], outfile: join(pinRoot, 'entry.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', alias, conditions: ['browser'], logLevel: 'silent' })
  await writeFile(join(pinRoot, 'index.html'), (await readFile('apps/desktop/src/renderer/screenshot-pin/index.html', 'utf8')).replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="./entry.css" /></head>'))
  const native = await command('native', require('electron'), [appRoot], { AGENTMUX_SCREENSHOT_EDITOR_OUT: out, AGENTMUX_SCREENSHOT_FILE_HELPER: resolve('apps/desktop/resources/bin/agentmux-workspace-move'), ELECTRON_RENDERER_URL: '' })
  receipt.native = JSON.parse(await readFile(join(out, 'native.json'), 'utf8'))
  assert.equal(native.code, 0, JSON.stringify(receipt.native.failure) + native.log)
  assert.equal(receipt.native.passed, true)
  assert.equal(receipt.native.cases.length, 5)
  assert.equal(receipt.native.screenshots.length, 10)
  const producerSource = producer, producerText = sources[producer]
  assert.equal(producerText.split('originalDelivered = true').length, 2, 'Mutate the exact original delivery completion once')
  const replayed = producerText.replace('originalDelivered = true', 'originalDelivered = false'), mutantOut = join(out, 'draft-redelivery')
  await mkdir(mutantOut)
  let producerConsumed = false
  await build({ ...mainOptions, plugins: [{ name: 'exact-original-draft-redelivery-counterexample', setup(builder) {
    builder.onLoad({ filter: /\/src\/main\/screen-capture\.ts$/ }, args => {
      assert.equal(args.path, resolve(producerSource)); producerConsumed = true
      return { contents: replayed, loader: 'ts', resolveDir: dirname(args.path) }
    })
  } }] })
  assert.equal(producerConsumed, true, 'The actual capture-to-editor producer must consume its mutant')
  const negative = await command('draft-redelivery', require('electron'), [appRoot], { AGENTMUX_SCREENSHOT_EDITOR_OUT: mutantOut,
    AGENTMUX_SCREENSHOT_FILE_HELPER: resolve('apps/desktop/resources/bin/agentmux-workspace-move'), ELECTRON_RENDERER_URL: '' })
  const counterexample = JSON.parse(await readFile(join(mutantOut, 'native.json'), 'utf8'))
  assert.equal(negative.code, 1); assert.equal(counterexample.passed, false); assert.ok(counterexample.cases.length > 0)
  assert.match(counterexample.failure?.message ?? '', /later clipboard image creates no second draft file/)
  receipt.nativeCaptureMutation = { source: producerSource, original: sha(producerText), consumed: sha(replayed),
    result: 'owning-AssertionRED', failure: counterexample.failure.message, receipt: join(mutantOut, 'native.json') }
  receipt.passed = true
} finally {
  await writeFile(join(out, 'native-stage-receipt.json'), JSON.stringify(receipt, null, 2))
  await rm(work, { recursive: true, force: true })
}
