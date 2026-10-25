import { describe, expect, it, vi } from 'vitest'
import { MAX_STORED_TEXT_BYTES, normalizePromptInputIntent } from '../src/prompt-submission-record.js'

const intent = (prompt: string) => ({ run: { runId: 'original-run' }, ownerInstanceId: 'original-owner', prompt,
  plan: { kind: 'single-phase', data: prompt } })
const utf8 = (value: string) => new TextEncoder().encode(value).length

describe('stored prompt bodies keep their exact UTF-8 byte limit', () => {
  it('accepts a body of exactly the limit and refuses one byte more, for 1-, 2-, 3- and 4-byte characters', () => {
    for (const unit of ['a', 'é', '中', '😀']) {
      const width = utf8(unit), fill = 'a'.repeat(MAX_STORED_TEXT_BYTES % width)
      const exact = fill + unit.repeat(Math.floor(MAX_STORED_TEXT_BYTES / width))
      expect(utf8(exact)).toBe(MAX_STORED_TEXT_BYTES)
      expect(normalizePromptInputIntent(intent(exact)).prompt).toBe(exact)
      expect(() => normalizePromptInputIntent(intent(exact + 'a'))).toThrow('Frozen prompt input is invalid.')
    }
  })

  it('counts a lone surrogate as the three replacement bytes the stored encoding writes', () => {
    const lone = '\ud800', exact = 'a'.repeat(MAX_STORED_TEXT_BYTES - 3) + lone
    expect(utf8(exact)).toBe(MAX_STORED_TEXT_BYTES)
    expect(normalizePromptInputIntent(intent(exact)).prompt).toBe(exact)
    expect(() => normalizePromptInputIntent(intent('a' + exact))).toThrow('Frozen prompt input is invalid.')
  })

  it('does not encode a stored body only to measure it', () => {
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    try {
      normalizePromptInputIntent(intent('中'.repeat(90_000)))
      expect(encode, 'normalizing a stored row must not copy each body into a new buffer').not.toHaveBeenCalled()
    } finally { encode.mockRestore() }
  })
})
