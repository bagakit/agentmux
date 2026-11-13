// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseAgentMarkdown, parseAgentMarkdownDocument, type BlockNode, type InlineNode } from '../src/lib/agent-markdown.js'

// `new URL('…', import.meta.url)` is rewritten to an http asset URL under happy-dom; resolve a file path instead.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Every node in reading order, so assertions see nested containers, cells and alerts. */
function walk(blocks: readonly BlockNode[]): (BlockNode | InlineNode)[] {
  const out: (BlockNode | InlineNode)[] = []
  const inline = (nodes: readonly InlineNode[]) => { for (const node of nodes) { out.push(node); if ('children' in node) inline(node.children) } }
  const block = (nodes: readonly BlockNode[]) => {
    for (const node of nodes) {
      out.push(node)
      if (node.kind === 'paragraph' || node.kind === 'heading') inline(node.children)
      else if (node.kind === 'list') node.items.forEach(block)
      else if (node.kind === 'table') [node.header, ...node.rows].forEach(row => row.forEach(inline))
      else if (node.kind === 'html-table') node.rows.forEach(row => row.cells.forEach(cell => block(cell.children)))
      else if (node.kind === 'details') { inline(node.summary); block(node.children) }
      else if (node.kind === 'footnotes') node.items.forEach(note => block(note.children))
      else if ('children' in node) block(node.children)
    }
  }
  block(blocks)
  return out
}
const textOf = (blocks: readonly BlockNode[]) => walk(blocks).map(node => node.kind === 'text' || node.kind === 'code' ? node.text : '').join('')
const textOfInline = (nodes: readonly InlineNode[]): string => nodes.map(node => node.kind === 'text' || node.kind === 'code' ? node.text : 'children' in node ? textOfInline(node.children) : '').join('')
const kinds = (blocks: readonly BlockNode[]) => walk(blocks).map(node => node.kind)
const images = (blocks: readonly BlockNode[]) => walk(blocks).filter((node): node is Extract<InlineNode, { kind: 'image' }> => node.kind === 'image')

