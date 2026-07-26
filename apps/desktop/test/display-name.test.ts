import { describe, expect, it } from 'vitest'
import {
  resolveAgentName,
  resolveTabName,
  type TabAgentMember
} from '../src/renderer/src/lib/display-name.js'

/**
 * 显示名的唯一优先级链：`用户手改 > 启动时指定 > 从成员/首条 prompt 派生 > Provider·Workspace 派生`。
 *
 * 这是《显示名与身份》合同里"名字求值只有一处"那条的守卫。每个 it 只证一件事：某一档在它上面各档
 * 缺席时胜出、且被上面任一档压过。把优先级写错（比如让派生越过用户手改）会让对应断言变红——这正是
 * "自动派生绝不覆盖用户意图"这条在这一层的落点。
 */
describe('resolveAgentName：优先级链', () => {
  it('用户手改压过其它一切来源', () => {
    const resolved = resolveAgentName({
      userName: '我的调查员',
      launchName: '启动时起的名',
      firstPrompt: '帮我查一下登录 bug',
      fallback: 'Codex · repo'
    })
    expect(resolved).toEqual({ name: '我的调查员', source: 'user' })
  })

  it('无手改时用启动时指定，压过派生与兜底', () => {
    const resolved = resolveAgentName({
      launchName: '启动时起的名',
      firstPrompt: '帮我查一下登录 bug',
      fallback: 'Codex · repo'
    })
    expect(resolved).toEqual({ name: '启动时起的名', source: 'launch' })
  })

  it('只有首条 prompt 时从它派生，取首行、压平空白、限长', () => {
    const resolved = resolveAgentName({
      firstPrompt: '  帮我查一下   登录 bug\n第二行不算 ',
      fallback: 'Codex · repo'
    })
    expect(resolved.source).toBe('derived')
    expect(resolved.name).toBe('帮我查一下 登录 bug')
  })

  it('超长的 prompt 截断并加省略号', () => {
    const long = 'x'.repeat(80)
    const resolved = resolveAgentName({ firstPrompt: long, fallback: 'Codex · repo' })
    expect(resolved.source).toBe('derived')
    expect(resolved.name.endsWith('…')).toBe(true)
    expect(resolved.name.length).toBeLessThanOrEqual(48)
  })

  it('全部上层缺席（或只有空白）时落到 Provider·Workspace 兜底', () => {
    expect(resolveAgentName({ fallback: 'Codex · repo' }))
      .toEqual({ name: 'Codex · repo', source: 'fallback' })
    // 纯空白不占据它那一档——否则一个空串会把兜底顶掉，显示一片空。
    expect(resolveAgentName({ userName: '   ', launchName: '\t', firstPrompt: '\n  \n', fallback: 'Codex · repo' }))
      .toEqual({ name: 'Codex · repo', source: 'fallback' })
  })

  it('手改名两端空白被裁掉，但仍算手改（不因空白降级）', () => {
    expect(resolveAgentName({ userName: '  改过的名字  ', fallback: 'Codex · repo' }))
      .toEqual({ name: '改过的名字', source: 'user' })
  })
})

describe('resolveTabName：默认策略随 Agent 成员数量变化', () => {
  const codex = (name: string): TabAgentMember => ({ name, providerLabel: 'Codex' })
  const claude = (name: string): TabAgentMember => ({ name, providerLabel: 'Claude' })

  it('一个 Agent 时对齐该 Agent 的名字', () => {
    const resolved = resolveTabName({ agents: [codex('调查员')], fallback: 'New Tab' })
    expect(resolved).toEqual({ name: '调查员', source: 'derived' })
  })

  it('两个及以上 Agent 时用家族名，不显示其中任一成员名', () => {
    const members = [codex('调查员'), codex('修复工'), claude('审阅者')]
    const resolved = resolveTabName({ agents: members, fallback: 'New Tab' })
    expect(resolved.source).toBe('derived')
    // 家族名体现"这是一组 Agent"：按 Provider 分组计数，不冒充任何一个成员。
    expect(resolved.name).toBe('Claude · Codex ×2')
    for (const member of members) expect(resolved.name).not.toContain(member.name)
  })

  it('家族名不随成员顺序变化——它对全体对称，故不随 title region 跳变', () => {
    const a = resolveTabName({ agents: [codex('a'), claude('b')], fallback: 'New Tab' })
    const b = resolveTabName({ agents: [claude('b'), codex('a')], fallback: 'New Tab' })
    expect(a.name).toBe(b.name)
  })

  it('用户手改压过两条自动策略——多 Agent 也照用手改名', () => {
    const resolved = resolveTabName({
      userName: '登录专项',
      agents: [codex('调查员'), claude('审阅者')],
      fallback: 'New Tab'
    })
    expect(resolved).toEqual({ name: '登录专项', source: 'user' })
  })

  it('没有 Agent 成员时落到表面兜底（文件名 / New Tab / 浏览器标题由调用方给出）', () => {
    expect(resolveTabName({ agents: [], fallback: 'README.md' }))
      .toEqual({ name: 'README.md', source: 'fallback' })
  })
})
