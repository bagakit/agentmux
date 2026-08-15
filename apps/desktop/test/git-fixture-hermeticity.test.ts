import { describe, expect, it } from 'vitest'
import { LocalExecutionHost } from '@agentmux/core'

/**
 * 夹具跑的 git 必须与开发者本人的 gitconfig 隔开——判据钉在**行为**上，不是钉在环境变量上。
 *
 * 判 `process.env.GIT_CONFIG_GLOBAL === '/dev/null'` 是恒真的一类断言：它只证明有人写过那行赋值，
 * 不证明子进程真的读不到全局配置。真正会坏的那一步在 `runProcess` 里——它用 `{...process.env}`
 * 派生子进程环境；哪天有人改成白名单派生，变量还在 `process.env` 里，git 却已经读回了
 * `~/.gitconfig`。所以这里去问 git 自己。
 *
 * 隔离的理由是**封闭性**，不是速度。速度只是它最先暴露出来的症状：本机 `~/.gitconfig` 里一条
 * `core.hooksPath` 指向公司提交钩子，夹具里那句 `git commit` 每次要跑它 2 秒，
 * `worktree-service.test.ts` 65s 里 56s 花在这上面（隔离后 5.8s）。但同一条继承链上还有
 * `user.useconfigonly`、`includeIf`、`credential.helper`——都是别人机器上长得不一样的东西。
 * 判据随机器漂移就不再是判据。
 */
describe('测试夹具里的 git 是封闭的', () => {
  it('读不到本机全局配置里的任何一条——问 git 自己，不问环境变量', async () => {
    const host = new LocalExecutionHost()

    // `core.hooksPath` 是本机实际存在的那条（指向公司提交钩子）。用 `--global` 显式限定作用域：
    // 不带作用域的 `git config --get` 会把仓库级配置也算进来，而本仓自己完全可以有同名键，
    // 那样这条断言就会因为一个无关的原因变红。
    const hooks = await host.run('git', ['config', '--global', '--get', 'core.hooksPath'])
    expect(hooks.exitCode, `夹具读到了全局 core.hooksPath：${hooks.stdout.trim()}`).toBe(1)
    expect(hooks.stdout.trim()).toBe('')

    // 第二个键取自完全不同的一族（alias），钉住的是「整份全局配置都进不来」，
    // 而不是「恰好这一个键没了」。
    const alias = await host.run('git', ['config', '--global', '--get', 'alias.st'])
    expect(alias.exitCode, `夹具读到了全局 alias：${alias.stdout.trim()}`).toBe(1)
  })

  it('隔离的是测试这一侧，不是 git 本身——夹具仍然跑得起一个真仓库', async () => {
    // 上一条单独存在时有个退化解会让它恒绿：把 git 变得完全不可用（比如 PATH 里没有 git），
    // 两个 `--get` 照样非零退出。这一条钉住下界——隔离之后 git 仍然正常工作。
    const host = new LocalExecutionHost()
    const version = await host.run('git', ['--version'])
    expect(version.exitCode).toBe(0)
    expect(version.stdout).toContain('git version')
  })
})
