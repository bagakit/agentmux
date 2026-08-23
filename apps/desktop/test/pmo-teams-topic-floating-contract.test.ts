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

it('keeps PMO teams topic on one fixed floating/compact launcher and one canonical Topic', () => {
  const entry = readFileSync(join(renderer, 'components/PmoTeamsTopicEntry.tsx'), 'utf8')
  const panel = readFileSync(join(renderer, 'components/PmoTeamsTopicFloatingPanel.tsx'), 'utf8')
  const styles = readFileSync(join(renderer, 'styles/pmo-teams-topic.css'), 'utf8')
  const floatingButtonStart = styles.indexOf('.pmo-teams-topic-floating-launcher__button {')
  const floatingButtonEnd = styles.indexOf('.pmo-teams-topic-floating-launcher__button:hover')
  expect(floatingButtonStart).toBeGreaterThan(-1)
  expect(floatingButtonEnd).toBeGreaterThan(floatingButtonStart)
  const floatingButtonRule = styles.slice(floatingButtonStart, floatingButtonEnd)
  const app = readFileSync(join(renderer, 'App.tsx'), 'utf8')
  const workbench = readFileSync(join(renderer, 'components/WorkspaceWorkbench.tsx'), 'utf8')
  const shared = readFileSync(new URL('../src/shared/scratch-topics.ts', import.meta.url), 'utf8')
  expect(entry).toContain('requestPmoTeamsTopicFloatingOpen')
  expect(entry).toContain('pmo-teams-topic-floating-launcher')
  expect(entry).toContain('pmoTeamsTopicAvatar')
  expect(entry).toContain('launcherPlacement')
  expect(entry).toContain('Collapse PMO teams topic to bottom switcher')
  expect(entry).toContain('footer')
  expect(entry).toContain('Close ${PMO_TEAMS_TOPIC_TITLE}')
  expect(entry).toContain('aria-expanded={placement === \'floating\' ? floating.open : undefined}')
  expect(entry).toContain('requestPmoTeamsTopicFloatingClose')
  expect(styles).toContain('.pmo-teams-topic-floating-launcher__button')
  expect(styles).toContain('border-radius: var(--radius-lg)')
  expect(styles).toContain('object-fit: contain')
  expect(styles).toContain('gap: var(--sp-1)')
  expect(styles).toContain('.pmo-teams-topic-floating__titlebar--attached')
  expect(floatingButtonRule).toMatch(/(?:^|;) backdrop-filter: blur\(18px\) saturate\(1\.25\);/)
  expect(styles).not.toContain('top: -5px; right: -5px')
  expect(styles).toContain('.pmo-teams-topic-compact-launcher__collapse-button')
  expect(styles).not.toContain('color-mix(in srgb, var(--green) 55%, var(--line))')
  expect(panel).toContain('api.scratch.ensureTopic(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)')
  expect(panel).toContain('api.scratch.renameTitle(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, PMO_TEAMS_TOPIC_TITLE)')
  expect(panel).toContain('openScratchTopic(PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, { reveal: false })')
  expect(panel).toContain('topicId={PMO_TEAMS_TOPIC_ID}')
  expect(panel).toContain('if (floating.open)')
  expect(panel).toContain('requestPmoTeamsTopicFloatingClose()')
  expect(panel).toContain('pmo-teams-topic-floating__titlebar--attached')
  expect(panel).toContain('id="pmo-teams-topic-floating-panel"')
  expect(panel).toContain("floating.openAnchor !== 'compact'")
  expect(panel).toContain('compactTop')
  expect(panel).toContain('launcherPosition')
  expect(panel).not.toContain('mainMode')
  expect(app).toContain('<PmoTeamsTopicFloatingPanel />')
  expect(app).toContain('<PmoTeamsTopicEntry placement="compact" footer />')
  expect(workbench).toContain('topicId?: string')
  expect(shared).toContain("PMO_TEAMS_TOPIC_ID = 'launcher:leader'")
  const callers = sourceFiles(renderer).filter((file) => readFileSync(file, 'utf8').includes('<PmoTeamsTopicEntry'))
  expect(callers.map((file) => relative(renderer, file)).sort()).toEqual([
    'App.tsx',
    'components/PmoTeamsTopicFloatingPanel.tsx'
  ])
})

it('uses the shipped AgentMux dragon asset for the PMO teams topic launcher', () => {
  const launcherAsset = readFileSync(join(renderer, 'assets/pmo-teams-topic-avatar.png'))
  const projectAsset = readFileSync(new URL('../resources/icon.png', import.meta.url))
  expect(launcherAsset.equals(projectAsset)).toBe(true)
})
