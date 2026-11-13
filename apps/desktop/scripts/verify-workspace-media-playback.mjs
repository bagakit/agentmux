import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { runProbeProcess, listProbeProcesses, signalOwnedProbeProcess } from './probe-process.mjs'
import { privatePackageSmokeEnvironment } from './package-smoke-context.mjs'

/**
 * Real Electron check of Workspace media playback: the production player, preload and Main lease owner
 * play a large file, an HLS VOD list and a live list ffmpeg is still writing; read cost, seeking, a deleted
 * file and a second-process restore are asserted, and frames are captured for independent image review.
 */
const require = createRequire(import.meta.url), { build } = await import('vite'), viteRequire = createRequire(require.resolve('vite')), esbuild = viteRequire('esbuild')
const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..'), fixture = join(desktop, 'scripts/fixtures/workspace-media-playback')
const arg = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const evidence = arg('--output') ? resolve(repository, arg('--output')) : join(repository, '.tmp/workspace-media-playback')
const review = arg('--review') ? resolve(repository, arg('--review')) : join(evidence, 'visual-review.json')
const receiptOnly = process.argv.includes('--receipt')
// Every file whose change can alter playback or a captured frame, so a review is never reused across them.
const sourceFiles = ['apps/desktop/src/main/workspace-media-streams.ts', 'apps/desktop/src/main/workspace-files.ts', 'apps/desktop/src/main/preview-paths.ts',
  'apps/desktop/src/preload/index.ts', 'apps/desktop/src/renderer/index.html',
  'apps/desktop/src/renderer/src/components/MediaPlayer.tsx', 'apps/desktop/src/renderer/src/components/FilePreviewPane.tsx',
  'apps/desktop/src/renderer/src/components/file-preview/PlaylistFilePreview.tsx', 'apps/desktop/src/renderer/src/lib/media-player.ts',
  'apps/desktop/src/renderer/src/lib/use-workspace-media-stream.ts', 'apps/desktop/src/renderer/src/styles/media-player.css',
  'apps/desktop/src/renderer/src/styles/tokens.css', 'apps/desktop/src/shared/workspace-file-preview.ts', 'apps/desktop/src/shared/workspace-file-format.ts',
  'packages/client-ui/src/theme/icon-authored.ts', 'packages/client-ui/src/theme/icon-catalog.ts', 'packages/client-ui/src/theme/icon-glyphs.ts',
  'apps/desktop/scripts/verify-workspace-media-playback.mjs', 'apps/desktop/scripts/package-smoke-context.mjs',
  'apps/desktop/scripts/fixtures/workspace-media-playback/main.cjs', 'apps/desktop/scripts/fixtures/workspace-media-playback/entry.tsx',
  'apps/desktop/scripts/fixtures/workspace-media-playback/preload.ts', 'apps/desktop/scripts/fixtures/workspace-media-playback/native-owner.ts']
async function sources() { const out = {}; for (const file of sourceFiles) out[file] = sha(await readFile(join(repository, file))); return out }

/** The production renderer's own Content-Security-Policy, read from the page the app loads. */
async function productionCsp() {
  const page = await readFile(join(desktop, 'src/renderer/index.html'), 'utf8')
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(page)?.[1]
  assert.ok(csp, 'The production renderer declares a Content-Security-Policy')
  assert.match(csp, /media-src[^;]*http:\/\/127\.0\.0\.1:\*/, 'The production CSP admits the loopback playback lease')
  return csp
}
const ffmpeg = (args, options = {}) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore', ...options })

if (receiptOnly) {
  // The gate consumes an existing capture bound to the current source, plus its independent image review.
  const receipt = JSON.parse(await readFile(join(evidence, 'capture-receipt.json'), 'utf8'))
  assert.equal(receipt.passed, true, 'The capture passed')
  assert.deepEqual(receipt.sources, await sources(), 'The capture is bound to the current source')
  for (const frame of receipt.frames) assert.equal(sha(await readFile(join(evidence, frame.file))), frame.sha256, 'Frame is the captured one: ' + frame.file)
  const verdict = JSON.parse(await readFile(review, 'utf8'))
  assert.equal(verdict.mustFix?.length ?? 1, 0, 'Independent image review has no must-fix items')
  assert.deepEqual([...verdict.reviewed].sort(), receipt.frames.map(frame => frame.sha256).sort(), 'The review covers exactly these frames')
  console.log(JSON.stringify({ passed: true, frames: receipt.frames.length, checks: receipt.processes[0].render.checks }))
  process.exit(0)
}