describe('README HTML subset projection', () => {
  it('projects alignment, sized images, breaks and inline marks as data', () => {
    const blocks = parseAgentMarkdown('<div align="center">\n\n<img src="docs/hero.webp" alt="Hero" width="100%">\n\n**Bold<br>next** H<sub>2</sub>O <kbd>Ctrl</kbd>\n\n</div>')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'container', align: 'center' })
    expect(images(blocks)).toEqual([{ kind: 'image', href: 'docs/hero.webp', alt: 'Hero', width: '100%' }])
    expect(walk(blocks).filter(node => node.kind === 'html-mark').map(node => node.kind === 'html-mark' && node.tag)).toEqual(['sub', 'kbd'])
    expect(kinds(blocks)).toContain('break')
    expect(textOf(blocks)).not.toMatch(/<\/?(?:div|img|br|sub|kbd)/u)
  })

  it('keeps Markdown between block tags as Markdown, including headings in the outline', () => {
    const document = parseAgentMarkdownDocument('<div align="center">\n\n## Inside\n\n- one\n- two\n\n</div>\n\n<h3 align="center">HTML heading</h3>')
    expect(document.headings.map(heading => [heading.level, heading.anchor])).toEqual([[2, 'inside'], [3, 'html-heading']])
    expect(document.blocks[0]).toMatchObject({ kind: 'container', align: 'center' })
    expect(kinds(document.blocks)).toEqual(expect.arrayContaining(['heading', 'list']))
    expect(document.blocks[1]).toMatchObject({ kind: 'heading', level: 3, align: 'center' })
  })

  it('reads a td-only table as layout cards and a th table as data', () => {
    const cards = parseAgentMarkdown('<table>\n<tr>\n<td width="33%" valign="top"><b>A</b><br><sub>one</sub></td>\n<td width="67%">B</td>\n</tr>\n</table>')
    expect(cards).toEqual([{ kind: 'html-table', layout: true, rows: [{ head: false, cells: [
      { header: false, width: '33%', valign: 'top', children: [{ kind: 'paragraph', children: [{ kind: 'strong', children: [{ kind: 'text', text: 'A' }] }, { kind: 'break' },
        { kind: 'html-mark', tag: 'sub', children: [{ kind: 'text', text: 'one' }] }] }] },
      { header: false, width: '67%', children: [{ kind: 'paragraph', children: [{ kind: 'text', text: 'B' }] }] }
    ] }] }])
    const data = parseAgentMarkdown('<table><thead><tr><th align="right" colspan="2">Head</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
    expect(data[0]).toMatchObject({ kind: 'html-table', layout: false, rows: [{ head: true, cells: [{ header: true, align: 'right', colspan: 2 }] }, { head: false }] })
  })

  it('selects picture variants only from prefers-color-scheme sources', () => {
    const [paragraph] = parseAgentMarkdown('<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="dark.svg 1x, dark@2x.svg 2x">\n  <source media="print" srcset="print.svg">\n  <img src="light.svg" alt="Diagram" width="100%">\n</picture>')
    expect(images([paragraph!])).toEqual([{ kind: 'image', href: 'light.svg', alt: 'Diagram', width: '100%', variants: { dark: 'dark.svg' } }])
    // A non-theme media source never becomes a variant, whatever its position.
    expect(images(parseAgentMarkdown('<picture>\n  <source media="print" srcset="print.svg">\n  <source media="(prefers-color-scheme: light)" srcset="l.svg">\n  <img src="base.svg" alt="D">\n</picture>')))
      .toEqual([{ kind: 'image', href: 'base.svg', alt: 'D', variants: { light: 'l.svg' } }])
    expect(images(parseAgentMarkdown('<picture><source media="(min-width: 600px)" srcset="wide.svg"><img src="base.svg" alt="D"></picture>')))
      .toEqual([{ kind: 'image', href: 'base.svg', alt: 'D' }])
  })

  it('validates attributes instead of passing them through', () => {
    const blocks = parseAgentMarkdown('<p align="middle" style="color:red" class="x" id="y" onclick="steal()">Styled</p>\n\n<img src="a.png" width="calc(100%)" height="-4" data-x="1">\n\n<table><tr><td width="999%" valign="center" colspan="0">c</td></tr></table>')
    expect(blocks[0]).toEqual({ kind: 'paragraph', children: [{ kind: 'text', text: 'Styled' }] })
    expect(images(blocks)).toEqual([{ kind: 'image', href: 'a.png', alt: '' }])
    expect(walk(blocks).find(node => node.kind === 'html-table')).toMatchObject({ rows: [{ cells: [{ header: false, children: expect.any(Array) }] }] })
    const cell = (walk(blocks).find(node => node.kind === 'html-table') as Extract<BlockNode, { kind: 'html-table' }>).rows[0]!.cells[0]!
    expect(Object.keys(cell).sort()).toEqual(['children', 'header'])
    expect(JSON.stringify(blocks)).not.toMatch(/steal|color:red|"class"|"id"|data-x/u)
  })

  it('keeps a raw-text element body as source and an unknown element as visible tags around its Markdown', () => {
    // Raw-text elements are not markup: tags inside a script body never become elements.
    expect(parseAgentMarkdown('Before <script>x <b>y</b></script> after')).toEqual([{ kind: 'paragraph', children: [{ kind: 'text', text: 'Before <script>x <b>y</b></script> after' }] }])
    // An unknown element keeps its own tags visible; whitelisted children inside keep their meaning.
    expect(parseAgentMarkdown('A <marquee>moving <b>bold</b></marquee> B')).toEqual([{ kind: 'paragraph', children: [
      { kind: 'text', text: 'A <marquee>moving ' }, { kind: 'strong', children: [{ kind: 'text', text: 'bold' }] }, { kind: 'text', text: '</marquee> B' }] }])
  })

  it('an unclosed raw-text start tag is only visible text; the Markdown after it keeps its structure', () => {
    // Agents often mention these tags in prose; GitHub keeps the rest of the paragraph and document.
    expect(parseAgentMarkdown('Add a <script> tag to **index.html** then run `pnpm dev`.')).toEqual([{ kind: 'paragraph', children: [
      { kind: 'text', text: 'Add a <script> tag to ' }, { kind: 'strong', children: [{ kind: 'text', text: 'index.html' }] },
      { kind: 'text', text: ' then run ' }, { kind: 'code', text: 'pnpm dev' }, { kind: 'text', text: '.' }] }])
    for (const tag of ['title', 'textarea', 'style', 'noscript']) {
      const blocks = parseAgentMarkdown(`Use <${tag}> here and [docs](https://example.com).`)
      expect(walk(blocks).filter(node => node.kind === 'link'), tag).toHaveLength(1)
      expect(textOf(blocks), tag).toContain(`<${tag}>`)
    }
    // Within one HTML block too: the start tag stays text and the element after it keeps its meaning.
    expect(parseAgentMarkdown('<p>Use <title> and <b>bold</b></p>')).toEqual([{ kind: 'paragraph', children: [
      { kind: 'text', text: 'Use <title> and ' }, { kind: 'strong', children: [{ kind: 'text', text: 'bold' }] }] }])
    const document = parseAgentMarkdownDocument('<iframe src="https://e.example">\n\n# Heading\n\n- one\n- two\n\nSome *text* here.')
    expect(document.headings.map(heading => heading.anchor)).toEqual(['heading'])
    expect(document.blocks.map(block => block.kind)).toEqual(['paragraph', 'heading', 'list', 'paragraph'])
    expect(textOf([document.blocks[0]!])).toBe('<iframe src="https://e.example">')
  })

  it('an unclosed raw-text tag opening a block keeps the rest of the document readable as written', () => {
    // CommonMark reads this as one type-1 HTML block to the end of the document; its lines stay lines.
    expect(parseAgentMarkdown('Intro\n\n<script>\n\n# Heading\n\n- one')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: 'Intro' }] },
      { kind: 'code', language: null, text: '<script>\n\n# Heading\n\n- one' }])
  })

  it('a link label keeps only text: an autolink or Markdown link inside <a> gives up its destination', () => {
    expect(parseAgentMarkdown('<a href="https://x.dev/docs">https://x.dev/docs</a>')).toEqual([{ kind: 'paragraph', children: [
      { kind: 'link', href: 'https://x.dev/docs', children: [{ kind: 'text', text: 'https://x.dev/docs' }] }] }])
    expect(parseAgentMarkdown('<a href="https://a.example/">see [b](https://b.example/)</a>')).toEqual([{ kind: 'paragraph', children: [
      { kind: 'link', href: 'https://a.example/', children: [{ kind: 'text', text: 'see b' }] }] }])
  })

  it('tag names that are object properties never change the document (constructor, toString, __proto__)', () => {
    for (const tag of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      // One HTML block holding both tags reached the tokenizer with an inherited "state" and failed the whole parse.
      const document = parseAgentMarkdownDocument(`<${tag}>\nbody\n</${tag}>\n\n## Next`)
      expect(document.headings.map(heading => heading.anchor), tag).toEqual(['next'])
      // Split across nodes, the content between the tags keeps its Markdown instead of becoming raw text.
      const blocks = parseAgentMarkdown(`a <${tag}>**bold**</${tag}> b`)
      expect(walk(blocks).some(node => node.kind === 'strong'), tag).toBe(true)
    }
  })

  it('only block-level HTML headings join the outline; headings flattened into a line take no anchor', () => {
    const document = parseAgentMarkdownDocument('<details><summary><h2>Hidden</h2></summary>\n\nbody\n\n</details>\n\n## Hidden\n\n<a href="#x"><h3>In link</h3></a>\n\n<div>\n\n## Inside div\n\n</div>')
    expect(document.headings.map(heading => [heading.level, heading.anchor])).toEqual([[2, 'hidden'], [2, 'inside-div']])
  })

  it('trims long HTML whitespace in linear time', () => {
    // A literal raw-text body keeps its whitespace, so a long inner run reaches the trailing trim.
    const source = '<p>a<textarea>' + ' '.repeat(64_000) + 'x</textarea></p>'
    const started = performance.now()
    const blocks = parseAgentMarkdown(source)
    expect(textOf(blocks)).toBe('a<textarea>' + ' '.repeat(64_000) + 'x</textarea>')
    // An end-anchored regex backtracks for seconds on this input; the linear scan takes milliseconds.
    expect(performance.now() - started).toBeLessThan(400)
  })

  it('a link never contains another link: a new <a> ends the open one', () => {
    expect(parseAgentMarkdown('<a href="https://one.example">one <a href="https://two.example">two</a></a>')).toEqual([{ kind: 'paragraph', children: [
      { kind: 'link', href: 'https://one.example', children: [{ kind: 'text', text: 'one ' }] },
      { kind: 'link', href: 'https://two.example', children: [{ kind: 'text', text: 'two' }] }] }])
  })

  it('an unknown tag never swallows the structure that follows it', () => {
    expect(parseAgentMarkdown('<p>one <foo> two\n<p>three')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: 'one <foo> two' }] },
      { kind: 'paragraph', children: [{ kind: 'text', text: 'three' }] }])
  })

  it('a script block keeps its whole body as source, including markup inside strings', () => {
    expect(parseAgentMarkdown("<script>\nwindow.x = '<b>y</b>'\n</script>")).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: "<script>\nwindow.x = '<b>y</b>'\n</script>" }] }])
  })

  it('keeps dangerous and unknown elements as readable source with their content', () => {
    for (const source of ['<script>window.compromised = true</script>', '<style>body{display:none}</style>', '<iframe src="https://evil.example"></iframe>',
      '<svg onload="steal()"><circle /></svg>', '<object data="x.swf"></object>', '<form action="/x"><input name="password"></form>', '<math><mi>x</mi></math>']) {
      const blocks = parseAgentMarkdown(`Before ${source} after`)
      expect(textOf(blocks), source).toContain(source.replace(/<circle \/>/u, '<circle />'))
      expect(kinds(blocks).filter(kind => kind !== 'paragraph' && kind !== 'text'), source).toEqual([])
    }
  })

  it('keeps links as data the renderer classifies; a forbidden scheme never gains another meaning', () => {
    const blocks = parseAgentMarkdown('<a href="javascript:alert(1)">bad</a> <a href="https://example.com/x">ok</a> <a>bare</a>')
    expect(walk(blocks).filter(node => node.kind === 'link')).toEqual([
      { kind: 'link', href: 'javascript:alert(1)', children: [{ kind: 'text', text: 'bad' }] },
      { kind: 'link', href: 'https://example.com/x', children: [{ kind: 'text', text: 'ok' }] }
    ])
    expect(textOf(blocks)).toContain('bare')
  })

  it('never repairs unclosed or mismatched structure: the tags stay visible and no text is lost', () => {
    for (const [source, visible] of [['<b>unclosed bold', '<b>unclosed bold'], ['<div align="center">\n\nbody', '<div align="center">'], ['a </div> b', 'a </div> b'],
      ['<table><tr><td>cell', '<table>'], ['<details><summary>S</summary>\n\nopen body', '<details>'], ['<sub>one <b>two</sub> three', 'two']] as const) {
      const text = textOf(parseAgentMarkdown(source))
      expect(text, source).toContain(visible)
      for (const word of source.replace(/<[^>]*>/gu, ' ').split(/\s+/u).filter(Boolean)) expect(text, source).toContain(word)
    }
  })

  it('hides HTML comments and decodes entities exactly once', () => {
    const blocks = parseAgentMarkdown('<!-- hidden note -->\n<p>A &amp; B &amp;lt; C</p>')
    expect(textOf(blocks)).toBe('A & B &lt; C')
  })

  it('preserves preformatted text and details structure', () => {
    const blocks = parseAgentMarkdown('<pre>\n  keep   spacing\n    exactly\n</pre>\n\n<details open>\n<summary>More <b>info</b></summary>\n\nHidden **body**\n\n</details>')
    expect(blocks[0]).toEqual({ kind: 'code', language: null, text: '  keep   spacing\n    exactly' })
    expect(blocks[1]).toMatchObject({ kind: 'details', open: true, summary: [{ kind: 'text', text: 'More ' }, { kind: 'strong' }] })
  })
})

