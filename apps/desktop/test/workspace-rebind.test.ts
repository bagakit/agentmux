import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { rebindLocalFolder, type RebindPorts } from '../src/main/workspace-rebind.js'
import type { AppConfig } from '../src/shared/contracts.js'

// ---------------------------------------------------------------------------
// 一次重绑，从头跑到尾。
//
// 此前守这一段的是 workspace-navigation-wiring 的 `readFileSync` +
// `toContain('item.id === workspaceId ? updated : item')` 一族。文本断言看不见那段编排有没有被
// 执行到：在 ipc.ts 的 handler 第一行插一句 `return null`，重绑对用户**永久失效**（点了
// "重新指定目录"永不更新路径），而那 2 条断言全绿（实测；死代码里那些字符串照旧存在）。
// handler 当时长在 registerIpc 的闭包里，本仓没有任何测试 import 得到它。
//
// 现在编排在 workspace-rebind 里、由注入的 ports 表达外界需求，所以这里真跑它。
// ---------------------------------------------------------------------------

const CONFIG: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'This Mac' }],
  executors: {},
  workspaces: [
    { id: 'moved', name: 'Moved', hostId: 'local', path: '/old/place/repo', kind: 'folder' },
    { id: 'sibling', name: 'Sibling', hostId: 'local', path: '/other/repo', kind: 'folder' },
    { id: 'remote', name: 'Remote', hostId: 'box', path: '/srv/repo', kind: 'folder' },
    {
      id: 'lane',
      name: 'lane-1',
      hostId: 'local',
      path: '/old/place/repo/.worktrees/lane-1',
      kind: 'worktree',
      repoPath: '/old/place/repo',
      branch: 'lane-1'
    }
  ],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, more: true } }
}

type Recorded = { defaultPaths: string[]; saved: AppConfig[] }

/** 一套"用户选了 /new/home/repo"的 ports，外加它记下的每一次调用。 */
function ports(overrides: Partial<RebindPorts> = {}): RebindPorts & { recorded: Recorded } {
  const recorded: Recorded = { defaultPaths: [], saved: [] }
  const base: RebindPorts = {
    chooseDirectory: async (defaultPath) => {
      recorded.defaultPaths.push(defaultPath)
      return { canceled: false, filePaths: ['/new/home/repo'] }
    },
    save: async (next) => {
      recorded.saved.push(next)
      return next
    }
  }
  return { ...base, ...overrides, recorded }
}

describe('重绑一个本地文件夹 Workspace', () => {
  it('只换那一条记录的 path，id 与名字不动，兄弟不受影响', async () => {
    const p = ports()
    const result = await rebindLocalFolder('moved', CONFIG, p)

    // 这是整条链子最要紧的一条：早退变异之下这里会是 null 且下面每一条都拿不到东西。
    expect(result.workspace).toEqual({
      id: 'moved',
      name: 'Moved',
      hostId: 'local',
      path: '/new/home/repo',
      kind: 'folder'
    })
    // 落盘的那份 config 也真的换了——只回报不写盘等于重启后原样退回去。
    expect(p.recorded.saved).toHaveLength(1)
    const savedPaths = p.recorded.saved[0]!.workspaces.map((item) => `${item.id}:${item.path}`)
    expect(savedPaths).toEqual([
      'moved:/new/home/repo',
      'sibling:/other/repo',
      'remote:/srv/repo',
      'lane:/old/place/repo/.worktrees/lane-1'
    ])
    // 返回的 config 是保存后的那一份，不是调用时那份旧的。
    expect(result.config).toBe(p.recorded.saved[0])
  })

  it('目录选择器从当前路径的父目录开始——用户要找的是那个搬走了的目录', async () => {
    const p = ports()
    await rebindLocalFolder('moved', CONFIG, p)
    expect(p.recorded.defaultPaths).toEqual(['/old/place'])
  })

  it('用户取消时一个字节都不写盘', async () => {
    const p = ports({ chooseDirectory: async () => ({ canceled: true, filePaths: [] }) })
    const result = await rebindLocalFolder('moved', CONFIG, p)
    expect(result.workspace).toBeNull()
    // 取消一次就重写一遍 config，会白触发一次 Runtime prepare/commit。
    expect(p.recorded.saved).toEqual([])
    expect(result.config).toBe(CONFIG)
  })

  it('取消的信号是 canceled 本身，即便响应里还留着一个路径', async () => {
    // 上面那条用例给的是 `canceled: true` **加**空清单，于是 `!path` 一侧就把它兜住了——
    // 两个条件守着同一个出口，混在一个 fixture 里就分不清是哪一个在承重（实测：把
    // `selection.canceled ||` 删掉，那条用例照旧全绿）。这里只翻 canceled，路径照旧在场。
    const p = ports({
      chooseDirectory: async () => ({ canceled: true, filePaths: ['/new/home/repo'] })
    })
    const result = await rebindLocalFolder('moved', CONFIG, p)
    expect(result.workspace).toBeNull()
    expect(p.recorded.saved).toEqual([])
  })

  it('对话框返回空清单也算取消，不拿 undefined 当路径写下去', async () => {
    const p = ports({ chooseDirectory: async () => ({ canceled: false, filePaths: [] }) })
    const result = await rebindLocalFolder('moved', CONFIG, p)
    expect(result.workspace).toBeNull()
    expect(p.recorded.saved).toEqual([])
  })

  it('非本机的 Workspace 响亮拒绝，不去弹一个本机目录选择器', async () => {
    const p = ports()
    await expect(rebindLocalFolder('remote', CONFIG, p)).rejects.toThrow(
      'Only local folder Workspaces can be rebound'
    )
    expect(p.recorded.defaultPaths).toEqual([])
    expect(p.recorded.saved).toEqual([])
  })

  it('worktree 不能被重绑——它的路径归 git，不归目录选择器', async () => {
    const p = ports()
    await expect(rebindLocalFolder('lane', CONFIG, p)).rejects.toThrow(
      'Only local folder Workspaces can be rebound'
    )
    expect(p.recorded.saved).toEqual([])
  })

  it('workspace 不存在时响亮失败，不静默返回 null', async () => {
    const p = ports()
    await expect(rebindLocalFolder('ghost', CONFIG, p)).rejects.toThrow('Unknown workspace: ghost')
    expect(p.recorded.saved).toEqual([])
  })

  it('落盘失败原样抛出，不假装重绑成功', async () => {
    const p = ports({
      save: async () => {
        throw new Error('disk full')
      }
    })
    await expect(rebindLocalFolder('moved', CONFIG, p)).rejects.toThrow('disk full')
  })
})

describe('handler 那层壳没有可以插早退的地方', () => {
  const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
  const code = ipc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('自检：真的截到了那个 handler', () => {
    expect(code).toContain("handle('workspaces:rebindLocalFolder'")
  })

  it('编排不许回到 ipc.ts —— 那里没有任何测试够得着', () => {
    // 判据是 **import 关系**，不是调用点的字面形状：把函数作为裸标识符提回去（不带括号）就能
    // 绕过 `not.toContain('rebindLocalFolder(')`，而它照旧可以被调用。能被 import 就能被调用。
    expect(code).toContain('./workspace-rebind.js')
    // 那段编排唯一需要的两样外界能力都由 handler 注入；handler 自己不再算路径、不再改 workspaces。
    const at = code.indexOf("handle('workspaces:rebindLocalFolder'")
    const head = code.slice(at, at + 600)
    expect(
      head,
      'rebind handler 又自己动 workspaces 了——那一段没人跑得到'
    ).not.toMatch(/workspaces:\s*config\.workspaces\.map/)
  })
})
