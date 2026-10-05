import { fixturePath as _reshape_fixturePath } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { AgentMarkdown } from '../src/components/AgentMarkdown'
import { GRAPHITE_THEME } from '../src/theme/catalog'
import { updateIconSprite, removeIconSprite, semanticIconHref } from '../src/theme/icon-sprite'
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
it('uses themed image semantics for all controlled fallback branches while preserving user labels and the original file action', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), open = vi.fn()
  updateIconSprite(document, GRAPHITE_THEME)
  try {
    await act(async () => root.render(<>
      <AgentMarkdown content="![Read only user alt](https://example.invalid/image.png)" readOnly />
      <AgentMarkdown content="![Local user alt](./image.png)" workspaceRoot={_reshape_fixturePath("private")} openWorkspaceFile={open} />
      <AgentMarkdown content="![Unavailable user alt](https://example.invalid/image.png)" />
    </>))
    const icons = [...host.querySelectorAll('[data-semantic-icon="object.image"]')]
    expect(icons).toHaveLength(3)
    expect(host.textContent).toContain('Read only user alt'); expect(host.textContent).toContain('Local user alt'); expect(host.textContent).toContain('Unavailable user alt')
    const before = document.getElementById(semanticIconHref('object.image').slice(1))!.innerHTML
    updateIconSprite(document, { ...GRAPHITE_THEME, icons: { 'object.image': { kind: 'paths', paths: [{ d: 'M3 3 L21 3 L12 21 Z' }] } } })
    expect(document.getElementById(semanticIconHref('object.image').slice(1))!.innerHTML).not.toBe(before)
    expect([...host.querySelectorAll('[data-semantic-icon="object.image"]')]).toEqual(icons)
    expect(icons.every(icon => icon.querySelector('use')?.getAttribute('href') === semanticIconHref('object.image'))).toBe(true)
    await act(async () => host.querySelector<HTMLButtonElement>('.md-image-attachment:not(.md-image-attachment--unavailable)')!.click())
    expect(open).toHaveBeenCalledWith('image.png', undefined, expect.anything())
    expect(host.querySelectorAll('.md-image-attachment--unavailable')).toHaveLength(2)
  } finally { await act(async () => root.unmount()); host.remove(); removeIconSprite(document) }
})
