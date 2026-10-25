import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { AgentInputImageReference } from '@agentmux/core'
import { inputImagePublicationFixture, png } from './helpers/input-image-publication-fixture.js'
import { preparePublicUserProfile } from '../src/public-author-profile.js'

it('App selected image artifact reaches both SDKs after retained diagnostic gaps on its original input', async () => {
  const artifactPath = process.env.AGENTMUX_TEST_IMAGE_RECOVERY_ARTIFACT!, artifactBytes = readFileSync(artifactPath)
  const artifact = JSON.parse(artifactBytes.toString()) as {
    body: string; inputImages: AgentInputImageReference[]; source: string;
    retained: { upload: AgentInputImageReference['upload']; dataBase64: string }
  }
  const f = await inputImagePublicationFixture(), id = 'image-agent', publication = f.services().publication!
  // Existing durable diagnostic facts are the precondition, not fabricated platform
  // receipts. This is the same shape retained when an older frozen body cannot qualify.
  for (const bindingId of ['feishu-binding', 'discord-binding']) for (let index = 0; index < 4; index++) {
    const gap = { gapId: `${bindingId}-old-diagnostic-${index}`, reason: 'version-unavailable', code: 'PUBLICATION_PENDING_CONTENT_UNCONFIRMED',
      record: { hostId: 'local', agentSessionId: id, source: { kind: 'captured', recordId: `old-input-${index}` } } }
    publication.store.database.prepare('INSERT INTO connector_publication_decision(binding_id,binding_revision,source_key,record_id,source_revision,reason,decision_json) VALUES(?,?,?,?,?,?,?)')
      .run(bindingId, 1, 'unified', gap.gapId, 'original', 'version-unavailable', JSON.stringify({ kind: 'gap', gap, state: 'unresolved' }))
  }
  // Consume the exact current Composer output across the browser/native boundary.
  // Neither the body spans nor typed membership are assembled in this consumer.
  const { upload, dataBase64 } = artifact.retained
  expect(Buffer.from(dataBase64, 'base64')).toEqual(png)
  expect(artifact.inputImages).toHaveLength(1)
  expect(artifact.inputImages[0]!.upload).toEqual(upload)
  expect(await f.rpc.call('file.upload', { ...upload, dataBase64 })).toMatchObject({ status: 'uploaded' })
  await f.send(artifact.body, artifact.inputImages, 'app-image-input', preparePublicUserProfile({ displayName: 'Original App person' })!)
  const key = { kind: 'prompt' as const, agentSessionId: id, expectedRun: { runId: 'run-image-agent' }, submissionId: 'app-image-input' }
  const resource = await f.rpc.call('agent.input.resource', { key, index: 0, revision: upload.revision, maxBytes: 1024 * 1024 })
  expect(resource).toMatchObject({ status: 'available', revision: upload.revision, byteLength: png.length })
  const receipt = { artifactSHA256: createHash('sha256').update(artifactBytes).digest('hex'), key, resource: { status: resource.status, revision: upload.revision, byteLength: png.length } }
  writeFileSync(artifactPath + '.consumer.json', JSON.stringify(receipt))
  await vi.waitFor(() => {
    expect(f.feishu.uploads).toEqual([png]); expect(f.discord.uploads).toEqual([png])
    for (const wire of [JSON.stringify(f.feishu.calls), JSON.stringify(f.discord.calls)]) {
      expect(wire).toContain('Before selected picture'); expect(wire).toContain('After selected picture'); expect(wire).not.toContain(artifact.source)
    }
    expect(f.operations().filter(op => op.payload.kind === 'image').map(op => op.state)).toEqual(['confirmed', 'confirmed'])
  }, { timeout: 8000 })
  for (const bindingId of ['feishu-binding', 'discord-binding']) {
    const image = f.operations().find(op => op.bindingId === bindingId && op.payload.kind === 'image')!
    const coverage = await f.rpc.call('connection.delivery.ls', { connectionId: image.target.connectionId, bindingId, bindingRevision: 1 })
    expect(coverage.coverage?.gaps.filter(gap => gap.code === 'PUBLICATION_PENDING_CONTENT_UNCONFIRMED')).toHaveLength(4)
    expect(coverage.coverage?.gaps.some(gap => gap.reason === 'resource-unavailable')).toBe(false)
    expect(image.reference.source).toEqual({ kind: 'captured', recordId: 'prompt:app-image-input' })
    // Feishu uploads before sending its image key; Discord sends multipart bytes
    // in the message request and therefore has no separate resourceUpload receipt.
    expect(await f.rpc.call('connection.delivery.inspect', { operationId: image.operationId })).toMatchObject({ delivery: { state: 'confirmed',
      ...(bindingId === 'feishu-binding' ? { resourceUpload: { state: 'confirmed', attempt: 1 } } : {}) } })
  }
  writeFileSync(artifactPath + '.consumer.json', JSON.stringify({ ...receipt, delivered: ['feishu', 'discord'], diagnosticsRetained: 8 }))
}, 60000)
