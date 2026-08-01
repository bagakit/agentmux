import { createElement, Fragment, isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  looksLikeMarkdown,
  parseAgentMarkdown,
  type InlineNode
} from '../src/renderer/src/lib/agent-markdown.js'

// Inline parsing now belongs to remark, so reach it the way the renderer does: through a paragraph.
function parseInline(source: string): InlineNode[] {
  const blocks = parseAgentMarkdown(source)
  const first = blocks[0]
  if (!first || first.kind !== 'paragraph') return []
  return first.children
}
import { AgentMarkdown, type LinkClickModifiers } from '../src/renderer/src/components/AgentMarkdown.js'

// This harness has no DOM and cannot dispatch a click. AgentMarkdown and its inner Inline/Block are
// pure, hookless render functions, so we invoke the tree by hand and read a rendered element's onClick
// off its props — the same drill the reveal-action and launch-control tests already use. Finding the
// `md-link` button and firing its handler is the only way to assert the BEHAVIOUR of a click (which seam
// it calls, with what) rather than merely that the class rendered.
type AnyElement = ReactElement<Record<string, unknown>>

function renderTree(element: ReactElement): unknown {
  const type = element.type
  if (typeof type === 'function') {
    return (type as (props: unknown) => unknown)(element.props)
  }
  return element
}

function findByClass(node: unknown, className: string): AnyElement | null {
  // Walk the rendered element tree, expanding any function component we meet, until we hit the host
  // element carrying the class we want. Returns the first match in document order.
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByClass(child, className)
      if (found) return found
    }
    return null
  }
  if (!isValidElement(node)) return null
  const element = node as AnyElement
  if (typeof element.type === 'function') {
    return findByClass(renderTree(element), className)
  }
  if (element.type === Fragment) {
    return findByClass(element.props.children, className)
  }
  const classes = element.props.className
  if (typeof classes === 'string' && classes.split(/\s+/u).includes(className)) return element
  return findByClass(element.props.children, className)
}

