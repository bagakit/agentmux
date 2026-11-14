import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const evidence = join(root, '.local/window-return/return-proof')
await mkdir(evidence, { recursive: true })
const require = createRequire(join(desktop, 'package.json'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const files = ['src/main/workbench-windows.ts', 'src/main/workbench-window-store.ts', 'src/shared/workbench-windows.ts',
  'src/renderer/src/lib/workbench-windows.tsx', 'src/renderer/src/components/StableWorkbenchView.tsx',
  'scripts/fixtures/workbench-window-return/main.ts', 'scripts/fixtures/workbench-window-return/entry.tsx',
  'scripts/fixtures/workbench-window-return/preload.cjs', 'scripts/fixtures/workbench-window-return/index.html',
  'src/renderer/src/components/WorkspaceWorkbench.tsx', 'src/renderer/src/lib/workbench-presentation.ts',
  'test/workbench-window-return.test.tsx', 'test/workbench-window-return.config.mts', 'scripts/verify-workbench-window-return.mjs']
const sources = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(join(desktop, file)))])))
let previous
try { previous = JSON.parse(await readFile(join(evidence, 'receipt.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
const receipt = { passed: false, source: await sources(), tests: [], restart: [] }
const componentFiles = files.filter(file => !file.startsWith('src/main/') && !file.startsWith('scripts/fixtures/'))
receipt.componentSource = Object.fromEntries(componentFiles.map(file => [file, receipt.source[file]]))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const unchanged = async inputs => {
  if (!inputs || Object.keys(inputs).length === 0) return false
  for (const [file, digest] of Object.entries(inputs)) {
    try { if (sha(await readFile(file)) !== digest) return false } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }
  return true
}
async function run(label, executable, args, env = {}, timeout = 90000) {
  const result = await new Promise((done, fail) => {
    const child = spawn(executable, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', killed = false
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL') }, timeout)
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    child.on('error', error => { clearTimeout(timer); fail(error) })
    child.on('close', (exit, signal) => { clearTimeout(timer); done({ exit, signal, killed, output }) })
  })
  await writeFile(join(evidence, label + '.log'), result.output)
  return result
}
async function tests(label, mutant = '') {
  const loaded = join(evidence, label + '.loaded.jsonl'), report = join(evidence, label + '.json')
  await writeFile(loaded, '')
  const result = await run(label, process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config',
    join(desktop, 'test/workbench-window-return.config.mts'), '--reporter=json', '--outputFile=' + report],
    { WINDOW_RETURN_MUTATION: mutant, WINDOW_RETURN_LOADED: loaded })
  const json = JSON.parse(await readFile(report, 'utf8'))
  const graph = (await readFile(loaded, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.ok(graph.length > 0 && graph.every(row => row.mutant === Boolean(mutant)), 'Nonempty actual product owner loaded with declared mutation')
  assert.equal(json.numTotalTests, 4)
  assert.equal(result.signal, null); assert.equal(result.killed, false)
  if (mutant) {
    assert.notEqual(result.exit, 0)
    assert.ok(json.testResults.flatMap(file => file.assertionResults).some(test => test.fullName.includes('cross-display') && test.status === 'failed'), 'Actual cross-display target consumer must reject the removed binding')
  } else { assert.equal(result.exit, 0, result.output); assert.equal(json.numFailedTests, 0); assert.equal(json.numPassedTests, 4) }
  receipt.tests.push({ label, exit: result.exit, passed: json.numPassedTests, failed: json.numFailedTests, graph })
  process.stdout.write(label + ': ' + (mutant ? 'expected consumer RED' : 'GREEN') + '\n')
}
async function restart() {
  const fixture = join(desktop, 'scripts/fixtures/workbench-window-return')
  const directory = await mkdtemp(join(tmpdir(), 'amx-window-return-'))
  try {
    const nativeInputs = {}
    const bind = async file => { nativeInputs[file] = sha(await readFile(file)) }
    for (const file of files.filter(file => !file.startsWith('test/'))) await bind(join(desktop, file))
    for (const file of ['package.json', 'test/workbench-window-presentations.config.mts', 'test/selection-field.config.mts',
      'scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts']) await bind(join(desktop, file))
    const { build } = createRequire(join(root, 'packages/core/package.json'))('esbuild')
    await symlink(join(desktop, 'node_modules'), join(directory, 'node_modules'))
    const mainBuild = await build({ metafile: true, entryPoints: [join(fixture, 'main.ts')], outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
    for (const input of Object.keys(mainBuild.metafile.inputs)) await bind(resolve(root, input))
    await copyFile(join(fixture, 'preload.cjs'), join(directory, 'preload.cjs'))
    const vite = require('vite')
    await vite.build({ configFile: join(desktop, 'test/workbench-window-presentations.config.mts'), root: fixture, base: './', worker: { format: 'es' }, logLevel: 'error',
      build: { outDir: join(directory, 'renderer'), emptyOutDir: true, sourcemap: false, minify: false },
      plugins: [{ name: 'native-window-return-loaded-inputs', enforce: 'pre', async transform(_source, id) {
        const file = id.split('?')[0]
        if (file.startsWith(root + '/') && !file.includes('/node_modules/') && !file.includes('\0')) await bind(file)
      } }]
    })
    await writeFile(join(directory, 'renderer/workbench-window.html'), '<!doctype html><html><body><div id="workbench-window-root"></div></body></html>')
    receipt.nativeInputs = nativeInputs
    receipt.nativeCompiled = { main: sha(await readFile(join(directory, 'main.mjs'))), renderer: sha(await readFile(join(directory, 'renderer/index.html'))), preload: sha(await readFile(join(directory, 'preload.cjs'))) }
    const env = { ...process.env }; env.ELECTRON_RUN_AS_NODE = undefined
    for (const phase of ['seed', 'restore']) {
      const path = join(evidence, phase + '-native.json')
      await rm(path, { force: true })
      const result = await run(phase + '-native', require('electron'), [join(directory, 'main.mjs'), directory, phase, path], env, 45000)
      const proof = JSON.parse(await readFile(path, 'utf8'))
      assert.equal(result.exit, 0, result.output + '\n' + JSON.stringify(proof)); assert.equal(proof.passed, true)
      receipt.restart.push(proof)
    }
    assert.notEqual(receipt.restart[0].pid, receipt.restart[1].pid, 'Independent real Electron processes')
    assert.equal(receipt.restart[0].durableWindowId, receipt.restart[1].durableWindowId, 'Same durable original window after real process restart')
    assert.ok(receipt.restart[0].durableSurveyWindowId)
    assert.equal(receipt.restart[0].durableSurveyWindowId, receipt.restart[1].durableSurveyWindowId, 'Same durable Survey window after real process restart')
    assert.deepEqual(receipt.restart.map(proof => [proof.reachedWillQuit, proof.expected.length, proof.closed.length]), [[true, 2, 2], [true, 1, 1]])
    receipt.nativeReceipts = Object.fromEntries(await Promise.all(['seed', 'restore'].map(async phase => {
      const file = join(evidence, phase + '-native.json'); return [file, sha(await readFile(file))]
    })))
    receipt.restartPassed = true
    process.stdout.write('real Electron restart and original window return: GREEN\n')
  } finally { await rm(directory, { recursive: true, force: true }) }
}
try {
  if (!process.argv.includes('--restart-only')) {
    if (previous?.componentPassed && same(previous.componentSource, receipt.componentSource) && await unchanged(previous.componentArtifacts)) {
      receipt.tests = previous.tests; receipt.componentArtifacts = previous.componentArtifacts
      process.stdout.write('component and mutation proof: reused unchanged loaded source and receipts\n')
    } else {
      await tests('baseline'); await tests('remove-original-target', 'remove-original-target'); await tests('restored')
      receipt.componentArtifacts = Object.fromEntries(await Promise.all(['baseline', 'remove-original-target', 'restored'].flatMap(label => ['.json', '.loaded.jsonl'].map(suffix => join(evidence, label + suffix))).map(async file => [file, sha(await readFile(file))])))
    }
    receipt.componentPassed = true
    if (!process.argv.includes('--components-only')) {
      const main = await run('main-receipts', process.execPath, [join(desktop, 'scripts/verify-workbench-window-receipts.mjs')])
      assert.equal(main.exit, 0, main.output)
    }
  }
  if (!process.argv.includes('--components-only')) {
    if (previous?.restartPassed && await unchanged(previous.nativeInputs) && await unchanged(previous.nativeReceipts) && previous.nativeCompiled) {
      for (const key of ['restart', 'nativeInputs', 'nativeReceipts', 'nativeCompiled', 'restartPassed']) receipt[key] = previous[key]
      process.stdout.write('real Electron restart: reused unchanged loaded inputs and native receipts\n')
    } else await restart()
  }
  assert.deepEqual(await sources(), receipt.source, 'Product and fixture inputs remain the exact tested candidate')
  receipt.passed = true
} finally { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n') }
