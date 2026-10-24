import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './mobile-web.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutant = process.env.MOBILE_SELECTION_MUTANT
const variants: Record<string, { before: string; after: string }> = {
  'late-picker': { before: 'if (operation.cancelled || !file) return', after: 'if (!file) return' },
  'queue-order': { before: 'selectionTail.current = predecessor.then(() => completion).catch(() => {})', after: 'selectionTail.current = completion.catch(() => {})' },
  'no-release': { before: 'await Promise.race([pending, operation.stopped])', after: 'await pending' },
  'skip-changed-read': { before: '(!originalScope.runtimeId || operation.target.runtimeId === originalScope.runtimeId) && (!originalScope.hostId || operation.target.hostId === originalScope.hostId))', after: '(!originalScope.runtimeId || operation.target.runtimeId === originalScope.runtimeId) && (!originalScope.hostId || operation.target.hostId === originalScope.hostId) && operation.target.runId === originalScope.runId && operation.target.recordId === originalRecord)' },
  'skip-changed-composer': { before: 'uploads.some(upload => upload.phase !== \'inserted\' && upload.identity.agentSessionId === selectedSession &&\n      (!target.runtimeId || upload.runtimeId === target.runtimeId) && (!target.hostId || upload.identity.hostId === target.hostId))', after: 'uploads.some(upload => upload.phase !== \'inserted\' && fileUploadScopeMatches(upload, target) && recordIds.current.get(upload.identity.operationId) === getDeviceWorkface().recordIdentity())' },
  'hide-unknown-target': { before: 'const targetUnknown = !visibleScope.runtimeId || !visibleScope.hostId || !visibleScope.runId', after: 'const targetUnknown = false' },
}
if (mutant && !variants[mutant]) throw new Error('Unknown selection mutation')
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), { name: 'selection-mutation', enforce: 'pre', transform(code, id) {
  if (!mutant || relative(root, id.split('?')[0]!) !== 'apps/mobile/src/conversation/MobileAttachments.tsx') return
  const variant = variants[mutant]!
  if (code.split(variant.before).length !== 2) throw new Error('Selection mutation did not match exactly once')
  return { code: code.replace(variant.before, variant.after), map: null }
} }], test: { ...base.test, include: ['test/mobile-attachment-selection-recovery.test.tsx'] } })
