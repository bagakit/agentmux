import { fixturePath as _reshape_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, readdir, writeFile, mkdir, mkdtemp, rm, copyFile, symlink } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'

const args = process.argv.slice(2)
assert.ok(args.every(arg => ['--mutations', '--visual', '--editor', '--model'].includes(arg)), 'Unsupported screenshot proof option')
if (args.includes('--model')) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolvePath('apps/desktop/scripts/verify-browser-screenshot-model.mjs'), ...args.filter(arg => arg !== '--model')], { stdio: 'inherit' })
    child.once('error', reject); child.once('exit', code => resolve(code))
  })
  process.exit(code ?? 1)
}
function resolvePath(path) { return resolve(path) }
const fixture = resolve('apps/desktop/scripts/fixtures/browser-screenshot-workface')
const require = createRequire(resolve('apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const out = resolve('.local/browser-screenshot-workface/editor-proof'), work = await mkdtemp(_reshape_fixturePath("tmp/agentmux-screenshot-workface-"))
await mkdir(out, { recursive: true })
await rm(join(out, 'receipt.json'), { force: true })
const pane = resolve('apps/desktop/src/renderer/src/components/BrowserPane.tsx')
const editor = resolve('apps/desktop/src/renderer/src/components/browser-screenshot/ScreenshotEditor.tsx')
const paneSource = await readFile(pane, 'utf8'), editorSource = await readFile(editor, 'utf8')
const screenshotDirectory = 'apps/desktop/src/renderer/src/components/browser-screenshot'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceInputs = [
  'apps/desktop/src/renderer/src/components/BrowserPane.tsx', 'apps/desktop/src/renderer/src/components/browser-screenshot/ScreenshotEditor.tsx',
  'apps/desktop/src/renderer/src/components/browser-screenshot/canvas-render.ts', 'apps/desktop/src/renderer/src/components/browser-screenshot/compose.ts',
  'apps/desktop/src/renderer/src/components/browser-screenshot/drawing-model.ts', 'apps/desktop/src/renderer/src/components/browser-screenshot/drawing-renderer.ts',
  'apps/desktop/src/renderer/src/hooks/useNativeOverlayChrome.ts', 'apps/desktop/src/renderer/src/lib/native-overlay-regions.ts',
  'apps/desktop/src/main/native-overlay-surfaces.ts', 'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/renderer/src/styles/browser.css',
  'apps/desktop/src/main/browser-screenshot-source.ts',
  'apps/desktop/src/main/browser-external-owner.ts', 'apps/desktop/src/renderer/src/styles/base.css',
  'packages/client-ui/src/theme/icon-catalog.ts', 'packages/client-ui/src/theme/icon-glyphs.ts',
  'packages/client-ui/src/theme/icon-sprite.ts',
  'apps/desktop/src/shared/contracts.ts',
  ...['public-rpc-server.ts', 'public-rpc-client.ts', 'public-rpc-service.ts', 'rpc-business-codec.ts', 'control-codec.ts', 'agentmux.ts'].map(name => 'packages/core/src/' + name),
  ...['index.js', 'control-host.js', 'public-rpc.js', 'public-rpc-frame.js', 'public-rpc-client.js', 'public-rpc-service.js', 'public-rpc-server.js', 'public-rpc-wire.js', 'rpc-business-codec.js', 'control-codec.js', 'runtime-paths.js', 'agentmux-cli-commands.js', 'agentmux.js'].map(name => 'packages/core/dist/' + name),
  'apps/desktop/scripts/verify-browser-screenshot-workface.mjs',
  ...['main.ts', 'renderer.tsx', 'bridge.ts', 'preload.cjs', 'fixture.css'].map(name => 'apps/desktop/scripts/fixtures/browser-screenshot-workface/' + name)
]
for (const name of await readdir(screenshotDirectory)) {
  const path = screenshotDirectory + '/' + name
  if (/\.tsx?$/.test(name) && !sourceInputs.includes(path)) sourceInputs.push(path)
}
const evidence = { schema: 'agentmux.browser-screenshot-workface-native.v1', sourceInputs: Object.fromEntries(await Promise.all(sourceInputs.map(async path => [path, sha(await readFile(path))]))), cases: [], passed: false }
const base = { bundle: true, logLevel: 'silent', absWorkingDir: process.cwd(), jsx: 'automatic',
  alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) },
  nodePaths: [resolve('apps/desktop/node_modules')] }
