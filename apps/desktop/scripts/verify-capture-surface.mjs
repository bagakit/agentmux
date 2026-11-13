import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

assert.equal(process.argv.length, 2, 'This bounded product proof has no skipped scenes')
const root = process.cwd(), require = createRequire(resolve('apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(resolve('.local/capture-surface'), { recursive: true })
const out = await mkdtemp(resolve('.local/capture-surface/run-'))
const work = await mkdtemp(join(tmpdir(), 'agentmux-capture-surface-'))
const receipt = { schema: 'agentmux.capture-surface-product-proof.v1', passed: false, inputs: {}, native: null, build: [], log: join(out, 'electron.log') }
try {
  const appRoot = join(work, 'app'), mainRoot = join(appRoot, 'out/main'), preloadRoot = join(appRoot, 'out/preload'), rendererRoot = join(appRoot, 'out/renderer/screenshot-editor')
  for (const directory of [mainRoot, preloadRoot, rendererRoot, join(mainRoot, 'user-data')]) await mkdir(directory, { recursive: true })
  await symlink(resolve('apps/desktop/node_modules'), join(appRoot, 'node_modules'))
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ type: 'module', main: 'out/main/main.js' }))
  const alias = { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
    '@agentmux/client-ui/theme': resolve('packages/client-ui/src/theme/index.ts'), '@agentmux/native-desktop/image': resolve('packages/native-desktop/src/image.ts') }
  const results = []
  results.push(await build({ entryPoints: ['apps/desktop/scripts/fixtures/capture-surface/main.ts'], outfile: join(mainRoot, 'main.js'), bundle: true, platform: 'node', format: 'esm',
    external: ['electron', '@agentmux/core', '@agentmux/core/*', '@agentmux/host/*'], banner: { js: "import { createRequire as fixtureRequire } from 'node:module';const require=fixtureRequire(import.meta.url);" }, alias, metafile: true, logLevel: 'silent' }))
  for (const name of ['capture-surface', 'screenshot-editor']) results.push(await build({ entryPoints: ['apps/desktop/src/preload/' + name + '.ts'], outfile: join(preloadRoot, name + '.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], metafile: true, logLevel: 'silent' }))
  results.push(await build({ entryPoints: ['apps/desktop/src/renderer/screenshot-editor/entry.tsx'], outfile: join(rendererRoot, 'entry.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', alias,
    conditions: ['browser'], metafile: true, logLevel: 'silent' }))
  const htmlFile = 'apps/desktop/src/renderer/screenshot-editor/index.html', html = await readFile(htmlFile, 'utf8')
  await writeFile(join(rendererRoot, 'index.html'), html.replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="./entry.css" /></head>'))
  const files = new Set(results.flatMap(result => Object.keys(result.metafile.inputs)).filter(file => !file.startsWith('<')))
  files.add(htmlFile); files.add('apps/desktop/scripts/verify-capture-surface.mjs'); files.add('apps/desktop/scripts/fixtures/capture-surface/scenario.md')
  receipt.inputs = Object.fromEntries(await Promise.all([...files].map(async file => [file, sha(await readFile(file))])))
  receipt.build = results.map(result => result.metafile.outputs)
  const result = await new Promise((done, reject) => {
    const env = { ...process.env, AGENTMUX_CAPTURE_SURFACE_OUT: out, ELECTRON_RENDERER_URL: '' }; delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(require('electron'), [appRoot], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = '', timeout = false, kill
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; process.stdout.write(bytes) })
    const timer = setTimeout(() => { timeout = true; child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 3000) }, 45000)
    child.once('error', reject)
    child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(kill); done({ code, signal, timeout, log }) })
  })
  await writeFile(receipt.log, result.log)
  assert.equal(result.timeout, false, 'a timed-out process is infrastructure failure, not proof')
  assert.equal(result.signal, null)
  receipt.native = JSON.parse(await readFile(join(out, 'native.json'), 'utf8'))
  assert.equal(result.code, 0, JSON.stringify(receipt.native.failure) + result.log)
  assert.equal(receipt.native.passed, true)
  assert.equal(receipt.native.cases.length, 11, 'all initial backgrounds, compositions, Tab/geometry/history, cancellation and expansion must actually execute')
  assert.equal(receipt.native.screenshots.length, 8)
  assert.equal(receipt.native.grabs.length, 10)
  for (const [file, hash] of Object.entries(receipt.inputs)) assert.equal(sha(await readFile(file)), hash, 'Candidate changed during proof: ' + file)
  receipt.passed = true
} finally {
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await rm(work, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json'), screenshots: receipt.native.screenshots }) + '\n')
