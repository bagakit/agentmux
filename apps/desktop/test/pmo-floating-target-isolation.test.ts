import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('keeps an explicit PMO target authoritative while the target Agent attaches', () => {
  const panel = readFileSync(new URL('../src/renderer/src/components/PmoTeamsTopicFloatingPanel.tsx', import.meta.url), 'utf8')
  const floating = readFileSync(new URL('../src/renderer/src/lib/pmo-teams-topic-floating.ts', import.meta.url), 'utf8')
  expect(panel.length).toBeGreaterThan(0)
  expect(floating.length).toBeGreaterThan(0)
  expect(panel).toContain('const targetSession = targetSurface?.kind === \'agent\'')
  expect(panel).toContain('const pmoTeamsSession = floating.targetTabId')
  expect(panel).toContain('const pmoTeamsSession = targetTabId')
  expect(panel).not.toContain('const pmoTeamsSession = sessions.find((session): session is Extract<typeof session, { kind: \'agent\' }> => session.kind === \'agent\' && session.id === targetSessionId)\n      ?? sessions.find')
  const ensureStart = panel.indexOf('api.scratch.ensureTopic(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)')
  const ensureEnd = panel.indexOf('}, [floating.open, floating.pendingPrompt, floating.targetTabId', ensureStart)
  expect(ensureStart).toBeGreaterThan(-1)
  expect(ensureEnd).toBeGreaterThan(ensureStart)
  expect(panel.slice(ensureStart, ensureEnd)).not.toContain('setFloating({ targetTabId: undefined })')
  expect(floating).toContain('targetTabId,')
  expect(floating).toContain('targetTabId: undefined')
})
