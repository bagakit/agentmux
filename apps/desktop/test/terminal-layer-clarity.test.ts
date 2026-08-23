import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const renderer = join(import.meta.dirname, '..', 'src', 'renderer', 'src')
const sessionPane = readFileSync(join(renderer, 'components', 'SessionPane.tsx'), 'utf8')
const terminalView = readFileSync(join(renderer, 'components', 'TerminalView.tsx'), 'utf8')
const terminalCss = readFileSync(join(renderer, 'styles', 'terminal.css'), 'utf8')
const agentCss = readFileSync(join(renderer, 'styles', 'agent.css'), 'utf8')

describe('terminal content and input layers', () => {
  it('keeps PTY output in a bounded canvas and gives the Agent input its own terminal-mode rail', () => {
    expect(sessionPane).toContain('className="agent-terminal-stage"')
    expect(terminalView).toContain('className={`terminal-view__xterm ${hydrating ? \'terminal-view__xterm--hydrating\' : \'\'}`}')
    expect(sessionPane).toContain("data-input-surface={session.kind === 'agent' && viewMode === 'terminal' ? 'terminal' : 'activity'}")
    expect(sessionPane).toContain('className="agent-input-stack__rail"')
    expect(sessionPane).toContain('Agent input')
    expect(sessionPane).toContain('agentInputIdentity')
    expect(sessionPane).toContain('agentInputSessionId')
    expect(sessionPane).toContain('Agent input for')
  })

  it('pins the geometry and separation rules that prevent terminal output from colliding with the composer', () => {
    expect(terminalCss).toContain('.terminal-view { position: relative; width: 100%; height: 100%; overflow: hidden; }')
    expect(terminalCss).toContain('min-height: 0')
    expect(agentCss).toContain('.agent-terminal-stage { position: relative; width: 100%; height: 100%; overflow: hidden; }')
    expect(agentCss).toContain(".agent-input-stack[data-input-surface='terminal']")
    expect(agentCss).toContain('border-top: 1px solid var(--line-soft)')
    expect(agentCss).toContain(".agent-input-stack[data-input-surface='terminal'] .composer")
  })

  it('does not couple the shared terminal layer to a provider name or branded terminal copy', () => {
    const terminalStart = sessionPane.indexOf('<div className="agent-terminal-stage">')
    const activityStart = sessionPane.indexOf('<ActivityView')
    const inputStart = sessionPane.indexOf('<div\n          className="agent-input-stack"')
    expect(terminalStart).toBeGreaterThan(-1)
    expect(activityStart).toBeGreaterThan(terminalStart)
    expect(inputStart).toBeGreaterThan(activityStart)
    const renderedLayer = `${sessionPane.slice(terminalStart, activityStart)}\n${sessionPane.slice(inputStart)}\n${terminalCss}\n${agentCss}`
    expect(renderedLayer).not.toMatch(/\b(?:codex|claude|trae|hermes)\b/i)
  })
})
