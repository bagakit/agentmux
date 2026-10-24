import { resolve, relative } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './mobile-web.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutant = process.env.MOBILE_UPDATE_MUTANT
const variants: Record<string, { file: string; before: string; after: string }> = {
  'ignore-live-owner': { file: 'apps/mobile/src/mobile-web/update-safety.ts', before: 'if (finalIssue) return blocked(finalIssue)', after: 'if (false && finalIssue) return blocked(finalIssue)' },
  'ignore-workface-change': { file: 'apps/mobile/src/mobile-web/update-safety.ts', before: '!workfaceStillSaved()', after: 'false' },
  'ignore-original-key': { file: 'apps/mobile/src/connection/MobileConnectionRoot.tsx', before: '!equal(key.secretKey, original.key.secretKey)', after: 'false' },
  'ignore-consumer-loss': { file: 'apps/mobile/src/connection/MobileConnectionRoot.tsx', before: 'binding.current === original && original.connected && !!saved', after: 'binding.current === original && !!saved' },
  'ignore-note-editor': { file: 'apps/mobile/src/navigation/MobileNoteFile.tsx', before: 'useMobileWebUpdateSafetyOwner(() => draft.reloadIssue())', after: 'void draft' },
  'reload-old-namespace': { file: 'apps/mobile/src/mobile-web/update-safety.ts', before: "location.assign('/' + mobileUpdateFragment)", after: 'location.reload()' },
  'ignore-last-identity': { file: 'apps/mobile/src/mobile-web/update-safety.ts', before: 'const finalConnection = await original.verifyConnection()', after: 'const finalConnection = connection' },
  'ignore-reload-identity': { file: 'apps/mobile/src/connection/MobileConnectionRoot.tsx', before: '!keyPair || updating && !matchesReloadIdentity(keyPair, reloadOfferIdentity(selected!), reloadRecordIdentity(selected!.serverId))', after: '!keyPair' },
  'ignore-reload-workface': { file: 'apps/mobile/src/connection/reload-identity.ts', before: 'offer: fileUploadRevision(new TextEncoder().encode(offer)), recordId })', after: 'offer: fileUploadRevision(new TextEncoder().encode(offer)), recordId: null })' },
  'ignore-reload-read-failure': { file: 'apps/mobile/src/connection/MobileConnectionRoot.tsx', before: 'if (issue || record.host?.origin !== location.origin', after: 'if (false || record.host?.origin !== location.origin' },
  'ignore-handoff-gate': { file: 'apps/mobile/src/connection/MobileConnectionRoot.tsx', before: 'if (updatePending) return <main', after: 'if (false && updatePending) return <main' },
  'ignore-offline-workface': { file: 'apps/mobile/src/connection/MobileConnectionRoot.tsx', before: 'flushSync(() => setUpdatePending(false))', after: 'void 0' },
  'ignore-cross-page-lock': { file: 'apps/mobile/src/connection/MobileConnectionRoot.tsx', before: 'await withDeviceStorageLock(() => {', after: 'await Promise.resolve().then(() => {' },
  'ignore-handoff-retry': { file: 'apps/mobile/src/connection/MobileConnectionRoot.tsx', before: 'onClick={() => retryConnection(value => value + 1)}', after: 'onClick={() => {}}' },
  'ignore-create-form': { file: 'apps/mobile/src/navigation/MobileAgentCreate.tsx', before: 'return value.edited && (value.prompt || value.executor || value.space && value.space !== (target.spaceId ?? \'\') || value.zone && value.zone !== (target.zoneId ?? \'\'))', after: 'return false && (value.prompt || value.executor || value.space && value.space !== (target.spaceId ?? \'\') || value.zone && value.zone !== (target.zoneId ?? \'\'))' },
  'ignore-cancel-preparation': { file: 'apps/mobile/src/conversation/use-mobile-prompt-controller.ts', before: 'original.cancelled = true; original.cancel?.()', after: 'void 0' },
  'ignore-pending-action': { file: 'apps/mobile/src/mobile-web/update-safety.ts', before: "const release = context?.register(() => pendingContinuation ? typeof message === 'function' ? message() : message : null)", after: 'const release = undefined' },
  'ignore-dispatched-prompt': { file: 'apps/mobile/src/mobile-web/update-safety.ts', before: 'group.add(match); dispatched.current.set(key, group)', after: 'void 0' },
  'ignore-dispatch-key': { file: 'apps/mobile/src/mobile-web/update-safety.ts', before: 'for (const match of dispatched.current.get(key) ?? []) if (match(candidate)) return true', after: 'for (const group of dispatched.current.values()) for (const match of group) if (match({ ...(candidate as object), key: Array.from(dispatched.current.keys())[0] })) return true' },
  'ignore-cancel-retry': { file: 'apps/mobile/src/conversation/use-mobile-prompt-controller.ts', before: 'if (action.cancelled) return\n      if (observed &&', after: 'if (false && action.cancelled) return\n      if (observed &&' },
  'ignore-cancel-stop': { file: 'apps/mobile/src/conversation/use-mobile-prompt-controller.ts', before: 'if (action.cancelled) {\n        if (attempts.current.get(key) === original && input.stopIntent === stop)', after: 'if (false && action.cancelled) {\n        if (attempts.current.get(key) === original && input.stopIntent === stop)' },
  'ignore-cancel-condition-restore': { file: 'apps/mobile/src/conversation/use-mobile-prompt-controller.ts', before: 'if (previousRequest === undefined) delete original.request; else original.request = previousRequest', after: 'void previousRequest' },
  'ignore-cancel-receipt': { file: 'apps/mobile/src/conversation/use-mobile-prompt-controller.ts', before: 'if (attempts.current.get(key) === original && !original.inputReceipt)', after: 'if (attempts.current.get(key) === original)' },
  'ignore-cancel-receipt-phase': { file: 'apps/mobile/src/conversation/use-mobile-prompt-controller.ts', before: 'if (!original.inputReceipt) {\n          original.phase = previousPhase', after: 'if (true) {\n          original.phase = previousPhase' },
  'ignore-retry-handoff': { file: 'apps/mobile/src/conversation/use-mobile-prompt-controller.ts', before: 'const retry = retryOriginalPrompt(unresolved[0]); allowUpdate()', after: 'const retry = retryOriginalPrompt(unresolved[0])' },
  'ignore-local-save': { file: 'apps/mobile/src/conversation/MobileConversationSurface.tsx', before: 'local.saveIssue || local.recordChanged || local.hasUnconfirmedSave', after: 'local.saveIssue || local.recordChanged' }
}
if (mutant && !variants[mutant]) throw new Error('Unknown mobile update mutation')
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), { name: 'mobile-update-mutation', enforce: 'pre', transform(code, id) {
  const variant = mutant && variants[mutant]
  if (!variant || relative(root, id.split('?')[0]!) !== variant.file) return
  if (code.split(variant.before).length !== 2) throw new Error('Mobile update mutation did not match exactly once')
  return { code: code.replace(variant.before, variant.after), map: null }
} }], test: { ...base.test, include: mutant === 'ignore-cancel-preparation' ? ['test/mobile-attachments.test.tsx'] : ['test/mobile-update-identity.test.ts', 'test/mobile-update-safety.test.tsx', 'test/mobile-update-connection.test.tsx', 'test/mobile-update-workface.test.tsx'] } })