describe('whitelist matches the behavior SSOT element by element', () => {
  // One sample per whitelisted element, from docs/design/behavior/files-and-git.md 《Markdown 的 HTML 子集与 GitHub 提示块》.
  const inline: [string, (nodes: InlineNode[]) => boolean][] = [
    ['<a href="https://x.example">t</a>', n => n.some(x => x.kind === 'link')],
    ['<img src="a.png" alt="t">', n => n.some(x => x.kind === 'image')],
    ['<picture><source media="(prefers-color-scheme: dark)" srcset="d.png"><img src="l.png" alt="t"></picture>', n => n.some(x => x.kind === 'image' && x.variants?.dark === 'd.png')],
    ['a<br>t', n => n.some(x => x.kind === 'break')], ['a<wbr>t', n => n.every(x => x.kind === 'text') && textOfInline(n) === 'at'],
    ...(['b', 'strong'] as const).map(tag => [`<${tag}>t</${tag}>`, (n: InlineNode[]) => n.some(x => x.kind === 'strong')] as [string, (n: InlineNode[]) => boolean]),
    ...(['i', 'em'] as const).map(tag => [`<${tag}>t</${tag}>`, (n: InlineNode[]) => n.some(x => x.kind === 'emphasis')] as [string, (n: InlineNode[]) => boolean]),
    ...(['s', 'del', 'strike'] as const).map(tag => [`<${tag}>t</${tag}>`, (n: InlineNode[]) => n.some(x => x.kind === 'strike')] as [string, (n: InlineNode[]) => boolean]),
    ['<code>t</code>', n => n.some(x => x.kind === 'code')],
    ...(['kbd', 'samp', 'var', 'sub', 'sup', 'ins', 'mark', 'small', 'q', 'cite', 'abbr', 'dfn'] as const).map(tag =>
      [`<${tag}>t</${tag}>`, (n: InlineNode[]) => n.some(x => x.kind === 'html-mark' && x.tag === tag)] as [string, (n: InlineNode[]) => boolean]),
    ['<tt>t</tt>', n => n.some(x => x.kind === 'html-mark' && x.tag === 'samp')],
    ...(['span', 'time'] as const).map(tag => [`<${tag}>t</${tag}>`, (n: InlineNode[]) => n.length === 1 && n[0]!.kind === 'text' && n[0]!.text === 't'] as [string, (n: InlineNode[]) => boolean]),
  ]
  const block: [string, (blocks: BlockNode[]) => boolean][] = [
    ['<div align="center">t</div>', b => b[0]?.kind === 'container'], ['<p align="right">t</p>', b => b[0]?.kind === 'paragraph' && b[0].align === 'right'],
    ...[1, 2, 3, 4, 5, 6].map(level => [`<h${level}>t</h${level}>`, (b: BlockNode[]) => b[0]?.kind === 'heading' && b[0].level === level] as [string, (b: BlockNode[]) => boolean]),
    ['<blockquote>t</blockquote>', b => b[0]?.kind === 'quote'], ['<ul><li>t</li></ul>', b => b[0]?.kind === 'list' && !b[0].ordered],
    ['<ol start="3"><li>t</li></ol>', b => b[0]?.kind === 'list' && b[0].ordered && b[0].start === 3], ['<pre>  t</pre>', b => b[0]?.kind === 'code' && b[0].text === '  t'],
    ['<hr>', b => b[0]?.kind === 'rule'],
    ['<table><caption>c</caption><thead><tr><th>h</th></tr></thead><tbody><tr><td>t</td></tr></tbody><tfoot><tr><td>f</td></tr></tfoot></table>',
      b => b[0]?.kind === 'html-table' && !b[0].layout && Boolean(b[0].caption) && b[0].rows.length === 3],
    ['<details open><summary>s</summary>t</details>', b => b[0]?.kind === 'details' && b[0].open],
    ['<dl><dt>term</dt><dd>t</dd></dl>', b => b[0]?.kind === 'paragraph' && b[1]?.kind === 'container' && Boolean(b[1].indent)],
    ['<figure>t<figcaption>c</figcaption></figure>', b => b.some(x => x.kind === 'paragraph')],
  ]
  it('projects every whitelisted inline element to its meaning', () => {
    expect(inline.length).toBeGreaterThan(25)
    for (const [source, ok] of inline) {
      const [paragraph] = parseAgentMarkdown(`x ${source} y`)
      expect(paragraph?.kind, source).toBe('paragraph')
      const children = paragraph?.kind === 'paragraph' ? paragraph.children.filter(node => node.kind !== 'text' || node.text.trim() !== 'x' && node.text.trim() !== 'y') : []
      const inner = children.map(node => node.kind === 'text' ? { ...node, text: node.text.replace(/^x /u, '').replace(/ y$/u, '') } : node)
      expect(ok(inner), source).toBe(true)
      expect(textOfInline(inner), source).not.toMatch(/</u)
    }
  })
  it('projects every whitelisted block element to its meaning', () => {
    expect(block.length).toBeGreaterThan(15)
    for (const [source, ok] of block) {
      const blocks = parseAgentMarkdown(source)
      expect(ok(blocks), source).toBe(true)
      expect(textOf(blocks), source).not.toMatch(/<\/?[a-z]/u)
    }
  })
  it('keeps an element outside the whitelist visible as source', () => {
    for (const tag of ['center', 'font', 'u', 'marquee', 'button', 'video', 'embed', 'object', 'section', 'nav']) {
      expect(textOf(parseAgentMarkdown(`x <${tag}>t</${tag}> y`)), tag).toContain(`<${tag}>`)
    }
  })
})

