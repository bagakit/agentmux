import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appSource = readFile(fileURLToPath(new URL('../src/renderer/src/App.tsx', import.meta.url)), 'utf8')
const railSource = readFile(fileURLToPath(new URL('../src/renderer/src/components/WorkspaceSidebar.tsx', import.meta.url)), 'utf8')
const stylesSource = readFile(fileURLToPath(new URL('../src/renderer/src/styles/agent.css', import.meta.url)), 'utf8')

describe('window utility status bar layout', () => {
  it('keeps utilities outside the project tree and the primary navigation centered', async () => {
    const app = await appSource
    const rail = await railSource
    const styles = await stylesSource
    expect(app).toContain('<WindowUtilityBar onOpenSettings={openSettings} />')
    expect(app).toContain('className="window-status-bar__status"')
    expect(app).toContain('className="window-status-bar__right"')
    expect(app).not.toContain('ProjectRailToolbar')
    expect(rail).not.toContain('ProjectRailToolbar')
    expect(styles).toContain('.window-status-bar__utilities')
    expect(styles).toContain('.window-status-bar__status')
    expect(styles).toContain('.window-status-bar__right')
    expect(styles).toContain('top: 50%')
    expect(styles).toContain('left: 50%')
  })
})
