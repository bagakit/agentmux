import { provePerformanceOwner } from './performance-owner-proof.mjs'
const overview='apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx'
const panel='apps/desktop/src/renderer/src/components/performance/PerformancePanel.tsx'
const test='apps/desktop/test/toolkit-agent-cards-performance.test.tsx'
provePerformanceOwner({name:'toolkit-agent-cards-performance',config:'apps/desktop/test/toolkit-agent-cards-performance.config.mts',
  owners:[overview,panel],tests:[test],minimumTests:7,mutantTests:[test],
  mutants:[
    ['card-consumer-disconnected',overview,'<ToolkitAgentCard card={card} fields={fields} resolvedFacts={facts} />','null'],
    ['totals-sum-row-peaks',overview,'value={cpu(totals?.cpuPercent)}','value={cpu(runs.reduce((sum, run) => sum + (run.cpuPercent ?? 0), 0))}'],
    ['totals-selected-run-only',overview,'value={memory(totals?.rssKib)}','value={memory(activeRun?.rssKib)}'],
    ['field-config-ignored',overview,'const fields = cardDocument?.fields ?? NO_FIELDS',"const fields: ToolkitAgentCardField[] = ['name']"],
    ['host-key-lost',overview,'JSON.stringify([run.hostId, run.runId])','JSON.stringify([run.runId])'],
    ['duplicate-card-last-wins',overview,'result.has(key) ? null : card','card'],
    ['public-document-disconnected',overview,'snapshot?.document?.agentCards','undefined as ToolkitMetricsSnapshot["document"] extends null ? never : undefined'],
    ['actual-panel-disconnected',panel,'<PerformanceOverview {...observation}','<PerformanceOverview {...observation} snapshot={null}']
  ],callers:[
    [panel,'<PerformanceOverview'],[overview,'<ToolkitAgentCard card={card}'],[overview,'useToolkitAgentCards(visibleCards, fields'],
    ['apps/desktop/src/renderer/src/components/toolkit/ToolkitStatusBar.tsx','<PerformancePanel'],
    [test,'root.render(<App />)']
  ]})
