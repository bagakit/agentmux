import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const file = 'apps/desktop/src/main/workspace-files.ts'
const source = await readFile(resolve(import.meta.dirname, '../../..', file), 'utf8')
const start = source.indexOf("  } else if (request.action === 'write') {")
const end = source.indexOf("  } else if (request.action === 'create') {", start)
assert.ok(start >= 0 && end > start)
const block = source.slice(start, end)
assert.ok(block.includes('const before = await currentFile(request.name)') && block.includes('await rename(temporaryName, request.name)'))
const withoutConflict = block
  .replace('before.revision !== request.expectedRevision', 'false')
  .replace('immediatelyBeforeReplace.revision !== request.expectedRevision', 'false')
assert.notEqual(block, withoutConflict)

await verifyRendererSourceMutations({
  name: 'workspace-file-bytes-mutations',
  tests: ['apps/desktop/test/workspace-file-bytes.test.ts'],
  sources: [file, 'apps/desktop/src/shared/workspace-file-bytes.ts'],
  mutations: [
    { label: 'binary-decodes-as-utf8', file, before: 'content: Buffer.from(input.bytes)', after: "content: Buffer.from(Buffer.from(input.bytes).toString('utf8'))" },
    { label: 'outside-byte-read-follows-explorer-link', file,
      before: 'const resolved = await localExistingPathWithin(workspace.path, requestedPath)\n    const document = JSON.parse',
      after: 'const resolved = await localReadablePath(workspace.path, requestedPath)\n    const document = JSON.parse' },
    { label: 'existing-file-overwritten', file, before: block, after: withoutConflict },
    { label: 'byte-transfer-budget-disconnected', file, before: 'totalBytes > request.maxFileBytes', after: 'false' }
  ]
})
