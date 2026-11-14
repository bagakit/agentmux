import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
const root = resolve(import.meta.dirname, '../../..'), output = resolve(process.argv[2] ?? '.tmp/source-close-visual')
const temporary = await mkdtemp(join(tmpdir(), 'source-close-scene-')), prefix = join(output, 'actual'), require = createRequire(join(root, 'apps/desktop/package.json'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(output, { recursive: true })
try {
  const tests = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/desktop/test/vitest.workbench-close.config.mts', '-t', 'actual Source (focus-menu|changed-agent)', '--maxWorkers=1', '--testTimeout=90000'], {
    cwd: root, env: { ...process.env, AGENTMUX_WORKBENCH_CLOSE_NATIVE: '1', AGENTMUX_SOURCE_CLOSE_VISUAL_DOM: prefix }, encoding: 'utf8' })
  await writeFile(join(output, 'actual-consumers.log'), tests.stdout + tests.stderr)
  assert.equal(tests.status, 0, tests.stdout + tests.stderr)
  const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
  const css = await build({ absWorkingDir: root, entryPoints: ['apps/desktop/src/renderer/src/styles/index.css'], outfile: join(output, 'scene.css'), bundle: true, metafile: true, logLevel: 'silent', loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' } })
  const menu = await build({ absWorkingDir: root, entryPoints: ['apps/desktop/scripts/fixtures/source-workbench-close/menu.tsx'], outfile: join(output, 'menu.js'), bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', metafile: true, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' } })
  const sources = Object.fromEntries(await Promise.all(Object.keys(css.metafile.inputs).map(async file => [file, hash(await readFile(resolve(root, file)))])))
  for (const file of Object.keys(menu.metafile.inputs)) sources[file] = hash(await readFile(resolve(root, file)))
  for (const file of ['apps/desktop/src/renderer/src/hooks/useSourceWorkbenchClose.tsx', 'apps/desktop/src/renderer/src/components/ConfirmationDialog.tsx', 'apps/desktop/src/renderer/src/components/SelectionField.tsx', 'apps/desktop/test/workbench-close-cli.test.ts']) sources[file] = hash(await readFile(join(root, file)))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = [], run = await runProbeProcess(require('electron'), [join(root, 'apps/desktop/scripts/fixtures/source-workbench-close/main.cjs'), output, prefix, temporary], { temporaryRoot: temporary, cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
  await writeFile(join(output, 'paint.log'), logs.join('\n'))
  assert.equal(run.exitCode, 0, logs.join('\n'))
  const { images } = JSON.parse(await readFile(join(output, 'render.json'), 'utf8'))
  assert.equal(images.length, 16)
  for (const image of images) image.sha256 = hash(await readFile(join(output, image.file)))
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ completed: true, captureOnly: true, aestheticReview: 'pending',
    boundary: 'Actual Source Focus/Main/Preload/original owner consumer tests produce the original modal DOM. Electron paints that DOM with current production CSS; the expanded shared SelectionField replays those exact choices and measures the actual Electron DOM. These screenshots do not prove physical input, live user installation or Runtime restoration.', sources, images }, null, 2))
  console.log(JSON.stringify({ completed: true, receipt: relative(root, join(output, 'receipt.json')), images: images.length }))
} finally {
  assert.deepEqual(await listProbeProcesses(-1, temporary), [], 'Only owned capture processes released')
  await rm(temporary, { recursive: true, force: true })
}
