import { build } from 'vite'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

// Capture-only: real Settings › Browser Profiles with preview config. Review the PNGs separately.
const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const fixture = join(desktop, 'scripts/fixtures/browser-profiles-settings'), directory = join(root, '.tmp/browser-profiles-visual', randomUUID())
const output = join(directory, 'compiled')
const scene = process.argv.includes('--trash-empty') ? 'trash-empty'
  : process.argv.includes('--switch') ? 'switch'
  : process.argv.includes('--environment-notice') ? 'environment-notice'
  : process.argv.includes('--service-notice') ? 'service-notice' : 'profiles'
await mkdir(directory, { recursive: true })
const sourceFiles = [
  'packages/client-ui/src/input/Switch.tsx',
  'packages/client-ui/src/input/SearchInput.tsx',
  'packages/client-ui/src/input/input.css',
  'apps/desktop/src/renderer/src/components/settings/BrowserProfilesSettingsPane.tsx',
  'apps/desktop/src/renderer/src/components/settings/BrowserProfileTrash.tsx',
  'apps/desktop/src/renderer/src/components/settings/BrowserProfileLibrary.tsx',
  'apps/desktop/src/renderer/src/components/settings/SettingsResourceLibrary.tsx',
  'apps/desktop/src/renderer/src/styles/settings-resource-library.css',
  'apps/desktop/src/renderer/src/components/SurfaceState.tsx',
  'apps/desktop/src/renderer/src/styles/surface-state.css',
  'apps/desktop/src/renderer/src/components/settings/BrowserProfileNetwork.tsx',
  'apps/desktop/src/renderer/src/components/settings/settings-browser-profiles.css',
  'apps/desktop/src/renderer/src/components/settings/modules/browser-profiles.tsx',
  'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
  'apps/desktop/src/renderer/src/components/BrowserOperationSurface.tsx',
  'apps/desktop/src/renderer/src/components/BrowserProfileChip.tsx',
  'apps/desktop/src/renderer/src/components/ProfileMark.tsx',
  'apps/desktop/src/renderer/src/lib/api.ts',
  'apps/desktop/src/renderer/src/styles/browser.css',
  'apps/desktop/src/renderer/src/styles/browser-operation-surface.css',
  'apps/desktop/src/main/browser-view-manager.ts',
  'apps/desktop/scripts/fixtures/browser-profiles-settings/entry.tsx',
  'apps/desktop/scripts/fixtures/browser-profiles-settings/main.cjs'
]
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
const source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), files: await sourceHashes() }
if (scene === 'environment-notice') {
  const producer=(await readFile(join(root,'apps/desktop/src/main/browser-view-manager.ts'),'utf8')).match(/return '(This Profile’s native environment[^']*)'/u)?.[1]
  const preview=(await readFile(join(fixture,'entry.tsx'),'utf8')).match(/await browser\('(This Profile’s native environment[^']*)'\)/u)?.[1]
  assert.ok(producer && preview,'The environment notice must have its actual producer and real-component preview')
  assert.equal(preview,producer,'The environment notice preview must retain the exact current product wording')
}
await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  build: { outDir: output, emptyOutDir: true, minify: false, sourcemap: false, chunkSizeWarningLimit: 20000 } })
const electron = createRequire(join(desktop, 'package.json'))('electron')
const logs = [], exit = await new Promise((done, reject) => {
  const child = spawn(electron, [join(fixture, 'main.cjs')], { cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, PROFILES_VISUAL_ROOT: directory, PROFILES_VISUAL_HTML: join(output, 'index.html'), PROFILES_VISUAL_SCENE: scene }, stdio: ['ignore', 'pipe', 'pipe'] })
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
console.log(JSON.stringify({ exit, scene, captureOnly: true, aestheticReview: 'not-performed', directory, source, screenshots: capture.screenshots?.map(item => item.file) }))
if (exit || !capture.complete) throw new Error(capture.failure?.message ?? 'Private visual capture failed')
if (!source.unchanged) throw new Error('Profile visual inputs changed during capture; retain these images as an unconfirmed candidate')
