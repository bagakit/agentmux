import { expect, it, vi } from 'vitest'
import { storageRecoveryNotice } from '../src/renderer/src/lib/storage-recovery-notice'
import type { DesktopStorageRecoveryRead } from '../src/shared/storage-recovery'

const point = { generationId: 'original-point', namespace: 'original-runtime', createdAt: 1_800_000_000_000, memberCount: 2,
  gaps: [], manifestHash: 'a'.repeat(64) }
const read: DesktopStorageRecoveryRead = { owner: { runtimeId: 'original-runtime', ownerInstanceId: 'original-instance' },
  status: { state: 'idle', lastGeneration: point, pending: false, issue: null } }
it('keeps normal backups quiet and treats only exact not-created owner coverage as informational', () => {
  const action = vi.fn()
  expect(storageRecoveryNotice(read, null, null, action, action)).toBeNull()
  expect(storageRecoveryNotice({ ...read, status: { ...read.status, state: 'unavailable', issue: 'RECOVERY_COVERAGE_INCOMPLETE',
    lastGeneration: { ...point, gaps: [{ sourceId: 'unused-owner', code: 'RECOVERY_OWNER_NOT_CREATED' }] } } }, null, null, action, action)).toBeNull()
  expect(storageRecoveryNotice({ ...read, status: { ...read.status, state: 'unavailable' } }, null, null, action, action)).not.toBeNull()
})
it('keeps a previous original point and exact gaps visible through unknown status without declaring an Agent failure', () => {
  const retry = vi.fn(), check = vi.fn()
  const notice = storageRecoveryNotice(read, point, 'Original status read unavailable', retry, check)!
  expect(notice.notice.kind).toBe('indeterminate')
  expect(notice.notice.notice.mode).toContain(point.generationId)
  expect(notice.notice.notice.mode).toContain('Current backup status is unknown')
  expect(notice.action?.label).toBe('Retry backup'); notice.action?.run()
  expect(retry).toHaveBeenCalledOnce(); expect(check).not.toHaveBeenCalled()
  const unknown = storageRecoveryNotice({ ...read, status: { ...read.status, lastGeneration: null, state: 'unavailable' } }, point, 'Original read remains unknown', retry, check)!
  expect(unknown.notice.notice.mode).toContain(point.generationId)
  const first = storageRecoveryNotice(null, null, 'Original owner unconfirmed', retry, check)!
  expect(first.action?.label).toBe('Check backup status'); first.action?.run()
  expect(check).toHaveBeenCalledOnce()
})
