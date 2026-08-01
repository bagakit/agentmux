import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { launcherPromptBinding } from '../src/renderer/src/lib/launcher-prompt-draft.js'

// ---------------------------------------------------------------------------
// 读的 key 与写的 key 必须是同一个（#306）。
//
// 名字那两格早已收成一处（见 launcher-name-draft.test.ts 那段说明），prompt 这一格当时没跟上：
// 组件里读一次 `state.agentComposerDrafts[regionId]`、写一次 `setAgentComposerDraft(regionId, …)`，
// 同一个概念两处判定。实测这笔代价——只把**写侧**那处 key 换成 `drift-${regionId}`：
//   launcher-draft-binding + launcher-draft-survival + launch-naming + controlled-input-is-writable
//   共 18 条**全绿**。
// 同样只漂移读侧，launcher-draft-binding 有 1 条红。也就是读侧有人守、写侧无人守，而写侧失守的
// 症状恰恰更隐蔽：textarea 静默变只读（写进 A 键、读 B 键，敲什么都看不见变化，也不报错）。
//
// 所以 key 只在 launcherPromptBinding 里判一次，读写共用同一个判定结果。下面前半段跑那个纯函数，
// 后半段守"壳里没有第二处 key 判定"——那正是当初无人守的那一侧。
// ---------------------------------------------------------------------------

type Write = { key: string; value: string }

function harness(input: { regionId: string | undefined; drafts?: Record<string, string>; local?: string }) {
  const shared: Write[] = []
  const local: Write[] = []
  const binding = launcherPromptBinding({
    regionId: input.regionId,
    drafts: input.drafts ?? {},
    writeShared: (regionId, value) => shared.push({ key: regionId, value }),
    local: input.local ?? '',
    writeLocal: (value) => local.push({ key: '<local>', value })
  })
  return { binding, shared, local }
}

describe('启动器 prompt 那一格的取值与写回', () => {
  it('读的键与写的键是同一个——这是这个模块存在的全部理由', () => {
    const { binding, shared } = harness({
      regionId: 'region:launcher',
      drafts: { 'region:launcher': '查一下登录为什么 500' }
    })

    expect(binding.prompt).toBe('查一下登录为什么 500')
    // 写落在同一个键上。读写各算一次 key 时，正是这条会分道扬镳——而分岔那一版 18 条全绿。
    binding.set('换个问题')
    expect(shared).toEqual([{ key: 'region:launcher', value: '换个问题' }])
  })

  it('这个 region 还没有草稿时给空串，不给 undefined', () => {
    // 受控输入拿到 undefined 会被 React 当成非受控，于是"用户敲的字不生效"换一种形式复发
    // （见 controlled-input-can-go-silently-readonly 那族）。
    const { binding } = harness({ regionId: 'region:fresh' })
    expect(binding.prompt).toBe('')
  })

  it('按 regionId 取，不串到别的 launcher，也不串到 Agent Composer 的会话草稿', () => {
    // 共享的那张表 `agentComposerDrafts` 同时被 launcher（键为 region id）与 AgentSessionComposer
    // （键为 session id）使用。两族键天然不撞，这条钉住"只认自己那一条"。
    const drafts = {
      'region:a': '甲的问题',
      'region:b': '乙的问题',
      'session:a': '会话里的草稿'
    }
    expect(harness({ regionId: 'region:b', drafts }).binding.prompt).toBe('乙的问题')
  })

  it('没有 regionId 时走本地取值，一个字都不写进共享表', () => {
    // 空分组占位没有可跨卸载存活的稳定键。若给它编一个键，那份草稿永远没人来清（它启动后重挂的
    // 是另一个组件），共享表会越攒越多。
    const { binding, shared, local } = harness({ regionId: undefined, local: '本地已有的' })
    expect(binding.prompt).toBe('本地已有的')
    binding.set('本地新写的')
    expect(shared).toEqual([])
    expect(local).toEqual([{ key: '<local>', value: '本地新写的' }])
  })

  it('有 regionId 时不碰本地取值——两条路互斥', () => {
    const { binding, shared, local } = harness({ regionId: 'region:launcher', local: '不该被读到' })
    expect(binding.prompt).toBe('')
    binding.set('共享')
    expect(local).toEqual([])
    expect(shared).toHaveLength(1)
  })
})

describe('组件那层壳没有第二处 key 判定', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/components/NewTabSurface.tsx', import.meta.url),
    'utf8'
  )
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  it('自检：真的截到了这段接线', () => {
    // 挡板：正则把整段注释连代码一起吃掉、或这段接线被改名，下面两条就会在"什么都没有"上
    // 静默通过。
    expect(code).toContain('launcherPromptBinding(')
  })

  it('组件不自己索引草稿表，也不自己算写回的 key', () => {
    // 判据是**有没有第二处判定**，不是某个字面量。这两条各守一侧：
    //   - `agentComposerDrafts[` 是读侧（组件应当把整张表交给 binding，索引发生在函数内部）
    //   - `setAgentComposerDraft(` 是写侧——就是当初 18 条全绿地漂移掉的那一侧
    // 组件只要自己索引一次，或自己给 setter 传一个算出来的 key，漂移的可能就全回来了。
    expect(code, '组件自己索引了草稿表——key 判定又变成两处').not.toMatch(/agentComposerDrafts\s*\[/)
    expect(code, '组件自己调了 setAgentComposerDraft——写侧的 key 又是独立算的').not.toMatch(
      /setAgentComposerDraft\s*\(/
    )
  })
})
