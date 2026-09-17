import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const repositoryRoot = new URL('../../../', import.meta.url).pathname

describe('feature history audit', () => {
  it('reports design anchors with production callers, tests, and deletion history', () => {
    const output = execFileSync('node', ['scripts/audit-feature-history.mjs'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8'
    })
    const report = JSON.parse(output)
    expect(report.schema).toBe('agentmux.feature-history-audit.v1')
    expect(report.anchors.length).toBeGreaterThan(0)
    expect(report.anchors.every((anchor: { ok: boolean; productionCallerCount: number; testHitCount: number }) => (
      anchor.ok && anchor.productionCallerCount > 0 && anchor.testHitCount > 0
    ))).toBe(true)
    expect(report.deletedHistory.length).toBeGreaterThan(0)
    const retiredStatusBar = report.deletedHistory.filter((entry: { path: string }) => entry.path.endsWith('/AgentStatusBar.tsx'))
    expect(retiredStatusBar.length).toBeGreaterThan(0)
    expect(retiredStatusBar.every((entry: { anchorId: string; replacementPresent: boolean }) => entry.anchorId === 'window-agent-status-and-resources' && entry.replacementPresent)).toBe(true)
    expect(report.anchors.find((entry: { id: string }) => entry.id === 'window-resource-observation')?.ok).toBe(true)
    expect(report.repositoryRoot).toBe(repositoryRoot.replace(/\/$/, ''))
  })
})
