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

it('keeps Leader Topic on one fixed floating/compact launcher and one canonical Topic', () => {
  const entry = readFileSync(join(renderer, 'components/LeaderTopicEntry.tsx'), 'utf8')
  const panel = readFileSync(join(renderer, 'components/LeaderTopicFloatingPanel.tsx'), 'utf8')
  const styles = readFileSync(join(renderer, 'styles/leader-topic.css'), 'utf8')
  const app = readFileSync(join(renderer, 'App.tsx'), 'utf8')
  const workbench = readFileSync(join(renderer, 'components/WorkspaceWorkbench.tsx'), 'utf8')
  const shared = readFileSync(new URL('../src/shared/scratch-topics.ts', import.meta.url), 'utf8')
  expect(entry).toContain('requestLeaderTopicFloatingOpen')
  expect(entry).toContain('leader-topic-floating-launcher')
  expect(entry).toContain('leaderTopicAvatar')
  expect(entry).toContain('launcherPlacement')
  expect(entry).toContain('More Leader Topic actions')
  expect(entry).toContain('Close ${LEADER_TOPIC_TITLE}')
  expect(entry).toContain('aria-expanded={placement === \'floating\' ? floating.open : undefined}')
  expect(styles).toContain('.leader-topic-floating-launcher__button')
  expect(styles).toContain('border-radius: var(--radius-lg)')
  expect(styles).toContain('object-fit: contain')
  expect(styles).toContain('gap: 2px')
  expect(styles).toContain('.leader-topic-floating__titlebar--attached')
  expect(panel).toContain('api.scratch.ensureTopic(SCRATCH_WORKSPACE_ID, LEADER_TOPIC_ID)')
  expect(panel).toContain('api.scratch.renameTitle(SCRATCH_WORKSPACE_ID, LEADER_TOPIC_ID, LEADER_TOPIC_TITLE)')
  expect(panel).toContain('openScratchTopic(LEADER_TOPIC_ID, SCRATCH_WORKSPACE_ID)')
  expect(panel).toContain('topicId={LEADER_TOPIC_ID}')
  expect(panel).toContain('if (floating.open)')
  expect(panel).toContain('requestLeaderTopicFloatingClose()')
  expect(panel).toContain('leader-topic-floating__titlebar--attached')
  expect(panel).toContain('id="leader-topic-floating-panel"')
  expect(panel).toContain('launcherPosition')
  expect(panel).not.toContain('mainMode')
  expect(app).toContain('<LeaderTopicFloatingPanel />')
  expect(app).toContain('<LeaderTopicEntry placement="compact" />')
  expect(workbench).toContain('topicId?: string')
  expect(shared).toContain("LEADER_TOPIC_ID = 'launcher:leader'")
  const callers = sourceFiles(renderer).filter((file) => readFileSync(file, 'utf8').includes('<LeaderTopicEntry'))
  expect(callers.map((file) => relative(renderer, file)).sort()).toEqual([
    'App.tsx',
    'components/LeaderTopicFloatingPanel.tsx'
  ])
})

it('uses the shipped AgentMux dragon asset for the Leader Topic launcher', () => {
  const launcherAsset = readFileSync(join(renderer, 'assets/leader-topic-avatar.png'))
  const projectAsset = readFileSync(new URL('../resources/icon.png', import.meta.url))
  expect(launcherAsset.equals(projectAsset)).toBe(true)
})
