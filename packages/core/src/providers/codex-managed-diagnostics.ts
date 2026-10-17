import { Transform } from 'node:stream'

const replacement = Buffer.from('[redacted]')
const credentialBytes = (credentials: readonly string[]): Buffer[] => [...new Set(credentials.filter(Boolean))]
  .sort((a, b) => Buffer.byteLength(b) - Buffer.byteLength(a)).map(value => Buffer.from(value))

/** Mask exact known credentials without decoding, truncating or retaining the diagnostic stream. */
export function codexDiagnosticStream(credentials: readonly string[]): Transform {
  const secrets = credentialBytes(credentials), retained = Math.max(0, ...secrets.map(value => value.length - 1))
  let pending = Buffer.alloc(0)
  const emit = (stream: Transform, final: boolean): void => {
    const limit = final ? pending.length : Math.max(0, pending.length - retained)
    let offset = 0
    while (offset < limit) {
      let index = pending.length, length = 0
      for (const secret of secrets) {
        const found = pending.indexOf(secret, offset)
        if (found >= 0 && found < index) { index = found; length = secret.length }
      }
      if (index >= limit) { stream.push(pending.subarray(offset, limit)); offset = limit; break }
      if (index > offset) stream.push(pending.subarray(offset, index))
      stream.push(replacement); offset = index + length
    }
    pending = Buffer.from(pending.subarray(offset))
  }
  return new Transform({
    transform(bytes: Buffer, _encoding, done) { pending = Buffer.concat([pending, bytes]); emit(this, false); done() },
    flush(done) { emit(this, true); done() }
  })
}

/** This text explains failures; it is never an input, readiness or recovery decision. */
export function formatCodexManagedDiagnostic(error: unknown, credentials: readonly string[]): string {
  const lines: string[] = [], seen = new Set<unknown>()
  for (let current = error; current !== undefined && !seen.has(current);) {
    seen.add(current)
    const value = current !== null && typeof current === 'object' ? current as Record<string, unknown> : undefined
    const name = typeof value?.name === 'string' ? value.name : 'Error'
    const code = typeof value?.code === 'string' || typeof value?.code === 'number' ? ` [code=${value.code}]` : ''
    const message = typeof value?.message === 'string' ? value.message : String(current)
    lines.push(`${lines.length ? 'Caused by: ' : ''}${name}${code}: ${message}`)
    current = value?.cause
  }
  let text = lines.join('\n')
  for (const secret of credentialBytes(credentials)) text = text.split(secret.toString()).join(replacement.toString())
  return text
}
