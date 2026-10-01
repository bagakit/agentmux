import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { type Root } from 'react-dom/client'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'

let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

describe('loaded Markdown local-link preview entry', () => {
  it('clicks real parsed image and file nodes with their once-decoded paths and reveal location', async () => {
    const open = vi.fn()
    await act(async () => root.render(<AgentMarkdown workspaceRoot={_hygiene_fixturePath("repo")} sourcePath="docs/readme.md" openWorkspaceFile={open}
      content={'![Photo](images/photo%20one.png)\n\n![图片](./图片.png)\n\n[Saved link](./Research%20%26%20Notes.webloc)\n\n[Reserved](./notes%23draft%3F%25.md)\n\n[Literal](./literal%252F.png)\n\n[Source](../src/解析.ts:42:7)'} />))
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')]
    expect(buttons.map(button => button.title)).toEqual(['docs/images/photo one.png', 'docs/图片.png', 'docs/Research & Notes.webloc', 'docs/notes#draft?%.md', 'docs/literal%2F.png', 'src/解析.ts'])
    for (const button of buttons) await act(async () => button.click())
    expect(open.mock.calls).toEqual([
      ['docs/images/photo one.png', undefined], ['docs/图片.png', undefined], ['docs/Research & Notes.webloc', undefined],
      ['docs/notes#draft?%.md', undefined], ['docs/literal%2F.png', undefined], ['src/解析.ts', { line: 42, column: 7 }]
    ])
  })

  it('keeps malformed and escaped image targets unavailable while retaining ordinary Terminal prose rules', async () => {
    const open = vi.fn()
    await act(async () => root.render(<AgentMarkdown workspaceRoot={_hygiene_fixturePath("repo")} sourcePath="docs/readme.md" openWorkspaceFile={open}
      content={'![Outside](../../escape.png)\n\n![Separator](images%2fphoto.png)\n\n![Malformed](bad%GG.png)\n\n[Scheme](file%3A12)\n\nBare 图片.png and photo%20one.png; `src/old.ts:3`.'} />))
    expect([...container.querySelectorAll('button')].map(button => button.getAttribute('title'))).toEqual(['src/old.ts'])
    expect([...container.querySelectorAll('.md-image-attachment--unavailable')].map(node => node.textContent)).toEqual(['🖼️ Outside', '🖼️ Separator', '🖼️ Malformed'])
    expect(container.textContent).toContain('Bare 图片.png and photo%20one.png')
    expect(open).not.toHaveBeenCalled()
  })
})
