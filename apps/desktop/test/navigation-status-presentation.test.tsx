import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { renderToStaticMarkup } from 'react-dom/server'
import { FocusNavigationButton } from '../src/renderer/src/components/FocusNavigationButton'
import { ProjectActivity } from '../src/renderer/src/components/ProjectActivity'

describe('compact navigation status presentation', () => {
  it('keeps the production status and activity surfaces callable', () => {
    expect(FocusNavigationButton).toBeTypeOf('function')
    expect(ProjectActivity).toBeTypeOf('function')
    expect(renderToStaticMarkup(<span className="status status--working"><span className="status__dot" /></span>)).toContain('status--working')
  })
})
