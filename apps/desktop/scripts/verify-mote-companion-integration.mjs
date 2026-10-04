import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve, join, relative } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), evidenceRoot = join(root, '.tmp/mote-companion')
const fixture = 'apps/desktop/scripts/fixtures/mote-companion-workflows/'
const owners = [
  'apps/desktop/src/renderer/src/components/MoteDetailsPanel.tsx', 'apps/desktop/src/renderer/src/components/MoteIdeaControls.tsx',
  'apps/desktop/src/renderer/src/lib/mote-materials-actions.ts', 'apps/desktop/src/renderer/src/lib/mote-cooperation.ts',
  'apps/desktop/src/renderer/src/lib/mote-idea-request.ts', 'apps/desktop/src/renderer/src/lib/launcher-state.ts',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts',
  'apps/desktop/src/renderer/src/lib/workbench-persistence.ts', 'apps/desktop/src/shared/space-addresses.ts',
  'apps/desktop/src/shared/scratch-topics.ts', 'apps/desktop/src/renderer/src/styles/mote-workface.css', 'packages/core/src/public-rpc-files.ts'
]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const files = [...owners, relative(root, import.meta.filename), fixture + 'verify-persona-restart.mjs', fixture + 'persona-restart-entry.ts']
const source = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(join(root, file)))])))
const directory = join(evidenceRoot, 'integration-' + globalThis.crypto.randomUUID()); await mkdir(directory, { recursive: true })
const receipt = { schema: 'agentmux.mote-companion.integration.v1', passed: false, source, rendererCapture: null, restart: null,
  boundary: 'Original Source-created exact Launcher tuples and unsent bytes, saved and initialized again through the original Workbench/LauncherState and real filesystem Core Spatial owner in 12 fresh processes. Current Ideas Renderer owners match its capture; any reused cooperation observations separately match their unchanged original owners. Aesthetic review, native Session/Run, model, package and installation qualifications are separate.' }
try {
  const names = (await readdir(evidenceRoot)).filter(name => /^persona-renderer-\d+$/.test(name)).sort((a, b) => Number(b.slice('persona-renderer-'.length)) - Number(a.slice('persona-renderer-'.length)))
  const observed = []
  let selected
  for (const name of names) {
    const file = join(evidenceRoot, name, 'receipt.json'), candidate = JSON.parse(await readFile(file, 'utf8'))
    const mismatches = owners.filter(owner => candidate.source?.[owner] !== source[owner])
    const renderer = candidate.passed ? JSON.parse(await readFile(join(evidenceRoot, name, 'renderer-result.json'), 'utf8')) : null
    const hasIdeaInputs = ['ideas-context-unknown', 'ideas-mote-aba-input-kept'].every(name => renderer?.restartInputs?.some(item => item.name === name))
    if (candidate.passed && !mismatches.length && hasIdeaInputs) { selected = file; break }
    observed.push({ file: relative(root, file), passed: candidate.passed, mismatches, hasIdeaInputs })
  }
  assert.ok(selected, 'No matching original Renderer capture is available. Run ' + fixture + 'capture-persona.mjs on this Source first. Observed: ' + JSON.stringify(observed))
  receipt.rendererCapture = { file: relative(root, selected), sha256: sha(await readFile(selected)) }
  const result = spawnSync(process.execPath, [join(root, fixture, 'verify-persona-restart.mjs'), selected], { cwd: root, encoding: 'utf8', timeout: 60000 })
  await writeFile(join(directory, 'restart.log'), (result.stdout ?? '') + (result.stderr ?? ''))
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr)
  const restartFile = result.stdout.trim().split('\n').at(-1), restart = JSON.parse(await readFile(join(root, restartFile), 'utf8'))
  assert.equal(restart.passed, true); assert.equal(restart.cases.length, 4)
  assert.equal(new Set(restart.cases.flatMap(item => item.pids)).size, 12, 'Four original Renderer cases each need a writer and two fresh readers')
  receipt.restart = { file: restartFile, sha256: sha(await readFile(join(root, restartFile))), captures: restart.captures, cases: restart.cases }
  for (const [file, digest] of Object.entries(source)) assert.equal(sha(await readFile(join(root, file))), digest, 'The bounded integration owners changed during verification')
  receipt.passed = true
} catch (error) { receipt.error = { message: error.message, stack: error.stack }; process.exitCode = 1 }
await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(relative(root, join(directory, 'receipt.json')))
if (!receipt.passed) console.error(receipt.error)
