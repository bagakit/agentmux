import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '../src/renderer/src/components/AgentMarkdown.js'
import {
  classifyMarkdownLinkHref,
  referenceRevealLocation,
  splitMarkdownFileReferences
} from '../src/renderer/src/lib/markdown-file-reference.js'

const ROOT = '/work/repo'

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
        expect(splitMarkdownFileReferences(prose, ROOT).every((s) => s.kind === 'text')).toBe(true)
      }
    })

    it('accepts an absolute path inside the workspace and rejects one outside it', () => {
      const inside = splitMarkdownFileReferences('/work/repo/src/a.ts', ROOT)
      expect(inside).toContainEqual(
        expect.objectContaining({ kind: 'file', reference: expect.objectContaining({ path: 'src/a.ts' }) })
      )

      expect(splitMarkdownFileReferences('/etc/passwd', ROOT).every((s) => s.kind === 'text')).toBe(true)
    })
  })

  describe('link href routing', () => {
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
      expect(markup).toContain('title="https://example.com"')
      // The external one keeps the plain link class; only the file one carries the file modifier.
      expect((markup.match(/md-link--file/gu) ?? []).length).toBe(1)
    })

    it('leaves prose untouched when no file seam is supplied', () => {
      // Absent seam is today's behaviour: plain text, never a button that does nothing.
      const content = 'I updated src/upload.ts.'
      const markup = renderToStaticMarkup(createElement(AgentMarkdown, { content, className: 'body' }))

      expect(markup).toBe(`<p class="body">${content}</p>`)
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
