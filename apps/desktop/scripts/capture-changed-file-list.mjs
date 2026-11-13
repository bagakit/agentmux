import { build } from 'vite'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'

// Capture-only: the real commit details with a 5001-file preview commit. Review the PNGs separately.
const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const fixture = join(desktop, 'scripts/fixtures/changed-file-list'), directory = join(root, '.tmp/changed-file-list-visual', randomUUID())
const output = join(directory, 'compiled')
await mkdir(directory, { recursive: true })
await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  build: { outDir: output, emptyOutDir: true, minify: false, sourcemap: false, chunkSizeWarningLimit: 20000 } })
const electron = createRequire(join(desktop, 'package.json'))('electron')
const logs = [], exit = await new Promise((done, reject) => {
  const child = spawn(electron, [join(fixture, 'main.cjs')], { cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, CHANGED_FILE_LIST_VISUAL_ROOT: directory, CHANGED_FILE_LIST_HTML: join(output, 'index.html') }, stdio: ['ignore', 'pipe', 'pipe'] })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 90000)
  child.once('close', () => clearTimeout(timeout))
  child.stdout.on('data', data => logs.push(data)); child.stderr.on('data', data => logs.push(data)); child.on('error', reject); child.on('close', done)
})
await writeFile(join(directory, 'native.log'), Buffer.concat(logs))
const capture = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8'))
await rm(output, { recursive: true, force: true })
for (const name of ['home', 'appData', 'userData', 'sessionData']) await rm(join(directory, name), { recursive: true, force: true })
console.log(JSON.stringify({ exit, captureOnly: true, aestheticReview: 'not-performed', directory, measurements: capture.measurements, screenshots: capture.screenshots?.map(item => item.file) }))
if (exit || !capture.complete) throw new Error(capture.failure?.message ?? 'Private visual capture failed')
