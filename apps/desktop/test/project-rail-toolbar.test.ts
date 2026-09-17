import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WindowUtilityBar } from '../src/renderer/src/components/WindowUtilityBar.js'

describe('Window utility status bar', () => {
  it('keeps keyboard shortcuts in the right global utility group', () => {
    const markup = renderToStaticMarkup(createElement(WindowUtilityBar))

    expect(markup).toContain('role="toolbar"')
    expect(markup).toContain('aria-label="Window tools"')
    expect(markup).not.toContain('aria-label="Settings"')
    const keyboard = markup.indexOf('aria-label="Keyboard shortcuts"')
    expect(keyboard).toBeGreaterThan(-1)
    expect(markup).not.toContain('project-rail-toolbar')
    expect(markup).toContain('width="14"')
    expect(markup.match(/<button/g)).toHaveLength(1)
  })
})
