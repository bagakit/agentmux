import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

// Read only newly generated records in this proof's originally empty private
// CODEX_HOME. auth/config and host native Sessions are never enumerated.
export async function readPrivateNativeRecords(authHome) {
  const root = join(authHome, 'sessions'), files = await readdir(root, { recursive: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  const paths = files.filter(path => path.endsWith('.jsonl'))
  assert.ok(paths.length <= 32, 'Private native record budget exceeded')
  return await Promise.all(paths.map(async path => {
    const absolute = join(root, path), metadata = await stat(absolute)
    assert.ok(metadata.size <= 8 * 1024 * 1024, 'Private native record size budget exceeded')
    const text = await readFile(absolute, 'utf8')
    return { path, text, records: text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)) }
  }))
}

// The first session_meta owns a native file; later metadata may be inherited ancestry.
const metadata = file => file.records[0]?.type === 'session_meta' ? file.records[0].payload : undefined

export function nativeSession(records, events, model, actualPrompt) {
  const threadId = events.find(event => event.type === 'thread.started')?.thread_id
  assert.ok(threadId, 'Actual native main thread identity is missing')
  const matches = records.filter(file => metadata(file)?.id === threadId)
  assert.equal(matches.length, 1, 'Original native main source is not unique')
  const main = matches[0], mainMetadata = metadata(main)
  assert.equal(mainMetadata.source, 'exec')
  const settings = main.records.find(record => record.type === 'event_msg' && record.payload.type === 'thread_settings_applied')?.payload.thread_settings
  assert.equal(settings?.model, model, 'Actual native model differs from this scenario')
  assert.equal(settings?.approval_policy, 'never')
  const inputs = main.records.filter(record => record.type === 'response_item' && record.payload.type === 'message' && record.payload.role === 'user')
  assert.ok(inputs.some(record => record.payload.content.some(part => part.type === 'input_text' && part.text === actualPrompt)), 'Original native input differs from the exact Core/fixture packet')
  const calls = main.records.filter(record => record.type === 'response_item' && record.payload.type === 'function_call' && record.payload.namespace === 'collaboration').map(record => record.payload)
  return { main, threadId, metadata: mainMetadata, calls }
}

export function assertNativeCollaboration(records, events, model, actualPrompt) {
  const { main, threadId, calls } = nativeSession(records, events, model, actualPrompt)
  const spawn = calls.filter(call => call.name === 'spawn_agent' && call.status === 'completed')
  assert.equal(spawn.length, 1, 'No unique actual Provider-native child invocation')
  const output = main.records.find(record => record.type === 'response_item' && record.payload.type === 'function_call_output' && record.payload.call_id === spawn[0].call_id)?.payload
  assert.ok(output, 'Original native child creation receipt is missing')
  const childPath = JSON.parse(output.output).task_name
  assert.ok(childPath)
  const children = records.filter(file => metadata(file)?.source?.subagent?.thread_spawn?.parent_thread_id === threadId &&
    metadata(file).source.subagent.thread_spawn.agent_path === childPath)
  assert.equal(children.length, 1, 'Native child source does not match its original parent/creation receipt')
  const completion = children[0].records.find(record => record.type === 'event_msg' && record.payload.type === 'task_complete')?.payload
  assert.match(completion?.last_agent_message ?? '', /\b21\b/u, 'Actual native child did not complete the multiplication')
  assert.ok(main.records.some(record => record.type === 'response_item' && record.payload.type === 'agent_message' &&
    record.payload.author === childPath && record.payload.recipient === '/root' && record.payload.content.some(part => part.type === 'input_text' && /\b21\b/u.test(part.text))), 'Original structured native child result was not returned to its parent')
  return { mainThreadId: threadId, childThreadId: metadata(children[0]).id,
    childPath, originalSpawnCallId: spawn[0].call_id, result: completion.last_agent_message }
}

// These mutate copied observed facts to check oracle sensitivity. They do not
// claim product implementation mutation coverage or start another model turn.
export function nativeEvidenceGuards(records, events, model, actualPrompt) {
  const original = assertNativeCollaboration(records, events, model, actualPrompt)
  const mutants = [
    ['remove-main-owner-retain-inherited-ancestry', files => { const index = files.findIndex(file => metadata(file)?.id === original.mainThreadId); assert.ok(index >= 0); files.splice(index, 1) }],
    ['duplicate-main-owner', files => { const duplicate = structuredClone(files.find(file => metadata(file)?.id === original.mainThreadId)); duplicate.path += '.duplicate'; files.push(duplicate) }],
    ['remove-native-invocation', files => { for (const file of files) file.records = file.records.filter(record => !(record.type === 'response_item' && record.payload.name === 'spawn_agent')) }],
    ['lose-native-creation-receipt', files => { for (const file of files) file.records = file.records.filter(record => !(record.type === 'response_item' && record.payload.type === 'function_call_output' && record.payload.call_id === original.originalSpawnCallId)) }],
    ['change-child-parent', files => { for (const file of files) for (const record of file.records) if (record.type === 'session_meta' && record.payload.source?.subagent?.thread_spawn) record.payload.source.subagent.thread_spawn.parent_thread_id = 'unrelated-parent' }],
    ['change-child-result', files => { for (const file of files) if (metadata(file)?.id === original.childThreadId) for (const record of file.records) if (record.type === 'event_msg' && record.payload.type === 'task_complete') record.payload.last_agent_message = 'wrong-result' }],
    ['lose-parent-result-delivery', files => { for (const file of files) file.records = file.records.filter(record => !(record.type === 'response_item' && record.payload.type === 'agent_message' && record.payload.author === original.childPath)) }]
  ]
  const results = mutants.map(([name, mutate]) => {
    const copy = structuredClone(records); mutate(copy)
    assert.throws(() => assertNativeCollaboration(copy, events, model, actualPrompt), undefined, 'Native evidence mutant escaped: ' + name)
    return { name, rejected: true }
  })
  assertNativeCollaboration(records, events, model, actualPrompt)
  return { kind: 'observed-fact oracle sensitivity; not product mutation', results, restored: true }
}
