import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

assert.equal(process.argv.length, 2, 'This verification has no optional skipped slices')
const root = process.cwd(), require = createRequire(resolve('apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const source = 'apps/desktop/src/main/screenshot-pins.ts', original = await readFile(source, 'utf8')
const hash = value => createHash('sha256').update(value).digest('hex')
const mutations = [
  { id: 'exact-actor', from: 'a.kind === b.kind && a.id === b.id', to: 'true', expected: 'keeps exact actors and Host identities' },
  { id: 'exact-pin', from: 'const pin = this.pins.get(record.pinId!)', to: 'const pin = this.pins.values().next().value', expected: 'closes only the exact target' },
  { id: 'original-effect', from: 'recordedOperation: operation ? structuredClone(operation) : null', to: 'recordedOperation: operation ? { ...structuredClone(operation), effect: pin?.window.isDestroyed() ? "closed" : operation.effect } : null', expected: 'closes only the exact target' },
  { id: 'exact-frame', from: ' && event.senderFrame === item.window.webContents.mainFrame', to: '', expected: 'refuses another frame or pin' },
  { id: 'dispose-await', from: "if (this.disposed) throw new AgentMuxError('The original image presentation owner closed before this action. Retain the original operation.', 'CONTROL_UNAVAILABLE')", to: 'void 0', expected: 'dispose during authority stage 2' },
  { id: 'closed-receipt', from: "await new Promise<void>(resolve => { pin.window.once('closed', resolve); pin.window.close() })", to: 'pin.window.close()', expected: 'close acknowledgement waits' },
  { id: 'origin-placement', from: 'origin.width / image.width, origin.height / image.height), work), origin, work)', to: 'origin.width / image.width, origin.height / image.height), work), { x: work.x + 24, y: work.y + 24 }, work)', expected: 'opens over its origin' },
  { id: 'origin-display', from: 'screen.getDisplayMatching({ x: Math.round(origin.x)', to: 'screen.getDisplayMatching({ x: 0 * Math.round(origin.x)', expected: 'opens over its origin' },
  { id: 'work-area-clamp', from: 'x: clamp(at.x, work.x, work.width - width)', to: 'x: Math.round(at.x)', expected: 'opens over its origin' },
  { id: 'exact-pin-action', from: "if (params?.pinId !== pin.id) throw new Error('Keep the original pinned image identity.')", to: 'void 0', expected: 'act only on the exact pin sender' },
  { id: 'opacity-range', from: '!(params.opacity >= 0.2 && params.opacity <= 1)', to: 'false', expected: 'act only on the exact pin sender' },
  { id: 'click-through-forward', from: 'setIgnoreMouseEvents(true, { forward: true })', to: 'setIgnoreMouseEvents(true)', expected: 'act only on the exact pin sender' },
  { id: 'zoom-around-pointer', from: 'bounds.x + (point.x as number) * (1 - applied)', to: 'bounds.x', expected: 'act only on the exact pin sender' },
  { id: 'zoom-minimum', from: 'Math.max(scale, PIN_MIN / image.width, PIN_MIN / image.height)', to: 'scale', expected: 'act only on the exact pin sender' },
  { id: 'drag-file-once', from: 'pin.drag ??= writeDragFile(pin)', to: 'pin.drag = writeDragFile(pin)', expected: 'drag-out writes this pin PNG once' },
  { id: 'drag-file-cleanup', from: 'if (pin.drag) void rm(', to: 'if (false) void rm(', expected: 'drag-out writes this pin PNG once' },
  { id: 'pin-logical-save', from: '...(params.logicalSize ? { logicalScale: pin.logicalScale } : {})', to: '...({})', expected: 'saves at 1x through the pin logical scale' }
]
await mkdir(resolve('.local/screenshot-pins'), { recursive: true })
const out = await mkdtemp(resolve('.local/screenshot-pins/run-'))
const inputs = [source, 'apps/desktop/src/shared/screenshot-pin.ts', 'apps/desktop/src/preload/screenshot-pin.ts',
  'apps/desktop/src/renderer/screenshot-pin/entry.tsx', 'apps/desktop/src/renderer/screenshot-pin/pin.css', 'apps/desktop/src/renderer/screenshot-pin/index.html',
  'apps/desktop/src/main/screenshot-files.ts', 'apps/desktop/src/main/browser-image.ts', 'apps/desktop/src/main/theme-bootstrap.ts',
  'apps/desktop/test/screenshot-pins.test.ts', 'apps/desktop/test/screenshot-pins.config.mts', 'apps/desktop/scripts/verify-screenshot-pins.mjs',
  'apps/desktop/scripts/fixtures/screenshot-pins/main.ts', 'apps/desktop/scripts/fixtures/screenshot-pins/scenario.md',
  'packages/core/src/public-rpc-image.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/rpc-native-codec.ts',
  'packages/core/src/image-cli.ts', 'packages/core/src/agentmux.ts', 'packages/native-desktop/src/image.ts']
const fingerprints = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await readFile(file))])))
const hashes = await fingerprints()
const receipt = { schema: 'agentmux.screenshot-pins-proof.v1', passed: false, sourceHashes: hashes, runs: [], native: null,
  boundary: 'Actual Main image owner with public service/client/CLI, controlled Electron counterexamples and real private BrowserWindow/preload/PinView. Aesthetic review and complete editor/Composer workflow remain separate.' }
