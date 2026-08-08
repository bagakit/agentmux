import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import {
  hydrateProcessEnvironmentFromLoginShell,
  loginShellEnvironmentWarning,
  parseLoginShellEnvironment
} from '../src/main/login-shell-environment.js'

const exec = promisify(execFile)

/** `kill(pid, 0)` 不送信号，只问「这个 pid 还在不在」——ESRCH 表示已经没了。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function framed(args: readonly string[], values: Record<string, string>): string {
  const marker = args[1]!.match(/__AGENTMUX_ENV_[\w-]+__/)![0]
  return `banner\n${marker}\0${Object.entries(values).map(([k, v]) => `${k}=${v}\0`).join('')}${marker}\0logout\n`
}

describe('login shell exported environment', () => {
  it('preserves empty, multiline, equals and ANSI bytes without parsing banner text', () => {
    expect(parseLoginShellEnvironment('banner\nm\0PATH=/bin\0EMPTY=\0VALUE=a=b\n\u001b[32m\0m\0bye', 'm'))
      .toEqual({ PATH: '/bin', EMPTY: '', VALUE: 'a=b\n\u001b[32m' })
    expect(parseLoginShellEnvironment('m\0PATH=/bin\0', 'm')).toBeNull()
    expect(parseLoginShellEnvironment('m\0INVALID\0m\0', 'm')).toBeNull()
    expect(parseLoginShellEnvironment('m\0EMPTY=\0m\0', 'm')).toEqual({ EMPTY: '' })
  })

  it.each(['/bin/zsh', '/bin/bash'])('loads real %s profile exports into a child without exporting shell-local variables', async (shell) => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-shell-env-'))
    try {
      await writeFile(join(directory, shell.endsWith('zsh') ? '.zprofile' : '.bash_profile'),
        'export AGENTMUX_TEST_PROFILE=profile\n' + (shell.endsWith('bash') ? '. "$HOME/.bashrc"\n' : ''))
      await writeFile(join(directory, shell.endsWith('zsh') ? '.zshrc' : '.bashrc'), [
        'printf "profile banner\\n"',
        "export AGENTMUX_TEST_RC='hello=world", "second line'",
        "export AGENTMUX_TEST_EMPTY=''",
        'AGENTMUX_TEST_LOCAL=not-exported',
        "export PATH='/opt/test tools:/usr/bin:/bin'"
      ].join('\n'))
      const env: NodeJS.ProcessEnv = { HOME: directory, ZDOTDIR: directory, SHELL: shell, PATH: '/usr/bin:/bin' }
      const result = await hydrateProcessEnvironmentFromLoginShell({ platform: 'darwin', env })
      expect(result).toEqual({ ok: true, shell, mode: 'interactive-login' })
      expect(loginShellEnvironmentWarning(result)).toBeUndefined()
      const child = await exec(process.execPath, ['-e', 'process.stdout.write(JSON.stringify([process.env.AGENTMUX_TEST_PROFILE, process.env.AGENTMUX_TEST_RC, process.env.AGENTMUX_TEST_EMPTY, process.env.AGENTMUX_TEST_LOCAL, process.env.PATH]))'], { env })
      expect(JSON.parse(child.stdout)).toEqual(['profile', 'hello=world\nsecond line', '', null, '/opt/test tools:/usr/bin:/bin'])
      expect(env.SHLVL).toBeUndefined()
      expect(env._).toBeUndefined()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('reports partial success after interactive failure and preserves inherited PATH entries', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin:/client/bin', SHELL: '/bin/zsh', KEEP: 'inherited' }
    const runner = vi.fn(async (_shell: string, args: readonly string[]) => {
      if (args[0] === '-ilc') throw new Error('private profile detail must not be reported')
      return framed(args, { PATH: '/opt/bin:/bin', EXPORTED: 'profile', PWD: '/probe' })
    })
    const result = await hydrateProcessEnvironmentFromLoginShell({ platform: 'darwin', env, runner })
    expect(result).toEqual({ ok: true, shell: '/bin/zsh', mode: 'login' })
    expect(env).toMatchObject({ PATH: '/opt/bin:/bin:/client/bin', KEEP: 'inherited', EXPORTED: 'profile' })
    expect(env.PWD).toBeUndefined()
    expect(loginShellEnvironmentWarning(result)).toContain('.zshrc could not be confirmed')
    expect(runner).toHaveBeenCalledTimes(2)
  })

  /**
   * 只有 `-lc` 那条臂才补回继承来的 PATH，`-ilc` **不补**。
   *
   * 这个不对称是有意的：交互式登录臂 source 了 `.zprofile` 和 `.zshrc`，用户的 PATH 已经是完整答案，
   * 再并上继承的那份等于把 launchd/Electron 塞进来、而用户 shell 里根本没有的条目硬塞回去。非交互臂
   * 不读 `.zshrc`，可能真的缺东西，所以那一侧才保守地并一次。
   *
   * 上面那条 `-lc` 用例只守住了「该并的时候并了」这一半。反过来的一半此前无人守：把 `-lc` 这道门去掉，
   * 12 条全绿（实测）——连真起 shell 的那条 it.each 都看不见，因为它的 `.zshrc` 导出的 PATH
   * （`/opt/test tools:/usr/bin:/bin`）恰好是继承那份（`/usr/bin:/bin`）的超集，并不并结果一模一样。
   * 所以判据必须是一条**只存在于继承侧**的条目：它出现在结果里，就说明交互臂也并了。
   */
  it('does not fold inherited PATH entries into the interactive arm result', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin:/inherited-only', SHELL: '/bin/zsh' }
    const result = await hydrateProcessEnvironmentFromLoginShell({
      platform: 'darwin',
      env,
      runner: async (_shell, args) => framed(args, { PATH: '/opt/bin', EXPORTED: 'profile' })
    })
    // 自检：赢的是交互臂。落到 `-lc` 的话下面那条断言测的是另一条路径，本条就不可观测了。
    expect(result).toEqual({ ok: true, shell: '/bin/zsh', mode: 'interactive-login' })
    expect(env.PATH, '继承侧独有的条目出现在结果里：交互臂也做了 PATH 合并').toBe('/opt/bin')
  })

  it('preserves all inherited values on total failure and returns a non-secret warning', async () => {
    const env = { PATH: '/bin', KEEP: 'original' }
    const result = await hydrateProcessEnvironmentFromLoginShell({ platform: 'darwin', env, runner: async () => { throw new Error('secret') } })
    expect(result).toEqual({ ok: false, reason: 'probe-failed' })
    expect(env).toEqual({ PATH: '/bin', KEEP: 'original' })
    expect(loginShellEnvironmentWarning(result)).toContain('inherited application environment')
    expect(loginShellEnvironmentWarning(result)).not.toContain('secret')
  })

  it('does not launch a shell on unsupported platforms', async () => {
    const runner = vi.fn()
    const result = await hydrateProcessEnvironmentFromLoginShell({ platform: 'win32', env: {}, runner })
    expect(result).toEqual({ ok: false, reason: 'unsupported-platform' })
    expect(runner).not.toHaveBeenCalled()
  })

  /**
   * 一个**永不 settle** 的 runner 必须被当成失败处理，而不是让调用方永远等下去。
   *
   * 这不是假想的形状，是实测出来的生产缺陷（#872）：`execFile` 的 `timeout` 发的是 SIGTERM，而卡在
   * `.zshrc` 里一句 `read` 上的交互式 zsh 忽略 SIGTERM——callback 一辈子不回调（实测 9 秒后
   * `killed=true` 而 `exitCode`/`signalCode` 全 null）。生产侧的修法是 `killSignal: 'SIGKILL'`，
   * 但那治的是**我们自带的那个 runner**；这条用例守的是更强的那件事：无论 runner 怎么坏，这个函数
   * 都要在预算内 settle。它是唯一能把 `withDeadline` 整个删掉这个变异打红的用例——把 runner 换成
   * SIGKILL 版本救不了它，因为这里的 runner 根本不起进程。
   *
   * 之所以要守到函数这一层：`startPrimaryInstance` 里 `buildWindow` 会 `await environmentReady`，
   * 于是「不 settle」的症状不是环境不全，而是**窗口根本建不出来**——Dock 图标弹一下，没有任何界面。
   */
  it('gives up on a runner that never settles instead of leaving the caller pending forever', async () => {
    const env = { PATH: '/bin', KEEP: 'original' }
    const started: string[] = []
    const result = await hydrateProcessEnvironmentFromLoginShell({
      platform: 'darwin',
      env,
      timeoutMs: 20,
      runner: (_shell, args) => {
        started.push(args[0]!)
        return new Promise<string>(() => {})
      }
    })
    expect(result).toEqual({ ok: false, reason: 'probe-failed' })
    expect(env).toEqual({ PATH: '/bin', KEEP: 'original' })
    // 自检：两条臂都真的跑过。只跑了一条的话，上面那条断言测的是「循环提前退出」而不是「超时」。
    expect(started).toEqual(['-ilc', '-lc'])
  })

  /**
   * 预算是**整次 hydration** 的，不是每条臂各给一份。
   *
   * 把共享预算改成每臂一份，在上面那条用例里是绿的——两条臂各自都会超时，结论一样。要打红它，判据
   * 只能是**墙钟总量**：两条臂加起来不能超过一个预算。用户等的是窗口，等两遍就是等两倍。
   */
  it('spends one budget across both arms rather than one budget per arm', async () => {
    const startedAtMs = Date.now()
    const result = await hydrateProcessEnvironmentFromLoginShell({
      platform: 'darwin',
      env: { PATH: '/bin' },
      timeoutMs: 60,
      runner: () => new Promise<string>(() => {})
    })
    const elapsedMs = Date.now() - startedAtMs
    expect(result).toEqual({ ok: false, reason: 'probe-failed' })
    expect(elapsedMs, `两条臂各等了一个完整预算（${elapsedMs}ms），预算没有共享`).toBeLessThan(120)
  })

  /**
   * 卡住的 `-ilc` 不能把 `-lc` 饿死。
   *
   * 这条是「共享预算」那条的对偶，两条缺一不可：让第一条臂独吞整个预算能让上面那条全绿，但那正好
   * 毁掉本条——而 `-lc` **不 source `.zshrc`**，恰恰是 `.zshrc` 卡住时唯一还能成功的那条路。只守总量
   * 会把「窗口不卡」换成「环境一定加载失败」，用户从看不到窗口变成看到一个没有 PATH 的窗口。
   */
  it('still reaches the non-interactive arm when the interactive one hangs', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', SHELL: '/bin/zsh' }
    const result = await hydrateProcessEnvironmentFromLoginShell({
      platform: 'darwin',
      env,
      timeoutMs: 200,
      runner: (_shell, args) => args[0] === '-ilc'
        ? new Promise<string>(() => {})
        : Promise.resolve(framed(args, { PATH: '/opt/bin', EXPORTED: 'profile' }))
    })
    expect(result).toEqual({ ok: true, shell: '/bin/zsh', mode: 'login' })
    expect(env).toMatchObject({ PATH: '/opt/bin:/bin', EXPORTED: 'profile' })
  })

  /**
   * 早退的臂要把没花完的份额**整份**让给下一条，而不是再对半分一次。
   *
   * 除数 `arms.length - index` 是「剩下还有几条臂」，不是常数 2。实测（审计独立复现）：把它换成常量
   * `arms.length`，上面每一条都还是绿的——因为现有用例要么两条臂都挂（各分一半，总量不变），要么第二条
   * 臂瞬间返回且预算充裕（分多分少都够用）。两个世界只在「第一条臂**很快失败**、第二条臂需要那份余额」
   * 这一处分岔，本条就是走这一处。
   *
   * 判据是**交给第二条臂的那个 timeoutMs**，不是返回值：两种除法下返回值完全一样（都是 -lc 成功），
   * 只有实参能把它们分开。地板取「远大于半额」而不是精确值——精确值会被这几行的执行耗时打成 flake。
   */
  it('hands the whole unspent remainder to the next arm, not another half share', async () => {
    const handed: Array<{ arm: string; timeoutMs: number }> = []
    const result = await hydrateProcessEnvironmentFromLoginShell({
      platform: 'darwin',
      env: { PATH: '/bin', SHELL: '/bin/zsh' },
      timeoutMs: 400,
      runner: (_shell, args, _env, timeoutMs) => {
        handed.push({ arm: args[0]!, timeoutMs })
        return args[0] === '-ilc'
          ? Promise.reject(new Error('interactive arm failed immediately'))
          : Promise.resolve(framed(args, { EXPORTED: 'profile' }))
      }
    })
    expect(result).toEqual({ ok: true, shell: '/bin/zsh', mode: 'login' })
    // 自检：两条臂都跑了，否则下面那条断言在读一个不存在的元素。
    expect(handed.map((call) => call.arm)).toEqual(['-ilc', '-lc'])
    // 第一条臂几乎没花时间，所以第二条臂应当拿到接近 400 的整份；恒 /2 的话它只会拿到约 200。
    expect(
      handed[1]!.timeoutMs,
      `第二条臂只拿到 ${handed[1]!.timeoutMs}ms：早退臂的余额没有整份让出去，除数被当成了常数`
    ).toBeGreaterThan(300)
  })

  /**
   * 预算耗尽时不能「以 0 超时」把臂放出去。
   *
   * `execFile` 的 `timeout: 0` 不是「立刻超时」，是**根本不设超时**——放出去的子进程再也没人收尸，正是
   * 这个修复要消灭的那个泄漏。负数更糟：`execFile` 会异步抛 `ERR_OUT_OF_RANGE`，而 vitest 会把它记在
   * 单独的 `Errors` 里，同时照样打印每条用例 passed（实测踩过）。所以判据不是「函数返回了什么」——那
   * 两种坏法下它都照常返回 `probe-failed`——而是**每条真正起跑的臂拿到的预算都必须为正**。
   */
  it('never starts an arm with a non-positive timeout when the budget is spent', async () => {
    const handed: Array<{ arm: string; timeoutMs: number }> = []
    const result = await hydrateProcessEnvironmentFromLoginShell({
      platform: 'darwin',
      env: { PATH: '/bin', SHELL: '/bin/zsh' },
      // 1ms：两条臂平分后第一份就是 0，是这条边界唯一稳定的触发方式。
      timeoutMs: 1,
      runner: (_shell, args, _env, timeoutMs) => {
        handed.push({ arm: args[0]!, timeoutMs })
        return new Promise<string>(() => {})
      }
    })
    expect(result).toEqual({ ok: false, reason: 'probe-failed' })
    expect(
      handed.filter((call) => call.timeoutMs <= 0),
      'execFile 的 timeout<=0 意味着不设超时或异步抛错，两种都会漏出一个没人杀的 shell'
    ).toEqual([])
  })

  /**
   * 生产 runner 必须用 SIGKILL 收尸。
   *
   * 上面几条守的是「函数会 settle」，它们对 `runProfileShell` 里那个 `killSignal` 是失明的——把它删掉
   * 依然全绿，因为 `withDeadline` 会替它兜底。但兜底之后进程还活着：那是个泄漏的 zsh，抱着用户的
   * tty 不放。这条用例真起一个忽略 SIGTERM 的子进程，所以只有真的送 SIGKILL 才能过。
   *
   * 判据是**那个 pid 还在不在**，不是 `ps` 输出里有没有这个临时目录名：`ZDOTDIR` 是环境变量，从不
   * 出现在命令行里，按目录名过滤 `ps -Ao command` 恒得空数组，那样写整条断言是恒真的。
   */
  it('kills a profile shell that ignores SIGTERM instead of leaking it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentmux-shell-hang-'))
    try {
      const pidFile = join(directory, 'probe.pid')
      // trap 掉 TERM 再无限等待：这正是「.zshrc 卡在 read 上」那个真实形状的可控复现。只有交互式那条
      // 臂会 source 到它，非交互的 `-lc` 不读 .zshrc，于是照常返回——这也是本条期望 ok:true 的原因。
      await writeFile(join(directory, '.zshrc'), [
        `printf '%s' "$$" > '${pidFile}'`,
        "trap '' TERM",
        'while true; do sleep 0.05; done'
      ].join('\n'))
      await writeFile(join(directory, '.zprofile'), 'export AGENTMUX_TEST_HANG_PROFILE=loaded\n')
      const env: NodeJS.ProcessEnv = { HOME: directory, ZDOTDIR: directory, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }

      const result = await hydrateProcessEnvironmentFromLoginShell({ platform: 'darwin', env, timeoutMs: 1_400 })

      // 交互臂被掐死，非交互臂顶上：用户拿到的是 login 模式 + 一条「.zshrc 没能确认」的告示。
      expect(result).toEqual({ ok: true, shell: '/bin/zsh', mode: 'login' })
      expect(loginShellEnvironmentWarning(result)).toContain('.zshrc could not be confirmed')
      // 自检：交互臂真的起来过并且真的卡在了 .zshrc 里。没有这个 pid 文件的话，下面那条「它死了吗」
      // 就是在问一个从来不存在的进程，恒真。
      const hungPid = Number(await readFile(pidFile, 'utf8'))
      expect(Number.isInteger(hungPid) && hungPid > 0, '交互臂没跑到 .zshrc，超时判据不可观测').toBe(true)
      expect(alive(hungPid), '探针 shell 在超时后还活着——TERM 被 trap 掉了，没有人送 SIGKILL').toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
