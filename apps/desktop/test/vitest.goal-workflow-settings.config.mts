import base from './vitest.goals-workflow.config.mts'

export default {
  ...base,
  test: {
    ...base.test,
    include: ['apps/desktop/test/goal-workflow-settings.test.tsx', 'apps/desktop/test/settings-work-preferences-control.test.ts']
  }
}
