import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tools = readFileSync(new URL('../src/renderer/src/components/AgentComposerTools.tsx', import.meta.url), 'utf8')
const composer = readFileSync(new URL('../src/renderer/src/components/AgentSessionComposer.tsx', import.meta.url), 'utf8')
const workbench = readFileSync(new URL('../src/renderer/src/components/WorkspaceWorkbench.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/renderer/src/styles/composer.css', import.meta.url), 'utf8')

describe('Agent view switch belongs to the Message Tool', () => {
  it('renders terminal and activity controls from the composer tools and keeps the store action', () => {
    expect(tools).toContain('composer-tool-view-switch')
    expect(tools).toContain('Show Terminal')
    expect(tools).toContain('Show Activity')
    expect(composer).toContain('onViewModeChange={(mode) => setViewMode(sessionId, mode)}')
    expect(styles).toContain('.composer-tool-view-switch')
  })

  it('does not leave the per-Agent switch in the pane top bar', () => {
    expect(workbench).not.toContain('pane-view-toggle')
    expect(workbench).not.toContain('aria-label="Agent view"')
  })
})
