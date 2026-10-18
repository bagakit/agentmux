import { expect } from 'vitest'
import { isObjectId } from '@agentmux/core'

/** Assert new owner allocations at a real public receipt or original database boundary. */
export function expectConnectionAllocations(value: unknown): void {
  const fields = new Set(['stepId', 'sourceStepId', 'avatarStepId', 'profileReadbackStepId', 'attemptId', 'authAttemptId', 'assetOperationId', 'credentialOperationId', 'configureOperationId', 'snapshotOperationId'])
  let found = 0
  const visit = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return
    for (const [key, item] of Object.entries(entry)) {
      if (fields.has(key) && item !== null && item !== undefined) { expect(isObjectId(item), 'New connector ' + key + ' must use the shared object ID').toBe(true); found++ }
      else visit(item)
    }
  }
  visit(value)
  expect(found, 'A consumer must expose at least one real owner allocation').toBeGreaterThan(0)
}
