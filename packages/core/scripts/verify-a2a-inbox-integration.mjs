import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { a2aProofSha, verifyA2aInboxProductProof } from '../../../apps/desktop/scripts/lib/a2a-inbox-product-proof.mjs'
const root = resolve(import.meta.dirname, '../../..')
// Consume the owning mailbox source mutations and independent visual review without
// another build. This command then checks the separate integration contract itself.
await promisify(execFile)(process.execPath, ['apps/desktop/scripts/verify-mailbox-reading-flow.mjs'], { cwd: root, maxBuffer: 4 * 1024 * 1024 })
const index = JSON.parse(await readFile(resolve(root, '.tmp/mailbox-reading-flow/receipt.json'), 'utf8'))
assert.ok(index.productArtifact?.path && index.productArtifact.sha256)
const bytes = await readFile(index.productArtifact.path); assert.equal(a2aProofSha(bytes), index.productArtifact.sha256)
const result = await verifyA2aInboxProductProof(JSON.parse(bytes), { root, scope: 'integration' })
console.log(JSON.stringify({ ...result, artifact: index.productArtifact }))
