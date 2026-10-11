import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'

/** Only PATH affects this executable check. Keep its value out of public detection receipts. */
export function executorEnvironmentRevision(env?: Readonly<Record<string, string>>): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(env?.PATH ?? null))))
}
