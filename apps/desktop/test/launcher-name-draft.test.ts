import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  EMPTY_LAUNCHER_NAMES,
  launcherNameBinding,
  type LauncherNameField,
  type LauncherNames
} from '../src/renderer/src/lib/launcher-name-draft.js'

// ---------------------------------------------------------------------------
// 读的 key 与写的 key 必须是同一个。
//
// 这个模块是从 NewTabSurface 里抽出来的，起因是一颗**存活的变异**：名字草稿刚搬进 store 时，组件
// 自己读一次（`state.launcherNameDrafts[regionId]`）、写一次（`setLauncherNameDraft(regionId, …)`），
// 同一个概念两处判定。把写回那一处换成 `tabId ?? regionId`，14 条测试**全绿**——而用户看到的是
// 输入框静默不响应：写进了 A 键、读的是 B 键，敲什么都看不见变化，也不报任何错。
//
// 所以 key 只在这里判一次，读写共用同一个判定结果；下面这些用例跑的就是它。
// ---------------------------------------------------------------------------

type Write = { regionId: string; field: LauncherNameField; value: string }

function harness(input: { regionId: string | undefined; drafts?: Record<string, LauncherNames> }) {
  const shared: Write[] = []
  const local: Write[] = []
  const binding = launcherNameBinding({
    regionId: input.regionId,
    drafts: input.drafts ?? {},
    writeShared: (regionId, field, value) => shared.push({ regionId, field, value }),
    local: EMPTY_LAUNCHER_NAMES,
    writeLocal: (field, value) => local.push({ regionId: '<local>', field, value })
  })
  return { binding, shared, local }
}

describe('启动对话框两格名字的取值与写回', () => {
  it('读的键与写的键是同一个——这是这个模块存在的全部理由', () => {
    const drafts = { 'region:launcher': { agentName: '调查员', tabName: '登录排查' } }
    const { binding, shared } = harness({ regionId: 'region:launcher', drafts })

    // 读：拿到的就是那个 region 的那一份。
    expect(binding.names).toEqual({ agentName: '调查员', tabName: '登录排查' })
    // 写：落到同一个键上。读写两侧各算一次 key 时，正是这条会分道扬镳（实测那版全绿）。
    binding.set('agentName', '换个名')
    expect(shared).toEqual([{ regionId: 'region:launcher', field: 'agentName', value: '换个名' }])
  })

  it('这个 region 还没有草稿时给两格空串，不给 undefined', () => {
    // 受控输入拿到 undefined 会被 React 当成非受控，于是"用户敲的字不生效"换一种形式复发。
    const { binding } = harness({ regionId: 'region:fresh' })
    expect(binding.names).toEqual({ agentName: '', tabName: '' })
  })

  it('按 regionId 取，不串到别的 launcher', () => {
    const drafts = {
      'region:a': { agentName: '甲', tabName: '甲页' },
      'region:b': { agentName: '乙', tabName: '乙页' }
    }
    expect(harness({ regionId: 'region:b', drafts }).binding.names).toEqual({
      agentName: '乙',
      tabName: '乙页'
    })
  })

  it('没有 regionId 时走本地取值，一个字都不写进共享表', () => {
    // 空分组占位没有可跨卸载存活的稳定键。若给它编一个键，那份草稿永远没人来清（它启动后重挂的
    // 是另一个组件），共享表会越攒越多。
    const { binding, shared, local } = harness({ regionId: undefined })
    expect(binding.names).toEqual(EMPTY_LAUNCHER_NAMES)
    binding.set('tabName', '本地')
    expect(shared).toEqual([])
    expect(local).toEqual([{ regionId: '<local>', field: 'tabName', value: '本地' }])
  })

  it('有 regionId 时不碰本地取值——两条路互斥', () => {
    const { binding, shared, local } = harness({ regionId: 'region:launcher' })
    binding.set('agentName', '共享')
    expect(local).toEqual([])
    expect(shared).toHaveLength(1)
  })

  it('两格分别可写，字段名原样带下去', () => {
    const { binding, shared } = harness({ regionId: 'region:launcher' })
    binding.set('agentName', '甲')
    binding.set('tabName', '乙')
    expect(shared.map((item) => `${item.field}=${item.value}`)).toEqual([
      'agentName=甲',
      'tabName=乙'
    ])
  })
})

describe('组件那层壳没有第二处 key 判定', () => {
  const source = readFileSync(
    new URL('../src/renderer/src/components/NewTabSurface.tsx', import.meta.url),
    'utf8'
  )
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  it('自检：真的截到了这段接线', () => {
    expect(code).toContain('launcherNameBinding(')
  })

  it('组件不自己索引草稿表，也不自己算写回的 key', () => {
    // 判据是 **有没有第二处判定**，不是某个字面量：组件只要自己索引一次 `launcherNameDrafts[...]`
    // 或自己给 setLauncherNameDraft 传一个算出来的 key，漂移的可能就回来了。
    expect(code).not.toMatch(/launcherNameDrafts\s*\[/)
    expect(code).not.toMatch(/setLauncherNameDraft\s*\(/)
  })
})
