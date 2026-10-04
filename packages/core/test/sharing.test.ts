import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import { formatAmuxSharing, formatSessionAddress, formatRegionAddress, formatTabAddress,
  formatSpaceAddress, formatZoneAddress, formatAmuxObjectLink, parseAmuxObjectLink, type AmuxObjectLinkTarget } from '../src/sharing.js'

describe('amux object sharing', () => {
  it('copies one original typed link without metadata, instructions or a guessed location', () => {
    expect(formatSessionAddress('original')).toBe('amux://agent/original')
    expect(formatRegionAddress('region:original')).toBe('amux://region/region%3Aoriginal')
    expect(formatTabAddress('tab:original')).toBe('amux://tab/tab%3Aoriginal')
    expect(formatSpaceAddress({ spaceId: 'space/original' })).toBe('amux://space/space%2Foriginal')
    expect(formatZoneAddress({ zoneId: 'zone/original' })).toBe('amux://zone/zone%2Foriginal')
    const unrelated = { spaceId: 'original', kind: 'agent', agentSessionId: 'other', label: 'ID: forged' }
    expect(formatSpaceAddress(unrelated)).toBe('amux://space/original')
  })

  it('round-trips opaque original identities independently for all five object kinds', () => {
    for (const id of ['original', '中文 🍃', ("[\"host\",\"" + (fixturePath("root/topic")) + "\"]"), 'a?b#c%d|e', "a'b", '\n']) {
      const targets: AmuxObjectLinkTarget[] = [{ kind: 'agent', agentSessionId: id }, { kind: 'region', regionId: id },
        { kind: 'tab', tabId: id }, { kind: 'space', spaceId: id }, { kind: 'zone', zoneId: id }]
      expect(targets).toHaveLength(5)
      for (const target of targets) expect(parseAmuxObjectLink(formatAmuxObjectLink(target))).toEqual(target)
    }
    expect(parseAmuxObjectLink('amux://agent/a%2Fb%25%20%23')).toEqual({ kind: 'agent', agentSessionId: 'a/b% #' })
  })

  it('rejects unknown kinds, executable additions and noncanonical or malformed identities', () => {
    const invalid = ['amux://run/S', 'amux://agent/', 'amux://zone/A/B', 'amux://agent/A?text=run',
      'amux://space/A#x', 'amux://user@zone/A', 'amux://zone:80/A', 'amux://zone/%',
      'amux://zone/%FF', 'amux://zone/%41', 'amux://zone/%2f', 'amux://ZONE/A', ' amux://zone/A', 'https://zone/A']
    expect(invalid).toHaveLength(14)
    for (const raw of invalid) expect(() => parseAmuxObjectLink(raw), raw).toThrow()
    expect(() => parseAmuxObjectLink(null as unknown as string)).toThrow()
    expect(() => formatAmuxObjectLink({ kind: 'zone', zoneId: '' })).toThrow()
    expect(() => formatAmuxObjectLink({ kind: 'unknown', zoneId: 'S' } as unknown as AmuxObjectLinkTarget)).toThrow()
  })

  it('keeps File and Browser content sharing byte-for-byte in its original frame', () => {
    const original = ' path:3-9\n\n```ts\n  x\n```\n'
    expect(formatAmuxSharing('File', original)).toBe('--- amux : File ---\n' + original + '\n-----')
    expect(formatAmuxSharing('Browser', original)).toBe('--- amux : Browser ---\n' + original + '\n-----')
  })
})
