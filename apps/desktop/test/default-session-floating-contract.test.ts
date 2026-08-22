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

it('keeps Default Session on one floating launcher and one canonical Topic', () => {
  const entry = readFileSync(join(renderer, 'components/DefaultSessionEntry.tsx'), 'utf8')
  const panel = readFileSync(join(renderer, 'components/DefaultSessionFloatingPanel.tsx'), 'utf8')
  expect(entry).toContain('requestDefaultSessionFloatingOpen()')
  expect(entry).not.toContain('__menu')
  expect(panel).toContain("openScratchTopic('launcher:default', SCRATCH_WORKSPACE_ID)")
  expect(panel).toContain('<WorkspaceWorkbench workspaceId={SCRATCH_WORKSPACE_ID}')
  const callers = sourceFiles(renderer).filter((file) => readFileSync(file, 'utf8').includes('<DefaultSessionEntry'))
  expect(callers.map((file) => relative(renderer, file)).sort()).toEqual([
    'App.tsx',
    'components/GlobalAgentsSurface.tsx',
    'components/GlobalBoardSurface.tsx',
    'components/WorkspaceWorkbench.tsx'
  ])
})
