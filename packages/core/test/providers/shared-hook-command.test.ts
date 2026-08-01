import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hermesHookCommand, managedHookCommand } from '../../src/providers/shared.js'
import { resolveCoreBinPath } from '../../src/runtime-paths.js'

// 缝选在 `resolveCoreBinPath` 而不是 `node:fs`：解析器**自己**就是靠 existsSync 逐个试候选的
// （runtime-paths.ts:65-68），mock 掉 existsSync 只会让它跳过第一个候选、返回下一个「存在」的，
// 于是被测函数照旧拿到一个真实存在的路径、不抛——那样测的是「换了个文件」而不是「文件不在」。
// 这里让解析器直接给出一个真不存在的路径、existsSync 保持真判，正是打包漏掉 agentmux-hook.js 时
// 的真实形状。
vi.mock('../../src/runtime-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/runtime-paths.js')>()
  return { ...actual, resolveCoreBinPath: vi.fn(actual.resolveCoreBinPath) }
})

const resolveMock = vi.mocked(resolveCoreBinPath)
// 真实现，用来在每条之后复原——mock 的默认实现就是它，所以改过之后必须设回这个，不能设回
// `getMockImplementation()`（那时拿到的已经是被改过的那个，等于没还原）。
const realResolve = resolveMock.getMockImplementation()!

afterEach(() => {
  resolveMock.mockImplementation(realResolve)
})

// 守的缺陷：这两个函数把 hook runner 的绝对路径**冻进用户自己的配置文件**。而
// `resolveCoreBinPath` 在所有候选都不存在时返回第一个候选——一个不存在的路径。那个 fallback 对
// `AGENTMUX_CLI_PATH`（模块顶层求值）是对的：在那里抛会让整个模块导入失败，连不 shell-out 的调用方
// 一起拖下水。但对这里是错的：打包漏掉 `agentmux-hook.js` 时（打包布局经 `process.resourcesPath`
// 解析，那几个候选在开发树里根本不存在），写进去的就是一条指向不存在文件的命令，而下游三处全都不校验
// ——安装器照写、provider CLI 静默起不来。用户看到的是一个永不汇报状态的 Agent，配置文件却「装好了」。
//
// 修法是在这里响亮失败：异常落进 `ensureManagedHooks` 的 best-effort catch，变成一条点名 provider 的
// 非致命 `agent-error`，Agent 照旧启动、终端输出照旧可见。代价是一条诚实的错误信息，而省掉这个检查
// 的代价是一次静默的谎。
describe('managed hook command refuses to freeze a path that is not there', () => {
  it('两个出口都在 runner 缺失时抛 HOOK_RUNNER_MISSING——绝不写一条跑不起来的命令', () => {
    const absent = '/nonexistent/agentmux-packaging-slip/agentmux-hook.js'
    // 挡板：构造的「缺失」必须真的缺失。若这个路径哪天存在，下面两条抛不出来的原因就不是被测代码，
    // 而是 fixture 自己失效——让那种失明响亮变红，而不是留一条恒真的断言。
    expect(existsSync(absent), 'fixture premise: the constructed path must really be absent').toBe(false)
    resolveMock.mockImplementation(() => absent)

    // 两个出口各自判：hermes 走的是另一条（它的 shell hook 用 /usr/bin/env 前缀），
    // 只守 managedHookCommand 会让 hermes 那侧继续静默写死命令。
    expect(() => managedHookCommand('claude')).toThrowError(/Managed Hook runner is missing/)
    try {
      managedHookCommand('claude')
      expect.unreachable('managedHookCommand must throw when the runner is missing')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('HOOK_RUNNER_MISSING')
    }
    try {
      hermesHookCommand()
      expect.unreachable('hermesHookCommand must throw when the runner is missing')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('HOOK_RUNNER_MISSING')
    }
  })

  it('runner 在场时两个出口都正常给出命令，且都带上真实路径', () => {
    const runner = realResolve('agentmux-hook.js')
    // 挡板：这一条的前提是「平时它在」。runner 不在的树里下面三条会因为别的原因红，先把前提钉响。
    expect(existsSync(runner), `fixture premise: ${runner} must exist in a healthy tree`).toBe(true)
    // 在场一侧同样要判——只守「缺失时抛」的话，一次「永远抛」的改动会让九家 Provider 全都装不上
    // hook，而那条缺失断言照旧绿。
    expect(managedHookCommand('claude')).toContain(runner)
    expect(hermesHookCommand()).toContain(runner)
    // hermes 那条必须带 /usr/bin/env 前缀：它的 shell hook 用 shlex.split + shell=False 调用，
    // 少了前缀整条 hook 起不来（这是记录在案的上游行为）。
    expect(hermesHookCommand().startsWith('/usr/bin/env ')).toBe(true)
    expect(managedHookCommand('claude').startsWith('/usr/bin/env ')).toBe(false)
  })
})
