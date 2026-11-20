import { GOAL_WORKFLOW_TEMPLATE_IDS, GOAL_WORKFLOW_TEMPLATES, resolveGoalWorkflowPreferences, type GoalsPreferences } from './goals-preferences.js'
import { readOriginalMoteConfiguration } from './mote-resources.js'

/** Read saved settings from the same original config used by the Workflows editor. */
export async function readGoalWorkflowPreferences(configurationPath: string) {
  const config = await readOriginalMoteConfiguration(configurationPath) as { goals?: GoalsPreferences } | null
  const workflow = resolveGoalWorkflowPreferences(config?.goals?.workflow)
  if (!GOAL_WORKFLOW_TEMPLATE_IDS.includes(workflow.template) ||
      ![workflow.maxConcurrent, workflow.maxAttempts].every(value => Number.isSafeInteger(value) && value >= 0))
    throw new Error('The saved Goals Workflows configuration is invalid.')
  return workflow
}

export async function readGoalWorkflowPlan(configurationPath: string) {
  const config = await readGoalWorkflowPreferences(configurationPath)
  if (config.template === 'off') return null
  return { id: config.template, ...GOAL_WORKFLOW_TEMPLATES[config.template],
    instructions: config.template === 'execution-review'
      ? 'Define the delivery and its repeatable check on the same Ticket. Subsequent Tickets depend on its independent signed review. Keep rework on the same Ticket with a new attempt.'
      : 'Define one evidence Ticket per independent source or question, each with a source check and an expected versioned result. Add a synthesis Ticket that depends on those verified deliveries. Write an explicit synthesis check against the current criteria.',
    completion: 'Prepare the evidence for human acceptance once all relevant Tickets pass.' }
}
