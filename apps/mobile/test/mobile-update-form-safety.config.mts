import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './mobile-web.config.mts'

const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.MOBILE_FORM_MUTANT, report = process.env.MOBILE_FORM_LOADED
const variants: Record<string, { file: string; before: string; after: string }> = {
  'ignore-topic-operation': { file: 'apps/mobile/src/topics/MobileTopicOrganization.tsx', before: 'if (local.current.busy || local.current.unknown)', after: 'if (false)' },
  'ignore-original-request': { file: 'apps/mobile/src/recovery/device-workface.ts', before: "if (existing && !sameValue(existing, captured)) throw new Error('原操作身份已绑定其他请求；原记录未覆盖。')", after: "if (false) throw new Error('原操作身份已绑定其他请求；原记录未覆盖。')" },
  'ignore-late-receipt': { file: 'apps/mobile/src/recovery/device-workface.ts', before: "if (!sameValue(existing, captured)) throw new Error('原操作记录已改变；原回执未覆盖其他请求。')", after: "if (false) throw new Error('原操作记录已改变；原回执未覆盖其他请求。')" },
  'ignore-unpreserved': { file: 'apps/mobile/src/goals/goal-operation-recovery.tsx', before: "if (!item.saved || current.issue || (current.record.recordId ?? null) !== item.recordId || !retained.has(JSON.stringify(item.item))) return", after: "if (false) return" },
  'ignore-owner-fence': { file: 'apps/mobile/src/goals/MobileGoalLinks.tsx', before: "'goal.link-session', { goalId: goal.id, sessionId, operationId }, undefined, operation.fence", after: "'goal.link-session', { goalId: goal.id, sessionId, operationId }, undefined, undefined" },
  'wait-link-success': { file: 'apps/mobile/src/goals/MobileGoalLinks.tsx', before: '    void finishGoalOperation(operation, true)', after: '    await finishGoalOperation(operation, true)' },
  'wait-link-error': { file: 'apps/mobile/src/goals/MobileGoalLinks.tsx', before: '      void finishGoalOperation(operation, false)', after: '      await finishGoalOperation(operation, false)' },
  'wait-action-success': { file: 'apps/mobile/src/goals/MobileGoalActions.tsx', before: '    if (operation) void finishGoalOperation(operation, true)', after: '    if (operation) await finishGoalOperation(operation, true)' },
  'wait-action-error': { file: 'apps/mobile/src/goals/MobileGoalActions.tsx', before: '      if (operation) void finishGoalOperation(operation, false)', after: '      if (operation) await finishGoalOperation(operation, false)' }
}
if (mutant && !variants[mutant]) throw Error('Unknown bounded form mutation')
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), { name: 'loaded-mobile-form-owner', enforce: 'pre', transform(original, id) {
  const file = relative(root, id.split('?')[0]!)
  if (!Object.values(variants).some(value => value.file === file)) return
  let code = original
  const variant = mutant ? variants[mutant] : undefined
  if (variant?.file === file) {
    if (original.split(variant.before).length !== 2) throw Error('Form mutation must load exactly once')
    code = original.replace(variant.before, variant.after)
  }
  if (report) {
    const sha = (value: string) => createHash('sha256').update(value).digest('hex')
    const record = { file, originalSHA256: sha(original), loadedSHA256: sha(code), mutation: variant?.file === file ? mutant : null }
    code = `import { appendFileSync as __formLoaded } from 'node:fs'; __formLoaded(${JSON.stringify(report)}, ${JSON.stringify(JSON.stringify(record) + '\n')});\n` + code
  }
  return code === original ? undefined : { code, map: null }
} }], test: { ...base.test, include: ['test/mobile-update-form-safety.test.tsx', 'test/mobile-goal-recovery-product.test.tsx', 'test/mobile-goal-recovery-race.test.tsx'] } })
