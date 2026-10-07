import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SemanticIcon } from '../src/renderer/src/components/semantic-icons/index.js'
import { iconShapes } from '@agentmux/client-ui/icons'

describe('glyph identity is independent of current activity', () => {
  it('retains distinct running/working shapes while both default to static in headings and history', () => {
    const running = renderToStaticMarkup(<SemanticIcon name="status.running" size={13} />)
    const working = renderToStaticMarkup(<SemanticIcon name="status.working" size={13} />)
    expect(running).toContain('agentmux-icon-status.running')
    expect(working).toContain('agentmux-icon-status.working')
    expect(iconShapes('status.running').length).toBeGreaterThan(0)
    expect(iconShapes('status.working').length).toBeGreaterThan(0)
    expect(iconShapes('status.running')).not.toEqual(iconShapes('status.working'))
    expect(running).not.toContain('data-icon-animation')
    expect(working).not.toContain('data-icon-animation')
  })
})
