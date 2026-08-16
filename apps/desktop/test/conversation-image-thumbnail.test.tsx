// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '../src/renderer/src/components/AgentMarkdown.js'
import { splitPastedImageReferences } from '../src/renderer/src/lib/pasted-image-reference.js'
import type { PastedImage } from '../src/shared/contracts.js'

// T-004: a pasted image cited in the conversation renders as a thumbnail, not the dead text link the user
// reported. Load-bearing constraints:
//   - the @path token in the message text is NEVER rewritten (the Agent reads the image from it);
//   - the judgement is the narrow "is this OUR pasted image" shape, not resolveWorkspaceRelativePath;
//   - non-pasted references (workspace files, ordinary paths) are untouched;
//   - a read failure falls back to the plain-text reference, never a broken <img> frame.

const DATA_URL = 'data:image/png;base64,aGVsbG8='
const IMAGE: PastedImage = { mimeType: 'image/png', dataUrl: DATA_URL, byteLength: 5 }
const TOKEN = '@/Users/dev/.agentmux/pasted/paste-1.png'

describe('splitPastedImageReferences — the narrow app-owned judgement', () => {
  it('splits a pasted token out of surrounding prose, keeping the verbatim token text', () => {
    expect(splitPastedImageReferences(`here ${TOKEN} thanks`)).toEqual([
      { kind: 'text', text: 'here ' },
      { kind: 'image', text: TOKEN, path: '/Users/dev/.agentmux/pasted/paste-1.png' },
      { kind: 'text', text: ' thanks' }
    ])
  })

  it('recognises every write-side extension and no other', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp']) {
      const [seg] = splitPastedImageReferences(`/Users/d/.agentmux/pasted/x.${ext}`)
      expect(seg).toMatchObject({ kind: 'image' })
    }
    // A non-image extension in the same directory is left as plain text — pin the whole result, since
    // `every(kind==='text')` is vacuously true on an empty split.
    expect(splitPastedImageReferences('/Users/d/.agentmux/pasted/notes.txt')).toEqual([
      { kind: 'text', text: '/Users/d/.agentmux/pasted/notes.txt' }
    ])
  })

  it('does not claim a path outside the pasted directory', () => {
    // A workspace path and an unrelated absolute path both stay whole text — this is the "one rejects,
    // the other picks up" contract: the pasted judgement must not swallow ordinary references.
    expect(splitPastedImageReferences('@/Users/dev/proj/src/foo.png')).toEqual([
      { kind: 'text', text: '@/Users/dev/proj/src/foo.png' }
    ])
    expect(splitPastedImageReferences('nothing here')).toEqual([{ kind: 'text', text: 'nothing here' }])
  })
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(content: string, readPastedImage: (path: string) => Promise<PastedImage | null>) {
  await act(async () => {
    root.render(createElement(AgentMarkdown, { content, readPastedImage, openWorkspaceFile: vi.fn(), workspaceRoot: '/Users/dev/proj' }))
  })
  // Let the load effect's promise resolve and re-render.
  await act(async () => { await Promise.resolve() })
}

describe('AgentMarkdown — pasted image thumbnail', () => {
  it('renders a thumbnail <img> with the returned data URI once bytes load', async () => {
    const readPastedImage = vi.fn(async () => IMAGE)
    await render(TOKEN, readPastedImage)
    const img = container.querySelector<HTMLImageElement>('img.md-conversation-image__thumb')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe(DATA_URL)
    // Read through the seam with the BARE path (sigil stripped), so main can confine it.
    expect(readPastedImage).toHaveBeenCalledWith('/Users/dev/.agentmux/pasted/paste-1.png')
  })

  it('preserves the @path token verbatim in the DOM — the Agent still reads the image from it', async () => {
    // The path representation is a hard constraint: it must remain findable in the rendered text. The
    // thumbnail carries it on title/alt, and while loading it is literally the text.
    await render(`see ${TOKEN}`, vi.fn(async () => IMAGE))
    const img = container.querySelector<HTMLImageElement>('img.md-conversation-image__thumb')
    expect(img!.getAttribute('alt')).toBe('/Users/dev/.agentmux/pasted/paste-1.png')
    const button = container.querySelector<HTMLButtonElement>('.md-conversation-image')
    expect(button!.getAttribute('title')).toBe('/Users/dev/.agentmux/pasted/paste-1.png')
  })

  it('falls back to the plain-text reference when the bytes cannot be read (not a broken image)', async () => {
    const readPastedImage = vi.fn(async () => null)
    await render(TOKEN, readPastedImage)
    expect(container.querySelector('img.md-conversation-image__thumb')).toBeNull()
    // The verbatim token is still on screen as text.
    expect(container.textContent).toContain(TOKEN)
  })

  it('leaves an ordinary workspace file reference as a file button, not a thumbnail', async () => {
    // The pasted branch must not connect to unrelated references. A normal in-workspace path still
    // renders as the file-link button it was.
    await render('the fix is in src/upload.ts now', vi.fn(async () => IMAGE))
    expect(container.querySelector('img.md-conversation-image__thumb')).toBeNull()
    expect(container.querySelector('.md-link--file')).not.toBeNull()
  })

  it('leaves prose with no pasted token exactly as before', async () => {
    await render('just some text', vi.fn(async () => IMAGE))
    expect(container.querySelector('img.md-conversation-image__thumb')).toBeNull()
    expect(container.textContent).toContain('just some text')
  })
})
