import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = await import(pathToFileURL(require.resolve('vite')))
const fixture = join(root, 'apps/desktop/scripts/fixtures/browser-task-parallel-ui')
const base = join(root, '.local/t009-ui'); await mkdir(base, { recursive: true })
const out = await mkdtemp(join(base, 'capture-')), sources = {}, hash = bytes => createHash('sha256').update(bytes).digest('hex')
const taskCss = join(root, 'apps/desktop/src/renderer/src/styles/browser-task-assets.css'), cssBefore = hash(await readFile(taskCss))
await build({ configFile: false, root: fixture, base: './', logLevel: 'warn', define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, esbuild: { jsx: 'automatic' },
  worker: { format: 'es' },
  plugins: [{ name: 'parallel-ui-source-proof', transform(code, id) { const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/')) sources[relative(root, file)] = hash(readFileSync(file)) } }],
  build: { outDir: join(out, 'compiled'), emptyOutDir: false, minify: false } })
if (hash(await readFile(taskCss)) !== cssBefore) throw new Error('Owned task styles changed during compilation; capture cannot qualify this source')
sources[relative(root, taskCss)] = cssBefore
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
Object.assign(env, { PARALLEL_UI_OUT: out, PARALLEL_UI_HTML: join(out, 'compiled/index.html') })
let probe
try {
  const lines = []
  probe = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs')], { cwd: out, env, timeoutMs: 90_000, onLine: line => lines.push(line) })
  await stopProbeProcesses(probe.originalPid, out)
  await writeFile(join(out, 'native.log'), lines.join('\n'))
  const remaining = await listProbeProcesses(probe.originalPid, out), capture = JSON.parse(await readFile(join(out, 'capture.json'), 'utf8'))
  await writeFile(join(out, 'source.json'), JSON.stringify({ sources, probe, remaining, capture }, null, 2))
  console.log(JSON.stringify({ out, complete: capture.complete, aestheticReview: 'not-performed' }))
  if (probe.exitCode !== 0 || probe.timedOut || remaining.length || !capture.complete) throw new Error(capture.failure?.message ?? 'Private capture incomplete')
} finally {
  if (probe) await stopProbeProcesses(probe.originalPid, out)
  for (const name of ['compiled', 'home', 'appData', 'userData', 'sessionData']) await rm(join(out, name), { recursive: true, force: true })
}
