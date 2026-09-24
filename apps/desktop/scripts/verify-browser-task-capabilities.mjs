import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath, writeFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { joinBrowserCapabilityProof, verifyIntegratedCandidateSources } from './lib/browser-capability-proof-join.mjs'

const root = resolve(import.meta.dirname, '../../..')
const run = promisify(execFile)
const common = (await run('git', ['rev-parse', '--git-common-dir'], { cwd: root })).stdout.trim()
const mainRoot = dirname(resolve(root, common))
const manifestPath = process.env.AGENTMUX_BROWSER_CLOSEOUT_MANIFEST ?? 'docs/reviews/evidence/browser-closeout-2026-10-03/final/join-input.json'
const manifestBytes = await readFile(resolve(root, manifestPath))
const manifest = JSON.parse(manifestBytes)
const candidateRoot = await realpath(manifest.candidate.root)
const electron = await realpath(createRequire(resolve(candidateRoot, 'package.json'))('electron'))
await run('git', ['merge-base', '--is-ancestor', manifest.candidate.commit, 'main'], { cwd: mainRoot })
assert.equal(manifest.candidate.sourceBranch, 'main', 'The complete delivery must have been built from integrated main')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
await verifyIntegratedCandidateSources({ candidate: manifest.candidate,
  readCommit: async (commit, path) => (await run('git', ['show', `${commit}:${path}`], {
    cwd: mainRoot, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout })
const read = async path => {
  if (isAbsolute(path)) {
    assert.equal(await realpath(path), electron, 'Only the actual candidate Electron executable may be an external identity input')
    return await readFile(electron)
  }
  const base = path.startsWith('docs/reviews/') ? root : candidateRoot
  const target = await realpath(resolve(base, path))
  const offset = relative(await realpath(base), target)
  assert.ok(offset && !isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`), 'Evidence path leaves its owner')
  return await readFile(target)
}
const tasks = JSON.parse(await readFile(resolve(mainRoot, '.bagakit/feature-tracker/features/f-2fm8f5q39/tasks.json'), 'utf8')).tasks
const historicalTasks = JSON.parse(await readFile(resolve(mainRoot, '.bagakit/feature-tracker/features-transferred/f-2ew8fzgff/tasks.json'), 'utf8')).tasks
const result = await joinBrowserCapabilityProof({ manifest, tasks, historicalTasks, read })
assert.deepEqual(await readFile(resolve(root, manifestPath)), manifestBytes, 'Join manifest changed during consumption')
await mkdir(resolve(root, '.tmp'), { recursive: true })
await writeFile(resolve(root, '.tmp/browser-task-capabilities-last.json'), JSON.stringify({
  schema: 'agentmux.browser-capability-closeout-receipt.v1', ...result,
  input: { path: manifestPath, sha256: hash(manifestBytes) },
  boundary: 'Existing exact-source proofs, actual ordinary Native restart and independent image reviews consumed; no App or Run was launched or controlled by this join.'
}, null, 2) + '\n')
console.log(JSON.stringify(result))
