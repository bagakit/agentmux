import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './mobile-web.config.mts'

const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.MOBILE_FORM_MUTANT, report = process.env.MOBILE_FORM_LOADED
const variants: Record<string, { file: string; before: string; after: string }> = {
  'ignore-topic-operation': { file: 'apps/mobile/src/topics/MobileTopicOrganization.tsx', before: 'if (local.current.busy || local.current.unknown)', after: 'if (false)' },
  'ignore-original-request': { file: 'apps/mobile/src/recovery/device-workface.ts', before: "if (!sameValue(original, captured)) throw new Error('原操作身份已绑定其他请求；原记录未覆盖。')", after: "if (false) throw new Error('原操作身份已绑定其他请求；原记录未覆盖。')" },
  'ignore-late-receipt': { file: 'apps/mobile/src/recovery/device-workface.ts', before: "if (!sameValue(original, captured)) throw new Error('原操作记录已改变；原回执未覆盖其他请求。')\n      if (confirmation === 'confirmed')", after: "if (false) throw new Error('原操作记录已改变；原回执未覆盖其他请求。')\n      if (confirmation === 'confirmed')" },
  'ignore-unpreserved': { file: 'apps/mobile/src/goals/goal-operation-recovery.tsx', before: "if (!item.saved || current.issue || (current.record.recordId ?? null) !== item.recordId || !record || item.confirmed && record.confirmation !== 'confirmed') return", after: "if (false) return" },
  'ignore-owner-fence': { file: 'apps/mobile/src/goals/MobileGoalLinks.tsx', before: "'goal.link-session', { goalId: goal.id, sessionId, operationId }, undefined, operation.fence", after: "'goal.link-session', { goalId: goal.id, sessionId, operationId }, undefined, undefined" },
  'wait-link-success': { file: 'apps/mobile/src/goals/MobileGoalLinks.tsx', before: '    void finishGoalOperation(operation, true)', after: '    await finishGoalOperation(operation, true)' },
  'wait-link-error': { file: 'apps/mobile/src/goals/MobileGoalLinks.tsx', before: '      void finishGoalOperation(operation, false)', after: '      await finishGoalOperation(operation, false)' },
  'wait-action-success': { file: 'apps/mobile/src/goals/MobileGoalActions.tsx', before: '    if (operation) void finishGoalOperation(operation, true)', after: '    if (operation) await finishGoalOperation(operation, true)' },
  'wait-action-error': { file: 'apps/mobile/src/goals/MobileGoalActions.tsx', before: '      if (operation) void finishGoalOperation(operation, false)', after: '      if (operation) await finishGoalOperation(operation, false)' },
  'allow-failed-copy': { file: 'apps/mobile/src/goals/goal-operation-recovery.tsx', before: 'if (success && pending && operations.has(pending))', after: 'if (pending && operations.has(pending))' },
  'drop-late-confirmation': { file: 'apps/mobile/src/goals/goal-operation-recovery.tsx', before: 'if (!confirmed) return false\n    value.discarded = false', after: 'if (true) return false\n    value.discarded = false' },
  'retarget-original-record': { file: 'apps/mobile/src/goals/goal-operation-recovery.tsx', before: "if (owner.recordIdentity() !== pending.recordId) { pending.issue = '设备工作面已替换；原请求不写入其他记录，请恢复原工作面后重试。'; notify(); return }", after: 'pending.recordId = owner.recordIdentity()' },
  'ignore-queued-cancellation': { file: 'apps/mobile/src/recovery/device-workface.ts', before: '(cancelled ? Promise.race([execution, cancelled]) : execution)', after: '(cancelled?.catch(() => {}), execution)' },
  'block-unreadable-exit': { file: 'apps/mobile/src/goals/goal-operation-recovery.tsx', before: "pending.discarded = true; operations.delete(pending)\n                setCopyIssue(actual === 'absent'", after: "if (actual !== 'absent') return\n                pending.discarded = true; operations.delete(pending)\n                setCopyIssue(actual === 'absent'" },
  'late-lock-callback': { file: 'apps/mobile/src/recovery/device-storage-lock.ts', before: 'if (signal?.aborted) { cancel(); return }; result = action()', after: 'if (false) { cancel(); return }; result = action()' },
  'delete-confirmed-record': { file: 'apps/mobile/src/recovery/device-workface.ts', before: "if (confirmation === 'confirmed') return record", after: 'if (false) return record' },
  'forget-confirmed-record': { file: 'apps/mobile/src/recovery/device-workface.ts', before: "_confirmation === 'confirmed' ? 'confirmed' : 'saved'", after: "false ? 'confirmed' : 'saved'" }
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
} }], test: { ...base.test, include: ['test/mobile-update-form-safety.test.tsx', 'test/mobile-goal-recovery-product.test.tsx', 'test/mobile-goal-recovery-race.test.tsx', 'test/mobile-goal-recovery-exit.test.tsx'] } })
