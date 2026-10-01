import { createReadStream } from 'node:fs'
import { AGENTMUX_CONTROL_MAX_MESSAGE_BYTES } from './control.js'
import { AgentMuxError } from './errors.js'

/** One bounded UTF-8 reader for authored Control resource input, including stdin. */
export async function readControlJsonInput(path: string, label: string): Promise<unknown> {
  const stream = path === '-' ? process.stdin : createReadStream(path)
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > AGENTMUX_CONTROL_MAX_MESSAGE_BYTES) throw new AgentMuxError(`${label} input exceeds the Control message budget.`, 'INVALID_CLI_ARGUMENT')
      chunks.push(buffer)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } catch (error) {
    if (error instanceof AgentMuxError) throw error
    throw new AgentMuxError(`${label} input must be a readable UTF-8 JSON file or stdin.`, 'INVALID_CLI_ARGUMENT')
  } finally { if (path !== '-') stream.destroy() }
}
