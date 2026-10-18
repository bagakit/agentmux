import { expect, it } from 'vitest'
import { fixturePath } from '../../../test/fixture-values.mjs'
import { captureGoalFileEvidence, goalFileEvidenceReadParams, readGoalFileEvidence } from '../src/goal-evidence.js'
import type { FileReadParams, FileReadResult } from '../src/public-rpc-files.js'
const target: FileReadParams = { zoneId: 'original-zone', path: 'result.log', expectedResource: { hostId: 'original-host', workspaceId: 'original-worktree', workspacePath: fixturePath('worktree') } }
const read: FileReadResult = { resource: { ...target.expectedResource, zoneId: target.zoneId, zonePath: fixturePath('worktree/proof'), path: 'proof/result.log' }, result: { status: 'read', document: { path: 'proof/result.log', content: 'Original proof', revision: 'sha256:' + 'a'.repeat(64) } } }
it('captures and reads the exact Files receipt rather than a Project-relative path', async () => {
  const evidence = captureGoalFileEvidence(target, read, { line: 5 })
  expect(evidence.resource).toEqual(read.resource); expect(evidence.location).toEqual({ line: 5 })
  expect(goalFileEvidenceReadParams(evidence)).toEqual(target)
  const result = await readGoalFileEvidence(evidence, async actual => { expect(actual).toEqual(target); return read })
  expect(result).toEqual({ target, observation: read, version: 'same' })
})
it.each(['hostId', 'workspaceId', 'workspacePath', 'zoneId'] as const)('rejects another %s in the original read receipt', async field => {
  const other = structuredClone(read); other.resource![field] += '-other'
  expect(() => captureGoalFileEvidence(target, other)).toThrow()
})
it('does not reinterpret the same Zone ID after its resource mapping changes', async () => {
  const evidence = captureGoalFileEvidence(target, read), other = structuredClone(read)
  other.resource!.zonePath = fixturePath('worktree/other'); other.resource!.path = 'other/result.log'
  if (other.result.status === 'read') other.result.document.path = 'other/result.log'
  await expect(readGoalFileEvidence(evidence, async () => other)).rejects.toMatchObject({ code: 'FILE_RESOURCE_MISMATCH' })
})
it('keeps changed bytes and unavailable observations distinct from original evidence', async () => {
  const evidence = captureGoalFileEvidence(target, read), changed = structuredClone(read)
  if (changed.result.status === 'read') changed.result.document.revision = 'sha256:' + 'b'.repeat(64)
  expect((await readGoalFileEvidence(evidence, async () => changed)).version).toBe('changed')
  expect((await readGoalFileEvidence({ ...evidence, revision: null }, async () => read)).version).toBe('unrecorded')
  const missing: FileReadResult = { resource: null, result: { status: 'unknown', code: 'offline', message: 'Original Host unavailable' } }
  expect((await readGoalFileEvidence(evidence, async () => missing)).observation).toEqual(missing)
  expect(evidence.revision).toBe('sha256:' + 'a'.repeat(64))
})
