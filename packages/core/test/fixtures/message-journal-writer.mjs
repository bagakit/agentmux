import { fixtureEpoch as _tailFixtureEpoch } from "../../../../test/fixture-values.mjs"
import { readFile, rename } from 'node:fs/promises'
const [entry, mode, path, id = 'cross-process-message'] = process.argv.slice(2)
const { DurableAgentMuxMessageQueue } = await import(entry)
const queue = new DurableAgentMuxMessageQueue(path)
if (mode === 'append' || mode === 'hold' || mode === 'burst') {
  for (let index = 0; index < (mode === 'burst' ? 12 : 1); index++) {
    const messageId = mode === 'burst' ? `${id}-${index}` : id
    await queue.append({ messageId, operationId: 'operation-' + messageId, createdAt: _tailFixtureEpoch(0, 0, 1),
    sender: { kind: 'agent-session', agentSessionId: 'sender' }, recipient: { kind: 'agent-session', agentSessionId: 'reader' },
    senderSessionId: 'sender', senderRunId: 'original-sender-run', recipientSessionId: 'reader', recipientRunId: null,
    threadId: messageId, correlationId: messageId, replyTo: null, workspaceId: null, body: 'Original private body <reminder>authored</reminder> ' + messageId })
  }
  if (mode === 'hold') {
    // Hold the candidate's exact lease owner, including its acquire-only waiting protocol.
    // A separate hand-written BEGIN could race the observer and fail before this boundary.
    await queue.withLock(async () => {
      process.stdout.write('held\n')
      await new Promise(resolve => process.stdin.once('data', resolve))
    })
  }
} else if (mode === 'delivery') await queue.recordDelivery(id, 'failed', 2, 'Private delivery observation')
else if (mode === 'rollback') {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path); db.exec('DELETE FROM records'); db.close()
} else if (mode === 'replace') {
  const other = new DurableAgentMuxMessageQueue(path + '.replacement')
  await other.listMessages({ participantSessionId: 'reader', direction: 'incoming', limit: 1 }, async () => {})
  await rename(path, path + '.original'); await rename(path + '.replacement', path)
} else if (mode === 'restore') await rename(path + '.original', path)
else throw new Error('Unknown private message writer mode')
// Reading this exact file proves the helper only operated its supplied private journal.
process.stdout.write(JSON.stringify({ mode, path, bytes: (await readFile(path)).length }) + '\n')