async function command(label, executable, args, extra = {}) {
  const result = await new Promise((done, reject) => {
    const env = { ...process.env, ...extra }
    if (executable === require('electron')) delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(executable, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timedOut = false, escalation
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 2000) }, 45000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(escalation); done({ code, signal, log, timedOut }) })
  })
  await writeFile(join(out, label + '.log'), result.log)
  assert.equal(result.timedOut, false, label + ': an infrastructure timeout is not behavior proof')
  assert.equal(result.signal, null, label + ': a terminated process is not behavior proof')
  return result
}
async function test(label, mutation) {
  const loaded = join(out, label + '.loaded.ndjson'), json = join(out, label + '.tests.json')
  const result = await command(label, process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/screenshot-pins.config.mts', '--reporter=json', '--outputFile=' + json],
    { SCREENSHOT_PINS_LOADED: loaded, SCREENSHOT_PINS_MUTATION: mutation ? JSON.stringify(mutation) : '' })
  const report = JSON.parse(await readFile(json, 'utf8')), assertions = report.testResults.flatMap(file => file.assertionResults)
  assert.ok(assertions.length >= 11 && assertions.every(test => ['passed', 'failed'].includes(test.status)), label + ': nonempty executed consumer assertions required')
  for (const file of report.testResults) assert.equal(file.message, '', label + ': collection failure cannot kill a behavior mutation')
  assert.doesNotMatch(result.log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
  const rows = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(rows.length > 0 && rows.every(row => row.source === hash(original) && row.consumed === hash(mutation ? original.replace(mutation.from, mutation.to) : original) && row.mutation === (mutation?.id ?? null)), 'Actual Main source must be consumed')
  if (mutation) {
    assert.notEqual(result.code, 0, 'Production pin mutation survived: ' + mutation.id)
    const owned = assertions.find(test => test.fullName.includes(mutation.expected))
    assert.equal(owned?.status, 'failed', 'Owning assertion must fail: ' + mutation.id)
    assert.match(owned.failureMessages.join('\n'), /AssertionError|promise resolved|promise rejected/)
  } else { assert.equal(result.code, 0, result.log); assert.ok(assertions.every(test => test.status === 'passed')) }
  receipt.runs.push({ label, code: result.code, assertions: assertions.length, loaded: rows })
  console.log(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN'))
}
const work = await mkdtemp(join(tmpdir(), 'amux-pin-'))
try {
  for (const mutation of mutations) assert.equal(original.split(mutation.from).length, 2, 'Pin mutation anchor must be unique: ' + mutation.id)
  await test('baseline')
  for (const mutation of mutations) await test(mutation.id, mutation)
  const appRoot = join(work, 'app'), mainRoot = join(appRoot, 'out/main'), preloadRoot = join(appRoot, 'out/preload'), rendererRoot = join(appRoot, 'out/renderer/screenshot-pin')
  for (const directory of [mainRoot, preloadRoot, rendererRoot]) await mkdir(directory, { recursive: true })
  await symlink(resolve('apps/desktop/node_modules'), join(appRoot, 'node_modules'))
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
  await build({ entryPoints: ['apps/desktop/scripts/fixtures/screenshot-pins/main.ts'], outfile: join(mainRoot, 'main.js'), bundle: true, platform: 'node', format: 'esm',
    external: ['electron'], plugins: [coreModules], alias, logLevel: 'silent' })
  await build({ entryPoints: ['apps/desktop/src/preload/screenshot-pin.ts'], outfile: join(preloadRoot, 'screenshot-pin.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  await build({ entryPoints: ['apps/desktop/src/renderer/screenshot-pin/entry.tsx'], outfile: join(rendererRoot, 'entry.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', alias, conditions: ['browser'], logLevel: 'silent' })
  const html = await readFile('apps/desktop/src/renderer/screenshot-pin/index.html', 'utf8')
  await writeFile(join(rendererRoot, 'index.html'), html.replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="./entry.css" /></head>'))
  const native = await command('native', require('electron'), [appRoot], { SCREENSHOT_PINS_OUT: out, SCREENSHOT_PINS_CLI: resolve('packages/core/dist/agentmux.js'), SCREENSHOT_PINS_NODE: process.execPath, ELECTRON_RENDERER_URL: '' })
  receipt.native = JSON.parse(await readFile(join(out, 'native.json'), 'utf8'))
  assert.equal(native.code, 0, JSON.stringify(receipt.native.failure) + native.log)
  assert.equal(receipt.native.passed, true)
  assert.equal(receipt.native.screenshots.length, 5); assert.equal(receipt.native.cases.length, 3)
  const after = await fingerprints()
  for (const file of inputs) assert.equal(after[file], hashes[file], 'Pin candidate changed during verification: ' + file)
  receipt.passed = true
} finally {
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await rm(work, { recursive: true, force: true })
  await rm(resolve('.tmp/screenshot-pins-cache'), { recursive: true, force: true })
}
console.log(JSON.stringify({ passed: receipt.passed, mutations: mutations.length, receipt: join(out, 'receipt.json'), screenshots: receipt.native.screenshots }))