const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-media-playback-'))
const workspace = join(privateRoot, 'workspace'), profile = join(privateRoot, 'profile'), outDir = join(privateRoot, 'renderer')
const result = { schema: 'agentmux.workspace-media-playback.v1', passed: false, sources: await sources(), frames: [], processes: [] }
try {
  await rm(evidence, { recursive: true, force: true }); await mkdir(evidence, { recursive: true })
  await mkdir(join(workspace, 'hls'), { recursive: true }); await mkdir(join(workspace, 'live'), { recursive: true })
  const source = arg('--video') ? resolve(arg('--video')) : null
  if (source) await copyFile(source, join(workspace, 'promo.mp4'))
  else ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '90', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '5M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(workspace, 'promo.mp4')])
  // Large enough that the player cannot have buffered its end before the file is removed.
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '60', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '6M', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(workspace, 'doomed.mp4')])
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', '-c:a', 'aac', join(workspace, 'tone.m4a')])
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=550', '-t', '24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', join(workspace, 'hls/index.m3u8')])
  await writeFile(join(workspace, 'notes.md'), '# Notes\n\nA neighbour File for the narrow Region.\n')

  // The fixture page carries the production CSP verbatim, so a blocked media request here is blocked in the app.
  const csp = await productionCsp()
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', worker: { format: 'es' },
    plugins: [{ name: 'production-csp', transformIndexHtml: html => html.replace('__PRODUCTION_CSP__', csp) }], define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, esbuild: { jsx: 'automatic' }, build: { outDir, emptyOutDir: true } })
  // Externals and the Host's native addon resolve through the desktop package's own dependencies.
  await symlink(join(desktop, 'node_modules'), join(privateRoot, 'node_modules'))
  // Same layout as the product: the file owner finds its native helper relative to its own module.
  const nativeModule = join(privateRoot, 'native/src/main/native-owner.mjs'), helper = join(privateRoot, 'native/resources/bin/agentmux-workspace-move')
  await mkdir(dirname(helper), { recursive: true }); await copyFile(join(desktop, 'resources/bin/agentmux-workspace-move'), helper)
  await esbuild.build({ entryPoints: [join(fixture, 'native-owner.ts')], outfile: nativeModule, bundle: true, platform: 'node', format: 'esm',
    external: ['electron', '@agentmux/core', '@agentmux/core/spatial-state'], logLevel: 'error',
    banner: { js: "import { createRequire as mediaProofCreateRequire } from 'node:module'; const require = mediaProofCreateRequire(import.meta.url);" } })
  // Same shape as the production preload: one sandbox-safe CommonJS bundle with every dependency inlined.
  await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, build: { outDir: privateRoot, emptyOutDir: false, minify: false,
    ssr: false, lib: { entry: join(fixture, 'preload.ts'), formats: ['cjs'], fileName: () => 'preload.cjs' }, rollupOptions: { external: ['electron'] } } })
  const main = join(privateRoot, 'main.cjs'); await copyFile(join(fixture, 'main.cjs'), main)
  const env = privatePackageSmokeEnvironment(process.env, { userData: join(profile, 'user-data'),
    runtimeRoot: join(privateRoot, 'runtime'), readyFile: join(privateRoot, 'ready.json') })
  for (const directory of [env.HOME, env.TMPDIR, join(profile, 'app-data')]) await mkdir(directory, { recursive: true })
  for (const phase of ['capture', 'restart']) {
    const lines = [], outcome = await runProbeProcess(require('electron'), [main, join(outDir, 'index.html'), profile, evidence, phase, nativeModule, workspace, process.execPath], { temporaryRoot: privateRoot, cwd: repository, env, timeoutMs: 240000, onLine: line => lines.push(line) })
    await writeFile(join(evidence, phase + '-process.log'), lines.join('\n'))
    const render = JSON.parse(await readFile(join(evidence, phase + '-render.json'), 'utf8'))
    result.processes.push({ phase, outcome, render: { ...render, requests: undefined, requestCount: render.requests.length } })
    assert.equal(outcome.exitCode, 0, render.failure?.message); assert.equal(render.passed, true)
    for (const frame of render.frames) result.frames.push({ ...frame, phase, sha256: sha(await readFile(join(evidence, frame.file))) })
  }
  assert.notEqual(result.processes[0].render.pid, result.processes[1].render.pid)
  assert.deepEqual(await sources(), result.sources, 'Relevant source did not change during capture')
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const remaining = await listProbeProcesses(-1, privateRoot); for (const pid of remaining) await signalOwnedProbeProcess(pid, privateRoot, 'SIGKILL')
  await rm(privateRoot, { recursive: true, force: true })
  await writeFile(join(evidence, 'capture-receipt.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ passed: result.passed, evidence, frames: result.frames.map(frame => frame.file), checks: result.processes[0]?.render.checks, failure: result.failure?.message ?? null }, null, 1))
  process.exitCode = result.passed ? 0 : 1
}
