import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runProbeProcess } from '../../probe-process.mjs'
const fixture = import.meta.dirname, root = path.resolve(fixture, '../../../../..'), require = createRequire(path.join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild'), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = path.join(root, '.tmp/agent-schedules/ui-renderer-' + globalThis.crypto.randomUUID()), compiled = path.join(directory, 'compiled')
await fs.mkdir(compiled, { recursive: true }); await fs.mkdir(path.join(directory, 'userData'))
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', source: {}, images: {}, boundary: 'Original CalendarScheduleControl/ContinuousProgressControl and Desktop styles in one isolated Electron Renderer. Controlled typed API replies, native pointer/keyboard controls, no user App/Run, Native lifecycle, model, package or install.' }
try {
  const alias = {}
  for (const name of ['core', 'layout', 'demand']) {
    const directory = path.join(root, 'packages', name), manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'))
    for (const [subpath, target] of Object.entries(manifest.exports)) if (!subpath.includes('*')) alias['@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))] = path.join(directory, target.import.replace('./dist/', name === 'core' ? './src/' : './').replace(/\.js$/, '.ts'))
  }
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'ui-entry.tsx')], outdir: compiled, bundle: true, format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', logLevel: 'error', metafile: true, alias, loader: { '.png': 'file', '.svg': 'file' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' } })
  for (const file of Object.keys(built.metafile.inputs)) receipt.source[file] = sha(await fs.readFile(path.resolve(root, file)))
  for (const file of ['CalendarScheduleControl', 'ContinuousProgressControl']) assert(receipt.source['apps/desktop/src/renderer/src/components/' + file + '.tsx'])
  for (const name of ['capture-ui.mjs', 'ui-main.cjs']) receipt.source[path.relative(root, path.join(fixture, name))] = sha(await fs.readFile(path.join(fixture, name)))
  await fs.writeFile(path.join(compiled, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="ui-entry.css"></head><body><div id="root"></div><script type="module" src="ui-entry.js"></script></body></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  receipt.process = await runProbeProcess(require('electron'), [path.join(fixture, 'ui-main.cjs'), path.join(compiled, 'index.html'), directory], { temporaryRoot: directory, cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
  await fs.writeFile(path.join(directory, 'renderer.log'), logs.join('\n'))
  receipt.renderer = JSON.parse(await fs.readFile(path.join(directory, 'renderer-result.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0); assert.equal(receipt.renderer.passed, true)
  for (const file of receipt.renderer.images) receipt.images[path.relative(root, path.join(directory, file))] = sha(await fs.readFile(path.join(directory, file)))
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack } }
await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); await fs.rm(compiled, { recursive: true, force: true })
console.log(path.relative(root, path.join(directory, 'receipt.json')))
if (!receipt.passed) { console.error(receipt.error); process.exitCode = 1 }
