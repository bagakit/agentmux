import { describe, expect, it } from 'vitest'
import { TERMINAL_HTTP_URL_REGEX } from '../src/renderer/src/lib/terminal-http-link.js'

function match(text: string): { value: string; index: number } | null {
  const result = text.match(TERMINAL_HTTP_URL_REGEX)
  return result?.[0] === undefined || result.index === undefined
    ? null
    : { value: result[0], index: result.index }
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
})
