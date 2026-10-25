import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function offlineEndpoint(home: string, inputs: string[], workspace?: string) {
  const sockets = new Set<import('node:net').Socket>()
  const requests: Record<string, unknown>[] = []
  const endpoint = createServer(async (request, response) => {
    if (request.method === 'GET') { response.setHeader('content-type', 'application/json'); response.end('{"data":[]}'); return }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString('utf8')
    const value = JSON.parse(body), text = value.input?.filter((item: any) => item.role === 'user').at(-1)?.content?.map((item: any) => item.text ?? '').join('') ?? ''
    if (!text.includes('PRIVATE_QUEUE') && !text.includes('<amux')) { response.setHeader('content-type', 'application/json'); response.end('{}'); return }
    requests.push(value)
    inputs.push(text)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const event = (value: unknown) => response.write('data: ' + JSON.stringify(value) + '\n\n')
    const id = 'private-response-' + inputs.length, item = { type: 'message', id: 'private-answer-' + inputs.length, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'PRIVATE_QUEUE_COMPLETE', annotations: [] }] }
    event({ type: 'response.created', response: { id, status: 'in_progress', output: [] } })
    event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    event({ type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    event({ type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: 'PRIVATE_QUEUE_COMPLETE' })
    event({ type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text: 'PRIVATE_QUEUE_COMPLETE' })
    event({ type: 'response.output_item.done', output_index: 0, item })
    event({ type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }); response.end()
  })
  endpoint.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve))
  const address = endpoint.address(); if (!address || typeof address === 'string') throw new Error('Private offline endpoint missing')
  await writeFile(join(home, 'config.toml'), `model="private-queue"\nmodel_provider="private_queue"\n[model_providers.private_queue]\nname="Private offline protocol"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n` +
    (workspace ? `\n[projects.${JSON.stringify(workspace)}]\ntrust_level="trusted"\n` : ''))
  return { endpoint, sockets, requests }
}
