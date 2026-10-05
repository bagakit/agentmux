const { fixturePath: _reshape_fixturePath } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const grammar = vi.hoisted(() => ({ calls: 0 }))
vi.mock('unified', async importOriginal => {
  const original = await importOriginal<typeof import('unified')>()
  return { ...original, unified: (...args: Parameters<typeof original.unified>) => {
    const processor = original.unified(...args), parse = processor.parse
    processor.parse = function (...values: Parameters<typeof parse>) { grammar.calls++; return parse.apply(this, values) }
    return processor
  } }
})
import { AgentMarkdown } from '../src/components/AgentMarkdown.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'

let root: Root, container: HTMLDivElement
const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
beforeEach(() => {
  grammar.calls = 0; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })
async function render(node: ReactNode) { await act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>)) }
function button(text: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
  expect(found, 'Actual current action ' + text).toBeDefined(); return found!
}

describe('current per-instance Markdown grammar result', () => {
  it('keeps unchanged syntax while every click uses the latest Host callback and path context', async () => {
    const calls: unknown[] = [], content = '[Web](https://example.com) [File](./a.ts:9:2)\n\n![Image](./a.png)'
    for (const [generation, sourcePath] of [[0, 'docs/guide.md'], [1, 'notes/guide.md']] as const) {
      await render(<AgentMarkdown content={content} documentMode sourcePath={sourcePath} workspaceRoot={_reshape_fixturePath("private/repo")}
        openHttpLink={url => calls.push({ generation, url })} openWorkspaceFile={(path, location) => calls.push({ generation, path, location })}
        renderWorkspaceImage={(path, alt) => <span data-image="">{generation}:{path}:{alt}</span>} />)
    }
    expect(grammar.calls).toBe(1)
    expect(container.querySelector('[data-image]')?.textContent).toBe('1:notes/a.png:Image')
    await act(async () => { button('Web').click(); button('File').click() })
    expect(calls).toEqual([{ generation: 1, url: 'https://example.com/' }, { generation: 1, path: 'notes/a.ts', location: { line: 9, column: 2 } }])
    await render(<AgentMarkdown content="# Fresh content" />)
    expect(container.textContent).toBe('Fresh content'); expect(grammar.calls).toBe(2)
  })

  it('changes grammar only for effective plain, block or outline parsing while presentation remains current', async () => {
    await render(<AgentMarkdown content="<https://example.com>" />)
    expect(grammar.calls).toBe(0); expect(container.querySelector('button')).toBeNull()
    await render(<AgentMarkdown content="<https://example.com>" inputMode />)
    expect(grammar.calls).toBe(1); expect(container.querySelector('.md-input button')).not.toBeNull()
    await render(<AgentMarkdown content="<https://example.com>" />)
    expect(grammar.calls).toBe(1); expect(container.textContent).toBe('<https://example.com>')
    await render(<AgentMarkdown content="# Heading" inputMode />)
    expect(container.querySelector('.md-heading')?.textContent).toBe('# Heading'); expect(grammar.calls).toBe(2)
    await render(<AgentMarkdown content="# Heading" documentMode inputMode />)
    expect(container.querySelector('h1')?.textContent).toBe('Heading'); expect(grammar.calls).toBe(2)
    await render(<AgentMarkdown content="# Heading" documentMode outline />)
    expect(container.querySelector('.md-outline__trigger')).not.toBeNull(); expect(grammar.calls).toBe(3)
    await render(<AgentMarkdown content="# Heading" documentMode outline readOnly />)
    expect(container.querySelector('.md-outline__trigger')).toBeNull(); expect(grammar.calls).toBe(4)
    await render(<AgentMarkdown content="Fresh plain text." />)
    expect(container.textContent).toBe('Fresh plain text.'); expect(grammar.calls).toBe(4)
  })

  it('keeps equal content independent across instances and re-parses after unmount', async () => {
    const content = '# Independent'
    await render(<><AgentMarkdown content={content} /><AgentMarkdown content={content} /></>)
    expect(grammar.calls).toBe(2)
    await render(null)
    await render(<AgentMarkdown content={content} />)
    expect(grammar.calls).toBe(3); expect(container.textContent).toBe('Independent')
  })
})
