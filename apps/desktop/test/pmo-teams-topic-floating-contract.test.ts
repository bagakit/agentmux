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

it('keeps one native anchored surface and one product footer caller for all Motes', () => {
  const entry = readFileSync(join(renderer, 'components/PmoTeamsTopicEntry.tsx'), 'utf8')
  const panel = readFileSync(join(renderer, 'components/PmoTeamsTopicFloatingPanel.tsx'), 'utf8')
  const styles = readFileSync(join(renderer, 'styles/pmo-teams-topic.css'), 'utf8')
  const chrome = readFileSync(join(renderer, 'styles/agent.css'), 'utf8')
  const app = readFileSync(join(renderer, 'App.tsx'), 'utf8')
  expect(entry).toContain('aria-expanded={visible}')
  expect(entry).toContain('pmoTeamsTopicAvatar')
  expect(panel).toContain('popover="auto"')
  expect(panel).toContain("placement: 'top-start'")
  expect(panel).toContain('topicId={target.topicId}')
  expect(panel).toContain('useScratchTopics(SCRATCH_WORKSPACE_ID)')
  expect(app).toContain('<PmoTeamsTopicFloatingPanel floating={moteFloating} setFloating={setMoteFloating} />')
  const expanded = chrome.match(/\.pmo-teams-topic-compact-launcher__button\[aria-expanded="true"\]\s*\{([^}]+)\}/)
  expect(expanded).not.toBeNull()
  expect(expanded![1]).toContain('border-color:')
  expect(expanded![1]).toContain('background:')
  const named = styles.match(/\.mote-chooser__name > strong\s*\{([^}]+)\}/)
  expect(named).not.toBeNull()
  expect(named![1]).toContain('font-size: var(--fs-body)')
  expect(styles).toContain('.pmo-teams-topic-floating:popover-open')
  expect(styles).not.toContain('titlebar')
  expect(styles).not.toContain('firework')
  const callers = sourceFiles(renderer).filter(file => readFileSync(file, 'utf8').includes('<PmoTeamsTopicEntry'))
  expect(callers.map(file => relative(renderer, file)).sort()).toEqual(['components/SurfaceNavigation.tsx'])
})

it('uses the shipped AgentMux dragon asset for the PMO teams topic launcher', () => {
  const launcherAsset = readFileSync(join(renderer, 'assets/pmo-teams-topic-avatar.png'))
  const projectAsset = readFileSync(new URL('../resources/icon.png', import.meta.url))
  expect(launcherAsset.equals(projectAsset)).toBe(true)
})
