import { describe, expect, it } from 'vitest'
import { parsePosixProcessIdentity } from '../src/posix-process-identity.js'

describe('POSIX process identity', () => {
  it('records a runnable process but treats a Zombie as no longer controllable', () => {
    expect(parsePosixProcessIdentity(
      '  42 Ss+  Mon Aug 10 18:46:09 2026\n',
      42
    )).toEqual({ pid: 42, startedAtMs: Date.parse('Mon Aug 10 18:46:09 2026 UTC') })
    expect(parsePosixProcessIdentity(
      '  42 Zs   Mon Aug 10 18:46:09 2026\n',
      42
    )).toBeNull()
  })

  it('rejects a row for another pid or an invalid start time', () => {
    expect(parsePosixProcessIdentity('  41 S Mon Aug 10 18:46:09 2026\n', 42)).toBeNull()
    expect(parsePosixProcessIdentity('  42 S not-a-date\n', 42)).toBeNull()
  })
})
