import { build } from 'vite'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { candidateAlias } from './candidate-package-resolve.mjs'

// Capture-only: the real BrowserPane find row with preview find answers. Review the PNGs separately.
const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const fixture = join(desktop, 'scripts/fixtures/browser-find-in-page'), directory = join(root, '.tmp/browser-find-visual', randomUUID())
const output = join(directory, 'compiled')
await mkdir(directory, { recursive: true })
const sourceFiles = [
  'apps/desktop/src/renderer/src/components/BrowserFindBar.tsx',
  'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
  'apps/desktop/src/renderer/src/lib/browser-shortcuts.ts',
  'apps/desktop/src/shared/browser-page-shortcuts.ts',
  'apps/desktop/src/renderer/src/lib/api.ts',
  'apps/desktop/src/renderer/src/styles/browser.css',
  'apps/desktop/scripts/fixtures/browser-find-in-page/entry.tsx',
  'apps/desktop/scripts/fixtures/browser-find-in-page/main.cjs'
]
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
const source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), files: await sourceHashes() }
await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
  resolve: { alias: [candidateAlias(root, { source: true, browser: true })], dedupe: ['react', 'react-dom'] },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
  build: { outDir: output, emptyOutDir: true, minify: false, sourcemap: false, chunkSizeWarningLimit: 20000 } })
const electron = createRequire(join(desktop, 'package.json'))('electron')
const logs = [], exit = await new Promise((done, reject) => {
  const child = spawn(electron, [join(fixture, 'main.cjs')], { cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, FIND_VISUAL_ROOT: directory, FIND_VISUAL_HTML: join(output, 'index.html') }, stdio: ['ignore', 'pipe', 'pipe'] })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 90000)
  child.once('close', () => clearTimeout(timeout))
  child.stdout.on('data', data => logs.push(data)); child.stderr.on('data', data => logs.push(data)); child.on('error', reject); child.on('close', done)
})
await writeFile(join(directory, 'native.log'), Buffer.concat(logs))
const capture = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8'))
source.unchanged = JSON.stringify(source.files) === JSON.stringify(await sourceHashes())
await writeFile(join(directory, 'source.json'), JSON.stringify(source, null, 2))
await rm(output, { recursive: true, force: true })
for (const name of ['home', 'appData', 'userData', 'sessionData']) await rm(join(directory, name), { recursive: true, force: true })
console.log(JSON.stringify({ exit, captureOnly: true, aestheticReview: 'not-performed', directory, source, oracles: capture.oracles, screenshots: capture.screenshots?.map(item => item.file) }))
if (exit || !capture.complete) throw new Error(capture.failure?.message ?? 'Private visual capture failed')
if (!source.unchanged) throw new Error('Find row visual inputs changed during capture; retain these images as an unconfirmed candidate')
