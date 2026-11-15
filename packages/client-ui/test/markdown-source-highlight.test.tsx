import { afterEach, describe, expect, it, vi } from 'vitest'
import * as grammar from '../src/lib/markdown-source.js'
import { getMarkdownSourceHighlights } from '../src/lib/markdown-source-highlight.js'

afterEach(() => vi.restoreAllMocks())

function highlighted(source: string) {
  let cursor = 0
  return getMarkdownSourceHighlights(source).map(({ start, end, kind }) => {
    expect(start).toBeGreaterThanOrEqual(cursor)
    expect(end).toBeGreaterThan(start)
    expect(end).toBeLessThanOrEqual(source.length)
    cursor = end
    return [kind, source.slice(start, end)]
  })
}

describe('Markdown source highlight ranges', () => {
  it('uses exact UTF-16 source offsets through BOM, CRLF, indentation and Unicode', () => {
    const source = '\uFEFF## 标题 😀\r\n\r\n  007. [x] **强调**\r\n\r\n  > [链](./x.md)\r\n\r\n```ts\r\nconst exact = "<tag>"\r\n```\r\n'
    expect(highlighted(source)).toEqual([
      ['heading', '## 标题 😀'],
      ['list-marker', '007.'],
      ['emphasis', '**强调**'],
      ['quote-marker', '>'],
      ['link', '[链](./x.md)'],
      ['code', '```ts\r\nconst exact = "<tag>"\r\n```']
    ])
  })

  it('keeps nested ranges in source order and uses the innermost construct at each offset', () => {
    const source = '## **正文 `code`** [**链接**](./x.md)\n\n~~删除~~ 和 $x_i$ 与 &amp; https://example.test'
    expect(highlighted(source)).toEqual([
      ['heading', '## '],
      ['emphasis', '**正文 '],
      ['code', '`code`'],
      ['emphasis', '**'],
      ['heading', ' '],
      ['link', '['],
      ['emphasis', '**链接**'],
      ['link', '](./x.md)'],
      ['emphasis', '~~删除~~'],
      ['link', 'https://example.test']
    ])
  })

  it('leaves escapes, raw HTML and unfinished inline syntax as plain source', () => {
    const source = '\\*literal\\* : `unfinished\n\n<div><img src="somewhere"/></div>\n\n[actual][ref]\n\n[ref]: ./file.md'
    expect(highlighted(source)).toEqual([['link', '[actual][ref]']])
  })

  it('bounds synchronous grammar work for long drafts and extremely dense container markers', () => {
    const parse = vi.spyOn(grammar, 'parseMarkdownSource')
    expect(highlighted('# Heading')).toEqual([['heading', '# Heading']])
    expect(parse).toHaveBeenCalledTimes(1)
    expect(highlighted('# Heading\n' + 'a'.repeat(8192))).toEqual([])
    expect(highlighted('- '.repeat(1024) + 'last')).toEqual([])
    expect(highlighted('>'.repeat(1024) + ' last')).toEqual([])
    expect(parse).toHaveBeenCalledTimes(1)
  })

  it('bounds repeated nesting across normal-length lines and still colors ordinary long drafts', () => {
    const parse = vi.spyOn(grammar, 'parseMarkdownSource')
    const denseDraft = ('- '.repeat(32) + 'last\n').repeat(20)
    expect(highlighted(denseDraft)).toEqual([])
    expect(parse).not.toHaveBeenCalled()

    const ordinaryDraft = '# Review\n\n- Fix **this** issue and cite the `result`.\n'.repeat(72)
    expect(highlighted(ordinaryDraft)).toHaveLength(288)
    expect(parse).toHaveBeenCalledOnce()
  })

  it('drops only coloring when the shared grammar fails and permits the next source to be highlighted', () => {
    vi.spyOn(grammar, 'parseMarkdownSource').mockImplementationOnce(() => { throw new RangeError('parser stack') })
    expect(highlighted('# Heading')).toEqual([])
    expect(highlighted('# Revised')).toEqual([['heading', '# Revised']])
  })
})
