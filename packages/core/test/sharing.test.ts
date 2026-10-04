import { fixturePath } from './helpers/fixture-values.js'
import { describe, expect, it } from 'vitest'
import {
  formatAmuxSharing, formatSessionAddress, formatMessagingAddress,
  formatRegionAddress, formatTabAddress, formatSpaceAddress, formatZoneAddress,
  formatAmuxSpatialLink, parseAmuxSpatialLink, type AmuxSpatialLinkTarget
} from '../src/sharing.js'

describe('amux sharing', () => {
  it('keeps an Agent card short, typed and directly addressable', () => {
    expect(formatSessionAddress('h_tAP3RXjU95i0d7', {
      nativeSessionId: 'native-thread-42', provider: 'Codex', executor: 'codex-full-auto'
    })).toBe([
      '--- amux : IDCard ---',
      'ID: h_tAP3RXjU95i0d7',
      'Exe: native-thread-42 | codex-full-auto (Codex)',
      '# amux agent send --to-session=\'h_tAP3RXjU95i0d7\' --text "..."',
      '# amux --skill',
      '-----'
    ].join('\n'))
  })

  it('keeps missing metadata unknown while retaining the usable SID', () => {
    expect(formatSessionAddress('original')).toContain('Exe: ? | ? (?)')
    expect(formatSessionAddress('original')).toContain("--to-session='original'")
    expect(formatSessionAddress('original', { executor: 'saved-id' }))
      .toContain('Exe: ? | saved-id (?)')
  })

  it('does not let structurally compatible metadata replace the semantic target or invent a Region', () => {
    const metadata = { provider: 'Codex', executor: 'X', agentSessionId: 'other', regionId: 'invented' }
    const card = formatSessionAddress('original', metadata)
    expect(card).toContain('ID: original\nExe: ? | X (Codex)')
    expect(card).toContain("--to-session='original'")
    expect(card).not.toContain('other')
    expect(card).not.toContain('Region:')
  })

  it('keeps a clicked Region as context without rerouting the Agent', () => {
    const card = formatMessagingAddress({
      agentSessionId: 'original', regionId: 'clicked', provider: 'Claude', executor: 'reviewer'
    })
    expect(card.split('\n')).toContain('Region: clicked')
    expect(card).toContain("--to-session='original'")
    expect(card).not.toContain('--to-region')
    expect(card).not.toContain('space mv')
    expect(card).not.toContain('--zone')
    expect(formatMessagingAddress({ agentSessionId: 'original' })).toBe(formatSessionAddress('original'))
  })

  it('types spatial cards without promising a unique semantic recipient', () => {
    expect(formatRegionAddress('R')).toBe(
      "--- amux : Region ---\nID: R\n# amux space inspect --region='R'\n# amux --skill\n-----")
    expect(formatTabAddress('T')).toBe(
      "--- amux : Tab ---\nID: T\n# amux space inspect --tab='T'\n# amux --skill\n-----")
    expect(formatRegionAddress('R') + formatTabAddress('T')).not.toContain('agent send')
  })

  it('prevents display metadata from forging fields while preserving names', () => {
    const card = formatSessionAddress('S', { provider: 'Codex\nID: forged', executor: 'A | B\r\n-----' })
    expect(card.split('\n')).toHaveLength(6)
    expect(card.split('\n').filter(line => line.startsWith('ID:'))).toEqual(['ID: S'])
    expect(card).toContain('Exe: ? | A \\| B\\r\\n----- (Codex\\nID: forged)')
    expect(formatSessionAddress('S', { nativeSessionId: 'native\nID: forged | token' }))
      .toContain('Exe: native\\nID: forged \\| token | ? (?)')
    expect(formatSessionAddress('S', { provider: 'A\u2028B\u2029C\u007f' }))
      .toContain('Exe: ? | ? (A\\u2028B\\u2029C\\u007f)')
  })

  it('frames owner content without trimming or interpreting it', () => {
    const original = ' path:3-9\n\n\`\`\`ts\n  x\n\`\`\`\n'
    expect(formatAmuxSharing('File', original)).toBe(
      '--- amux : File ---\n' + original + '\n-----')
  })

  it('shares original parent Space and Zone identities without a child or a stale parent hint', () => {
    const spaceId = JSON.stringify(['local', fixturePath("Topics/工作")]), zoneId = '["topic", "one/two%"]'
    const card = formatSpaceAddress({ spaceId, label: 'Work\nID: fake' })
    expect(card.split('\n')).toEqual(['--- amux : Space ---', `ID: ${spaceId}`, 'Name: Work\\nID: fake',
      `Link: ${formatAmuxSpatialLink({ kind: 'space', spaceId })}`, `# amux space inspect --space='${spaceId}'`, '# amux --skill', '-----'])
    const zone = formatZoneAddress({ zoneId })
    expect(zone).toContain(`Link: ${formatAmuxSpatialLink({ kind: 'zone', zoneId })}`)
    expect(zone).not.toContain('--space='); expect(zone).not.toContain('Name:')
    expect(formatZoneAddress({ zoneId: "a'b" })).toContain("--zone='a'\"'\"'b'")
  })

  it('round-trips opaque identities through the strict public URI owner', () => {
    for (const id of ['original', '中文 🍃', ("[\"host\",\"" + (fixturePath("root/topic")) + "\"]"), 'a?b#c%d|e', "a'b", '\n']) {
      for (const target of [{ kind: 'space', spaceId: id }, { kind: 'zone', zoneId: id }] as AmuxSpatialLinkTarget[]) {
        expect(parseAmuxSpatialLink(formatAmuxSpatialLink(target))).toEqual(target)
      }
    }
  })

  it('rejects unsupported targets, hidden actions, malformed encoding and guessed identities', () => {
    for (const raw of ['amux://agent/S', 'amux://zone/', 'amux://zone/A/B', 'amux://zone/A?space=B',
      'amux://space/A#x', 'amux://user@zone/A', 'amux://zone:80/A', 'amux://zone/%',
      'amux://zone/%FF', 'amux://zone/%41', 'amux://zone/%2f', 'amux://ZONE/A', ' amux://zone/A', 'https://zone/A']) {
      expect(() => parseAmuxSpatialLink(raw), raw).toThrow()
    }
    expect(() => parseAmuxSpatialLink(null as unknown as string)).toThrow()
    expect(() => formatAmuxSpatialLink({ kind: 'zone', zoneId: '' })).toThrow()
    expect(() => formatAmuxSpatialLink({ kind: 'agent', zoneId: 'S' } as unknown as AmuxSpatialLinkTarget)).toThrow()
  })
})
