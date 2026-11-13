import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { launchPrivateA2aProof } from '../scripts/lib/a2a-private-model-proof.mjs'

const root = resolve(import.meta.dirname, '../../..'), temporary = join(root, '.tmp'), exec = promisify(execFile)

test('requires an installed Core before starting a model or creating execution evidence', async () => {
  await mkdir(temporary, { recursive: true })
  const scope = await mkdtemp(join(temporary, 'a2a-launch-scope-')), name = basename(scope), originalExitCode = process.exitCode
  try {
    await assert.rejects(launchPrivateA2aProof({ repository: root, sourceInputs: [], name,
      coordinatorEntry: join(scope, 'unreachable.mjs'), executableName: join(scope, 'not-a-model') }), /requires an installed Core/u)
    assert.deepEqual((await readdir(temporary)).filter(file => file.startsWith(name + '-')), [])
  } finally {
    process.exitCode = originalExitCode
    for (const file of await readdir(temporary)) if (file.startsWith(name + '-')) await rm(join(temporary, file), { recursive: true, force: true })
    await rm(scope, { recursive: true, force: true })
  }
})

test('the actual prepare-only consumer remains read-only and never launches its model', async () => {
  await mkdir(temporary, { recursive: true })
  const executions = async () => (await readdir(temporary)).filter(file => file.startsWith('a2a-reference-agent-flow-')).sort()
  const before = await executions()
  const { stdout } = await exec(process.execPath, ['packages/core/scripts/verify-a2a-reference-agent-flow.mjs', '--prepare-only'], { cwd: root })
  const facts = JSON.parse(stdout)
  assert.equal(facts.modelStarted, false)
  assert.equal(typeof facts.authFileAvailable, 'boolean')
  assert.ok(facts.sourceHashes['packages/core/scripts/lib/a2a-private-model-proof.mjs'])
  assert.deepEqual(await executions(), before)
})
