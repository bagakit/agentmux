import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'
const alignment = 'apps/desktop/src/renderer/src/components/GoalAlignment.tsx'
const board = 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx'
await verifyRendererSourceMutations({
  name: 'goals-t3-ui-mutations-final',
  tests: ['apps/desktop/test/goals-alignment-workflow.test.tsx'],
  sources: [alignment, board, 'apps/desktop/src/renderer/src/components/GoalDetail.tsx', 'apps/desktop/src/renderer/src/lib/goal-presentation.ts'],
  mutations: [
    { label: 'confirm-unreviewed-revision', file: alignment, before: 'confirmDemandGoal(demand.id, attempt.revision)', after: 'confirmDemandGoal(demand.id, attempt.revision + 1)' },
    { label: 'accept-unreviewed-submission', file: alignment, before: 'acceptDemandResult(demand.id, attempt.revision, attempt.submissionId, attempt.gaps)', after: "acceptDemandResult(demand.id, attempt.revision, 'unreviewed', attempt.gaps)" },
    { label: 'gap-explicit-choice-dropped', file: alignment, before: 'submissionId: grounding.submissionId, gaps: true', after: 'submissionId: grounding.submissionId, gaps: false' },
    { label: 'unknown-gets-gap-shortcut', file: alignment, before: 'const gapIssue = groundingAcceptanceIssue(alignment, grounding, true)', after: 'const gapIssue = null' },
    { label: 'reload-auto-confirms-unread-content', file: alignment, before: 'await refreshDemand(demand.id); onFeedbackChange({ failure: null })', after: 'await refreshDemand(demand.id); await confirmDemandGoal(demand.id, useAppStore.getState().demands[demand.id]!.alignment!.revision); onFeedbackChange({ failure: null })' },
    { label: 'acknowledgement-feedback-detached-on-navigation', file: board, before: 'acknowledgementFeedback={acknowledgementFeedback[selectedDemand.id] ?? EMPTY_GOAL_ACKNOWLEDGEMENT}', after: 'acknowledgementFeedback={EMPTY_GOAL_ACKNOWLEDGEMENT}' },
    { label: 'evidence-location-dropped', file: alignment, before: 'openFile(path, undefined, location, workspace.id)', after: 'openFile(path, undefined, undefined, workspace.id)' },
    { label: 'list-stage-detached-from-owner-facts', file: board, before: '{goalNextStep(demand)}', after: "{'Align goal'}" }
  ]
})
