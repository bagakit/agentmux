import { fixturePath as _hygiene_fixturePath } from "../../lib/fixture-values.mjs"
import { createRoot } from 'react-dom/client'
import { AgentMarkdown } from '../../../../../packages/client-ui/src/components/AgentMarkdown'
import '../../../src/renderer/src/styles/tokens.css'
import '../../../src/renderer/src/styles/base.css'
import '../../../src/renderer/src/styles/file-preview.css'
import '../../../../../packages/client-ui/src/styles/markdown.css'

const content = `# Reading, with room to think

A file should feel like a document. Clear structure and quiet controls keep the content in focus.

## The details matter

Paragraphs preserve **emphasis**, *nuance*, and a deliberate line break.${'  '}
This is a second line, not a second paragraph.

3. Keep the original document
4. Follow references without losing your place

- [x] Read the current unsaved draft
- [ ] Review the next revision

> The workspace is the shared context. Files retain their own identity.

| Format | Reader | Source |
| :--- | :--- | ---: |
| Markdown | Document | Editable |
| CSV | Table | Editable |
| PDF | Pages | Original bytes |

### Local references

[Open the source][source] or [jump to the notes](#local-references).

![A large document image](original.png)

A precise claim has a footnote.[^one]

\`\`\`ts
const view = workspace.file('notes.md')
await view.preview()
\`\`\`

[source]: code.ts
[^one]: This note stays in the same document.
`
const graphic = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#7699ac"/><rect x="180" y="180" width="360" height="390" fill="#ebdcc2"/></svg>`
const imageUrl = `data:image/svg+xml,${encodeURIComponent(graphic)}`
document.documentElement.dataset.appearance = 'dark'
document.body.style.cssText = 'margin:0;padding:16px;background:var(--surface-0);font-family:system-ui;box-sizing:border-box'
createRoot(document.getElementById('root')!).render(<section id="reading-region" style={{ width: 900, height: 580 }}>
  <AgentMarkdown className="file-markdown-preview" content={content} documentMode workspaceRoot={_hygiene_fixturePath("repo")}
    renderWorkspaceImage={(_path, alt) => <span className="file-markdown-image"><img src={imageUrl} alt={alt} /></span>} />
</section>)

function bounds(element: Element) {
  const box = element.getBoundingClientRect()
  return { width: box.width, height: box.height, top: box.top, bottom: box.bottom }
}
;(window as any).markdownLayoutProbe = {
  resize(width: number, height: number) {
    const region = document.getElementById('reading-region')!
    region.style.width = `${width}px`; region.style.height = `${height}px`
  },
  facts() {
    const document = window.document.querySelector<HTMLElement>('.file-markdown-preview')!
    const table = document.querySelector<HTMLTableElement>('.md-table')!
    const tableScroll = document.querySelector<HTMLElement>('.md-table-scroll')!
    const code = document.querySelector<HTMLElement>('.md-block-code')!
    const nextHeading = document.querySelector<HTMLElement>('[data-md-anchor="local-references"]')!
    const image = document.querySelector<HTMLImageElement>('img')!
    return { root: { ...bounds(document), clientHeight: document.clientHeight, scrollHeight: document.scrollHeight },
      table: bounds(table), tableScroll: bounds(tableScroll), nextHeading: bounds(nextHeading),
      code: { ...bounds(code), clientHeight: code.clientHeight, scrollHeight: code.scrollHeight },
      rows: Array.from(table.rows).map(row => Array.from(row.cells).map(cell => cell.textContent)),
      image: { naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight },
      children: Array.from(document.children).map(child => ({ tag: child.tagName, className: child.className, ...bounds(child) })) }
  }
}
