import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WindowUtilityBar } from '../src/renderer/src/components/WindowUtilityBar.js'

describe('Window utility status bar', () => {
  it('renders Settings and keyboard shortcuts as one global utility group', () => {
    const markup = renderToStaticMarkup(createElement(WindowUtilityBar, {
      onOpenSettings: vi.fn()
    }))

    expect(markup).toContain('role="toolbar"')
    expect(markup).toContain('aria-label="Window tools"')
    expect(markup).toContain('aria-label="Settings"')
    const keyboard = markup.indexOf('aria-label="Keyboard shortcuts"')
    const settings = markup.indexOf('aria-label="Settings"')
    expect(keyboard).toBeGreaterThan(-1)
    expect(settings).toBeGreaterThan(keyboard)
    expect(markup).toContain('data-settings-section="workspaces"')
    expect(markup).not.toContain('project-rail-toolbar')
    expect(markup).toContain('width="14"')
    expect(markup.match(/<button/g)).toHaveLength(2)
  })
})
