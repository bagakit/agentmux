import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AgentMuxAgentRuntimeStatus } from '../src/client.js'
import { pmoSessionMatches, pmoSessionStatus } from '../src/pmo-session-filter.js'

/**
 * `pmo sessions --status` 曾经**恒假**：过滤读一个 `AgentMuxAgentSession` 上不存在的 `processState`
 * 字段（经 `as unknown as` 洗白类型），于是 `--status <任意值>` 永远返回零条。这组用例把过滤钉在
 * 诚实来源 `observation.process` 上：进程活性一改，`--status` 的命中集必须跟着变，否则红。
 */

// 只造过滤真正读到的三处：observation.process / session.agentSessionId / session.updatedAt。
// 其余轴（semantic/readiness/…）过滤不看，留最小可信形状，不假装填一份完整快照。
function sessionAt(process: 'running' | 'exited' | 'interrupted', agentSessionId = 's1', updatedAt = 1000): AgentMuxAgentRuntimeStatus {
  return {
    session: { agentSessionId, updatedAt },
    observation: { process }
  } as AgentMuxAgentRuntimeStatus
}

describe('pmo sessions status filter', () => {
  it('读的是诚实的 observation.process，不是一个不存在的字段', () => {
    // 若谓词回退去读 session.processState（那个幽灵字段），下面这行会拿到 undefined→'' 而非 'running'。
    expect(pmoSessionStatus(sessionAt('running'))).toBe('running')
    expect(pmoSessionStatus(sessionAt('interrupted'))).toBe('interrupted')
  })

  it('--status 按进程活性真的筛选，而不是永远放行或永远拒绝', () => {
    const sessions = [sessionAt('running', 'a'), sessionAt('exited', 'b'), sessionAt('running', 'c')]
    const running = sessions.filter((session) => pmoSessionMatches(session, { status: 'running' }))
    // 恒假 bug 会让这里得到 []；把 === 改成 !== 之类的取反会得到全 3 条。钉死这一份具体命中集。
    expect(running.map((session) => session.session.agentSessionId)).toEqual(['a', 'c'])
    expect(sessions.filter((session) => pmoSessionMatches(session, { status: 'exited' })).map((session) => session.session.agentSessionId)).toEqual(['b'])
    // 无 status 时不筛（三条都在），证明过滤不是靠「谁都不匹配」假装工作。
    expect(sessions.filter((session) => pmoSessionMatches(session, {})).length).toBe(3)
  })

  it('sessionId 与 since 与 status 是合取，各自都能独立排除', () => {
    const older = sessionAt('running', 'a', 500)
    const newer = sessionAt('running', 'a', 1500)
    expect(pmoSessionMatches(newer, { sessionId: 'a', status: 'running', since: 1000 })).toBe(true)
    expect(pmoSessionMatches(older, { sessionId: 'a', status: 'running', since: 1000 })).toBe(false)
    expect(pmoSessionMatches(newer, { sessionId: 'b' })).toBe(false)
    expect(pmoSessionMatches(newer, { status: 'exited' })).toBe(false)
  })

  it('生产代码真的调用了这个谓词，而不是留一份平行实现', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/agentmux.ts', import.meta.url)), 'utf8')
    expect(source).toContain('pmoSessionMatches(session, { sessionId, status, since })')
    // 幽灵字段的 cast 必须已消失——它是这条 bug 的标记物。
    expect(source).not.toContain('processState?: string')
    expect(source).not.toContain('as unknown as { processState')
  })
})
