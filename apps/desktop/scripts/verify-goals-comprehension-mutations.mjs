import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const alignment = 'apps/desktop/src/renderer/src/components/GoalAlignment.tsx'
const detail = 'apps/desktop/src/renderer/src/components/GoalDetail.tsx'
const presentation = 'apps/desktop/src/renderer/src/lib/goal-presentation.ts'
await verifyRendererSourceMutations({
  name: 'goals-comprehension-ui-mutations',
  tests: ['apps/desktop/test/goals-alignment-workflow.test.tsx'],
  sources: [alignment, detail, presentation],
  mutations: [
    { label: 'agreed-no-report-fact-hidden', file: alignment, before: "demand.status === 'done' || alignment?.confirmedAt ?", after: "demand.status === 'done' ?" },
    { label: 'done-without-proposal-misrepresented', file: presentation, before: "if (demand.status === 'done' && !grounding)", after: "if (demand.status === 'done' && !grounding && alignment?.confirmedAt)" },
    { label: 'report-without-target-hidden', file: alignment, before: '{grounding ? <section', after: '{grounding && alignment ? <section' },
    { label: 'open-discussion-secretly-sends-request', file: detail, before: 'onClick={onOpenMote}', after: 'onClick={onGrill}' },
  ],
})
