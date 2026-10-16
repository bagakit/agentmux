import { fixtureEpoch as _tailFixtureEpoch } from "../../../../../test/fixture-values.mjs"
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root = resolve(import.meta.dirname, '../../../../..'), coreBuildInputs = {}
const observed = registerHooks({ load(url, context, next) {
  const loaded = next(url, context)
  if (url.startsWith('file:')) {
    const file = fileURLToPath(url)
    if (file.startsWith(join(root, 'packages/core/dist/')) && file.endsWith('.js')) coreBuildInputs[relative(root, file)] = createHash('sha256').update(readFileSync(file)).digest('hex')
  }
  return loaded
} })
const { AgentMuxClient, AgentMuxFileAgentSessionStore } = await import('@agentmux/core')
const { complete, plain, incomplete, quoted, resourceWire, source, recordId, reference } = await import('./inputs.mjs')
const directory = resolve(process.argv[2] ?? '')
assert.ok(directory, 'Private sample directory required')
await mkdir(directory, { recursive: true })
const nativePath = join(directory, 'native.jsonl'), bodies = [complete, plain, incomplete, quoted]
await writeFile(nativePath, bodies.map((text, index) => JSON.stringify({ sessionId: source.nativeSessionId, uuid: 'original-' + index,
  type: 'user', message: { role: 'user', content: text } })).join('\n') + '\n')
const before = await readFile(nativePath)
const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.sqlite'))
const session = { kind: 'agent', agentSessionId: 'reader', providerId: source.providerId, executorId: source.providerId, hostId: 'local', workspacePath: directory,
  run: { runId: 'private-unstarted-run' }, retiredRuns: [], hookBindingId: 'private-reading', hookToken: 'private-reading', createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1),
  nativeHandle: { kind: 'provider', providerId: source.providerId, sessionId: source.nativeSessionId, transcriptPath: nativePath } }
await store.compareAndSwap(null, session)
const client = new AgentMuxClient({ store })
try {
  const frame = await client.readAgentConversation({ hostId: 'local', agentSessionId: 'reader', limit: 100, maxBytes: 4 * 1024 * 1024 })
  assert.ok(frame.items.length > 0 && frame.window.complete)
  const changes = await client.readConversationChanges({ hostId: 'local', agentSessionId: 'reader', checkpoint: frame.window.checkpoint, view: frame.window.view, maxBytes: 4 * 1024 * 1024 })
  const bytes = Buffer.from(JSON.stringify({ kind: 'text', text: resourceWire })), sha256 = createHash('sha256').update(bytes).digest('hex')
  const resource = { kind: 'resource', resourceType: 'text', reference, content: { encoding: 'json-utf8', kind: 'text', byteLength: bytes.length, sha256 } }
  await writeFile(join(directory, 'reading.json'), JSON.stringify({ frame, changes, coreBuildInputs, session: await store.readMetadata('reader'),
    resource: { part: resource, source, recordId, reference, text: resourceWire, bytesBase64: bytes.toString('base64'), sha256, byteLength: bytes.length },
    expected: { first: complete, resource: resourceWire },
    boundary: 'Nonempty frames from actual built-in Claude reader/Core/FileStore; original native authors unknown. Resource bytes are a controlled exact public resource response, not a real large Provider record. No Run started or model invoked.' }) + '\n')
  assert.deepEqual(await readFile(nativePath), before)
} finally { await client.dispose(); observed.deregister() }
