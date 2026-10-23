import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { aliases, browserInstalledDependency, desktopRequire, root } from './fixtures/settings-connections/environment.mjs'

const fixture = resolve(root, 'apps/desktop/scripts/fixtures/channel-entry')
const headerStatus = process.argv.includes('--header-status'), main = headerStatus ? 'status-main.cjs' : 'main.cjs'
const evidenceRoot = headerStatus ? '.local/group-readiness/header-visual' : '.local/channel-protocol/channel-entry'
const evidence = resolve(root, evidenceRoot, 'runs', randomUUID()), temporary = await mkdtemp(resolve(tmpdir(), 'amux-channel-entry-'))
await mkdir(evidence, { recursive: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const receipt = { passed: false, captureOnly: true, aestheticReview: 'not-performed', candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), inputs: {} }
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
try {
  for (const path of ['apps/desktop/scripts/capture-channel-entry.mjs', ...['entry.tsx', main, 'index.html', 'scenario.md'].map(name => 'apps/desktop/scripts/fixtures/channel-entry/' + name)]) receipt.inputs[path] = sha(await readFile(resolve(root, path)))
  const { build } = await import(pathToFileURL(desktopRequire.resolve('vite')).href), compiled = resolve(temporary, 'compiled')
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, resolve: { alias: aliases }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'bind-channel-entry-renderer', enforce: 'pre', resolveId: browserInstalledDependency, transform(code, id) { const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/')) receipt.inputs[relative(root, file)] = sha(code) } }], build: { target: 'esnext', outDir: compiled, emptyOutDir: true } })
  if (!headerStatus) await cp(compiled, resolve(evidence, 'compiled'), { recursive: true })
  receipt.compiled = Object.fromEntries(await Promise.all((await readdir(compiled, { recursive: true })).filter(name => /\.(?:html|js|css)$/u.test(name)).map(async name => [name, sha(await readFile(resolve(compiled, name)))])))
  const visual = resolve(evidence, 'visual'); await mkdir(visual)
  const lines = [], execution = await runProbeProcess(desktopRequire('electron'), [resolve(fixture, main), resolve(compiled, 'index.html'), temporary, visual], { cwd: root, temporaryRoot: temporary, env, timeoutMs: 60000, onLine: line => lines.push(line) })
  await writeFile(resolve(visual, 'capture.log'), lines.join('\n'))
  const render = JSON.parse(await readFile(resolve(visual, 'render.json'), 'utf8'))
  assert.equal(execution.exitCode, 0, JSON.stringify(render.failure)); assert.equal(render.passed, true)
  assert.equal(render.frames.length, headerStatus ? 6 : 8)
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
