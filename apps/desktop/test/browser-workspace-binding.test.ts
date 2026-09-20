import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { verifiedBrowserWorkspace } from '../src/main/browser-workspace-binding.js'

describe('Browser Workspace source', () => {
  it('only an explicit configured Workspace is verified; absence never guesses a current Workspace', () => {
    const configured = [{ id: 'workspace-a' }, { id: 'workspace-b' }]
    expect(verifiedBrowserWorkspace(configured, 'workspace-b')).toBe('workspace-b')
    expect(verifiedBrowserWorkspace(configured, 'workspace-a')).toBe('workspace-a')
    expect(verifiedBrowserWorkspace(configured, undefined)).toBeNull()
    expect(verifiedBrowserWorkspace(configured, null)).toBeNull()
    expect(verifiedBrowserWorkspace(configured, 'foreign-workspace')).toBeNull()
    expect(verifiedBrowserWorkspace(configured, { id: 'workspace-a' })).toBeNull()
    expect(verifiedBrowserWorkspace([], 'workspace-a')).toBeNull()
  })

  it('both Main handlers validate configuration and all real create callers pass their Region Workspace', () => {
    const ipc = readFileSync(join(import.meta.dirname, '../src/main/ipc.ts'), 'utf8')
    for (const label of ['create', 'restore']) {
      const start = ipc.indexOf(`handle('browser:${label}'`)
      const end = ipc.indexOf('\n  handle(', start + 1)
      expect(start).toBeGreaterThan(-1)
      expect(end).toBeGreaterThan(start)
      const handler = ipc.slice(start, end)
      expect(handler).toContain(`browser:${label}`)
      expect(handler).toContain('verifiedBrowserWorkspace(config.workspaces,')
    }
    const callers = ['store.ts', 'components/BrowserPane.tsx'].flatMap(file => {
      const source = readFileSync(join(import.meta.dirname, '../src/renderer/src', file), 'utf8')
      return [...source.matchAll(/api\.browser\.create\(([^)\n]+)\)/gu)].map(match => match[1]!)
    })
    expect(callers.length).toBeGreaterThan(0)
    for (const argumentsText of callers) {
      expect(argumentsText.split(',')).toHaveLength(3)
      expect(argumentsText.split(',').at(-1)).toMatch(/workspace(?:Id|\.id)/i)
    }
    const pane = readFileSync(join(import.meta.dirname, '../src/renderer/src/components/BrowserPane.tsx'), 'utf8')
    const start = pane.indexOf('api.browser.restore(')
    const end = pane.indexOf('}).then', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(pane.slice(start, end)).toContain('workspaceId: tab.workspaceId')
  })
})
