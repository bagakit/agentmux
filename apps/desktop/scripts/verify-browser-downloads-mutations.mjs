import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/src/main/browser-downloads.ts'
await verifyRendererSourceMutations({
  name: 'browser-downloads-mutations',
  tests: ['apps/desktop/test/browser-downloads.test.ts'],
  sources: [file, 'apps/desktop/src/shared/browser-download.ts', 'apps/desktop/src/main/workspace-files.ts', 'apps/desktop/src/shared/workspace-file-bytes.ts'],
  mutations: [
    { label: 'subscription-after-trigger', file, before: "session.on('will-download', received)", after: "setTimeout(() => session.on('will-download', received), 0)" },
    { label: 'received-claims-completed', file, before: "status: 'received', filename: download.getFilename()", after: "status: 'completed', filename: download.getFilename()" },
    { label: 'native-cancellation-warning-lost', file, before: "'Chromium cancelled the download.'", after: 'undefined' },
    { label: 'original-source-binding-disconnected', file,
      before: 'Object.entries(original).some(([key, value]) => value !== reference[key as keyof BrowserDownloadReference])', after: 'false' },
    { label: 'other-browser-download-claimed', file, before: 'owner.id !== contents.id', after: 'false' },
    { label: 'receipt-reservation-not-serialized', file, before: 'await this.reserve(receipt)', after: 'await this.makeRoom(); await this.save(receipt)' },
    { label: 'chromium-completion-published-without-workspace-owner', file, before: 'await this.files.writeBytes(workspace, { path: options.path, bytes })',
      after: "{ status: 'written' as const, revision: 'sha256:disconnected' }" }
  ]
})
