import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

assert.equal(process.argv.length, 2, 'This bounded verification has no optional skipped slices')
const root = process.cwd(), require = createRequire(resolve('apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const source = 'apps/desktop/src/main/system-screenshot-editor.ts'
const original = await readFile(source, 'utf8'), sha = value => createHash('sha256').update(value).digest('hex')
const mutations = [
  { id: 'exact-window', from: 'event.sender !== request.window.webContents || ', to: '', expected: 'rejects another window and an embedded frame' },
  { id: 'original-request', from: 'params?.requestId !== request.input.requestId', to: 'false', expected: 'refuses stale request identities' },
  { id: 'failed-delivery-retains-editor', from: "return { status: 'failed', message: message(error) }", to: "request.window.close(); return { status: 'failed', message: message(error) }", expected: 'keeps the original editor after a failed delivery' },
  { id: 'original-operation-receipt', from: 'if (existing) return await existing', to: 'if (false) return await existing', expected: 'returns the original completion receipt for duplicate operation IDs' },
  { id: 'late-delivery-isolation', from: 'if (this.current === request && !request.window.isDestroyed()) request.window.close()', to: 'if (this.current && !this.current.window.isDestroyed()) this.current.window.close()', expected: 'an earlier late result never closes the newer editor' },
  { id: 'validated-output-png', from: 'pngBytes(params.image!)', to: 'void params.image', expected: 'refuses stale request identities' }
]
await mkdir(resolve('.local/system-screenshot-editor'), { recursive: true })
const out = await mkdtemp(resolve('.local/system-screenshot-editor/run-'))
const inputs = [source, 'apps/desktop/src/shared/system-screenshot-editor.ts', 'apps/desktop/src/preload/screenshot-editor.ts',
  'apps/desktop/src/renderer/screenshot-editor/entry.tsx', 'apps/desktop/src/renderer/screenshot-editor/SystemScreenshotEditorView.tsx',
  'apps/desktop/src/renderer/screenshot-editor/screenshot-editor.css', 'apps/desktop/src/renderer/src/components/image-annotation/compose.ts',
  'apps/desktop/src/renderer/src/components/image-annotation/ImageAnnotationEditor.tsx', 'apps/desktop/src/renderer/src/components/image-annotation/image-annotation.css',
  'apps/desktop/src/renderer/src/components/image-annotation/AnnotationToolbar.tsx', 'apps/desktop/test/system-screenshot-editor.test.ts',
  ...['drawing-model.ts', 'drawing-renderer.ts', 'geometry.ts', 'selection-geometry.ts', 'view.ts', 'canvas-render.ts', 'AnnotationNotes.tsx', 'AnnotationOriginalMenu.tsx', 'types.ts']
    .map(name => 'apps/desktop/src/renderer/src/components/image-annotation/' + name),
  'apps/desktop/src/renderer/src/components/RovingToolbar.tsx', 'apps/desktop/src/main/theme-bootstrap.ts', 'packages/native-desktop/src/image.ts',
  'apps/desktop/test/browser-screenshot-compose.test.ts', 'apps/desktop/test/browser-screenshot-context.test.ts',
  'apps/desktop/test/system-screenshot-editor.config.mts', 'apps/desktop/scripts/fixtures/system-screenshot-editor/main.ts',
  'apps/desktop/scripts/fixtures/system-screenshot-editor/scenario.md', 'apps/desktop/scripts/verify-system-screenshot-editor.mjs',
  'packages/client-ui/src/theme/runtime.ts', 'apps/desktop/electron.vite.config.ts']
const hashes = Object.fromEntries(await Promise.all(inputs.map(async file => [file, sha(await readFile(file))])))
const receipt = { schema: 'agentmux.system-screenshot-editor-proof.v1', passed: false, sharedTreeMutations: 0, inputs: hashes, runs: [], native: null }
async function command(label, program, args, env = {}) {
  const result = await new Promise((done, reject) => {
    const childEnv = { ...process.env, ...env }
    if (program === require('electron')) delete childEnv.ELECTRON_RUN_AS_NODE
    const child = spawn(program, args, { cwd: root, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timeout = false
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
    const timer = setTimeout(() => { timeout = true; child.kill('SIGTERM') }, 45000)
    child.once('error', reject)
    child.once('exit', (code, signal) => { clearTimeout(timer); done({ code, signal, log, timeout }) })
  })
  await writeFile(join(out, label + '.log'), result.log)
  assert.equal(result.timeout, false, label + ': timed-out infrastructure is not a behavior result')
  assert.equal(result.signal, null, label + ': process termination is not behavior proof')
  return result
}
async function test(label, mutation) {
  const loaded = join(out, label + '.loaded.ndjson'), json = join(out, label + '.tests.json')
  const result = await command(label, process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', 'apps/desktop/test/system-screenshot-editor.config.mts',
    '--reporter=json', '--outputFile=' + json], { AGENTMUX_SCREENSHOT_EDITOR_LOADED: loaded,
      AGENTMUX_SCREENSHOT_EDITOR_MUTATION: mutation ? JSON.stringify(mutation) : '' })
  const report = JSON.parse(await readFile(json, 'utf8')), assertions = report.testResults.flatMap(file => file.assertionResults)
  assert.ok(assertions.length >= 7 && assertions.every(row => ['passed', 'failed'].includes(row.status)), label + ': nonempty executed original tests required')
  for (const file of report.testResults) assert.equal(file.message, '', label + ': collection failures do not prove a behavior mutation')
  assert.doesNotMatch(result.log, /Unhandled Errors|Unhandled Rejection|Uncaught Exception/)
  const consumed = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(consumed.length > 0 && consumed.every(row => row.original === sha(original) && row.consumed === sha(mutation ? original.replace(mutation.from, mutation.to) : original) && row.mutation === (mutation?.id ?? null)), label + ': actual production source must consume this exact candidate')
  if (mutation) {
    assert.notEqual(result.code, 0, 'Production mutation survived: ' + label)
    const owner = assertions.find(row => row.fullName.includes(mutation.expected))
    assert.equal(owner?.status, 'failed', label + ': owning behavioral consumer must fail')
    assert.match(owner.failureMessages.join('\n'), /AssertionError|promise resolved|promise rejected/)
  } else {
    assert.equal(result.code, 0, result.log)
    assert.ok(assertions.every(row => row.status === 'passed'))
  }
  receipt.runs.push({ label, code: result.code, assertions: assertions.length, loaded: consumed })
  process.stdout.write(label + ': ' + (mutation ? 'AssertionRED' : 'GREEN') + '\n')
}
const work = await mkdtemp(join(tmpdir(), 'agentmux-screenshot-editor-'))
try {
  assert.ok(mutations.length > 0)
  for (const mutation of mutations) assert.equal(original.split(mutation.from).length, 2, 'Unique production mutation: ' + mutation.id)
  await test('baseline')
  for (const mutation of mutations) await test(mutation.id, mutation)
  const appRoot = join(work, 'app'), mainRoot = join(appRoot, 'out/main'), preloadRoot = join(appRoot, 'out/preload'), rendererRoot = join(appRoot, 'out/renderer/screenshot-editor')
  for (const dir of [mainRoot, preloadRoot, rendererRoot]) await mkdir(dir, { recursive: true })
  await mkdir(join(mainRoot, 'user-data'))
  await symlink(resolve('apps/desktop/node_modules'), join(appRoot, 'node_modules'))
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ type: 'module', main: 'out/main/main.js' }))
  const alias = { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
    '@agentmux/client-ui/theme': resolve('packages/client-ui/src/theme/index.ts'), '@agentmux/native-desktop/image': resolve('packages/native-desktop/src/image.ts') }
  await build({ entryPoints: ['apps/desktop/scripts/fixtures/system-screenshot-editor/main.ts'], outfile: join(mainRoot, 'main.js'), bundle: true, platform: 'node', format: 'esm',
    external: ['electron', '@agentmux/core/object-id'], alias, logLevel: 'silent' })
  await build({ entryPoints: ['apps/desktop/src/preload/screenshot-editor.ts'], outfile: join(preloadRoot, 'screenshot-editor.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  await build({ entryPoints: ['apps/desktop/src/renderer/screenshot-editor/entry.tsx'], outfile: join(rendererRoot, 'entry.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', alias,
    conditions: ['browser'], logLevel: 'silent' })
  const html = await readFile('apps/desktop/src/renderer/screenshot-editor/index.html', 'utf8')
  await writeFile(join(rendererRoot, 'index.html'), html.replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="./entry.css" /></head>'))
  const native = await command('native', require('electron'), [appRoot], { AGENTMUX_SCREENSHOT_EDITOR_OUT: out, ELECTRON_RENDERER_URL: '' })
  receipt.native = JSON.parse(await readFile(join(out, 'native.json'), 'utf8'))
  assert.equal(native.code, 0, JSON.stringify(receipt.native.failure) + native.log)
  assert.equal(receipt.native.passed, true)
  assert.equal(receipt.native.cases.length, 3)
  assert.equal(receipt.native.screenshots.length, 4)
  for (const [file, hash] of Object.entries(hashes)) assert.equal(sha(await readFile(file)), hash, 'Candidate changed during proof: ' + file)
  receipt.passed = true
} finally {
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await rm(work, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, mutations: mutations.length, receipt: join(out, 'receipt.json'), screenshots: receipt.native.screenshots }) + '\n')
