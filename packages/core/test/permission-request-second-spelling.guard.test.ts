import { describe, expect, it } from 'vitest'
import {
  createNumberedTerminalInteractionProtocol,
  normalizeTerminalInteraction,
  type TerminalPermissionOption
} from '../src/agent-interaction.js'
import { rawEventNamesForLifecycle } from '../src/agent-hook-event.js'

// ---------------------------------------------------------------------------
// 守「permission-request 的第二拼法」不被漏掉。
//
// canonical 表（agent-hook-event.ts）把 `PermissionRequest`（:73）与 `permissionRequest`（:279）
// 一并归一到 `permission-request`。`normalizeTerminalInteraction` 此前比的是原始拼法
// （`eventName === 'PermissionRequest'`），只认 PascalCase 那一种。
//
// 这个缺陷今天**不咬**：只有 claude 与 codex 声明了 interaction 协议，两者都发 PascalCase。所以
// 它是潜伏的，而不是活的——这份守卫存在的理由正是它潜伏：等哪天一个 camelCase 方言的 Provider
// 拿到 interaction 协议，漏掉的那一半会让它的授权请求**静默不弹框**（question 那条走
// `protocol.questionEvents`，是 Provider 自己声明的拼法，不受影响），Agent 停在等待、用户无从批准。
// 潜伏缺陷没人会在日常使用里撞见，只能靠守卫在改坏的那一刻叫出来。与 7377272b 是同一个决定。
//
// 派生而非手抄：原始名集合来自 `rawEventNamesForLifecycle('permission-request')`。手抄一份清单
// 正是本次要修的缺陷形状——将来表里再加一个方言拼法，这份守卫自动覆盖它。
//
// 判据钉**行为**（第二拼法与 PascalCase 那一种走同一分支、产出同一个 permission 请求），不是源码里
// 有没有某个字符串：`toContain` 不执行代码，对提前 return 与拼法替换都失明。
// ---------------------------------------------------------------------------

const PERMISSION_RAW_NAMES = rawEventNamesForLifecycle('permission-request')
// `PermissionRequest` 是被硬编码的那一个字面量；「第二拼法」= 除它以外的每一个。
const SECOND_SPELLINGS = PERMISSION_RAW_NAMES.filter((name) => name !== 'PermissionRequest')

const OPTIONS: readonly TerminalPermissionOption[] = [
  { id: 'allow-once', label: 'Allow', kind: 'allow-once', tier: 'safe', input: '1' },
  { id: 'reject-once', label: 'Deny', kind: 'reject-once', tier: 'safe', input: '' }
]

// `questionEvents` 刻意不含任何 permission 拼法，`questionTools` 也不含下面用的工具名——否则
// question 那条分支（在前）会先命中，测的就不是 permission 分支了。
const protocol = createNumberedTerminalInteractionProtocol({
  questionEvents: ['PreToolUse'],
  questionTools: ['askuserquestion'],
  permissionOptions: OPTIONS
})

function normalize(eventName: string) {
  return normalizeTerminalInteraction({
    receiptId: 'receipt-1',
    agentSessionId: 'agent-1',
    runId: 'run-1',
    providerId: 'codex',
    eventName,
    payload: { tool_name: 'Edit', tool_input: { path: 'src/index.ts' } }
  }, 100, protocol)
}

describe('permission-request 的每一种原始拼法都要弹出授权框', () => {
  // 这一组必须非空，否则整份守卫是一次无意义的空扫——「零个第二拼法」与「每个第二拼法都通过」
  // 在断言上同形。把 `permissionRequest: 'permission-request'`（:279）从表里删掉，这条红。
  it('canonical 表里确实存在第二拼法（否则本文件是空扫）', () => {
    expect(SECOND_SPELLINGS.length).toBeGreaterThan(0)
  })

  it.each(PERMISSION_RAW_NAMES)('%s 归一到 permission-request，产出授权请求', (eventName) => {
    // 把实现改回 `eventName === 'PermissionRequest'`，第二拼法这几条红（PascalCase 那条仍绿——
    // 它证明红不是「整个分支塌了」，而恰恰是「只认一种拼法」）。
    const request = normalize(eventName)
    expect(request).toMatchObject({
      kind: 'permission',
      id: 'receipt-1',
      agentSessionId: 'agent-1',
      toolName: 'Edit',
      options: [{ id: 'allow-once' }, { id: 'reject-once' }]
    })
  })

  it('不在表里的事件名不产出授权请求（判据没有宽到认下一切）', () => {
    // 把实现放宽成「非空就当 permission」这一类过宽变异，这条红。
    expect(normalize('PreCompact')).toBeUndefined()
  })
})
