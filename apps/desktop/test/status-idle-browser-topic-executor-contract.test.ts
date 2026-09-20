import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allStyles } from './helpers/styles'

const rendererRoot = resolve(__dirname, '../src/renderer/src')

function read(relativePath: string): string {
  return readFileSync(join(rendererRoot, relativePath), 'utf8')
}

function sliceFrom(source: string, anchor: string, endAnchor?: string): string {
  const start = source.indexOf(anchor)
  expect(start, `contract anchor missing: ${anchor}`).toBeGreaterThan(-1)
  const end = endAnchor ? source.indexOf(endAnchor, start + anchor.length) : source.length
  if (endAnchor) expect(end, `contract end anchor missing: ${endAnchor}`).toBeGreaterThan(start)
  const result = source.slice(start, endAnchor ? end : undefined)
  expect(result.length, `contract slice empty: ${anchor}`).toBeGreaterThan(anchor.length)
  return result
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string' && /\.(tsx?|css)$/.test(entry))
    .map((entry) => join(root, entry))
}

describe('status/browser/topic/executor integration contract', () => {
  it('keeps the Browser page flexible and operation status inside its existing toolbar', () => {
    const css = allStyles()
    const surface = sliceFrom(css, '.browser-surface {', '.browser-toolbar {')
    const stage = sliceFrom(css, '.browser-stage {', '.browser-surface > .browser-toolbar')
    const status = sliceFrom(css, '.browser-operation-status__trigger {', '.browser-operation-status__trigger:hover')
    expect(surface).toMatch(/display:\s*flex/)
    expect(surface).toMatch(/flex-direction:\s*column/)
    expect(stage).toMatch(/flex:\s*1/)
    expect(status).toMatch(/width:\s*27px/)
    expect(status).toMatch(/height:\s*27px/)
    const operationSource = read('components/BrowserOperationSurface.tsx')
    expect(operationSource).toContain('BrowserOperationStatus')
    expect(operationSource).toContain("phase === 'idle'")
    expect(operationSource).not.toContain('browser-rsi-rail')
  })

  it('keeps every Topic row action inside its own action cell', () => {
    const source = read('components/WorkspaceTopicsPanel.tsx')
    const actions = sliceFrom(source, 'className="workspace-topic-actions"')
    expect(actions).toMatch(/onClick=\{\(event\) => \{ event\.stopPropagation\(\)/)
    expect(actions).toContain('Reveal')
    const css = read('styles/dock.css')
    const row = sliceFrom(css, '.workspace-topic-item {')
    expect(row).toMatch(/grid-template-columns/)
    expect(css).toContain('.workspace-topic-actions')
  })

  it('finds real production consumers of the shared Executor identity and settings route', () => {
    const files = sourceFiles(rendererRoot)
    const consumers = files
      .filter((file) => !file.endsWith('/components/AgentAvatar.tsx'))
      .filter((file) => /<AgentAvatar\b/.test(readFileSync(file, 'utf8')))
    expect(consumers.length).toBeGreaterThan(0)
    expect(consumers.some((file) => file.endsWith('/components/WorkbenchTabMarks.tsx'))).toBe(true)
    expect(consumers.some((file) => file.endsWith('/components/TopicPresence.tsx'))).toBe(true)
    const avatar = read('components/AgentAvatar.tsx')
    expect(avatar).toContain('navigation.open(\'agents\', resolvedExecutorId)')
    expect(avatar).toContain('onPointerEnter={show}')
    const settings = read('components/SettingsPanel.tsx')
    expect(settings).toContain('executorId={executorId}')
  })

  it('connects the idle count to Project/Scratch tree rows without duplicating status truth', () => {
    const board = read('lib/project-board.ts')
    expect(board).toContain('idleAgentCount')
    const sidebar = read('components/WorkspaceSidebar.tsx')
    expect(sidebar).toContain('idleAgentCount')
    expect(sidebar).toMatch(/idle|Idle/)
    const state = read('lib/session-state.ts')
    expect(state).toContain('displayStateForAgentError')
    expect(state).toContain('AGENT_RUN_EXITED')
  })
})
