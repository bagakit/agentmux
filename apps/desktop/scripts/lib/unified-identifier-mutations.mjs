export const clientIdentityMutations = {
  'incident-temp-reader': { file: 'apps/host/src/client-incident-archive.ts', before: '(?:[1-9A-HJ-NP-Za-km-z]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', after: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', test: 'apps/desktop/test/client-incident-temp-cleanup.test.ts' },
  'input-observation-reader': { file: 'packages/core/src/performance-diagnostics.ts', before: 'isObjectId(observerId) || ', after: '', test: 'packages/core/test/performance-input-correlation.test.ts' },
  'journal-owner': { file: 'apps/desktop/src/main/browser-operation-journal.ts', before: 'options.id ?? mintObjectId', after: 'options.id ?? (() => crypto.randomUUID())', test: 'apps/desktop/test/browser-operation-journal.test.ts' },
  'note-block-owner': { file: 'apps/desktop/src/main/note-file-writer.ts', before: 'blockId: mintObjectId()', after: 'blockId: crypto.randomUUID()', test: 'apps/desktop/test/unified-note-identifiers.test.ts' },
  'wiki-occurrence-owner': { file: 'packages/client-ui/src/note/note-wiki-input.ts', before: 'referenceId: mintObjectId()', after: 'referenceId: crypto.randomUUID()', test: 'apps/desktop/test/note-wikilinks-editor.test.tsx' },
  'preload-correlation': { file: 'apps/desktop/src/preload/index.ts', before: 'const token = mintObjectId()', after: 'const token = crypto.randomUUID()', test: 'apps/desktop/test/preload-history-observation.test.ts' },
  'window-ticket-secret': { file: 'apps/desktop/src/main/workbench-windows.ts', before: "url.searchParams.set('ticket', mintCapabilityToken())", after: "url.searchParams.set('ticket', mintObjectId())", test: 'apps/desktop/test/workbench-windows.test.ts' },
  'incident-admission-secret': { file: 'apps/desktop/src/main/client-incident-ipc.ts', before: 'token: mintCapabilityToken()', after: 'token: mintObjectId()', test: 'apps/desktop/test/client-incident-ipc.test.ts' },
  'shared-grant-reader': { file: 'apps/desktop/src/main/browser-external-bridge.ts', before: 'grantId: storedIdentity', after: 'grantId: z.string().uuid()', test: 'apps/desktop/test/unified-browser-identifiers.test.ts' },
  'extension-owner': { file: 'apps/desktop/browser-extension/service-worker.js', before: 'grantId: mintObjectId()', after: 'grantId: crypto.randomUUID()', test: 'apps/desktop/test/unified-browser-identifiers.test.ts' },
  'native-export-owner': { file: 'apps/mobile/src/platform/native/workface-file.ts', before: 'stagingId: mintObjectId()', after: 'stagingId: crypto.randomUUID()', test: 'apps/mobile/test/native-workface-file.test.ts' }
}
