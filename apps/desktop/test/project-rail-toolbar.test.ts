import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ProjectRailToolbar } from '../src/renderer/src/components/ProjectRailToolbar.js'

describe('Project rail bottom toolbar', () => {
  it('renders only real Settings routes in the expanded rail', () => {
    const markup = renderToStaticMarkup(createElement(ProjectRailToolbar, {
      onOpenSettings: vi.fn()
    }))

    expect(markup).toContain('role="toolbar"')
    expect(markup).toContain('aria-label="Settings"')
    expect(markup).toContain('data-settings-section="workspaces"')
    expect(markup).toContain('aria-label="Hosts"')
    expect(markup).toContain('data-settings-section="hosts"')
    expect(markup).not.toContain('Settings &amp; hosts')
    expect(markup.match(/project-rail-toolbar__button/g)).toHaveLength(2)
    expect(markup).toContain('width="13"')
    expect(markup.match(/<button/g)).toHaveLength(2)
  })

  it('keeps one Settings affordance when the project rail is collapsed', () => {
    const markup = renderToStaticMarkup(createElement(ProjectRailToolbar, {
      collapsed: true,
      onOpenSettings: vi.fn()
    }))

    expect(markup).toContain('data-project-rail-corner-toolbar="true"')
    expect(markup).toContain('aria-label="Settings"')
    expect(markup).toContain('data-settings-section="workspaces"')
    expect(markup).not.toContain('aria-label="Hosts"')
    expect(markup.match(/project-rail-toolbar__button/g)).toHaveLength(1)
    expect(markup.match(/<button/g)).toHaveLength(1)
  })
})
