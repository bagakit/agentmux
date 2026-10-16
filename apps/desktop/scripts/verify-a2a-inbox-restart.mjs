import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { a2aProofSha, verifyA2aInboxProductProof } from './lib/a2a-inbox-product-proof.mjs'
const root = resolve(import.meta.dirname, '../../..')
await promisify(execFile)(process.execPath, ['packages/core/scripts/verify-a2a-inbox-integration.mjs'], { cwd: root, maxBuffer: 4 * 1024 * 1024 })
const index = JSON.parse(await readFile(resolve(root, '.tmp/mailbox-reading-flow/receipt.json'), 'utf8'))
assert.ok(index.productArtifact?.path && index.productArtifact.sha256)
const bytes = await readFile(index.productArtifact.path); assert.equal(a2aProofSha(bytes), index.productArtifact.sha256)
const result = await verifyA2aInboxProductProof(JSON.parse(bytes), { root, scope: 'restart' })
console.log(JSON.stringify({ ...result, artifact: index.productArtifact }))
