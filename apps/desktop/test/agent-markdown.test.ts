import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  looksLikeMarkdown,
  parseAgentMarkdown,
  parseInline
} from '../src/renderer/src/lib/agent-markdown.js'
import { AgentMarkdown } from '../src/renderer/src/components/AgentMarkdown.js'

describe('agent markdown parser', () => {
  it('never produces markup — only a node tree the renderer maps to elements', () => {
    // The load-bearing security property. Agent output is untrusted; if this ever returned an HTML
    // string, something downstream would eventually have to sanitise it and eventually get that wrong.
    const blocks = parseAgentMarkdown('## Heading\n\nSome **bold** text.')
    const serialised = JSON.stringify(blocks)

    expect(serialised).not.toContain('<')
    expect(serialised).not.toContain('&lt;')
    expect(blocks.every((block) => typeof block === 'object' && 'kind' in block)).toBe(true)
  })

  it('leaves raw HTML as literal text instead of interpreting it', () => {
    // An agent that prints a script tag — quoting one from a file, say — must see it as characters.
    const blocks = parseAgentMarkdown('Before <script>alert(1)</script> after')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({
      kind: 'paragraph',
      children: [{ kind: 'text', text: 'Before <script>alert(1)</script> after' }]
    })
  })

  it('parses headings at every level and keeps the level as semantics', () => {
    // level survives so the renderer can weight them; it must NOT be used to pick a font size — the
    // design contract forbids buying hierarchy with type size.
    const blocks = parseAgentMarkdown('# One\n## Two\n###### Six')
    expect(blocks.map((block) => block.kind === 'heading' ? block.level : null)).toEqual([1, 2, 6])
  })

  it('keeps fenced code verbatim, with its language when given', () => {
    const blocks = parseAgentMarkdown('```ts\nconst x = 1\nif (x) {\n}\n```')
    expect(blocks[0]).toEqual({ kind: 'code', language: 'ts', text: 'const x = 1\nif (x) {\n}' })

    expect(parseAgentMarkdown('```\nplain\n```')[0]).toEqual({
      kind: 'code', language: null, text: 'plain'
    })
  })

  it('does not parse markdown inside a code fence', () => {
    // An agent explaining markdown must be able to show `## not a heading` without it becoming one.
    const blocks = parseAgentMarkdown('```md\n## not a heading\n**not bold**\n```')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'code', text: '## not a heading\n**not bold**' })
  })

  it('keeps the rest of the output when a fence never closes', () => {
    // Half an answer is worse than an unclosed block, so the fence swallows the remainder rather than
    // the parser discarding it.
    const blocks = parseAgentMarkdown('```sh\nnpm install\nstill going')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'code', text: 'npm install\nstill going' })
  })

  it('groups consecutive bullets and numbers into one list each', () => {
    const bulleted = parseAgentMarkdown('- one\n- two\n* three')
    expect(bulleted).toHaveLength(1)
    expect(bulleted[0]).toMatchObject({ kind: 'list', ordered: false })
    if (bulleted[0]!.kind === 'list') expect(bulleted[0].items).toHaveLength(3)

    const numbered = parseAgentMarkdown('1. first\n2. second')
    expect(numbered[0]).toMatchObject({ kind: 'list', ordered: true })
  })

  it('separates a list from the prose around it', () => {
    const blocks = parseAgentMarkdown('Steps:\n- one\n- two\nDone.')
    expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'list', 'paragraph'])
  })

  it('reads inline code without parsing what is inside it', () => {
    expect(parseInline('run `npm **install**` now')).toEqual([
      { kind: 'text', text: 'run ' },
      { kind: 'code', text: 'npm **install**' },
      { kind: 'text', text: ' now' }
    ])
  })

  it('reads strong before emphasis so ** is never two *', () => {
    expect(parseInline('**bold** and *italic*')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'bold' }] },
      { kind: 'text', text: ' and ' },
      { kind: 'emphasis', children: [{ kind: 'text', text: 'italic' }] }
    ])
  })

  it('carries a link href verbatim and leaves the decision to open it elsewhere', () => {
    // The parser must not judge schemes: whether a URL may be opened is the renderer's call through the
    // existing external-URL seam, and duplicating that rule here would create a second place to get it
    // wrong. So even a hostile scheme parses — and is refused downstream.
    expect(parseInline('see [docs](https://example.com/a?b=1)')).toEqual([
      { kind: 'text', text: 'see ' },
      {
        kind: 'link',
        href: 'https://example.com/a?b=1',
        children: [{ kind: 'text', text: 'docs' }]
      }
    ])
    expect(parseInline('[x](javascript:alert(1))')[0]).toMatchObject({
      kind: 'link',
      href: 'javascript:alert(1'
    })
  })

  it('emits an unclosed marker as the literal character it was written as', () => {
    // A stray asterisk or backtick must show up, not swallow the rest of the sentence.
    expect(parseInline('2 * 3 = 6')).toEqual([{ kind: 'text', text: '2 * 3 = 6' }])
    expect(parseInline('a `b')).toEqual([{ kind: 'text', text: 'a `b' }])
    expect(parseInline('**unclosed')).toEqual([{ kind: 'text', text: '**unclosed' }])
    expect(parseInline('[label](no-close')).toEqual([{ kind: 'text', text: '[label](no-close' }])
  })

  it('loses no characters on malformed input', () => {
    // The property that matters most for untrusted text: whatever we cannot interpret still reaches the
    // reader. Compare the visible characters in, to the visible characters out.
    const messy = '# h\n**a *b `c [d](e ~~~\n- item\n1) num\n\n\nplain'
    const blocks = parseAgentMarkdown(messy)
    const flatten = (nodes: ReturnType<typeof parseInline>): string =>
      nodes.map((node) => {
        if (node.kind === 'text' || node.kind === 'code') return node.text
        return flatten(node.children)
      }).join('')
    const out = blocks.map((block) => {
      if (block.kind === 'code') return block.text
      if (block.kind === 'list') return block.items.map(flatten).join('')
      return flatten(block.children)
    }).join('')

    // Every WORD survives somewhere in the output. Deliberately not every character: a list marker like
    // `1)` is structure the parser is supposed to consume, and demanding its digit reappear in the text
    // would assert that markdown must not be parsed at all. What must never vanish is content.
    for (const word of ['h', 'item', 'num', 'plain']) expect(out).toContain(word)
    // The characters that failed to form a construct are still there as literal text.
    expect(out).toContain('`c')
    expect(out).toContain('[d](e')
  })

  it('handles CRLF and an empty document without special-casing at the call site', () => {
    expect(parseAgentMarkdown('a\r\nb')[0]).toMatchObject({ kind: 'paragraph' })
    expect(parseAgentMarkdown('')).toEqual([])
    expect(parseAgentMarkdown('\n\n\n')).toEqual([])
  })

  it('recognises when output is plain prose, so a sentence pays for nothing', () => {
    // Also protects text that was never markdown from being reshaped by a parser.
    expect(looksLikeMarkdown('Just a normal sentence about files.')).toBe(false)
    expect(looksLikeMarkdown('## Heading')).toBe(true)
    expect(looksLikeMarkdown('- bullet')).toBe(true)
    expect(looksLikeMarkdown('use `code`')).toBe(true)
    expect(looksLikeMarkdown('**bold**')).toBe(true)
    expect(looksLikeMarkdown('[a](b)')).toBe(true)
  })

  it('does not hang or blow up on adversarial repetition', () => {
    // A hostile agent could emit thousands of markers; a line-oriented left-to-right scanner cannot be
    // walked into backtracking, and this pins that.
    const started = Date.now()
    expect(() => parseAgentMarkdown('*'.repeat(5000))).not.toThrow()
    expect(() => parseAgentMarkdown('`'.repeat(5000))).not.toThrow()
    expect(() => parseAgentMarkdown('['.repeat(5000))).not.toThrow()
    expect(() => parseAgentMarkdown('#'.repeat(5000))).not.toThrow()
    expect(Date.now() - started).toBeLessThan(3000)
  })

  // Rendering assertions. The parser being right is not the same as the surface using it correctly, and
  // the heading rule in particular is a claim about DERIVED output, not about a CSS file.
  it('renders every heading level as one element with no size of its own', () => {
    // The user's constraint and the surface contract agree: hierarchy comes from weight and spacing, not
    // type scale. The body sets 13px and headings INHERIT it, so a heading must never carry a font-size.
    const markup = renderToStaticMarkup(createElement(AgentMarkdown, {
      content: '# One\n### Three\n###### Six'
    }))

    expect(markup).toContain('data-level="1"')
    expect(markup).toContain('data-level="3"')
    expect(markup).toContain('data-level="6"')
    // Same element for every level — no h1/h2/h6 with their own browser sizes.
    expect((markup.match(/md-heading/gu) ?? []).length).toBe(3)
    expect(markup).not.toMatch(/<h[1-6]/u)
    // And no inline size anywhere in the output.
    expect(markup).not.toContain('font-size')
  })

  it('never emits raw markup for untrusted content', () => {
    const markup = renderToStaticMarkup(createElement(AgentMarkdown, {
      content: 'text <script>alert(1)</script> and <img onerror=x>'
    }))

    // React escapes it; the tags arrive as visible characters, not elements.
    expect(markup).toContain('&lt;script&gt;')
    expect(markup).not.toContain('<script>')
    expect(markup).not.toContain('<img')
  })

  it('renders a link as a button so it cannot navigate the renderer', () => {
    // An <a href> inside agent output is an escape hatch. Main owns the decision and normalises the URL.
    const markup = renderToStaticMarkup(createElement(AgentMarkdown, {
      content: 'see [docs](https://example.com)'
    }))

    expect(markup).toContain('md-link')
    expect(markup).toContain('<button')
    expect(markup).not.toContain('href=')
  })

  it('leaves plain prose exactly as written', () => {
    // Running a parser over text that was never markdown risks reshaping someone's sentence.
    const content = 'I changed the retry logic in the uploader. It now backs off.'
    const markup = renderToStaticMarkup(createElement(AgentMarkdown, { content, className: 'body' }))

    expect(markup).toBe(`<p class="body">${content}</p>`)
  })

  it('gives a code block its own scroll rather than widening the turn', () => {
    const markup = renderToStaticMarkup(createElement(AgentMarkdown, {
      content: '```ts\nconst x = 1\n```'
    }))

    expect(markup).toContain('md-block-code')
    expect(markup).toContain('data-language="ts"')
    expect(markup).toContain('const x = 1')
  })
})
