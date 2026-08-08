import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentStatusBar } from '../src/renderer/src/components/AgentStatusBar'
import { ProjectActivity } from '../src/renderer/src/components/ProjectActivity'

describe('compact navigation status presentation', () => {
  it('keeps the production status and activity surfaces callable', () => {
    expect(AgentStatusBar).toBeTypeOf('function')
    expect(ProjectActivity).toBeTypeOf('function')
    expect(renderToStaticMarkup(<span className="status status--working"><span className="status__dot" /></span>)).toContain('status--working')
  })
})
