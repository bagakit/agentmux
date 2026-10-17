import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseRendererTraceResult } from './renderer-trace.js'
import { scanRendererTraceBytes } from './renderer-trace-bytes.js'
import { writeNewCliFile } from './cli-atomic-file.js'

export async function writeRendererTrace(path: string, result: unknown) {
  const capture = parseRendererTraceResult(rpcRecord(result, ['capture'], 'CONTROL_PROTOCOL_ERROR').capture)
  const material = capture.trace
  if (material === null) throw new AgentMuxError('This capture returned no trace. It was not rerun and no file was written.', 'CONTROL_UNAVAILABLE')
  async function* compressed() {
    for (let offset = 0; offset < material!.data.length; offset += 64 * 1024) {
      yield Buffer.from(material!.data.slice(offset, offset + 64 * 1024), 'base64')
    }
  }
  const written = await writeNewCliFile(path, async write => {
    const scan = await scanRendererTraceBytes(compressed(), { onDecodedChunk: write })
    if (scan.gzipBytes !== material.bytes || scan.gzipSha256 !== material.sha256 || scan.rawBytes !== capture.traceBytes ||
      scan.rawSha256 !== capture.sha256 || scan.events !== capture.receivedEvents) {
      throw new AgentMuxError('The original trace bytes or checksum did not match. No file was published.', 'CONTROL_PROTOCOL_ERROR')
    }
  })
  return { ...written, sha256: capture.sha256 }
}
