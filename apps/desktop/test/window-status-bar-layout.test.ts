import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appSource = readFile(fileURLToPath(new URL('../src/renderer/src/App.tsx', import.meta.url)), 'utf8')
const railSource = readFile(fileURLToPath(new URL('../src/renderer/src/components/WorkspaceSidebar.tsx', import.meta.url)), 'utf8')
const stylesSource = readFile(fileURLToPath(new URL('../src/renderer/src/styles/agent.css', import.meta.url)), 'utf8')

describe('window utility status bar layout', () => {
  it('keeps navigation first and window utilities in the right footer group', async () => {
    const app = await appSource
    const rail = await railSource
    const styles = await stylesSource
    expect(app).toContain('<WindowUtilityBar settingsOpen=')
    expect(app).not.toContain('className="window-status-bar__status"')
    expect(app).toContain('className="window-status-bar__right"')
    expect(app).not.toContain('ProjectRailToolbar')
    expect(rail).not.toContain('ProjectRailToolbar')
    expect(styles).toContain('.window-status-bar__utilities')
    expect(app).toContain('toolkit={<PerformancePanel />}')
    expect(app).not.toContain('ResourceUsagePanel')
    expect(styles).toContain('.window-status-bar__right')
    const start = app.indexOf('<footer className="window-status-bar">')
    const end = app.indexOf('</footer>', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const footer = app.slice(start, end)
    expect(footer).toContain('<SurfaceSwitch onCloseSettings={closeSettings} />')
    expect(footer).toContain('toolkit={<PerformancePanel />}')
    const navigation = footer.indexOf('window-status-bar__surface-switch')
    const right = footer.indexOf('window-status-bar__right')
    const utilities = footer.indexOf('<WindowUtilityBar')
    expect(navigation).toBeGreaterThan(-1)
    expect(right).toBeGreaterThan(navigation)
    expect(utilities).toBeGreaterThan(right)
    const rule = styles.match(/\.window-status-bar__surface-switch\s*\{([^}]+)\}/)
    expect(rule).not.toBeNull()
    expect(rule![1]).toContain('flex: 0 0 auto')
    expect(rule![1]).not.toContain('position: absolute')
    expect(rule![1]).not.toContain('translate')
  })
})
