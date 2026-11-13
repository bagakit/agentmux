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
