import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const root = process.cwd(), require = createRequire(resolve('apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const source = 'apps/desktop/src/renderer/src/components/image-annotation/image-annotation.css'
const original = await readFile(source, 'utf8'), from = '@container screenshot-editor (max-width: 740px)', to = '@container screenshot-editor (max-width: 580px)'
assert.equal(original.split(from).length, 2, 'the medium-width production breakpoint must be unique')
const menuFrom = 'max-height: min(70vh, 480px, var(--radix-dropdown-menu-content-available-height, 70vh)); overflow-y: auto;'
assert.equal(original.split(menuFrom).length, 2, 'the tool menu viewport limit must be unique')
const variants = [null, { id: 'narrow-breakpoint', from, to }, { id: 'unbounded-menu', from: menuFrom, to: 'max-height: none; overflow-y: visible;' }]
const hash = value => createHash('sha256').update(value).digest('hex')
await mkdir(resolve('.local/screenshot-toolbar'), { recursive: true })
const out = await mkdtemp(resolve('.local/screenshot-toolbar/run-')), work = await mkdtemp(join(tmpdir(), 'agentmux-screenshot-toolbar-'))
const receipt = { schema: 'agentmux.screenshot-toolbar-proof.v1', passed: false, variants: [], inputs: {}, cleanup: {} }
try {
  const appRoot = join(work, 'app'), main = join(appRoot, 'out/main'), preload = join(appRoot, 'out/preload'), renderer = join(appRoot, 'out/renderer/screenshot-editor')
  for (const dir of [main, preload, renderer]) await mkdir(dir, { recursive: true })
  await symlink(resolve('apps/desktop/node_modules'), join(appRoot, 'node_modules'))
  await writeFile(join(appRoot, 'package.json'), JSON.stringify({ type: 'module', main: 'out/main/main.js' }))
  const alias = { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')),
    '@agentmux/client-ui/theme': resolve('packages/client-ui/src/theme/index.ts'), '@agentmux/native-desktop/image': resolve('packages/native-desktop/src/image.ts') }
  const builds = []
  builds.push(await build({ entryPoints: ['apps/desktop/scripts/fixtures/screenshot-toolbar/main.ts'], outfile: join(main, 'main.js'), bundle: true, platform: 'node', format: 'esm', external: ['electron', '@agentmux/core', '@agentmux/core/*', '@agentmux/host/*'], alias,
    banner: { js: "import { createRequire as fixtureRequire } from 'node:module';const require=fixtureRequire(import.meta.url);" }, metafile: true, logLevel: 'silent' }))
  builds.push(await build({ entryPoints: ['apps/desktop/src/preload/screenshot-editor.ts'], outfile: join(preload, 'screenshot-editor.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], metafile: true, logLevel: 'silent' }))
  const htmlFile = 'apps/desktop/src/renderer/screenshot-editor/index.html', html = await readFile(htmlFile, 'utf8')
  await writeFile(join(renderer, 'index.html'), html.replace('./entry.tsx', './entry.js').replace('</head>', '<link rel="stylesheet" href="./entry.css" /></head>'))
  for (const mutation of variants) {
    const label = mutation?.id ?? 'baseline'
    const scene = join(out, label); await mkdir(scene)
    const consumed = []
    const result = await build({ entryPoints: ['apps/desktop/src/renderer/screenshot-editor/entry.tsx'], outfile: join(renderer, 'entry.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', alias, conditions: ['browser'], metafile: true, logLevel: 'silent',
      plugins: [{ name: 'exact-toolbar-css', setup(builder) { builder.onLoad({ filter: /\/image-annotation\.css$/ }, async args => {
        assert.equal(args.path, resolve(source)); const value = await readFile(args.path, 'utf8'); assert.equal(value, original)
        const css = mutation ? value.replace(mutation.from, mutation.to) : value
        consumed.push({ original: hash(value), consumed: hash(css) }); return { contents: css, loader: 'css', resolveDir: dirname(args.path) }
      }) } }] })
    assert.equal(consumed.length, 1); assert.equal(consumed[0].consumed, hash(mutation ? original.replace(mutation.from, mutation.to) : original))
    builds.push(result)
    const env = { ...process.env, AGENTMUX_SCREENSHOT_TOOLBAR_OUT: scene, ELECTRON_RENDERER_URL: '' }; delete env.ELECTRON_RUN_AS_NODE
    const resultProcess = await new Promise((done, reject) => {
      const child = spawn(require('electron'), [appRoot], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = '', timedOut = false, kill
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes })
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); kill = setTimeout(() => child.kill('SIGKILL'), 3000) }, 45000)
      child.once('error', error => { clearTimeout(timer); clearTimeout(kill); reject(error) })
      child.once('exit', (code, signal) => { clearTimeout(timer); clearTimeout(kill); done({ code, signal, timedOut, log }) })
    })
    await writeFile(join(scene, 'electron.log'), resultProcess.log)
    assert.equal(resultProcess.timedOut, false, label + ': timeout cannot prove behavior'); assert.equal(resultProcess.signal, null)
    const native = JSON.parse(await readFile(join(scene, 'native.json'), 'utf8'))
    receipt.variants.push({ label, consumed, code: resultProcess.code, native })
    if (label === 'baseline') {
      assert.equal(resultProcess.code, 0, JSON.stringify(native.failure)); assert.equal(native.passed, true)
      assert.equal(native.cases.length, 8); assert.equal(native.screenshots.length, 4)
    } else {
      assert.notEqual(resultProcess.code, 0, 'the old breakpoint must fail actual toolbar geometry')
      assert.equal(native.failure?.name, 'AssertionError'); assert.ok(native.cases.some(row => row.width === 640))
      assert.match(native.failure.message, mutation.id === 'unbounded-menu' ? /the last tool remains within the viewport and hittable after scrolling/ : /toolbar controls remain independently hittable|toolbar controls never overlap|compact tool menu remains available/)
    }
    process.stdout.write(label + ': ' + (label === 'baseline' ? 'GREEN' : 'AssertionRED') + '\n')
  }
  const inputs = new Set(builds.flatMap(result => Object.keys(result.metafile.inputs)).filter(file => !file.startsWith('<')))
  inputs.add(htmlFile); inputs.add('apps/desktop/scripts/verify-screenshot-toolbar.mjs')
  receipt.inputs = Object.fromEntries(await Promise.all([...inputs].map(async file => [file, hash(await readFile(file))])))
  for (const [file, digest] of Object.entries(receipt.inputs)) assert.equal(hash(await readFile(file)), digest, 'The original candidate input changed: ' + file)
  receipt.passed = true
} finally {
  await rm(work, { recursive: true, force: true }); receipt.cleanup.temporaryBuildRemoved = true
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json') }) + '\n')
