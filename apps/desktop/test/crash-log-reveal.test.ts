import { describe, expect, it } from 'vitest'
import { crashLogRevealNotice } from '../src/renderer/src/lib/crash-log-reveal.js'

describe('crash log notices follow the exact diagnostic receipt', () => {
  it('reports no fact before an explicit request', () => {
    expect(crashLogRevealNotice(null)).toBeNull()
  })
  it('does not infer health from absence or visible Finder from a request', () => {
    expect(crashLogRevealNotice({ path: '/owned/log', outcome: 'absent' })).toBe('No crash log file exists at this path.')
    expect(crashLogRevealNotice({ path: '/owned/log', outcome: 'requested' })).toBe('Requested in your file manager.')
  })
  it('retains the original cause instead of a generic folder hint', () => {
    expect(crashLogRevealNotice({ path: '/owned/log', outcome: 'check-failed', cause: { code: 'EACCES', message: 'Original cause' } })).toBe('Could not request the log: EACCES · Original cause')
  })
})
