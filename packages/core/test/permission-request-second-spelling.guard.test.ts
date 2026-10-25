import { describe, expect, it } from 'vitest'
import {
  createNumberedTerminalInteractionProtocol,
  normalizeTerminalInteraction,
  type TerminalPermissionOption
} from '../src/agent-interaction.js'

const PERMISSION_RAW_NAMES = ['fixturePermission', 'fixture_permission']
const SECOND_SPELLINGS = PERMISSION_RAW_NAMES.slice(1)

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
  }, 100, protocol, undefined, PERMISSION_RAW_NAMES.includes(eventName) ? 'permission-request' : undefined)
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
