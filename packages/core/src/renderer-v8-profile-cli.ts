import { createHash } from 'node:crypto'
import { writeNewCliFile } from './cli-atomic-file.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseRendererV8ProfileResult, rendererV8ProfileJSON } from './renderer-v8-profile.js'

/** The output path is local to this CLI; it never crosses the public service. */
export async function writeRendererV8Profile(path: string, result: unknown): Promise<{ path: string; sha256: string; bytes: number }> {
  const body = rpcRecord(result, ['capture'], 'CONTROL_PROTOCOL_ERROR')
  const capture = parseRendererV8ProfileResult(body.capture)
  if (capture.profile === null) throw new AgentMuxError('This capture returned no profile. It was not rerun and no file was written.', 'CONTROL_UNAVAILABLE')
  const text = rendererV8ProfileJSON(capture.profile)
  const sha256 = createHash('sha256').update(text).digest('hex')
  if (sha256 !== capture.sha256) throw new AgentMuxError('The original profile checksum did not match. No file was written.', 'CONTROL_PROTOCOL_ERROR')
  const written = await writeNewCliFile(path, text)
  return { path: written.path, sha256, bytes: written.bytes }
}
