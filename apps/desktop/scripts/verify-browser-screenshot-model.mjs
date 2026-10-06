import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve, join, dirname } from 'node:path'
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
const require = createRequire(resolve('apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const root = resolve('apps/desktop/src/renderer/src/components/browser-screenshot')
const output = resolve('.local/browser-screenshot-workface/model-proof'), work = await mkdtemp(join(tmpdir(), 'amx-screenshot-model-'))
await mkdir(output, { recursive: true })
await rm(join(output, 'receipt.json'), { force: true })
const sources = Object.fromEntries(await Promise.all(['drawing-model.ts', 'drawing-renderer.ts', 'compose.ts'].map(async file => [file, await readFile(join(root, file), 'utf8')])))
const evidence = { passed: false, sourceHashes: Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, createHash('sha256').update(source).digest('hex')])), cases: [] }
const proofInputs = ['apps/desktop/scripts/verify-browser-screenshot-model.mjs', 'apps/desktop/scripts/fixtures/browser-screenshot-workface/model.ts']
evidence.proofInputs = Object.fromEntries(await Promise.all(proofInputs.map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])))
async function run(label, mutation) {
  const compiled = join(work, label); await mkdir(compiled, { recursive: true })
  await mkdir(join(compiled, 'user-data'))
  await symlink(resolve('apps/desktop/node_modules'), join(compiled, 'node_modules'))
  const plugins = mutation ? [{ name: label, setup(build) { build.onLoad({ filter: /(?:drawing-model|drawing-renderer|compose)\.ts$/ }, args => {
    const name = args.path.split('/').at(-1), source = sources[name]
    if (name !== mutation.file) return
    assert.equal(source.split(mutation.find).length, 2, 'Actual source mutation must be unique: ' + label)
    return { contents: source.replace(mutation.find, mutation.replace), loader: 'ts', resolveDir: root }
  }) } }] : []
  await build({ bundle: true, logLevel: 'silent', absWorkingDir: process.cwd(), platform: 'browser', format: 'iife', plugins,
    entryPoints: ['apps/desktop/scripts/fixtures/browser-screenshot-workface/model.ts'], outfile: join(compiled, 'model.js') })
  await writeFile(join(compiled, 'index.html'), '<!doctype html><script src="model.js"></script>')
  await writeFile(join(compiled, 'main.cjs'), `const { app, BrowserWindow } = require('electron'); const { writeFile } = require('node:fs/promises');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
app.setPath('userData', ${JSON.stringify(join(compiled, 'user-data'))});
(async () => { await app.whenReady(); console.log('model-app-ready');
const window = new BrowserWindow({ show:false, webPreferences:{ sandbox:true, backgroundThrottling:false }});
window.webContents.on('console-message', (_event, _level, message) => console.log(message));
window.showInactive(); await window.loadFile(${JSON.stringify(join(compiled, 'index.html'))}); console.log('model-loaded');
const result = await window.webContents.executeJavaScript('window.modelProof'); console.log('model-finished');
await writeFile(${JSON.stringify(join(compiled, 'receipt.json'))}, JSON.stringify(result)); window.destroy(); app.exit(result.passed ? 0 : 1);
})().catch(error => { console.error(error); app.exit(1); });`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const result = await new Promise((done, reject) => {
    const child = spawn(require('electron'), [join(compiled, 'main.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', escalation
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes })
    const timer = setTimeout(() => { child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 1500) }, 20000)
    child.on('error', reject); child.on('exit', code => { clearTimeout(timer); clearTimeout(escalation); done({ code, output }) })
  })
  const receipt = JSON.parse(await readFile(join(compiled, 'receipt.json'), 'utf8').catch(error => { throw new Error('Model child produced no receipt: ' + JSON.stringify(result), { cause: error }) }))
  if (mutation) { assert.equal(result.code, 1, JSON.stringify(receipt)); assert.equal(receipt.passed, false); assert.match(receipt.failure, mutation.failure) }
  else { assert.equal(result.code, 0, result.output + JSON.stringify(receipt)); assert.equal(receipt.passed, true); assert.equal(receipt.cases.length, 7) }
  if (receipt.png) { await writeFile(join(output, label + '.png'), Buffer.from(receipt.png.dataUrl.split(',')[1], 'base64')); delete receipt.png }
  await writeFile(join(output, label + '.json'), JSON.stringify({ ...receipt, process: result }, null, 2))
  evidence.cases.push({ label, result: mutation ? 'RED' : 'GREEN' }); console.log(label + ': ' + (mutation ? 'expected RED' : 'GREEN'))
}
try {
  await run('source')
  if (process.argv.includes('--mutations')) {
    await run('crop-omitted', { file: 'compose.ts', find: 'if (!input.crop) return output', replace: 'return output', failure: /crop must change/ })
    await run('pixelation-omitted', { file: 'drawing-renderer.ts', find: "case 'pixelate': drawPixelate(context, shape); break", replace: "case 'pixelate': break", failure: /pixelate must change/ })
    await run('move-omitted', { file: 'drawing-model.ts', find: 'const move = (at: ScreenshotPoint) => ({ x: at.x + dx, y: at.y + dy })', replace: 'const move = (at: ScreenshotPoint) => at', failure: /move must preserve/ })
    await run('restored-source')
  }
  for (const [file, source] of Object.entries(sources)) assert.equal(await readFile(join(root, file), 'utf8'), source, 'Model source changed during native verification: ' + file)
  for (const [file, hash] of Object.entries(evidence.proofInputs)) assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), hash, 'Model proof changed during verification: ' + file)
  evidence.passed = true; await writeFile(join(output, 'receipt.json'), JSON.stringify(evidence, null, 2))
} finally { await rm(work, { recursive: true, force: true }) }
