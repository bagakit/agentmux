import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve, join, dirname } from 'node:path'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

const require = createRequire(resolve('apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const sourcePath = resolve('apps/desktop/src/main/native-overlay-surfaces.ts'), source = await readFile(sourcePath, 'utf8')
const out = resolve('.local/browser-menu-native-input/proof'), work = await mkdtemp(join(tmpdir(), 'agentmux-browser-menu-'))
await mkdir(out, { recursive: true })
await rm(join(out, 'receipt.json'), { force: true })
const base = { bundle: true, logLevel: 'silent', absWorkingDir: process.cwd(), jsx: 'automatic',
  alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) } }
const proofInputs = ['apps/desktop/scripts/verify-browser-menu-native-input.mjs',
  'apps/desktop/scripts/fixtures/browser-menu-native-input/main.ts', 'apps/desktop/scripts/fixtures/browser-menu-native-input/renderer.tsx',
  'apps/desktop/src/renderer/src/components/HoverDropdownMenu.tsx', 'apps/desktop/src/renderer/src/components/WindowOverlayHost.tsx',
  'apps/desktop/src/renderer/src/styles/agent.css', 'apps/desktop/src/shared/native-overlay.ts', 'apps/desktop/src/shared/browser-bounds.ts']
const evidence = { sourceSha256: createHash('sha256').update(source).digest('hex'),
  proofInputs: Object.fromEntries(await Promise.all(proofInputs.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')]))),
  cases: [], passed: false }
async function run(label, mutant = false) {
  const compiled = join(work, label); await mkdir(compiled, { recursive: true })
  const plugins = mutant ? [{ name: 'revoke-input-during-same-position-repaint', setup(build) {
    build.onLoad({ filter: /native-overlay-surfaces\.ts$/ }, args => {
      assert.equal(args.path, sourcePath)
      const target = /projection\.interactive = projection\.interactive && paintedBounds\.x === region\.bounds\.x &&\s+paintedBounds\.y === region\.bounds\.y && paintedBounds\.width === region\.bounds\.width && paintedBounds\.height === region\.bounds\.height/g
      assert.equal([...source.matchAll(target)].length, 1, 'The actual input-preservation mutation must be unique and nonempty')
      return { contents: source.replace(target, 'projection.interactive = false'), loader: 'ts', resolveDir: dirname(sourcePath) }
    })
  } }] : []
  await build({ ...base, plugins, platform: 'node', format: 'esm', external: ['electron'], entryPoints: ['apps/desktop/scripts/fixtures/browser-menu-native-input/main.ts'], outfile: join(compiled, 'main.mjs') })
  await build({ ...base, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, entryPoints: ['apps/desktop/scripts/fixtures/browser-menu-native-input/renderer.tsx'], outfile: join(compiled, 'renderer.js') })
  await writeFile(join(compiled, 'index.html'), '<!doctype html><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>')
  const env = { ...process.env, AGENTMUX_MENU_PROBE_ROOT: compiled }; delete env.ELECTRON_RUN_AS_NODE
  const result = await new Promise((done, reject) => {
    const child = spawn(require('electron'), [join(compiled, 'main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes })
    let timedOut = false, escalation
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      escalation = setTimeout(() => child.kill('SIGKILL'), 1500)
    }, 20000)
    child.once('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error) })
    child.once('exit', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation)
      if (timedOut) reject(new Error('Private native menu proof timed out and its exact child exited: ' + label))
      else done({ code, signal, output })
    })
  })
  const receipt = JSON.parse(await readFile(join(compiled, 'receipt.json'), 'utf8'))
  await writeFile(join(out, label + '.json'), JSON.stringify({ ...receipt, process: result }, null, 2))
  if (mutant) {
    assert.equal(result.code, 1, 'Revoking confirmed input during repaint must fail the native menu proof')
    assert.match(receipt.failure?.message ?? '', /same-position-repaint-action: native click must execute the original menu handler exactly once/)
    assert.equal(receipt.passed, false)
  } else {
    assert.equal(result.code, 0, result.output + '\n' + JSON.stringify(receipt.failure))
    assert.equal(receipt.passed, true)
    assert.deepEqual(receipt.cases.map(row => row.label), ['ordinary-action', 'same-position-repaint-action', 'same-position-repaint-radio', 'same-position-repaint-keyboard'])
    assert.deepEqual(receipt.warnings, [])
  }
  evidence.cases.push({ label, result: mutant ? 'RED' : 'GREEN', receipt: label + '.json' })
  console.log(label + ': ' + (mutant ? 'expected RED' : 'GREEN'))
}
try {
  await run('source')
  if (process.argv.includes('--mutations')) { await run('repaint-input-revoked', true); await run('restored-source') }
  evidence.passed = true
  await writeFile(join(out, 'receipt.json'), JSON.stringify(evidence, null, 2))
} finally { await rm(work, { recursive: true, force: true }) }
