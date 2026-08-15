import { describe, expect, it } from 'vitest'
import type { SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { activityContextsForWorkspaces, buildActivityGroups } from '../src/renderer/src/lib/activity-groups'

function agent(id: string, workspacePath: string, overrides: Partial<Extract<SessionSnapshot, { kind: 'agent' }>> = {}): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: id.startsWith('claude') ? 'claude' : 'codex',
    executorId: 'codex',
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    hostId: 'local',
    workspacePath,
    label: id,
    createdAt: 1,
    updatedAt: 10,
    processState: 'running',
    status: { state: 'working', source: 'run-process', observedAt: 10 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } },
    ...overrides
  } as SessionSnapshot
}

function workspace(id: string, path: string, branch?: string, hostId = 'local'): WorkspaceRecord {
  return { id, name: id, path, hostId, kind: branch ? 'worktree' : 'folder', ...(branch ? { branch } : {}) } as WorkspaceRecord
}

describe('Activity work-line grouping', () => {
  it('groups multiple Agents by explicit branch/worktree context', () => {
    const contexts = activityContextsForWorkspaces([
      workspace('w-main', 'repo', 'main'),
      workspace('w-feature', 'repo-feature', 'feat/ui')
    ])
    const groups = buildActivityGroups([
      agent('codex-1', 'repo'),
      agent('claude-1', 'repo'),
      agent('codex-2', 'repo-feature')
    ], contexts)

    expect(groups.map((group) => [group.label, group.sessions.map((session) => session.id)])).toEqual([
      ['feat/ui', ['codex-2']],
      ['main', ['claude-1', 'codex-1']]
    ])
  })

  it('keeps same path on different hosts and unbound sessions separate', () => {
    const contexts = activityContextsForWorkspaces([
      workspace('local', 'repo', 'main', 'local'),
      workspace('remote', 'repo', 'main', 'studio')
    ])
    const groups = buildActivityGroups([
      agent('local-agent', 'repo'),
      agent('remote-agent', 'repo', { hostId: 'studio' }),
      agent('orphan', 'elsewhere')
    ], contexts)

    expect(groups.map((group) => ({ label: group.label, host: group.hostId, ids: group.sessions.map((session) => session.id) }))).toEqual([
      { label: 'main', host: 'local', ids: ['local-agent'] },
      { label: 'main', host: 'studio', ids: ['remote-agent'] },
      { label: 'Unassigned', host: 'local', ids: ['orphan'] }
    ])
  })

  it('does not merge unbound Sessions from different Hosts into one misleading row', () => {
    const groups = buildActivityGroups([
      agent('local-orphan', 'elsewhere'),
      agent('remote-orphan', 'elsewhere', { hostId: 'studio' })
    ])

    expect(groups.map((group) => ({ label: group.label, host: group.hostId, ids: group.sessions.map((session) => session.id) }))).toEqual([
      { label: 'Unassigned', host: 'local', ids: ['local-orphan'] },
      { label: 'Unassigned', host: 'studio', ids: ['remote-orphan'] }
    ])
  })

  it('一个跑完的 Agent 不会把它所在的组顶到「在干活」之上——完成不是一个请求', () => {
    // 这条守的是组间排序里那个曾经手抄的排除：`!category || category === 'done'`。它今天由
    // `isUrgentAttention` 回答，而这个判据要能在那个清单被扩错时报红。
    //
    // 为什么必须是「完成 + 在跑」**同一组**：`ATTENTION_SORT_RANK` 里 done 与 idle 同为 3，所以一个
    // 只有 done 的组，无论 done 算不算紧急，档位都是 3——分歧不可观测。把一个 working 放进同一组，
    // 两条路才分岔：正确时 `groupAttention` 返回 null，这组退到 `workingAgentCount > 0` 的 working
    // （2）；把 done 错当紧急时它返回 'done'，档位变成 3。
    //
    // 光这样还不够——实测过：两组都是 2 时并列，尾部的 `label.localeCompare` 恰好给出与「mixed 掉到
    // 3」相同的顺序，于是变异后照样绿。所以 mixed 必须在**并列时赢**，靠的是排序的第二段
    // `updatedAt` 倒序。这样正确答案是 mixed 在前，而把 done 当紧急会让它掉到 busy 之后——变异这时
    // 才真的翻面。判据落在顺序上，不落在某个内部字段，因为顺序才是用户看得见的那一面。
    const contexts = activityContextsForWorkspaces([
      workspace('w-mixed', 'repo-mixed', 'mixed'),
      workspace('w-busy', 'repo-busy', 'busy')
    ])
    const groups = buildActivityGroups(
      [
        agent('mixed-done', 'repo-mixed', {
          updatedAt: 50,
          status: { state: 'done', source: 'native-hook', observedAt: 50 }
        } as never),
        agent('mixed-working', 'repo-mixed', { updatedAt: 50 } as never),
        agent('busy-working', 'repo-busy', { updatedAt: 20 } as never)
      ],
      contexts
    )

    // 自证：两组都得真的在场，否则下面比的是一个长度为 1 的清单，恒真。
    expect([...groups.map((group) => group.label)].sort()).toEqual(['busy', 'mixed'])
    expect(
      groups.map((group) => group.label),
      '组里有一个跑完的 Agent，就把整组排到在干活的组后面了——done 被当成了一个请求'
    ).toEqual(['mixed', 'busy'])
  })

  it('有人在等你的组排在只是在干活的组前面——组间的第一判据是急迫档，不是谁最近动过', () => {
    // 上面那条守的是「done 算不算紧急」，它构造的是一个**并列**（两组都该是 rank 2），于是
    // `leftRank - rightRank` 恒为 0，整条排序实际只由 `updatedAt` 倒序决出——把那一段主判据整个删掉，
    // 上面那条、以及 buildActivityGroups 的全部测试面都照旧全绿（实测）。换句话说组间排序的**第一
    // 判据从来没有被观察过**，它今天正确只是因为没人改过它。
    //
    // 这一条把两段分开：waiting 那组（rank 0）的 `updatedAt` 刻意**更旧**（10 < 40），所以
    //   · 有 rank 段：needs-you 赢 → ['waiting-group', 'busy-group']
    //   · 无 rank 段：updatedAt 倒序赢 → ['busy-group', 'waiting-group']
    // 两个世界给出相反的顺序，删掉主判据这条必红。label 的字典序（busy < waiting）与「无 rank 段」
    // 同向，所以连尾部的 localeCompare 也帮不了那个坏世界蒙混过关。
    const contexts = activityContextsForWorkspaces([
      workspace('w-waiting', 'repo-waiting', 'waiting-group'),
      workspace('w-busy', 'repo-busy', 'busy-group')
    ])
    const groups = buildActivityGroups(
      [
        agent('asking', 'repo-waiting', {
          updatedAt: 10,
          status: { state: 'waiting', source: 'native-hook', observedAt: 10 }
        } as never),
        agent('busy', 'repo-busy', { updatedAt: 40 } as never)
      ],
      contexts
    )

    expect([...groups.map((group) => group.label)].sort()).toEqual(['busy-group', 'waiting-group'])
    expect(
      groups.map((group) => group.label),
      '在等你的那组被排到了在干活的那组后面——组间排序丢了急迫档这一段，只剩「谁最近动过」'
    ).toEqual(['waiting-group', 'busy-group'])
  })
})
