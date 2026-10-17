import { build } from 'vite'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, resolve, relative } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const fixture = join(desktop, 'scripts/fixtures/browser-use-settings'), directory = join(root, '.tmp/browser-use-visual', randomUUID())
const output = join(directory, 'compiled'), sources = {}
await mkdir(directory, { recursive: true })
const hash = text => createHash('sha256').update(text).digest('hex')
await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  build: { outDir: output, emptyOutDir: true, minify: false, sourcemap: false, chunkSizeWarningLimit: 20000 },
  plugins: [{ name: 'browser-use-visual-source-identity', enforce: 'pre', transform(source, id) {
    if ((id.startsWith(join(desktop, 'src') + '/') || id.startsWith(join(root, 'packages/client-ui/src') + '/')) && !id.includes('?')) {
      sources[relative(root, id)] = { file: hash(readFileSync(id)), consumed: hash(source) }
      if (process.argv.includes('--effect-mutant') && id === join(desktop, 'src/shared/browser-agent-control.ts')) {
        const anchor = '  const p = preferences'
        if (source.split(anchor).length !== 2) throw new Error('Unique shared-effect production mutation anchor')
        const mutated = source.replace(anchor, "  return ''; // private mutation: remove shared drawing\n" + anchor)
        sources[relative(root, id)].consumed = hash(mutated)
        return mutated
      }
    }
  } }] })
const require = createRequire(join(desktop, 'package.json')), electron = require('electron')
const logs = [], exit = await new Promise((resolve, reject) => {
  const child = spawn(electron, [join(fixture, 'main.cjs')], { cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, BROWSER_USE_VISUAL_ROOT: directory, BROWSER_USE_VISUAL_HTML: join(output, 'index.html') }, stdio: ['ignore', 'pipe', 'pipe'] })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 60000)
  child.once('close', () => clearTimeout(timeout))
  child.stdout.on('data', data => logs.push(data)); child.stderr.on('data', data => logs.push(data)); child.on('error', reject); child.on('close', resolve)
})
await writeFile(join(directory, 'native.log'), Buffer.concat(logs))
const capture = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8'))
await writeFile(join(directory, 'source.json'), JSON.stringify({ sources, electron, capture, exit, variant: process.argv.includes('--effect-mutant') ? 'shared-effect-cut' : 'control' }, null, 2))
await rm(output, { recursive: true, force: true })
for (const name of ['home', 'appData', 'userData', 'sessionData']) await rm(join(directory, name), { recursive: true, force: true })
console.log(JSON.stringify({ exit, captureOnly: true, aestheticReview: 'not-performed', directory }))
if (exit || !capture.complete) throw new Error(capture.failure?.message ?? 'Private visual capture failed')
