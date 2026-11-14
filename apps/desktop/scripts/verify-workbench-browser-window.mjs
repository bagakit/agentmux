import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const evidence = join(root, '.local/window-return/native-orphan/proof')
await mkdir(evidence, { recursive: true })
const require = createRequire(join(desktop, 'package.json')), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fixture = join(desktop, 'scripts/fixtures/workbench-browser-window')
const files = ['scripts/verify-workbench-browser-window.mjs', 'src/main/browser-view-manager.ts', 'src/main/workbench-windows.ts',
  'src/main/workbench-window-store.ts', 'src/main/app-capture.ts', 'src/renderer/src/components/WorkspaceWorkbench.tsx',
  'src/renderer/src/components/BrowserPane.tsx', 'src/renderer/src/components/BrowserPresentationStage.tsx', 'src/renderer/src/components/StableWorkbenchView.tsx',
  'src/renderer/src/lib/workbench-windows.tsx', 'src/renderer/src/lib/workbench-presentation.ts', 'src/shared/workbench-windows.ts',
  'scripts/fixtures/workbench-browser-window/main.ts', 'scripts/fixtures/workbench-browser-window/entry.tsx',
  'scripts/fixtures/workbench-browser-window/preload.cjs', 'scripts/fixtures/workbench-browser-window/index.html']
const inputs = async () => Object.fromEntries(await Promise.all(files.map(async file => [join(desktop, file), sha(await readFile(join(desktop, file)))])))
const unchanged = async values => {
  if (!values || !Object.keys(values).length) return false
  for (const [file, digest] of Object.entries(values)) { try { if (sha(await readFile(file)) !== digest) return false } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
  return true
}
let previous
try { previous = JSON.parse(await readFile(join(evidence, 'receipt.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
const receipt = { passed: false, source: await inputs(), native: [], boundary: 'Actual WorkspaceWorkbench/BrowserPane plus real Main BrowserViewManager/WebContentsView/WorkbenchWindows. Native-layer composition uses production AppCaptureSource; does not claim an OS compositor screenshot or real physical input. Private HTTP/file forms only.' }
async function command(label, executable, args, options = {}) {
  const result = await new Promise((done, fail) => {
    const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout ?? 90000)
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk)
    child.once('error', error => { clearTimeout(timer); fail(error) })
    child.once('exit', (status, signal) => { clearTimeout(timer); done({ status, signal, output }) })
  })
  await writeFile(join(evidence, label + '.log'), result.output)
  assert.equal(result.status, 0, result.output)
  return result
}
async function native() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-native-window-'))
  try {
    const loaded = {}, bind = async file => { loaded[file] = sha(await readFile(file)) }
    for (const file of Object.keys(receipt.source)) await bind(file)
    for (const file of ['package.json', 'test/workbench-window-presentations.config.mts', 'test/selection-field.config.mts', 'scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts']) await bind(join(desktop, file))
    await bind(join(root, 'pnpm-lock.yaml'))
    await symlink(join(desktop, 'node_modules'), join(directory, 'node_modules'))
    const { build } = createRequire(join(root, 'packages/core/package.json'))('esbuild')
    const main = await build({ metafile: true, entryPoints: [join(fixture, 'main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
    for (const file of Object.keys(main.metafile.inputs)) await bind(resolve(root, file))
    await copyFile(join(fixture, 'preload.cjs'), join(directory, 'preload.cjs'))
    await require('vite').build({ configFile: join(desktop, 'test/workbench-window-presentations.config.mts'), root: fixture, base: './', worker: { format: 'es' }, logLevel: 'error',
      build: { outDir: join(directory, 'renderer'), emptyOutDir: true, sourcemap: false, minify: false },
      plugins: [{ name: 'native-browser-window-actual-inputs', enforce: 'pre', async transform(_source, id) {
        const file = id.split('?')[0]
        if (file.startsWith(root + '/') && !file.includes('/node_modules/') && !file.includes('\0')) await bind(file)
      } }] })
    await writeFile(join(directory, 'renderer/workbench-window.html'), '<!doctype html><html><body><div id="workbench-window-root"></div></body></html>')
    receipt.loadedInputs = loaded
    receipt.compiled = { main: sha(await readFile(join(directory, 'main.mjs'))), preload: sha(await readFile(join(directory, 'preload.cjs'))), renderer: sha(await readFile(join(directory, 'renderer/index.html'))) }
    for (const phase of ['seed', 'restore']) {
      await rm(join(evidence, phase + '.json'), { force: true })
      await command(phase, require('electron'), [join(directory, 'main.mjs'), directory, phase, evidence], { env: { ELECTRON_RUN_AS_NODE: undefined }, timeout: 90000 })
      const result = JSON.parse(await readFile(join(evidence, phase + '.json'), 'utf8'))
      assert.equal(result.passed, true, JSON.stringify(result))
      receipt.native.push(result)
    }
    assert.notEqual(receipt.native[0].pid, receipt.native[1].pid)
    assert.equal(receipt.native[0].durableWindowId, receipt.native[1].durableWindowId, 'Same durable window after real process restart')
    receipt.artifacts = Object.fromEntries(await Promise.all(receipt.native.flatMap(result => [join(evidence, result.phase + '.json'), ...result.frames.map(frame => join(evidence, frame.file))]).map(async file => [file, sha(await readFile(file))])))
    receipt.nativePassed = true
    console.log('Real native Browser windows, forms, return and process restart: passed')
  } finally { await rm(directory, { recursive: true, force: true }) }
}
try {
  if (!process.argv.includes('--native-only')) await command('components', process.execPath, [join(desktop, 'scripts/verify-workbench-browser-window-components.mjs')])
  if (previous?.nativePassed && await unchanged(previous.loadedInputs) && await unchanged(previous.artifacts)) {
    for (const key of ['native', 'compiled', 'loadedInputs', 'artifacts', 'nativePassed']) receipt[key] = previous[key]
    console.log('Reusing exact native Browser window candidate proof')
  } else await native()
  assert.deepEqual(await inputs(), receipt.source, 'Candidate inputs remain unchanged')
  receipt.passed = true
} finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n') }
