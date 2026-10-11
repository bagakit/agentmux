import { createHash } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseRendererTraceResult, rendererTraceJSON } from './renderer-trace.js'
import { writeNewCliFile } from './cli-atomic-file.js'

export async function writeRendererTrace(path: string, result: unknown) {
  const capture = parseRendererTraceResult(rpcRecord(result, ['capture'], 'CONTROL_PROTOCOL_ERROR').capture)
  if (capture.trace === null) throw new AgentMuxError('This capture returned no trace. It was not rerun and no file was written.', 'CONTROL_UNAVAILABLE')
  const text = rendererTraceJSON(capture.trace)
  const sha256 = createHash('sha256').update(text).digest('hex')
  if (sha256 !== capture.sha256) {
    throw new AgentMuxError('The original trace checksum did not match. No file was written.', 'CONTROL_PROTOCOL_ERROR')
  }
  const written = await writeNewCliFile(path, text)
  return { path: written.path, sha256, bytes: written.bytes }
}
