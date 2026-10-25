import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Deterministic Anthropic protocol endpoint; executes no tools and uses no external model. */
export const CLAUDE_PROOF_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwaDjwHwAFBAKAPJ4DgAAAAABJRU5ErkJggg=='

export async function createClaudeExecutionProofModel({ root, workspace, nativeTools = false }) {
  const modelRequests = [], diagnostics = [], modelSockets = new Set()
  let releaseFirstAnswer, stopTask
  const firstAnswer = new Promise(resolve => { releaseFirstAnswer = resolve })
  const steps = [
    { id: 'toolu_remote_read', name: 'Read', input: { file_path: join(workspace, 'input.txt') } },
    { id: 'toolu_remote_image', name: 'Read', input: { file_path: join(workspace, 'fixture.png') } },
    { id: 'toolu_remote_write', name: 'Write', input: { file_path: join(workspace, 'note.txt'), content: 'original\n' } },
    { id: 'toolu_remote_edit', name: 'Edit', input: { file_path: join(workspace, 'note.txt'), old_string: 'original', new_string: 'modified' } },
    { id: 'toolu_remote_notebook_read', name: 'Read', input: { file_path: join(workspace, 'fixture.ipynb') } },
    { id: 'toolu_remote_notebook', name: 'NotebookEdit', input: { notebook_path: join(workspace, 'fixture.ipynb'), cell_id: 'cell-original', new_source: 'print("modified")', cell_type: 'code', edit_mode: 'replace' } },
    { id: 'toolu_remote_effect', name: 'Bash', input: { command: `printf 'once\\n' >> '${join(workspace, 'effect-count.txt')}'; pwd; cat '${join(workspace, 'note.txt')}'`, description: 'Isolated resource-side effect' } },
    { id: 'toolu_remote_background', name: 'Bash', input: { command: `sleep 0.4; printf background-complete > '${join(workspace, 'background.txt')}'`, run_in_background: true, description: 'Isolated resource-side background command' } },
    { id: 'toolu_remote_long_background', name: 'Bash', input: { command: `printf started > '${join(workspace, 'long-background-started.txt')}'; sleep 300; printf forbidden > '${join(workspace, 'long-background-forbidden.txt')}'`, run_in_background: true, description: 'Isolated background task retained across a Core restart' } },
  ]
  const modelToolPrefix = nativeTools ? '' : 'mcp__amux_exec__'
  const finalNames = { first: 'PRIVATE_CLAUDE_ORIGINAL_COMPLETE', resumed: 'PRIVATE_CLAUDE_RESUMED_COMPLETE' }
  function responseContent(body) {
    const messages = body.messages ?? [], encoded = JSON.stringify(messages), resumed = encoded.includes('PRIVATE_CLAUDE_RESUMED_CONTEXT')
    const results = messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(value => value.type === 'tool_result')
    const called = new Set(results.map(value => value.tool_use_id))
    for (const result of results) assert(result.is_error !== true, `Native tool ${result.tool_use_id} failed: ${JSON.stringify(result.content)}`)
    if (resumed) {
      if (!called.has('toolu_remote_resumed_read')) return { content: [{ type: 'tool_use', id: 'toolu_remote_resumed_read', name: modelToolPrefix + 'Read', input: { file_path: join(workspace, 'note.txt') } }], stop_reason: 'tool_use' }
      if (stopTask && !called.has('toolu_remote_stop')) return { content: [{ type: 'tool_use', id: 'toolu_remote_stop', name: modelToolPrefix + 'TaskStop', input: { task_id: stopTask } }], stop_reason: 'tool_use' }
      return { content: [{ type: 'text', text: finalNames.resumed }], stop_reason: 'end_turn' }
    }
    const next = steps.find(step => !called.has(step.id))
    if (next) {
      assert((body.tools ?? []).some(tool => tool.name === modelToolPrefix + next.name), 'Actual native model tool manifest must contain ' + next.name)
      return { content: [{ type: 'tool_use', ...next, name: modelToolPrefix + next.name }], stop_reason: 'tool_use' }
    }
    return { content: [{ type: 'text', text: finalNames.first }], stop_reason: 'end_turn', hold: true }
  }
  const model = createServer(async (request, response) => {
    try {
      let data = ''; for await (const bytes of request) data += bytes
      let body; try { body = JSON.parse(data) } catch {}
      if (!request.url?.includes('/messages')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return }
      if (request.url.includes('count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":100}'); return }
      const record = { path: request.url, body }; modelRequests.push(record)
      await writeFile(join(root, 'model-requests.json'), JSON.stringify(modelRequests, null, 2), { mode: 0o600 })
      let result = responseContent(body)
      if (result.hold) { await firstAnswer; result = responseContent(body) }
      const id = 'msg_isolated_' + modelRequests.length, message = { id, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: result.content, stop_reason: result.stop_reason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 30 } }
      if (!body.stream) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)
      send('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } })
      for (const [index, content] of result.content.entries()) {
        send('content_block_start', { type: 'content_block_start', index, content_block: content.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: content.id, name: content.name, input: {} } })
        send('content_block_delta', { type: 'content_block_delta', index, delta: content.type === 'text' ? { type: 'text_delta', text: content.text } : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } })
        send('content_block_stop', { type: 'content_block_stop', index })
      }
      send('message_delta', { type: 'message_delta', delta: { stop_reason: result.stop_reason, stop_sequence: null }, usage: { output_tokens: 30 } })
      send('message_stop', { type: 'message_stop' }); response.end()
    } catch (error) { diagnostics.push({ source: 'controlled-model', error: String(error) }); response.writeHead(500); response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: String(error) } })) }
  })
  model.on('connection', socket => { modelSockets.add(socket); socket.once('close', () => modelSockets.delete(socket)) })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const port = model.address().port
  let closed = false
  return { model, port, steps, finalNames, stopResourceTask: id => { assert(typeof id === 'string' && id.length > 0); stopTask = id }, modelRequests, diagnostics, modelSockets, releaseFirstAnswer, close: async () => { if (closed) return; closed = true; releaseFirstAnswer(); for (const socket of modelSockets) socket.destroy(); await new Promise(resolve => model.close(resolve)) } }
}
