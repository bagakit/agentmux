import { open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { AgentMuxError } from './errors.js'
import { V8_PROFILE_MAX_BYTES } from './v8-profile.js'
import { analyseV8Profile, parseV8ProfileBytes, summariseV8Profile } from './v8-profile-analysis.js'

/** Explicit local artifact processing. No endpoint, capture or service state is consulted. */
export async function analyseLocalV8Profile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
    throw new AgentMuxError('The explicitly selected local profile could not be opened.', 'PROFILE_INPUT_UNAVAILABLE')
  })
  let bytes: Buffer
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > V8_PROFILE_MAX_BYTES)
      throw new AgentMuxError('Select a regular cpuprofile within the original 8 MiB profile budget.', 'INVALID_CLI_ARGUMENT')
    const buffer = Buffer.alloc(V8_PROFILE_MAX_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, null)
      if (read.bytesRead === 0) break
      length += read.bytesRead
    }
    if (length > V8_PROFILE_MAX_BYTES)
      throw new AgentMuxError('The selected profile grew beyond its original 8 MiB budget.', 'INVALID_CLI_ARGUMENT')
    bytes = buffer.subarray(0, length)
  } finally { await file.close() }
  const analysis = analyseV8Profile(parseV8ProfileBytes(bytes))
  const source = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
    captureIdentity: 'unavailable-in-bare-profile' as const }
  return summariseV8Profile(analysis, source)
}
