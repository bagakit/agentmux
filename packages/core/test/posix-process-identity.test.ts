const upstreamPosixStart = new Date(24 * 60 * 60 * 1_000)
const upstreamPosixParts = upstreamPosixStart.toUTCString().match(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/u)!
const upstreamPosixStartStamp = `${upstreamPosixParts[1]} ${upstreamPosixParts[3]} ${String(Number(upstreamPosixParts[2])).padStart(2, ' ')} ${upstreamPosixParts[5]} ${upstreamPosixParts[4]}`
import { describe, expect, it } from 'vitest'
import { parsePosixProcessIdentity } from '../src/posix-process-identity.js'

describe('POSIX process identity', () => {
  it('records a runnable process but treats a Zombie as no longer controllable', () => {
    expect(parsePosixProcessIdentity(
      ("  42 Ss+  " + upstreamPosixStartStamp + "\n"),
      42
    )).toEqual({ pid: 42, startedAtMs: Date.parse((upstreamPosixStartStamp + " UTC")) })
    expect(parsePosixProcessIdentity(
      ("  42 Zs   " + upstreamPosixStartStamp + "\n"),
      42
    )).toBeNull()
  })

  it('rejects a row for another pid or an invalid start time', () => {
    expect(parsePosixProcessIdentity(("  41 S " + upstreamPosixStartStamp + "\n"), 42)).toBeNull()
    expect(parsePosixProcessIdentity('  42 S not-a-date\n', 42)).toBeNull()
  })
})
