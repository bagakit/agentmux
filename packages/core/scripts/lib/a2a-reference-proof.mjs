import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { idleInputMutations, idleInputOwners } from '../../test/fixtures/a2a-idle-input-proof.mjs'

export const referenceProofSha = bytes => createHash('sha256').update(bytes).digest('hex')
const coreSource = 'packages/core/src/'
/** Loaded records name repository files; the shared mutation table names Core source files. */
export function nativeMutationTarget(mutation) {
  const file = idleInputMutations[mutation]?.[0]; assert.ok(file, 'Declared native mutation: ' + mutation)
  return coreSource + file
}
/** One coherent set of observed compiler conditions; the target alone may be edited. */
export function nativeSourceConditions(records, targetFile) {
  assert.ok(records.length > 0)
  const conditions = new Map()
  for (const item of records) {
    assert.ok(typeof item.file === 'string' && !isAbsolute(item.file) && !item.file.split('/').includes('..'))
    assert.match(item.originalSHA256, /^[a-f0-9]{64}$/u); assert.match(item.sha256, /^[a-f0-9]{64}$/u)
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes > 0)
    if (item.mutation) {
      assert.equal(item.file, targetFile)
      assert.equal(nativeMutationTarget(item.mutation), targetFile)
      assert.ok(idleInputOwners.includes(item.file)); assert.notEqual(item.sha256, item.originalSHA256)
    } else assert.equal(item.sha256, item.originalSHA256)
    const condition = { sourceSHA256: item.originalSHA256,
      ...(item.file === targetFile ? {} : { compilerSHA256: item.sha256, bytes: item.bytes }) }
    if (conditions.has(item.file)) assert.deepEqual(conditions.get(item.file), condition, 'One source version per original test run: ' + item.file)
    conditions.set(item.file, condition)
  }
  return Object.fromEntries([...conditions].sort(([left], [right]) => left.localeCompare(right)))
}
/** Every loaded declared owner is its current source, or that source with its one declared mutation. */
export function assertLoadedNativeSources(records, { files, hashes }) {
  for (const item of records) {
    const source = files.get(item.file)
    if (source === undefined) continue
    if (Object.hasOwn(hashes, item.file)) assert.equal(item.originalSHA256, hashes[item.file], 'Original owning source candidate: ' + item.file)
    assert.equal(referenceProofSha(source), item.originalSHA256, 'Selected native source: ' + item.file)
    const edit = item.mutation && idleInputMutations[item.mutation]
    if (edit) assert.equal(source.split(edit[1]).length, 2)
    const compiled = edit ? source.replace(edit[1], edit[2]) : source
    assert.equal(referenceProofSha(compiled), item.sha256); assert.equal(Buffer.byteLength(compiled), item.bytes)
  }
}
export function assertNativeSourcePair(red, restored, mutation) {
  const target = nativeMutationTarget(mutation)
  assert.deepEqual(nativeSourceConditions(red, target), nativeSourceConditions(restored, target), 'Only the selected compilation may differ between mutation and restoration')
}
