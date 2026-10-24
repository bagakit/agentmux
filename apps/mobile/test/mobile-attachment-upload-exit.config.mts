import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './mobile-web.config.mts'
const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.MOBILE_UPLOAD_EXIT_MUTANT
const variants: Record<string, { file: string; edits: Array<{ before: string; after: string }> }> = {
  'lose-owner': { file: 'apps/mobile/src/mobile-web/update-safety.ts', edits: [{ before: 'const issue = attachment.current?.issue(); if (issue) return issue;', after: 'void attachment;' }] },
  'late-insertion': { file: 'apps/mobile/src/conversation/MobileAttachments.tsx', edits: [{ before: '!original || flight.cancelled || flight.claimedForSend || getDeviceWorkface()', after: '!original || getDeviceWorkface()' }] },
  'pre-dispatch': { file: 'apps/mobile/src/conversation/MobileAttachments.tsx', edits: [
    { before: 'if (flight.cancelled) { retireFlight(flight); return null }', after: 'if (false) { retireFlight(flight); return null }' },
    { before: 'if (flight.cancelled) return null\n          if (fileUploadIntentKey(upload)', after: 'if (false) return null\n          if (fileUploadIntentKey(upload)' }
  ] },
  'same-operation-collision': { file: 'apps/mobile/src/conversation/MobileAttachments.tsx', edits: [{
    before: "if (bytes.current.has(file.id) || latestUploads.current.some(item => item.identity.operationId === file.id) || originalEntries.current.has(file.id)) {\n      throw new Error('附件操作标识与原记录冲突；原附件和这次正文保留，请重新选择文件。')\n    }", after: 'void file.id' }] },
  'drop-confirmation': { file: 'apps/mobile/src/conversation/MobileAttachments.tsx', edits: [{
    before: "onClick={() => setCopyDecision(decideCopy(upload, file, 'discard'))}", after: "onClick={() => releaseCopy(decideCopy(upload, file, 'discard'))}" }] },
  'replace-original-bytes': { file: 'apps/mobile/src/conversation/MobileAttachments.tsx', edits: [{
    before: 'bytes.current.get(id) !== decision.file || decision.file.revision !== decision.revision', after: 'decision.file.revision !== decision.revision' }] },
  'export-is-not-receipt': { file: 'apps/mobile/src/conversation/MobileAttachments.tsx', edits: [{
    before: "setCopyDecision(decideCopy(upload, file, 'saved'))", after: "releaseCopy(decideCopy(upload, file, 'saved'))" }] },
  'export-lost-on-add': { file: 'apps/mobile/src/conversation/MobileAttachments.tsx', edits: [{
    before: "await retain({ ...upload, phase: 'inserted' })\n    if (!exportedCopies.current.has(upload.identity.operationId)) bytes.current.delete(upload.identity.operationId)",
    after: "await retain({ ...upload, phase: 'inserted' })\n    bytes.current.delete(upload.identity.operationId)" }] },
  'export-lost-on-inspect-insert': { file: 'apps/mobile/src/conversation/MobileAttachments.tsx', edits: [{
    before: "await retain({ ...(confirmed as MobileFileUpload), phase: 'inserted' }); if (!exportedCopies.current.has(id)) bytes.current.delete(id); owner.changed()",
    after: "await retain({ ...(confirmed as MobileFileUpload), phase: 'inserted' }); bytes.current.delete(id); owner.changed()" }] },
  'export-lost-on-send': { file: 'apps/mobile/src/conversation/MobileAttachments.tsx', edits: [{
    before: "await retain({ ...upload, phase: 'inserted' }, true)\n          if (!exportedCopies.current.has(upload.identity.operationId)) bytes.current.delete(upload.identity.operationId)",
    after: "await retain({ ...upload, phase: 'inserted' }, true)\n          bytes.current.delete(upload.identity.operationId)" }] },
  'export-lost-on-confirmation': { file: 'apps/mobile/src/conversation/MobileAttachments.tsx', edits: [{
    before: 'if (exportedCopies.current.has(upload.identity.operationId) && bytes.current.has(upload.identity.operationId)) return', after: 'void upload' }] },
  'inspect-is-not-upload': { file: 'apps/mobile/src/conversation/MobileAttachments.tsx', edits: [{
    before: "flight.dispatched = inspectOnly ? 'inspect' : 'upload'", after: "flight.dispatched = 'upload'" }] },
  'sync-failure-unknown': { file: 'apps/mobile/src/conversation/MobileAttachments.tsx', edits: [
    { before: '          requested = true\n          const pending = inspectOnly', after: '          const pending = inspectOnly' },
    { before: "flight.dispatched = inspectOnly ? 'inspect' : 'upload'", after: "requested = true; flight.dispatched = inspectOnly ? 'inspect' : 'upload'" }
  ] },
  'preserve-confirmed-receipt': { file: 'apps/mobile/src/conversation/MobileAttachments.tsx', edits: [{
    before: "if (previous && fileUploadIntentKey(previous) === intent && (previous.phase === 'uploaded' || previous.phase === 'inserted') &&\n            upload.phase !== 'uploaded' && upload.phase !== 'inserted') throw new Error('原上传已确认；不会用较早的未确认结果覆盖回执。')",
    after: 'void previous' }] },
  'no-ui-overwrite-after-cas': { file: 'apps/mobile/src/conversation/MobileAttachments.tsx', edits: [{
    before: "if (mounted.current) setNotice(`原附件回执尚未保全；可核对同一操作。${errorMessage(error)}`)\n        return false",
    after: "if (mounted.current) setNotice(`原附件回执尚未保全；可核对同一操作。${errorMessage(error)}`)" }] }
}
if (mutant && !variants[mutant]) throw new Error('Unknown upload-exit mutation')
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), { name: 'upload-exit-mutation', enforce: 'pre', transform(code, id) {
  if (!mutant) return
  const variant = variants[mutant]!
  if (relative(root, id.split('?')[0]!) !== variant.file) return
  for (const edit of variant.edits) {
    if (code.split(edit.before).length !== 2) throw new Error(`Upload-exit mutation ${mutant} did not match exactly once`)
    code = code.replace(edit.before, edit.after)
  }
  return { code, map: null }
} }], test: { ...base.test, include: ['test/mobile-attachment-upload-exit.test.tsx'] } })
