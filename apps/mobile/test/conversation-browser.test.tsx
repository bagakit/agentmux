import { fixtureFileUrl } from '../../../test/fixture-values.mjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserPlatform, openBrowserHttpLink } from '../src/platform/browser'
import { deliveryOutcome } from '../src/conversation/delivery'

const originalCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')
afterEach(() => {
  vi.unstubAllGlobals()
  if (originalCommand) Object.defineProperty(document, 'execCommand', originalCommand)
  else Reflect.deleteProperty(document, 'execCommand')
  document.body.replaceChildren()
  document.getSelection()?.removeAllRanges()
})
const commandPort = (implementation: () => boolean) => {
  const command = vi.fn(implementation)
  Object.defineProperty(document, 'execCommand', { configurable: true, value: command })
  return command
}
const clipboardEvent = (setData = vi.fn()) => {
  const event = new Event('copy', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { setData } })
  document.activeElement!.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  return setData
}

describe('explicit mobile browser IO and delivery classification', () => {
  it('reports clipboard denial rather than claiming success and opens only web destinations', async () => {
    const denial = new Error('clipboard permission denied'), report = vi.fn()
    const write = vi.fn().mockRejectedValueOnce(denial).mockResolvedValueOnce(undefined)
    const platform = createBrowserPlatform({ clipboard: { writeText: write } })
    const command = commandPort(() => true)
    expect(await platform.copyText('原文', report)).toBe(false)
    expect(report).toHaveBeenCalledExactlyOnceWith(denial)
    expect(await platform.copyText('原文', report)).toBe(true)
    expect(write.mock.calls).toEqual([['原文'], ['原文']])
    expect(command).not.toHaveBeenCalled()
    expect(platform.overlayContainer()).toBe(document.body)
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    openBrowserHttpLink('https://example.test/docs')
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.test/docs', '_blank', 'noopener,noreferrer')
    expect(() => openBrowserHttpLink(fixtureFileUrl('private'))).toThrow('不是网页地址')
    expect(() => openBrowserHttpLink('javascript:alert(1)')).toThrow('不是网页地址')
    expect(open).toHaveBeenCalledOnce()
  })
  it('copies original CRLF and Unicode synchronously without changing the original input or selection', async () => {
    vi.stubGlobal('navigator', { clipboard: undefined })
    const original = document.createElement('textarea'); original.value = '原始草稿'; document.body.append(original)
    original.focus(); original.setSelectionRange(1, 3, 'backward')
    const setData = vi.fn(), text = ' 原始\r\n正文\t🦊\n末行 ', report = vi.fn()
    let temporary: HTMLTextAreaElement | null = null
    const command = commandPort(() => {
      temporary = document.activeElement as HTMLTextAreaElement
      expect(temporary).not.toBe(original)
      expect(temporary.readOnly).toBe(true); expect(temporary.inputMode).toBe('none')
      expect([temporary.selectionStart, temporary.selectionEnd]).toEqual([0, temporary.value.length])
      // Model the browser's textarea newline normalization, absent from this DOM fixture.
      temporary.value = temporary.value.replace(/\r\n?/g, '\n')
      original.setSelectionRange(0, 0)
      clipboardEvent(setData); return true
    })
    const result = createBrowserPlatform().copyText(text, report)
    expect(command).toHaveBeenCalledExactlyOnceWith('copy')
    expect(setData).toHaveBeenCalledExactlyOnceWith('text/plain', text)
    expect(await result).toBe(true); expect(report).not.toHaveBeenCalled()
    expect(document.querySelectorAll('textarea')).toHaveLength(1)
    expect(document.activeElement).toBe(original); expect(original.value).toBe('原始草稿')
    expect([original.selectionStart, original.selectionEnd, original.selectionDirection]).toEqual([1, 3, 'backward'])
    const later = new Event('copy', { cancelable: true }); temporary!.dispatchEvent(later)
    expect(later.defaultPrevented).toBe(false)
  })
  it.each(['false', 'throw', 'no-event', 'data-error', 'data-absent', 'absent'] as const)('reports the native %s failure and restores the original DOM selection', async reason => {
    vi.stubGlobal('navigator', { clipboard: undefined })
    const original = document.createElement('div'); original.tabIndex = 0; original.textContent = '原文与选区'; document.body.append(original); original.focus()
    const range = document.createRange(); range.setStart(original.firstChild!, 1); range.setEnd(original.firstChild!, 4)
    document.getSelection()!.addRange(range)
    const report = vi.fn(), denial = new Error('native copy denied')
    commandPort(() => {
      document.getSelection()!.removeAllRanges()
      if (reason === 'throw') throw denial
      if (reason === 'no-event') return true
      if (reason === 'data-absent') { document.activeElement!.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true })); return true }
      clipboardEvent(vi.fn(() => { if (reason === 'data-error') throw denial }))
      return reason !== 'false'
    })
    if (reason === 'absent') Reflect.deleteProperty(document, 'execCommand')
    expect(await createBrowserPlatform().copyText('不能伪报成功', report)).toBe(false)
    expect(report).toHaveBeenCalledOnce()
    if (reason === 'throw' || reason === 'data-error') expect(report).toHaveBeenCalledWith(denial)
    expect(document.querySelector('textarea')).toBeNull(); expect(document.activeElement).toBe(original)
    expect(document.getSelection()!.toString()).toBe('文与选')
    expect(document.body.textContent).toBe('原文与选区')
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
