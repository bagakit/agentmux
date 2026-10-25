import { createHash } from 'node:crypto'
import { writeNewCliFile } from './cli-atomic-file.js'
import { AgentMuxError } from './errors.js'
import { v8ProfileJSON, type V8Profile } from './v8-profile.js'

/** Verify original profile bytes before publishing one new local file. */
export async function writeV8ProfileFile(path: string, profile: V8Profile, expectedSha256: string | null): Promise<{ path: string; sha256: string; bytes: number }> {
  const text = v8ProfileJSON(profile)
  const sha256 = createHash('sha256').update(text).digest('hex')
  if (sha256 !== expectedSha256) throw new AgentMuxError('The original profile checksum did not match. No file was written.', 'CONTROL_PROTOCOL_ERROR')
  const written = await writeNewCliFile(path, text)
  return { path: written.path, sha256, bytes: written.bytes }
}
