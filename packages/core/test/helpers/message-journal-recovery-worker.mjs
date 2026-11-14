import { DatabaseSync } from 'node:sqlite'
import { DurableAgentMuxMessageQueue } from '../../src/agent-global-message-queue.ts'

const [mode, path, id = 'second-process'] = process.argv.slice(2), queue = new DurableAgentMuxMessageQueue(path)
if (mode === 'append') await queue.append({ messageId: id, operationId: 'operation-' + id, createdAt: 1,
  sender: { kind: 'agent-session', agentSessionId: 'sender' }, recipient: { kind: 'agent-session', agentSessionId: 'reader' },
  senderSessionId: 'sender', senderRunId: 'sender-run', recipientSessionId: 'reader', recipientRunId: null,
  threadId: id, correlationId: id, replyTo: null, workspaceId: null, body: 'synthetic original body ' + id })
const records = await queue.readJournal()
const db = new DatabaseSync(path, { readOnly: true }), mutex = new DatabaseSync(path + '.mutex.sqlite', { readOnly: true })
try {
  console.log(JSON.stringify({ pid: process.pid, queueId: queue.queueId, messages: records.filter(row => row.kind === 'message').map(row => row.envelope.messageId),
    incarnation: db.prepare('SELECT incarnation FROM metadata').get().incarnation,
    marker: mutex.prepare('SELECT incarnation FROM journal_format').get().incarnation,
    privateRows: mode === 'read' ? db.prepare('SELECT * FROM preservation_probe').all() : [],
    privateMutexRows: mode === 'read' ? mutex.prepare('SELECT * FROM mutex_preservation_probe').all() : [] }))
} finally { db.close(); mutex.close() }
