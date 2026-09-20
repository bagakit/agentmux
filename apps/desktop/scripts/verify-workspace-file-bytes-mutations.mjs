import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/src/main/workspace-files.ts'

await verifyRendererSourceMutations({
  name: 'workspace-file-bytes-mutations',
  tests: ['apps/desktop/test/workspace-file-bytes.test.ts'],
  sources: [file, 'apps/desktop/src/shared/workspace-file-bytes.ts'],
  mutations: [
    { label: 'binary-decodes-as-utf8', file, before: 'content: Buffer.from(input.bytes)', after: "content: Buffer.from(Buffer.from(input.bytes).toString('utf8'))" },
    { label: 'outside-byte-read-follows-explorer-link', file,
      before: 'const resolved = await localExistingPathWithin(workspace.path, requestedPath)\n    const document = JSON.parse',
      after: 'const resolved = await localReadablePath(workspace.path, requestedPath)\n    const document = JSON.parse' },
    { label: 'existing-file-overwritten', file, before: 'await link(temporaryName, request.name)', after: 'await rename(temporaryName, request.name)' },
    { label: 'upload-snapshot-truncated-to-public-chunk', file, before: 'offset: 0, maxBytes: WORKSPACE_FILE_MAX_BYTES', after: 'offset: 0, maxBytes: WORKSPACE_FILE_MAX_READ_BYTES' },
    { label: 'byte-transfer-budget-disconnected', file, before: 'totalBytes > request.maxFileBytes', after: 'false' }
  ]
})
