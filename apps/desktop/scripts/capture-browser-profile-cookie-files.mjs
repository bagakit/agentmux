import { build } from 'vite'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop'), fixture = join(desktop, 'scripts/fixtures/browser-profile-cookie-files-ui')
const directory = join(root, '.local/t026-ui/capture', randomUUID()), output = join(directory, 'compiled')
await mkdir(directory, { recursive: true })
const files = ['apps/desktop/src/renderer/src/components/settings/BrowserProfileCookieFiles.tsx', 'apps/desktop/src/renderer/src/components/settings/settings-browser-profile-cookie-files.css', 'apps/desktop/src/renderer/src/components/settings/BrowserProfilesSettingsPane.tsx', 'apps/desktop/src/shared/ipc-result.ts', 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/renderer/src/lib/api.ts', 'packages/core/src/browser-profile-cookie-files.ts', 'packages/core/dist/browser-profile-cookie-files.js', 'apps/desktop/scripts/fixtures/browser-profile-cookie-files-ui/entry.tsx', 'apps/desktop/scripts/fixtures/browser-profile-cookie-files-ui/main.cjs']
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')]))), source = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), files: await hashes() }
await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' }, resolve: { alias: [{ find: '@agentmux/browser', replacement: join(root, 'packages/browser/src') }, { find: /^@agentmux\/host\/(.+)$/, replacement: join(root, 'apps/host/src/$1.ts') }] }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, build: { outDir: output, emptyOutDir: true, minify: false, sourcemap: false, chunkSizeWarningLimit: 20000 } })
const electron = createRequire(join(desktop, 'package.json'))('electron'), logs = []
const exit = await new Promise((done, reject) => { const child = spawn(electron, [join(fixture, 'main.cjs')], { cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, COOKIE_FILES_VISUAL_ROOT: directory, COOKIE_FILES_VISUAL_HTML: join(output, 'index.html') }, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', data => logs.push(data)); child.stderr.on('data', data => logs.push(data)); child.on('error', reject); child.on('close', done) })
await writeFile(join(directory, 'native.log'), Buffer.concat(logs))
const capture = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')); source.unchanged = JSON.stringify(source.files) === JSON.stringify(await hashes()); await writeFile(join(directory, 'source.json'), JSON.stringify(source, null, 2))
await rm(output, { recursive: true, force: true }); for (const name of ['home', 'appData', 'userData', 'sessionData']) await rm(join(directory, name), { recursive: true, force: true })
console.log(JSON.stringify({ exit, directory, complete: capture.complete, sourceUnchanged: source.unchanged, screenshots: capture.screenshots.map(item => item.file) }))
if (exit || !capture.complete || !source.unchanged) throw Error(capture.failure?.message ?? 'Private Cookie file capture failed or source changed')