async function run(label, mutant) {
  const compiled = join(work, label); await mkdir(compiled)
  await symlink(resolve('apps/desktop/node_modules'), join(compiled, 'node_modules'))
  await copyFile(join(fixture, 'preload.cjs'), join(compiled, 'preload.cjs'))
  const adapter = await readFile(join(fixture, 'bridge.ts'), 'utf8')
  const plugins = [{ name: 'private-product-IO-and-reversible-source-mutation', setup(build) {
    build.onLoad({ filter: /\/renderer\/src\/(lib\/api|store)\.ts$/ }, () => ({ contents: adapter, loader: 'ts', resolveDir: fixture }))
    if (mutant === 'omit-screenshot-hide') build.onLoad({ filter: /BrowserPane\.tsx$/ }, value => {
      assert.equal(value.path, pane)
      const target = '          screenshot !== null ||\n'
      assert.equal(paneSource.split(target).length - 1, 1, 'The actual legacy screenshot visibility consumer exists exactly once')
      return { contents: paneSource.replace(target, ''), loader: 'tsx', resolveDir: dirname(pane) }
    })
    if (mutant === 'disable-busy-cancel') build.onLoad({ filter: /ScreenshotEditor\.tsx$/ }, value => {
      assert.equal(value.path, editor)
      const matches = [...editorSource.matchAll(/<button\b[^>]*onClick=\{onCancel\}[^>]*>/g)]
      assert.equal(matches.length, 1, 'The actual Cancel action exists exactly once')
      const target = matches[0][0]
      assert.ok(!target.includes('disabled='), 'The original Cancel retains its existing enabled input capability')
      return { contents: editorSource.replace(target, target.replace('<button', '<button disabled={busy}')), loader: 'tsx', resolveDir: dirname(editor) }
    })
    if (mutant === 'omit-selected-move') build.onLoad({ filter: /ScreenshotEditor\.tsx$/ }, value => {
      assert.equal(value.path, editor)
      const target = 'currentGestureRef.current = moveShape(original, at.x - start.x, at.y - start.y)'
      assert.equal(editorSource.split(target).length - 1, 1, 'The actual selected-object move consumer exists exactly once')
      return { contents: editorSource.replace(target, 'currentGestureRef.current = original'), loader: 'tsx', resolveDir: dirname(editor) }
    })
    if (mutant === 'omit-processed-crop') build.onLoad({ filter: /ScreenshotEditor\.tsx$/ }, value => {
      assert.equal(value.path, editor)
      const target = 'const input = { image: base, shapes, crop: documentState.crop, displayWidth: image.width, displayHeight: image.height }'
      assert.equal(editorSource.split(target).length - 1, 1, 'The actual processed image/context crop consumer exists exactly once')
      return { contents: editorSource.replace(target, target.replace('crop: documentState.crop', 'crop: null')), loader: 'tsx', resolveDir: dirname(editor) }
    })
  } }]
  await build({ ...base, platform: 'node', format: 'esm', packages: 'external',
    banner: { js: `import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);` },
    entryPoints: [join(fixture, 'main.ts')], outfile: join(compiled, 'main.mjs') })
  await build({ ...base, plugins, platform: 'browser', format: 'esm', define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
    loader: { '.png': 'file', '.svg': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
    entryPoints: [join(fixture, 'renderer.tsx')], outfile: join(compiled, 'renderer.js') })
  await writeFile(join(compiled, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>')
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENTMUX_|CTXMUX_)/.test(key)))
  const env = { ...cleanEnv, AGENTMUX_SCREENSHOT_PROBE_ROOT: compiled, AGENTMUX_SCREENSHOT_PROBE_OUT: out,
    AGENTMUX_SCREENSHOT_CLI: resolve('packages/core/dist/agentmux.js'),
    AGENTMUX_RUNTIME_DIRECTORY: join(compiled, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(compiled, 'state'),
    AGENTMUX_SCREENSHOT_PROBE_LABEL: label, AGENTMUX_SCREENSHOT_VISUAL: !mutant && args.includes('--visual') ? '1' : '0' }
  delete env.ELECTRON_RUN_AS_NODE
  await Promise.all([label + '.json', label + '.progress.json'].map(name => rm(join(out, name), { force: true })))
  const result = await new Promise((done, reject) => {
    const child = spawn(require('electron'), [join(compiled, 'main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', expired = false, escalation
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes })
    const timeout = setTimeout(() => { expired = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 1500) }, 30000)
    child.once('error', error => { clearTimeout(timeout); clearTimeout(escalation); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timeout); clearTimeout(escalation); expired ? reject(new Error('Exact private screenshot child timed out and exited: ' + label + '\n' + output)) : done({ code, signal, output }) })
  })
  const receipt = JSON.parse(await readFile(join(out, label + '.json'), 'utf8'))
  await writeFile(join(out, label + '.json'), JSON.stringify({ ...receipt, process: result }, null, 2))
  if (mutant) {
    assert.equal(result.code, 1, 'Actual source mutation must fail after native preparation: ' + mutant)
    const failures = {
      'omit-screenshot-hide': /screenshot-mode-must-hide-original-native-owner/,
      'disable-busy-cancel': /busy-copy-must-keep-Cancel-action-available/,
      'omit-selected-move': /actual-Select-move-must-move-the-original-ink/,
      'omit-processed-crop': /actual-Crop-must-change-the-consumed-PNG-dimensions/
    }
    assert.match(receipt.failure?.message ?? '', failures[mutant])
  } else {
    assert.equal(result.code, 0, result.output + '\n' + receipt.failure?.message + '\nEvidence: ' + join(out, label + '.json'))
    assert.equal(receipt.passed, true)
    assert.ok(receipt.cases.some(row => row.label === 'continuous-pointer-ink-with-zero-native-chrome-work'))
    assert.ok(receipt.images.length > 0)
  }
  evidence.cases.push({ label, result: mutant ? 'RED' : 'GREEN', receipt: label + '.json' })
  console.log(label + ': ' + (mutant ? 'expected RED' : 'GREEN'))
}
try {
  await run('source')
  if (args.includes('--mutations')) {
    await run('omit-screenshot-hide', 'omit-screenshot-hide')
    await run('disable-busy-cancel', 'disable-busy-cancel')
    await run('omit-selected-move', 'omit-selected-move')
    await run('omit-processed-crop', 'omit-processed-crop')
    await run('restored-source')
  }
  for (const path of sourceInputs) assert.equal(sha(await readFile(path)), evidence.sourceInputs[path], 'Shared source changed during proof: ' + path)
  evidence.passed = true
  await writeFile(join(out, 'receipt.json'), JSON.stringify(evidence, null, 2))
} finally { await rm(work, { recursive: true, force: true }) }
