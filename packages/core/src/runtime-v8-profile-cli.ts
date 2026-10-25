import { AgentMuxError } from './errors.js'
import { parseRuntimeV8ProfileInput, parseRuntimeV8ProfileResult } from './runtime-v8-profile.js'
import { writeV8ProfileFile } from './v8-profile-cli.js'

export async function writeRuntimeV8Profile(path: string, result: unknown, input: unknown): Promise<{ path: string; bytes: number; sha256: string }> {
  const capture = parseRuntimeV8ProfileResult(result, parseRuntimeV8ProfileInput(input, true))
  if (!capture.profile) throw new AgentMuxError('The capture returned no profile. No file was written or capture retried.', 'CONTROL_UNAVAILABLE')
  return await writeV8ProfileFile(path, capture.profile, capture.profileSha256)
}
