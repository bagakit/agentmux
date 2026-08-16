import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkflowCard } from '../src/renderer/src/components/workflow/WorkflowCard.js'
import { WorkflowDock } from '../src/renderer/src/components/workflow/WorkflowDock.js'
import { WorkflowPhase } from '../src/renderer/src/components/workflow/WorkflowPhase.js'
import { WorkflowToolRow } from '../src/renderer/src/components/workflow/WorkflowToolRow.js'
import { largeWorkflow, legacyDaemonWorkflow, runningWorkflow } from '../src/renderer/src/components/workflow/fixtures.js'
import { visibleWorkflowAgents, type WorkflowAgent } from '../src/renderer/src/components/workflow/types.js'
import { workflowPresentation } from '../src/renderer/src/components/workflow/presentation.js'
import { allStyleRules } from './helpers/styles.js'

describe('Workflow reusable surface components', () => {
  it('renders the running summary, progress facts and expanded phases from public props', () => {
    const markup = renderToStaticMarkup(createElement(WorkflowCard, { workflow: runningWorkflow }))
    expect(markup).toContain('data-workflow-id="review-changes-running"')
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('4/11 agents')
    expect(markup).toContain('Review: review:security')
    expect(markup).toContain('aria-valuenow="4"')
    expect(markup).toContain('review:security')
    expect(markup).toContain('verify:db.ts')
  })

  it('keeps failed and current agents visible while collapsing only a quiet tail', () => {
    const agents: WorkflowAgent[] = [
      ...Array.from({ length: 12 }, (_, index) => ({ id: `running-${index}`, label: `running-${index}`, status: 'running' as const })),
      { id: 'failed', label: 'failed', status: 'failed' as const },
      { id: 'queued-1', label: 'queued-1', status: 'queued' as const },
      { id: 'queued-2', label: 'queued-2', status: 'queued' as const }
    ]
    const result = visibleWorkflowAgents(agents)
    expect(result.visible.map((item) => item.id)).toEqual([...agents.slice(0, 13).map((item) => item.id)])
    expect(result.hiddenCount).toBe(2)
    const phase = renderToStaticMarkup(createElement(WorkflowPhase, {
      phase: { id: 'large', label: 'Large', status: 'running', completed: 12, total: 15, agents, defaultExpanded: true }
    }))
    expect(phase).toContain('failed')
    expect(phase).toContain('… 还有 2 个')
    expect(phase).not.toContain('queued-1')
  })

  it('renders the legacy daemon as a flat tool row without an empty disclosure shell', () => {
    const markup = renderToStaticMarkup(createElement(WorkflowCard, { workflow: legacyDaemonWorkflow }))
    expect(markup).toContain('daemon 版本较旧，暂无阶段明细')
    expect(markup).toContain('wf-tool-row')
    expect(markup).not.toContain('wf-card')
    expect(markup).not.toContain('wf-phase__head')
    expect(markup).not.toContain('aria-expanded')
  })

  it('reuses the same card structure for dock density and keeps a close affordance', () => {
    const markup = renderToStaticMarkup(createElement(WorkflowDock, { workflow: runningWorkflow }))
    expect(markup).toContain('aria-label="Workflow progress dock"')
    expect(markup).toContain('aria-label="关闭 Workflow 进度"')
    expect(markup).toContain('wf-card--dock')
    expect(markup).toContain('data-workflow-id="review-changes-running"')
  })

  it('separates legacy capability policy and supports controlled disclosure', () => {
    expect(workflowPresentation(legacyDaemonWorkflow)).toEqual({ kind: 'tool', notice: 'daemon 版本较旧，暂无阶段明细' })
    expect(workflowPresentation(runningWorkflow)).toEqual({ kind: 'card', defaultExpanded: true })
    let expanded = false
    const markup = renderToStaticMarkup(createElement(WorkflowCard, {
      workflow: runningWorkflow,
      expanded,
      onExpandedChange: (next: boolean) => { expanded = next }
    }))
    expect(markup).toContain('aria-expanded="false"')
    expect(expanded).toBe(false)
  })

  it('keeps the tool-row fallback in the same low-noise state language', () => {
    const markup = renderToStaticMarkup(createElement(WorkflowToolRow, {
      title: 'Bash npm run build', workflowName: 'review-changes', status: 'running', duration: '2m 13s', notice: 'daemon 版本较旧，暂无阶段明细'
    }))
    expect(markup).toContain('Workflow review-changes')
    expect(markup).toContain('2m 13s')
    expect(markup).toContain('daemon 版本较旧')
    expect(markup).toContain('data-status="running"')
  })

  it('has a non-empty style source with the responsive, state and accessibility rules', () => {
    const styles = allStyleRules()
    expect(styles.length).toBeGreaterThan(0)
    const selectors = [
      '.wf-card[data-status=',
      '.wf-agents--grid',
      '.wf-agent[data-state=',
      '.wf-card--dock',
      '@media (max-width: 560px)',
      '@media (pointer: coarse)',
      '@media (prefers-reduced-motion: reduce)'
    ]
    for (const selector of selectors) expect(styles).toContain(selector)
  })
})
