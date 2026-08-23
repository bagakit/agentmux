import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allStyles } from './helpers/styles.js'

const tools = readFileSync(new URL('../src/renderer/src/components/AgentComposerTools.tsx', import.meta.url), 'utf8')
const composer = readFileSync(new URL('../src/renderer/src/components/AgentSessionComposer.tsx', import.meta.url), 'utf8')
const workbench = readFileSync(new URL('../src/renderer/src/components/WorkspaceWorkbench.tsx', import.meta.url), 'utf8')
const styles = allStyles()

describe('Agent view switch belongs to the Message Tool', () => {
  it('renders one compact target-oriented view toggle from the composer tools', () => {
    expect(tools).toContain('composer-tool-view-switch')
    expect(tools).toContain('Show Terminal')
    expect(tools).toContain('Show Activity')
    expect(tools).toContain("onViewModeChange(viewMode === 'terminal' ? 'activity' : 'terminal')")
    expect(tools).not.toContain('aria-pressed={viewMode')
    expect(tools).not.toContain('composer-tool__label">Terminal')
    expect(tools).not.toContain('composer-tool__label">Activity')
    expect(composer).toContain('onViewModeChange={(mode) => setViewMode(sessionId, mode)}')
    expect(styles).toContain('.composer-tool-view-switch .composer-tool--view-toggle')
  })

  it('does not leave the per-Agent switch in the pane top bar', () => {
    expect(workbench).not.toContain('pane-view-toggle')
    expect(workbench).not.toContain('aria-label="Agent view"')
  })
})