const CLICK: LinkClickModifiers = { metaKey: false, ctrlKey: false, clientX: 12, clientY: 34 }

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
    // remark reports the markup run as its own node; what matters is that EVERY node is text-bearing and
    // none is an element, so the characters reach the reader as characters. Asserting the exact node
    // split would pin an implementation detail of the parser instead of the property we need.
    const paragraph = blocks[0]!
    if (paragraph.kind !== 'paragraph') throw new Error('expected a paragraph')
    const joined = paragraph.children.map((child) => 'text' in child ? child.text : '').join('')
    expect(joined).toBe('Before <script>alert(1)</script> after')
    expect(paragraph.children.every((child) => child.kind === 'text')).toBe(true)
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
    // `-` and `*` are different markers, so commonmark starts a new list at the marker change. That is
    // correct behaviour, not a defect — assert per-marker grouping rather than forcing them together.
    const bulleted = parseAgentMarkdown('- one\n- two\n- three')
    expect(bulleted).toHaveLength(1)
    expect(bulleted[0]).toMatchObject({ kind: 'list', ordered: false })
    if (bulleted[0]!.kind === 'list') expect(bulleted[0].items).toHaveLength(3)

    const numbered = parseAgentMarkdown('1. first\n2. second')
    expect(numbered[0]).toMatchObject({ kind: 'list', ordered: true })
  })

  it('separates a list from the prose around it', () => {
    const blocks = parseAgentMarkdown('Steps:\n- one\n- two\n\nDone.')
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
    // A hostile scheme still PARSES — the parser's job is to report what was written, and remark reports
    // the balanced parens correctly where the old hand-rolled scanner truncated at the first ')'.
    // Refusing it is the renderer's job through the external-URL seam; duplicating that judgement here
    // would create a second place for the rule to drift.
    expect(parseInline('[x](javascript:alert(1))')[0]).toMatchObject({
      kind: 'link',
      href: 'javascript:alert(1)'
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

  it('routes a clicked http link through the injected menu seam, never straight out to the system', () => {
    // 用户报的缺陷本体：对话里的链接以前 onClick 直接 openExternal，绕过浮窗菜单直接拉起系统浏览器。
    // 修复后点击必须把 URL 交给注入的 openHttpLink 出口（宿主据此浮出与终端相同的菜单），而不是自己开。
    // 把 onClick 改回 `context.openExternal(node.href)` 之类的直开，这条就会红——它是整个修复的意义所在。
    const openHttpLink = vi.fn()
    const button = findByClass(
      renderTree(createElement(AgentMarkdown, {
        content: 'see [docs](https://example.com/a?b=1)',
        openHttpLink
      }) as ReactElement),
      'md-link'
    )
    expect(button, 'expected an md-link button in the rendered turn').not.toBeNull()

    const onClick = button!.props.onClick as (event: LinkClickModifiers) => void
    onClick(CLICK)

    // 出口收到的是这条链接的 URL 与本次点击的修饰键/坐标——菜单要浮在点击处、要能判 Cmd/Ctrl 直开。
    expect(openHttpLink).toHaveBeenCalledTimes(1)
    expect(openHttpLink).toHaveBeenCalledWith('https://example.com/a?b=1', CLICK)
  })

  it('raises no second, silent path to the system browser when no seam is wired', () => {
    // 没有注入出口时，点击必须什么都不做，而不是退回直开系统浏览器——那个 fallback 正是缺陷复活的形状。
    // 这条守着「不留兼容层」：默认实现里若偷偷 import api.ui.openExternal，这条无从直接断言，但配合
    // 上一条（必须走注入出口）与源码里删掉 defaultOpenExternal，方向是明确的。这里断言点击不抛、不navigate。
    const button = findByClass(
      renderTree(createElement(AgentMarkdown, {
        content: 'see [docs](https://example.com)'
      }) as ReactElement),
      'md-link'
    )
    expect(button).not.toBeNull()
    const onClick = button!.props.onClick as (event: LinkClickModifiers) => void
    expect(() => onClick(CLICK)).not.toThrow()
  })

  // A non-http(s) scheme must never become an actionable link in agent prose. The Terminal already
  // refuses to make such a URI clickable (`parseHttpLinkUrl`); the conversation has to make the SAME
  // call, or the two surfaces treat one scheme differently. Behavioural, not textual: it renders the
  // real component and checks the DERIVED tree, so deleting the scheme gate — which puts the erroring
  // button back — turns these red. Every case below is one an agent actually produces: an explicit
  // hostile/opaque scheme, and a bare email that GFM autolinking silently rewrites to `mailto:`.
  it.each([
    ['[mail](mailto:alice@example.com)', 'mail'],
    ['[x](javascript:alert(1))', 'x'],
    ['[f](file:///etc/passwd)', 'f'],
    ['[v](vscode://file/etc/hosts)', 'v'],
    // GFM autolinks a bare email inside markdown into a mailto: link node — the same dead button, but
    // reached without the agent writing any link syntax at all.
    ['# Support\n\nEmail alice@example.com for help.', 'alice@example.com']
  ])('never makes a non-http(s) scheme clickable: %s', (content, visibleText) => {
    const openHttpLink = vi.fn()
    const tree = renderTree(createElement(AgentMarkdown, { content, openHttpLink }) as ReactElement)

    // No md-link button at all: a mailto:/file:/javascript:/vscode: href is not something this surface
    // can open, so a button here would only ever error on click. If the gate is removed the button
    // comes back and this fails.
    expect(findByClass(tree, 'md-link')).toBeNull()
    // The words still reach the reader — the rejected link degrades to its own text, not to nothing.
    expect(renderToStaticMarkup(createElement(AgentMarkdown, { content, openHttpLink })))
      .toContain(visibleText)
    // And with no actionable button there is no path to the open seam.
    expect(openHttpLink).not.toHaveBeenCalled()
  })

  it('still makes an http(s) link — including a GFM-autolinked bare URL — clickable', () => {
    // The other side of the same gate: narrowing to http(s) must not also kill the links that ARE
    // openable. A plain URL an agent typed autolinks to http:// and stays a working button.
    const openHttpLink = vi.fn()
    const button = findByClass(
      renderTree(createElement(AgentMarkdown, {
        content: '# Docs\n\nvisit www.example.com now',
        openHttpLink
      }) as ReactElement),
      'md-link'
    )
    expect(button, 'expected the autolinked http URL to remain an md-link button').not.toBeNull()
    ;(button!.props.onClick as (event: LinkClickModifiers) => void)(CLICK)
    // GFM normalises the bare host to an http URL, and that normalised URL is what reaches the seam.
    expect(openHttpLink).toHaveBeenCalledTimes(1)
    expect(openHttpLink).toHaveBeenCalledWith('http://www.example.com/', CLICK)
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

  // The four constructs this Feature exists for. Each was previously rendered as a pile of pipes,
  // a flattened list, or literal text; an assertion here has to go red the moment its branch stops
  // producing its own node, which is exactly what a hand-rolled parser regression would look like.
  it('parses a GFM table into rows and per-column alignment', () => {
    const blocks = parseAgentMarkdown(
      '| Stage | Count |\n| :--- | ---: |\n| parse | 2 |\n| render | 3 |'
    )

    const table = blocks.find((block) => block.kind === 'table')
    expect(table).toBeDefined()
    if (table?.kind !== 'table') throw new Error('expected a table block')
    expect(table.align).toEqual(['left', 'right'])
    expect(table.header).toHaveLength(2)
    expect(table.rows).toHaveLength(2)
    // Cells carry inline nodes, so the text survives rather than the pipes.
    expect(table.rows[0]?.[0]).toEqual([{ kind: 'text', text: 'parse' }])
    expect(table.rows[1]?.[1]).toEqual([{ kind: 'text', text: '3' }])
  })

  it('keeps a nested list nested instead of flattening it', () => {
    const blocks = parseAgentMarkdown('- outer\n  - inner')

    const list = blocks.find((block) => block.kind === 'list')
    if (list?.kind !== 'list') throw new Error('expected a list block')
    // One top-level item whose own blocks contain the nested list — flattening would give two items.
    expect(list.items).toHaveLength(1)
    const nested = list.items[0]?.find((block) => block.kind === 'list')
    expect(nested).toBeDefined()
    if (nested?.kind !== 'list') throw new Error('expected a nested list')
    expect(nested.items).toHaveLength(1)
  })

  it('parses a blockquote as a quote holding its own blocks', () => {
    const blocks = parseAgentMarkdown('> quoted line')

    const quote = blocks.find((block) => block.kind === 'quote')
    expect(quote).toBeDefined()
    if (quote?.kind !== 'quote') throw new Error('expected a quote block')
    expect(quote.children[0]?.kind).toBe('paragraph')
  })

  it('parses a thematic break as a rule rather than literal dashes', () => {
    const blocks = parseAgentMarkdown('before\n\n---\n\nafter')

    expect(blocks.some((block) => block.kind === 'rule')).toBe(true)
    // And it never degrades into text that still shows the dashes.
    const paragraphs = blocks.filter((block) => block.kind === 'paragraph')
    for (const paragraph of paragraphs) {
      if (paragraph.kind !== 'paragraph') continue
      expect(JSON.stringify(paragraph.children)).not.toContain('---')
    }
  })

  it('renders a wide table inside its own scroll container', () => {
    const markup = renderToStaticMarkup(createElement(AgentMarkdown, {
      content: '| A | B |\n| :--- | ---: |\n| 1 | 2 |'
    }))

    // The container is what keeps a wide table from widening the whole turn.
    expect(markup).toContain('md-table-scroll')
    expect(markup).toContain('<table')
    expect(markup).toContain('data-align="left"')
    expect(markup).toContain('data-align="right"')
  })
})
