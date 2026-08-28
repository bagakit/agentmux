import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'

const renderer = new URL('../src/renderer/src/', import.meta.url).pathname
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.tsx') ? [path] : []
  })
}

it('keeps PMO teams on one bottom entry and one canonical Topic', () => {
  const entry = readFileSync(join(renderer, 'components/PmoTeamsTopicEntry.tsx'), 'utf8')
  const panel = readFileSync(join(renderer, 'components/PmoTeamsTopicFloatingPanel.tsx'), 'utf8')
  const styles = readFileSync(join(renderer, 'styles/pmo-teams-topic.css'), 'utf8')
  const app = readFileSync(join(renderer, 'App.tsx'), 'utf8')
  const workbench = readFileSync(join(renderer, 'components/WorkspaceWorkbench.tsx'), 'utf8')
  const chrome = readFileSync(join(renderer, 'styles/agent.css'), 'utf8')
  const shared = readFileSync(new URL('../src/shared/scratch-topics.ts', import.meta.url), 'utf8')
  expect(entry).toContain('requestPmoTeamsTopicFloatingOpen')
  expect(entry).toContain('pmo-teams-topic-compact-launcher')
  expect(entry).toContain('pmoTeamsTopicAvatar')
  expect(entry).toContain('aria-expanded={floating.open}')
  expect(entry).toContain('requestPmoTeamsTopicFloatingClose')
  expect(entry).not.toContain('launcherPlacement')
  expect(entry).not.toContain('data-pmo-teams-topic-mode')
  expect(styles).not.toContain('pmo-teams-topic-floating-launcher')
  expect(styles).toContain('pmo-teams-topic-floating--opening::after')
  expect(styles).toContain('pmo-teams-topic-signal')
  expect(styles).toContain('pmo-teams-topic-eye-particles')
  expect(styles).toContain('prefers-reduced-motion')
  expect(chrome).toContain('.window-status-bar__pmo-entry')
  expect(chrome).toContain('left: 50%')
  expect(chrome).toContain('right: calc(50% + 26px)')
  expect(styles).toContain('.pmo-teams-topic-floating__titlebar--attached')
  expect(panel).toContain('api.scratch.ensureTopic(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)')
  expect(panel).toContain('api.scratch.renameTitle(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, PMO_TEAMS_TOPIC_TITLE)')
  expect(panel).toContain('openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { reveal: false })')
  expect(panel).toContain('topicId={PMO_TEAMS_TOPIC_ID}')
  expect(panel).toContain('requestPmoTeamsTopicFloatingClose')
  expect(panel).toContain('id="pmo-teams-topic-floating-panel"')
  expect(panel).not.toContain('launcherPosition')
  expect(panel).not.toContain('openAnchor')
  expect(app).toContain('<PmoTeamsTopicFloatingPanel />')
  expect(app).toContain('<div className="window-status-bar__pmo-entry"><PmoTeamsTopicEntry placement="compact" /></div>')
  expect(workbench).toContain('topicId?: string')
  expect(shared).toContain("PMO_TEAMS_TOPIC_ID = 'launcher:leader'")
  const callers = sourceFiles(renderer).filter((file) => readFileSync(file, 'utf8').includes('<PmoTeamsTopicEntry'))
  expect(callers.map((file) => relative(renderer, file)).sort()).toEqual(['App.tsx'])
})

it('uses the shipped AgentMux dragon asset for the PMO teams topic launcher', () => {
  const launcherAsset = readFileSync(join(renderer, 'assets/pmo-teams-topic-avatar.png'))
  const projectAsset = readFileSync(new URL('../resources/icon.png', import.meta.url))
  expect(launcherAsset.equals(projectAsset)).toBe(true)
})
