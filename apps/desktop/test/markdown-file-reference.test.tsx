import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '../src/renderer/src/components/AgentMarkdown.js'
import {
  classifyMarkdownLinkHref,
  referenceRevealLocation,
  splitMarkdownFileReferences
} from '../src/renderer/src/lib/markdown-file-reference.js'

const ROOT = _hygiene_fixturePath("work/repo")

// What the user asked for has two halves: clicking a file reference opens it, AND the file navigator
// points at it. The second half is not implemented here — it falls out of routing through the same
// `openFile` the Explorer and the Terminal use, because that action sets the workspace's last-active
// file and the Explorer reveals on it. That is exactly why these tests assert the ROUTE (which seam a
// click calls, with what arguments) and not just "something happened": a hand-rolled open-a-tab would
// satisfy a laxer assertion while silently dropping the reveal.

describe('markdown file references', () => {
  describe('detection over inline text', () => {
    it('finds a path written in prose and reports the span it occupies', () => {
      const segments = splitMarkdownFileReferences('I changed src/upload.ts today', ROOT)

      expect(segments).toEqual([
        { kind: 'text', text: 'I changed ' },
        { kind: 'file', text: 'src/upload.ts', reference: expect.objectContaining({ path: 'src/upload.ts' }) },
        { kind: 'text', text: ' today' }
      ])
    })

    it('carries :line:col through as a reveal target', () => {
      const [segment] = splitMarkdownFileReferences('src/upload.ts:42:7', ROOT)

      expect(segment).toMatchObject({ kind: 'file' })
      const reference = segment?.kind === 'file' ? segment.reference : null
      expect(reference).toMatchObject({ path: 'src/upload.ts', line: 42, column: 7 })
      expect(referenceRevealLocation(reference!)).toEqual({ line: 42, column: 7 })
    })

    it('omits the reveal target entirely when there is no line suffix', () => {
      // Not `{ line: undefined }`: exactOptionalPropertyTypes makes those different types, and
      // openFile's parameter is optional. A present-but-undefined value would not type-check.
      const [segment] = splitMarkdownFileReferences('src/upload.ts', ROOT)
      const reference = segment?.kind === 'file' ? segment.reference : null

      expect(referenceRevealLocation(reference!)).toBeUndefined()
    })

    it('returns one text segment when there is no path, so callers keep their existing output', () => {
      expect(splitMarkdownFileReferences('nothing to see here', ROOT)).toEqual([
        { kind: 'text', text: 'nothing to see here' }
      ])
    })

    it('does not invent references the terminal projection would refuse', () => {
      // Delegated to the shared resolver on purpose — this asserts the delegation holds, so a second
      // copy of "what counts as a path" cannot appear here without turning this red.
      for (const prose of ['e.g. this', 'version 1.2.3', 'see README', 'at ~/notes.md', '../outside.ts']) {
        // 钉整份切分结果：`every(...)===true` 对空数组恒成立，切分器什么都不返回（这段文字在
        // 界面上整个消失）时它照样绿，而那比「多认了一个引用」严重得多。
        expect(splitMarkdownFileReferences(prose, ROOT)).toEqual([{ kind: 'text', text: prose }])
      }
    })

    it('accepts an absolute path inside the workspace and rejects one outside it', () => {
      const inside = splitMarkdownFileReferences(_hygiene_fixturePath("work/repo/src/a.ts"), ROOT)
      expect(inside).toContainEqual(
        expect.objectContaining({ kind: 'file', reference: expect.objectContaining({ path: 'src/a.ts' }) })
      )

      // 同上：钉整份结果，不是「每段都是 text」——后者对空数组恒成立。
      expect(splitMarkdownFileReferences('/etc/passwd', ROOT)).toEqual([
        { kind: 'text', text: '/etc/passwd' }
      ])
    })
  })

  describe('link href routing', () => {
    it.each([
      ['images/photo%20one.png', 'images/photo one.png'],
      ['./图片.png', '图片.png'],
      ['./%F0%9F%96%BC%EF%B8%8F.png', '🖼️.png'],
      ['./Research%20%26%20Notes.webloc', 'Research & Notes.webloc'],
      ['./notes%23draft%3F%25.md', 'notes#draft?%.md'],
      ['./literal%252F.png', 'literal%2F.png'],
      ['./literal%252e%252e.png', 'literal%2e%2e.png'],
      ['@asset.png', '@asset.png'],
      ['./@asset.png', '@asset.png']
    ])('decodes an explicit href once: %s', (href, path) => {
      expect(classifyMarkdownLinkHref(href, ROOT)).toEqual({ index: 0, length: href.length, path })
    })

    it('normalizes decoded dot segments against the source document without escaping the workspace', () => {
      expect(classifyMarkdownLinkHref('%2e%2e/overview.md', ROOT, '', 'docs/readme.md')).toMatchObject({ path: 'overview.md' })
      expect(classifyMarkdownLinkHref('./images/%2e%2e/图片.png', ROOT, '', 'docs/readme.md')).toMatchObject({ path: 'docs/图片.png' })
      expect(classifyMarkdownLinkHref('%2e%2e/escape.png', ROOT)).toBeNull()
      expect(classifyMarkdownLinkHref('%2e%2e/%2e%2e/escape.png', ROOT, '', 'docs/readme.md')).toBeNull()
      expect(classifyMarkdownLinkHref(_hygiene_fixturePath("work/repo/../outside.png"), ROOT)).toBeNull()
    })

    it('keeps absolute and known-home paths inside the original workspace and carries line locations', () => {
      expect(classifyMarkdownLinkHref(_hygiene_fixturePath("work/repo/图片%20one.png"), ROOT, '', 'docs/readme.md')).toMatchObject({ path: '图片 one.png' })
      expect(classifyMarkdownLinkHref('~/repo/docs/%E5%9B%BE%E7%89%87.png', ROOT, _hygiene_fixturePath("work"))).toMatchObject({ path: 'docs/图片.png' })
      const href = './src/解析.ts:42:7'
      expect(classifyMarkdownLinkHref(href, ROOT, '', 'docs/readme.md')).toEqual({ index: 0, length: href.length, path: 'docs/src/解析.ts', line: 42, column: 7 })
      expect(classifyMarkdownLinkHref('~/repo/图片.png', ROOT)).toBeNull()
      expect(classifyMarkdownLinkHref(_hygiene_fixturePath("outside/图片.png"), ROOT)).toBeNull()
      expect(classifyMarkdownLinkHref('~/outside/图片.png', ROOT, _hygiene_fixturePath("work"))).toBeNull()
    })

    it.each([
      './bad%.png', './bad%GG.png', './bad%C0%AF.png', './bad%ED%A0%80.png',
      './images%2Fphoto.png', './images%5cphoto.png', './images\\photo.png',
      './photo%00.png', './photo%0a.png', './photo%7f.png', './photo%85.png',
      './photo.png?download=1', './photo.png#section', './photo one.png',
      'see src/photo.png', 'file%3A12', 'fi%6ce%3A12', '%68ttps%3A//example.test/a.png'
    ])('refuses an ambiguous, malformed or non-file explicit target: %s', href => {
      expect(classifyMarkdownLinkHref(href, ROOT)).toBeNull()
    })

    it('recognizes an explicit bare image filename without promoting ordinary dotted prose', () => {
      expect(classifyMarkdownLinkHref('diagram.png', ROOT)).toMatchObject({ path: 'diagram.png' })
      expect(splitMarkdownFileReferences('diagram.png e.g. 1.2.3', ROOT)).toEqual([{ kind: 'text', text: 'diagram.png e.g. 1.2.3' }])
    })
    it('routes an in-workspace href to the file seam', () => {
      expect(classifyMarkdownLinkHref('./src/parse.ts', ROOT)).toMatchObject({ path: 'src/parse.ts' })
    })

    it('leaves every http(s) URL to the external seam', () => {
      // Main owns scheme normalisation and refusal. This function must never become a second place
      // that decides what is safe to open.
      expect(classifyMarkdownLinkHref('https://example.com/a/b.ts', ROOT)).toBeNull()
      expect(classifyMarkdownLinkHref('http://example.com', ROOT)).toBeNull()
    })

    it('refuses any scheme, including one shaped like a local path', () => {
      expect(classifyMarkdownLinkHref('file:///etc/passwd', ROOT)).toBeNull()
      expect(classifyMarkdownLinkHref('javascript:alert(1)', ROOT)).toBeNull()
      expect(classifyMarkdownLinkHref('mailto:a@b.c', ROOT)).toBeNull()
    })

    it('refuses a scheme whose tail parses as a path-with-line', () => {
      // The scheme guard is what makes this null, and nothing else is: the path scanner reads
      // `file:12` as "the file named `file`, line 12" — a full-span match that every other check here
      // waves through. Deleting the guard opens a file named after the scheme.
      expect(classifyMarkdownLinkHref('file:12', ROOT)).toBeNull()
      expect(classifyMarkdownLinkHref('javascript:12:3', ROOT)).toBeNull()
      expect(classifyMarkdownLinkHref('custom-app:1', ROOT)).toBeNull()
    })

    it('refuses an href that merely contains a path rather than being one', () => {
      // Two distinct cases, and only the second exercises the full-span check: `see src/a.ts` is a
      // SINGLE match that does not span the href, so a count-only check would wave it through and
      // open a file the link text never named.
      expect(classifyMarkdownLinkHref('see src/a.ts and src/b.ts', ROOT)).toBeNull()
      expect(classifyMarkdownLinkHref('see src/a.ts', ROOT)).toBeNull()
      expect(classifyMarkdownLinkHref('src/a.ts here', ROOT)).toBeNull()
      expect(classifyMarkdownLinkHref('', ROOT)).toBeNull()
    })
  })

  describe('rendering', () => {
    it('makes a path in prose clickable and opens it through the injected seam', () => {
      const openWorkspaceFile = vi.fn()
      const markup = renderToStaticMarkup(createElement(AgentMarkdown, {
        content: 'The fix is in **src/upload.ts:42** now.',
        openWorkspaceFile,
        workspaceRoot: ROOT
      }))

      expect(markup).toContain('md-link--file')
      expect(markup).toContain('title="src/upload.ts"')
      // Still a button, never an anchor — same reason as an external link.
      expect(markup).not.toContain('href=')
    })

    it('finds paths inside inline code, which is how agents usually write them', () => {
      const markup = renderToStaticMarkup(createElement(AgentMarkdown, {
        content: 'Look at `src/upload.ts` for the retry.',
        openWorkspaceFile: vi.fn(),
        workspaceRoot: ROOT
      }))

      expect(markup).toContain('md-code')
      expect(markup).toContain('md-link--file')
    })

    it('finds a path in a one-line answer that is not markdown at all', () => {
      // The most common way an agent cites a file is a bare sentence, which trips the plain-text
      // fallback. Detection has to run there too or the frequent case stays dead.
      const markup = renderToStaticMarkup(createElement(AgentMarkdown, {
        content: 'I updated src/upload.ts.',
        openWorkspaceFile: vi.fn(),
        workspaceRoot: ROOT
      }))

      expect(markup).toContain('md-link--file')
      expect(markup).toContain('title="src/upload.ts"')
    })

    it('sends an in-workspace markdown link to the file seam and a URL to the external one', () => {
      const markup = renderToStaticMarkup(createElement(AgentMarkdown, {
        content: 'see [the parser](./src/parse.ts) and [docs](https://example.com)',
        openWorkspaceFile: vi.fn(),
        workspaceRoot: ROOT
      }))

      expect(markup).toContain('title="src/parse.ts"')
      // The http link is put through the shared scheme gate (`parseHttpLinkUrl`), the same one the
      // Terminal uses — so the button carries and opens that gate's NORMALISED form, which is what the
      // Store would open anyway. `new URL('https://example.com')` canonicalises the bare host with a
      // trailing slash, so that is the title, not the raw text.
      expect(markup).toContain('title="https://example.com/"')
      // The external one keeps the plain link class; only the file one carries the file modifier.
      expect((markup.match(/md-link--file/gu) ?? []).length).toBe(1)
    })

    it('leaves prose untouched when no file seam is supplied', () => {
      // Absent seam is today's behaviour: plain text, never a button that does nothing.
      const content = 'I updated src/upload.ts.'
      const markup = renderToStaticMarkup(createElement(AgentMarkdown, { content, className: 'body' }))

      expect(markup).toBe(`<p class="body md-paragraph">${content}</p>`)
    })

    it('escapes a hostile path rather than emitting markup for it', () => {
      const markup = renderToStaticMarkup(createElement(AgentMarkdown, {
        content: 'a/<script>alert(1)</script>/b.ts',
        openWorkspaceFile: vi.fn(),
        workspaceRoot: ROOT
      }))

      expect(markup).not.toContain('<script>')
      expect(markup).toContain('&lt;script&gt;')
    })
  })
})
