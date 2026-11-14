/** Each virtual production edit must fail its unique real MobileApp/Goal-owner consumer. */
export const mobileBrandMutations = {
  'brand-art-hidden': {
    file: 'apps/mobile/src/goals/MobileGoalsSurface.tsx',
    before: '<img className="mobile-goals-start__art"',
    after: '<img hidden className="mobile-goals-start__art"',
    target: 'mobile brand art appears only on the visible Goal directory'
  },
  'brand-create-inert': {
    file: 'apps/mobile/src/goals/MobileGoalsSurface.tsx',
    before: 'aria-label="开始新目标" onClick={() => setCreateOpen(true)}',
    after: 'aria-label="开始新目标" onClick={() => undefined}',
    target: 'mobile brand CTA opens the original form without writes'
  },
  'brand-discussion-wrong-goal': {
    file: 'apps/mobile/src/goals/MobileGoalAlignment.tsx',
    before: "invoke('goal.discuss', { goalId: goal.id, mode: 'grill' })",
    after: "invoke('goal.discuss', { goalId: 'wrong-brand-goal', mode: 'grill' })",
    target: 'mobile brand proposal actions retain the exact Goal owner'
  }
}
export const mobileBrandOwners = [
  'apps/mobile/src/MobileApp.tsx',
  'apps/mobile/src/goals/MobileGoalsSurface.tsx',
  'apps/mobile/src/goals/MobileGoalCreate.tsx',
  'apps/mobile/src/goals/MobileGoalAlignment.tsx',
  'apps/mobile/src/goals/goals.css',
  'apps/mobile/test/mobile-goal-owner.test.tsx',
  'packages/core/src/public-rpc-service.ts',
  'apps/host/src/goals.ts'
]
