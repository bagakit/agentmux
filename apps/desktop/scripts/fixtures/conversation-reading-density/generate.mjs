import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fixtureEpoch } from '../../../../../test/fixture-values.mjs'
import { sessionId, source, originalRows, appendedRow, snapshots, reply, draft } from './scene.mjs'

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
const { consumeConversationWindowPage } = await import('@agentmux/core/conversation')
assert.ok(process.argv[2], 'An explicitly owned private sample directory is required')
const directory = resolve(process.argv[2]), nativePath = join(directory, 'native.jsonl')
await mkdir(directory, { recursive: true })
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
await writeFile(nativePath, jsonl(originalRows(directory)))
const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.sqlite'))
const session = { kind: 'agent', agentSessionId: sessionId, providerId: source.providerId, executorId: source.providerId, hostId: 'local', workspacePath: directory,
  run: { runId: 'private-unstarted-run' }, retiredRuns: [], hookBindingId: 'private-reading', hookToken: 'private-reading',
  createdAt: fixtureEpoch(1), updatedAt: fixtureEpoch(1),
  nativeHandle: { kind: 'provider', providerId: source.providerId, sessionId: source.nativeSessionId, transcriptPath: nativePath } }
await store.compareAndSwap(null, session)
for (const item of snapshots) await store.applyTimelineMutation({ type: 'append', agentSessionId: sessionId, item })
const client = new AgentMuxClient({ store })
try {
  const ref = { hostId: 'local', agentSessionId: sessionId, limit: 100, maxBytes: 4 * 1024 * 1024 }
  const before = await readFile(nativePath), frame = await client.readAgentConversation(ref)
  const assembled = consumeConversationWindowPage(frame)
  assert.equal(assembled.kind, 'complete', 'One complete bounded public Core frame')
  assert.ok(assembled.snapshot.units.length > 0)
  const originals = assembled.snapshot.units.flatMap(unit => unit.records)
  const report = originals.find(record => record.original.item.id === 'collaboration-report')?.original.item
  assert.deepEqual(report?.collaboration, { kind: 'message', source, sender: '/root/reviewer', recipient: '/root' }, 'Built Core must contain the current native collaboration parser')
  assert.equal(report.turnId, 'original-review-turn')
  assert.ok(originals.some(record => record.original.item.id === 'reply-observation'))
  assert.deepEqual(await readFile(nativePath), before, 'Public reading preserves original bytes')
  await appendFile(nativePath, jsonl([appendedRow]))
  const changes = await client.readConversationChanges({ ...ref, checkpoint: frame.window.checkpoint, view: frame.window.view })
  const changed = consumeConversationWindowPage(changes)
  assert.equal(changed.kind, 'complete')
  assert.ok(changed.snapshot.units.some(unit => unit.records.some(record => record.original.item.id === 'later-progress')))
  assert.deepEqual(await store.readMetadata(sessionId), session, 'No Session or Run mutation during reads')
  await writeFile(join(directory, 'reading.json'), JSON.stringify({ frame, changes, coreBuildInputs, session, expected: { reply, draft, sessionId },
    boundary: 'Nonempty original Codex/FileStore/Core public reader frames and durable changes; saved private transcript and Hook observations only. No model, live Run, installed App, recovery or delivery claim.' }) + '\n')
} finally { await client.dispose(); observed.deregister() }
