import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { allStyleRules } from './helpers/styles'
it('uses a 24px footer with one Focus observation and an on-demand resource entry', () => {
  const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8'), chrome = readFileSync(new URL('../src/renderer/src/components/TopRowChrome.tsx', import.meta.url), 'utf8')
  const start = app.indexOf('<footer className="window-status-bar">'), end = app.indexOf('</footer>', start)
  expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start); const footer = app.slice(start, end)
  expect(footer).toContain('<SurfaceSwitch'); expect(footer).toContain('toolkit={<PerformancePanel />}')
  expect(footer).not.toContain('ResourceUsagePanel'); expect(footer).not.toContain('AgentStatusBar'); expect(footer).not.toContain('window-status-bar__status')
  expect(app).toContain("const mergedTopRow = mainSurface === 'agents' ||")
  expect(chrome).toContain("plugin.id === 'focus' ? FocusNavigationButton : 'button'")
  const rules = allStyleRules().match(/\.window-status-bar\s*\{([^}]+)\}/g) ?? []
  expect(rules.length).toBeGreaterThan(0); expect(rules.join('\n')).toContain('height: 24px'); expect(rules.join('\n')).not.toMatch(/height:\s*(?:2[5-9]|[3-9]\d)px/)
})
