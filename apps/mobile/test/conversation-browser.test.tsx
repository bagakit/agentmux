import { fixtureFileUrl } from '../../../test/fixture-values.mjs'
import { describe, expect, it, vi } from 'vitest'
import { createBrowserPlatform, openBrowserHttpLink } from '../src/platform/browser'
import { deliveryOutcome } from '../src/conversation/delivery'

describe('explicit mobile browser IO and delivery classification', () => {
  it('reports clipboard denial rather than claiming success and opens only web destinations', async () => {
    const denial = new Error('clipboard permission denied'), report = vi.fn()
    const write = vi.fn().mockRejectedValueOnce(denial).mockResolvedValueOnce(undefined)
    const platform = createBrowserPlatform({ clipboard: { writeText: write } })
    expect(await platform.copyText('原文', report)).toBe(false)
    expect(report).toHaveBeenCalledExactlyOnceWith(denial)
    expect(await platform.copyText('原文', report)).toBe(true)
    expect(write.mock.calls).toEqual([['原文'], ['原文']])
    expect(platform.overlayContainer()).toBe(document.body)
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    openBrowserHttpLink('https://example.test/docs')
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.test/docs', '_blank', 'noopener,noreferrer')
    expect(() => openBrowserHttpLink(fixtureFileUrl('private'))).toThrow('不是网页地址')
    expect(() => openBrowserHttpLink('javascript:alert(1)')).toThrow('不是网页地址')
    expect(open).toHaveBeenCalledOnce()
  })
  it('requires an authoritative nonapplication fact; a stale post-admission error remains unknown', () => {
    expect(deliveryOutcome({ code: 'AGENT_PROMPT_INPUT_NOT_APPLIED', detail: 'not_applied' }, 'prompt')).toBe('unknown')
    expect(deliveryOutcome({ code: 'AGENT_INTERACTION_PENDING' }, 'prompt')).toBe('unknown')
    expect(deliveryOutcome({ code: 'AGENT_PROMPT_SUBMISSION_STATE_INVALID' }, 'prompt')).toBe('unknown')
    expect(deliveryOutcome({ code: 'AGENT_PROMPT_SUBMISSION_RECEIPT_MISMATCH' }, 'prompt')).toBe('unknown')
    expect(deliveryOutcome({ code: 'INVALID_AGENT_PROMPT' }, 'prompt')).toBe('rejected')
    expect(deliveryOutcome({ code: 'INVALID_AGENT_INTERACTION_RESPONSE' }, 'interaction')).toBe('rejected')
    expect(deliveryOutcome({ code: 'CTXMUX_input_cursor_mismatch', detail: 'not_applied' }, 'prompt')).toBe('unknown')
    expect(deliveryOutcome({ code: 'CTXMUX_input_cursor_mismatch', detail: 'not_applied' }, 'interaction')).toBe('rejected')
    expect(deliveryOutcome({ code: 'STALE_AGENT_SESSION' }, 'prompt')).toBe('unknown')
    expect(deliveryOutcome({ code: 'INVALID_AGENT_PROMPT', detail: 'unknown' }, 'prompt')).toBe('unknown')
    expect(deliveryOutcome(new Error('socket closed'), 'prompt')).toBe('unknown')
  })
})
