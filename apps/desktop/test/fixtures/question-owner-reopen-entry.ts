import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { WorkbenchUserStateStore } from '../../src/main/workbench-user-state'

const owner = new WorkbenchUserStateStore(process.argv[2]!)
const raw = await owner.read()
assert.ok(raw)
const saved = JSON.parse(raw), replies = Object.values(saved.state.questionReplies).flatMap(value => Object.values(value as Record<string, { phase: string; input: { answers: unknown; operationId: string } }>))
assert.equal(replies.length, 1)
const reply = replies[0]!
console.log(JSON.stringify({ pid: process.pid, phase: reply.phase, operationId: reply.input.operationId, answers: reply.input.answers,
  savedSHA256: createHash('sha256').update(raw).digest('hex'), ownerSourceEvaluated: Reflect.get(globalThis, '__questionReopenSource') === true }))
