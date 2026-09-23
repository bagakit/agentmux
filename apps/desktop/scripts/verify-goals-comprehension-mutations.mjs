import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const alignment = 'apps/desktop/src/renderer/src/components/GoalAlignment.tsx'
const detail = 'apps/desktop/src/renderer/src/components/GoalDetail.tsx'
const board = 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx'
const presentation = 'apps/desktop/src/renderer/src/lib/goal-presentation.ts'
await verifyRendererSourceMutations({
  name: 'goals-comprehension-r1-ui-mutations-final',
  tests: ['apps/desktop/test/goals-alignment-workflow.test.tsx'],
  sources: [alignment, detail, presentation, board],
  mutations: [
    { label: 'row-loses-retained-recovery-action', file: board, before: "acknowledgementFailed ? 'Reload current proposal' : goalNextStep(demand)", after: 'goalNextStep(demand)' },
    { label: 'confirmation-competes-with-recovery', file: alignment, before: '!failure && !alignment.confirmedAt && !confirmIssue', after: '!alignment.confirmedAt && !confirmIssue' },
    { label: 'agreed-no-report-fact-hidden', file: alignment, before: "demand.status === 'done' || alignment?.confirmedAt ?", after: "demand.status === 'done' ?" },
    { label: 'done-without-proposal-misrepresented', file: presentation, before: "if (demand.status === 'done' && !grounding)", after: "if (demand.status === 'done' && !grounding && alignment?.confirmedAt)" },
    { label: 'report-without-target-hidden', file: alignment, before: '{grounding ? <section', after: '{grounding && alignment ? <section' },
    { label: 'open-discussion-secretly-sends-request', file: detail, before: 'onClick={onOpenMote}', after: 'onClick={onGrill}' },
  ],
})