describe('GitHub alerts', () => {
  it('recognizes the five types case-insensitively and keeps the body', () => {
    for (const type of ['NOTE', 'tip', 'Important', 'WARNING', 'caution']) {
      const [alert] = parseAgentMarkdown(`> [!${type}]\n> Body with [link](https://example.com).`)
      expect(alert, type).toMatchObject({ kind: 'alert', alert: type.toLowerCase(), children: [{ kind: 'paragraph' }] })
      expect(textOf([alert!])).toBe('Body with link.')
    }
  })

  it('stays an ordinary quote exactly where GitHub does', () => {
    for (const source of ['> [!NOTE] title on the same line', '> [!NOTE]', '> [!NOTES]\n> body', '> [! NOTE]\n> body', '- > [!TIP]\n  > in a list', '> > [!TIP]\n> > nested']) {
      const blocks = parseAgentMarkdown(source)
      expect(kinds(blocks), source).not.toContain('alert')
      expect(textOf(blocks), source).toMatch(/\[!/u)
    }
  })

  it('keeps multi-paragraph bodies and later quotes as quotes', () => {
    const blocks = parseAgentMarkdown('> [!WARNING]\n> First.\n>\n> Second.\n\n> plain quote')
    expect(blocks.map(block => block.kind)).toEqual(['alert', 'quote'])
    expect((blocks[0] as Extract<BlockNode, { kind: 'alert' }>).children).toHaveLength(2)
  })
})

describe('root README files as real input', () => {
  for (const name of ['README.md', 'README.zh-CN.md']) {
    it(`${name} has no visible README HTML source left outside code`, () => {
      const source = readFileSync(join(ROOT, name), 'utf8')
      const document = parseAgentMarkdownDocument(source)
      const prose = walk(document.blocks).map(node => node.kind === 'text' ? node.text : '').join('\n')
      expect(document.blocks.length).toBeGreaterThan(50)
      expect(prose).not.toMatch(/<\/?(?:div|p|img|picture|source|table|tr|td|th|sub|sup|br|b|a)\b/u)
      expect(prose).not.toMatch(/\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/u)
      const all = walk(document.blocks)
      expect(all.filter(node => node.kind === 'alert')).toHaveLength(1)
      expect(all.filter(node => node.kind === 'html-table' && node.layout)).toHaveLength(3)
      expect(all.filter(node => node.kind === 'container' && node.align === 'center')).toHaveLength(1)
      const pictures = images(document.blocks).filter(image => image.variants?.dark)
      expect(pictures).toHaveLength(1)
      expect(pictures[0]!.href).toMatch(/architecture-light.*\.svg$/u)
      expect(images(document.blocks).filter(image => image.width === '72%')).toHaveLength(1)
      expect(images(document.blocks).filter(image => image.href.startsWith('https://img.shields.io/'))).toHaveLength(6)
      expect(document.headings.length).toBeGreaterThan(10)
    })
  }
})
