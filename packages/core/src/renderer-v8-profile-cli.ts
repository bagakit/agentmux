import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseRendererV8ProfileResult } from './renderer-v8-profile.js'
import { writeV8ProfileFile } from './v8-profile-cli.js'

/** The output path is local to this CLI; it never crosses the public service. */
export async function writeRendererV8Profile(path: string, result: unknown): Promise<{ path: string; sha256: string; bytes: number }> {
  const body = rpcRecord(result, ['capture'], 'CONTROL_PROTOCOL_ERROR')
  const capture = parseRendererV8ProfileResult(body.capture)
  if (capture.profile === null) throw new AgentMuxError('This capture returned no profile. It was not rerun and no file was written.', 'CONTROL_UNAVAILABLE')
  return await writeV8ProfileFile(path, capture.profile, capture.sha256)
}
