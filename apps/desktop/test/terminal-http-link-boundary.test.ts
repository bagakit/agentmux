import { describe, expect, it } from 'vitest'
import { terminalUriTokens } from '@agentmux/client-ui/terminal-path-link'
import { terminalHttpLinkText } from '../src/renderer/src/lib/terminal-http-link.js'

function match(text: string): { value: string; index: number } | null {
  const token = terminalUriTokens(text)[0]
  if (!token) return null
  const value = terminalHttpLinkText(token.text)
  return value ? { value, index: token.index } : null
}

describe('bare terminal HTTP link boundaries', () => {
  it('stops before adjacent CJK prose and punctuation', () => {
    const line = '产物见 https://example.test/docs?q=1#part中文。请查阅'
    expect(match(line)).toEqual({ value: 'https://example.test/docs?q=1#part', index: 4 })
  })

  it('stops before CJK punctuation even when there is no following Han character', () => {
    expect(match('打开 https://example.test/a，继续')).toEqual({
      value: 'https://example.test/a',
      index: 3
    })
    expect(match('打开 https://example.test/a：')).toEqual({
      value: 'https://example.test/a',
      index: 3
    })
  })

  it('keeps ASCII URL payload and percent-encoded Unicode intact', () => {
    expect(match('https://example.test/a%20b?q=%E4%B8%AD&x=1#part')).toEqual({
      value: 'https://example.test/a%20b?q=%E4%B8%AD&x=1#part',
      index: 0
    })
  })

  it('does not create a partial link from a literal CJK-only URL suffix', () => {
    expect(match('https://例子.测试/文档')).toBeNull()
  })
  it('keeps an IDN authority and mixed case scheme with an unambiguous path', () => {
    expect(match('说明见HtTpS://例子.test/demo。')).toEqual({
      value: 'HtTpS://例子.test/demo',
      index: 3
    })
  })

  it('excludes supplementary-plane Han prose and preserves balanced URL punctuation', () => {
    expect(match('(https://example.test/a(b)[c]𠮷。')).toMatchObject({ value: 'https://example.test/a(b)[c]' })
    expect(match('https://example.test/~')).toMatchObject({ value: 'https://example.test/~' })
  })

})
