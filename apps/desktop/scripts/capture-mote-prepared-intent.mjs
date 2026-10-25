import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { aliases, browserInstalledDependency, desktopRequire, root } from './fixtures/settings-connections/environment.mjs'

const fixture = resolve(root, 'apps/desktop/scripts/fixtures/mote-prepared-intent')
const hostAliases = Object.entries(JSON.parse(readFileSync(resolve(root, 'apps/host/package.json'), 'utf8')).exports).map(([key, value]) => ({
  find: '@agentmux/host' + (key === '.' ? '' : key.slice(1)), replacement: resolve(root, value.import.replace('./dist/', 'apps/host/src/').replace(/\.js$/u, '.ts'))
}))
const accountSummary = process.argv.includes('--account-summary')
const evidenceRoot = accountSummary ? '.local/connector-entity-components/account-visual' : '.local/channel-protocol/host-owned-channels/mote-prepared-preview'
const evidence = resolve(root, evidenceRoot, 'runs', randomUUID()), temporary = await mkdtemp(resolve(tmpdir(), 'amux-mote-prepared-intent-'))
await mkdir(evidence, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), inputs: {}, loadedTransforms: {} }
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
try {
  for (const path of ['apps/desktop/scripts/capture-mote-prepared-intent.mjs', ...['entry.tsx', 'main.cjs', 'index.html', 'scenario.md'].map(name => 'apps/desktop/scripts/fixtures/mote-prepared-intent/' + name)]) receipt.inputs[path] = sha(await readFile(resolve(root, path)))
  const cssFiles = new Set()
  async function pinCss(file) {
    if (cssFiles.has(file)) return
    cssFiles.add(file)
    const bytes = await readFile(file); receipt.inputs[relative(root, file)] = sha(bytes)
    for (const match of bytes.toString().matchAll(/@import\s+["']([^"']+)["']/gu)) if (match[1].startsWith('.')) await pinCss(resolve(dirname(file), match[1]))
  }
  await pinCss(resolve(root, 'apps/desktop/src/renderer/src/styles/index.css'))
  const ts = desktopRequire('typescript'), imageSource = ts.transpileModule(await readFile(resolve(root, 'apps/desktop/test/fixtures/mote-identity-image.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText
  const { imagePng } = await import('data:text/javascript;base64,' + Buffer.from(imageSource).toString('base64')), image = imagePng()
  receipt.inputs['apps/desktop/test/fixtures/mote-identity-image.ts'] = sha(await readFile(resolve(root, 'apps/desktop/test/fixtures/mote-identity-image.ts')))
  const { build } = await import(pathToFileURL(desktopRequire.resolve('vite')).href), compiled = resolve(temporary, 'compiled')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, resolve: { alias: [...hostAliases, ...aliases] }, define: { __MOTE_PREPARED_IMAGE__: JSON.stringify({ dataUrl: 'data:image/png;base64,'+image.toString('base64'), sha256: sha(image) }), __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'bind-mote-prepared-intent-renderer', enforce: 'pre', resolveId: browserInstalledDependency, transform(code, id) { const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/')) { receipt.inputs[relative(root, file)] = sha(readFileSync(file)); receipt.loadedTransforms[relative(root, id)] = sha(code) } } }], build: { target: 'esnext', outDir: compiled, emptyOutDir: true } })
  receipt.compiled = Object.fromEntries(await Promise.all((await readdir(compiled, { recursive: true })).filter(name => /\.(?:html|js|css)$/u.test(name)).map(async name => [name, sha(await readFile(resolve(compiled, name)))])))
  const visual = resolve(evidence, 'visual'); await mkdir(visual)
  const lines = [], execution = await runProbeProcess(desktopRequire('electron'), [resolve(fixture, 'main.cjs'), resolve(compiled, 'index.html'), temporary, visual, ...(accountSummary ? ['--account-summary'] : [])], { cwd: root, temporaryRoot: temporary, env, timeoutMs: 60000, onLine: line => lines.push(line) })
  await writeFile(resolve(visual, 'capture.log'), lines.join('\n'))
  const render = JSON.parse(await readFile(resolve(visual, 'render.json'), 'utf8'))
  assert.equal(execution.exitCode, 0, JSON.stringify(render.failure)); assert.equal(render.passed, true)
  assert.equal(render.frames.length, accountSummary || process.env.MOTE_PREPARED_CAPTURE_OWNERLESS_ONLY === '1' ? 2 : 6)
  receipt.render = render; receipt.images = Object.fromEntries(await Promise.all(render.frames.map(async file => [file, sha(await readFile(resolve(visual, file)))])))
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; throw error }
finally {
  receipt.cleanup = { remaining: await listProbeProcesses(-1, temporary) }; assert.deepEqual(receipt.cleanup.remaining, [])
  await rm(temporary, { recursive: true, force: true })
  await writeFile(resolve(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await writeFile(resolve(root, evidenceRoot, 'latest.json'), JSON.stringify({ evidence, receipt: resolve(evidence, 'receipt.json') }, null, 2))
  console.log(JSON.stringify({ passed: receipt.passed, evidence }))
}
