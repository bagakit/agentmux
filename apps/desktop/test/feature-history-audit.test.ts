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
    expect(report.repositoryRoot).toBe(repositoryRoot.replace(/\/$/, ''))
  })
})
