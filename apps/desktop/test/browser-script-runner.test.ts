import { describe, expect, it } from 'vitest'
import { runBrowserScript } from '../src/main/browser-script-runner.js'

/**
 * 子进程执行器：Agent 写的脚本在独立进程里跑。
 *
 * 这里**不 mock 子进程**。被测的性质恰恰是"真起一个进程、它真崩了、主进程真没事"——
 * 假的 spawn 想让 OOM 长什么样就长什么样，那证明的是 fixture 的形状，不是隔离（见 MEMORY
 * 「合成的 fixture 等于自证」）。所以每条用例都真 spawn。代价是慢，值。
 */

// 真起进程 + Electron 二进制冷启动，5s 默认超时不够。
const SPAWN_TIMEOUT_MS = 30_000

describe('子进程里跑 Agent 脚本', () => {
  it('正常脚本跑完，返回值和日志都回来了', async () => {
    const result = await runBrowserScript({
      code: 'console.log("from the script"); return 1 + 1'
    })

    expect(result.completed, `脚本没跑完：${JSON.stringify(result)}`).toBe(true)
    expect(result.completed && result.value).toBe(2)
    expect(result.logs).toContain('from the script')
  }, SPAWN_TIMEOUT_MS)

  it('脚本在自己的进程里跑，不是在主进程里', async () => {
    // 承重的一条：整个任务的前提就是"不在主进程里"。若被测实现哪天退化成 eval，
    // 上面那条正常用例照样绿，而隔离已经没了。用 pid 判——这是唯一不会说谎的判据。
    const result = await runBrowserScript({ code: 'return process.pid' })

    expect(result.completed).toBe(true)
    expect(result.completed && result.value, '脚本报的 pid 就是主进程的 pid——它根本没进子进程').not.toBe(
      process.pid
    )
  }, SPAWN_TIMEOUT_MS)

  it('脚本 throw：主进程无感，错误如实回传', async () => {
    const result = await runBrowserScript({ code: 'throw new Error("deliberate boom")' })

    expect(result.completed).toBe(false)
    expect(!result.completed && result.failure.kind).toBe('script-error')
    expect(!result.completed && 'message' in result.failure && result.failure.message).toContain(
      'deliberate boom'
    )
  }, SPAWN_TIMEOUT_MS)

  it('抛错前打的日志不会丢', async () => {
    // 调试脚本炸掉之前打的那几行，往往正是 Agent 需要的信息。跟着异常一起丢掉的话，
    // Agent 只能看到一句错误，看不到它是怎么走到那儿的。
    const result = await runBrowserScript({
      code: 'console.log("got this far"); throw new Error("boom")'
    })

    expect(result.completed).toBe(false)
    expect(result.logs, '失败路径把日志丢了').toContain('got this far')
  }, SPAWN_TIMEOUT_MS)

  it('语法错误报成脚本错误，不是崩溃', async () => {
    // 分类必须对：语法错是 Agent 要改脚本，崩溃是环境出事。混成一类，Agent 就会去查错的方向。
    const result = await runBrowserScript({ code: 'this is not javascript at all' })

    expect(result.completed).toBe(false)
    expect(!result.completed && result.failure.kind).toBe('script-error')
  }, SPAWN_TIMEOUT_MS)

  it('死循环被超时杀掉，报 timeout 而不是伪装成别的失败', async () => {
    const started = Date.now()
    const result = await runBrowserScript({ code: 'while (true) {}', timeoutMs: 1_500 })
    const elapsed = Date.now() - started

    expect(result.completed).toBe(false)
    // 报成 crashed 就是在说谎：进程是我们杀的。Agent 看到 crashed 会去查环境，
    // 看到 timeout 才知道是自己的脚本没停下来。
    expect(!result.completed && result.failure.kind, '死循环被报成了别的失败').toBe('timeout')
    // 反向那一半：确实是被超时截断的，不是碰巧很快就结束了。
    expect(elapsed, '远超超时才返回——超时没有真的生效').toBeLessThan(15_000)
  }, SPAWN_TIMEOUT_MS)

  it('超时之后主进程还能继续跑下一段脚本', async () => {
    // "主进程无感"不是靠断言说出来的，是靠"杀完一个之后还能正常工作"证出来的。
    await runBrowserScript({ code: 'while (true) {}', timeoutMs: 1_000 })
    const after = await runBrowserScript({ code: 'return "still here"' })

    expect(after.completed, '杀掉死循环之后，执行器自己坏了').toBe(true)
    expect(after.completed && after.value).toBe('still here')
  }, SPAWN_TIMEOUT_MS)

  it('堆上限真的传给了 V8：同一段分配，卡小了就撞墙，给够了就跑完', async () => {
    // 两侧一起判，才是在测"上限生效"。只判失败那半的话，把 `--max-old-space-size` 整个删掉
    // 也能绿——失控分配迟早会以别的方式失败（实测删掉后仍然 crashed，只是慢了 45 倍）。
    // 所以取一段**有界**的分配：它在 32MB 下必然撞墙，在 4096MB 下必然跑完。
    const code =
      'const hog = []; for (let i = 0; i < 150; i++) hog.push(new Array(1e6).fill(i)); return hog.length'

    const capped = await runBrowserScript({ code, heapMb: 32, timeoutMs: 20_000 })
    expect(capped.completed, '32MB 堆装下了 150 个百万元素数组——上限没有传给 V8').toBe(false)
    expect(!capped.completed && capped.failure.kind).toBe('crashed')

    const roomy = await runBrowserScript({ code, heapMb: 4096, timeoutMs: 20_000 })
    expect(roomy.completed, '给够了堆却仍然失败——这个判据在测别的东西').toBe(true)
    expect(roomy.completed && roomy.value).toBe(150)
  }, 90_000)

  it('OOM 报成 crashed，且主进程不跟着一起死', async () => {
    // 堆压到很小，让失控 allocate 在一秒内撞墙。不压的话要吃掉几个 G 才触发，
    // 那既慢又真的会影响跑测试的这台机器。
    const result = await runBrowserScript({
      code: 'const hog = []; while (true) hog.push(new Array(1e6).fill("x"))',
      heapMb: 32,
      timeoutMs: 25_000
    })

    expect(result.completed).toBe(false)
    // 这里不要求一定是 'crashed'：不同 Node 版本下失控分配可能先撞堆上限（crashed），
    // 也可能一路慢下去直到超时（timeout）。两者都是"被拦住了"，都不是静默成功——
    // 而后者正是这条真正要排除的东西。
    expect(
      !result.completed && ['crashed', 'timeout'].includes(result.failure.kind),
      `OOM 被归成了 ${!result.completed && result.failure.kind}`
    ).toBe(true)

    const after = await runBrowserScript({ code: 'return "alive"' })
    expect(after.completed && after.value, 'OOM 之后主进程侧的执行器不能用了').toBe('alive')
  }, 60_000)

  it('脚本无法污染帧通道，console 里写的 JSON 只是日志', async () => {
    // stdout 是一行一条 JSON 的帧通道。脚本随手 console.log 一个 result 帧就能伪造返回值——
    // 这是执行器唯一的"输入来自不可信代码"的边界。守住它的是子进程里对 console 的接管：
    // 脚本的每一次 console 都被包成 log 帧，写不出裸帧。
    const forged = JSON.stringify({ kind: 'result', encoded: '"forged"' })
    const result = await runBrowserScript({
      code: `console.log(${JSON.stringify(forged)}); return "real"`
    })

    expect(result.completed).toBe(true)
    expect(result.completed && result.value, '脚本用一行 console.log 伪造了返回值').toBe('real')
    // 承重的一条。只判上面的返回值不够：没有接管时那行会被当成真帧解掉，只是随后被真结果
    // 覆盖而已——测试照样绿，而边界已经没了。要求它**作为日志文本**出现，才是在判接管本身。
    expect(
      result.logs,
      '伪造的帧没有作为日志出现——说明它被当成真帧解析了，console 没有被接管'
    ).toContain(forged)
  }, SPAWN_TIMEOUT_MS)

  it('返回值序列化不了时明说，而不是静默交出 undefined', async () => {
    const result = await runBrowserScript({ code: 'const a = {}; a.self = a; return a' })

    expect(result.completed, '循环引用被静默吞成了成功').toBe(false)
    expect(!result.completed && result.failure.kind).toBe('script-error')
  }, SPAWN_TIMEOUT_MS)

  it('输出洪水被截断，且不会把主进程内存一起吃掉', async () => {
    // 脚本必须**让出事件循环**（await），否则 stdout 全堵在子进程自己的缓冲里，父进程一个字节
    // 都收不到——那样子进程先自己撑死，测的就不是"父进程截断"了。真实脚本天然会让出：
    // T-007 之后每次页面调用都是一次异步往返。这里用 setTimeout(0) 把那个形状复现出来。
    const result = await runBrowserScript({
      code: [
        'const line = "x".repeat(10000)',
        'while (true) {',
        '  for (let i = 0; i < 50; i++) console.log(line)',
        '  await new Promise((resolve) => setTimeout(resolve, 0))',
        '}'
      ].join('\n'),
      timeoutMs: 20_000
    })

    expect(result.completed).toBe(false)
    // 归类要对：这是我们主动截断，不是环境崩了，也不是超时。报成 crashed 会让 Agent 去查环境，
    // 报成 timeout 会让它以为脚本慢——真正要改的是"少打点日志"。
    expect(
      !result.completed && result.failure.kind,
      '洪水没有被归成 output-limit——主进程要么跟着一起涨，要么把原因说错了'
    ).toBe('output-limit')
    expect(result.logs.some((line) => line.includes('被丢弃')), '没有告诉调用方输出被截断了').toBe(true)
  }, 40_000)

  it('从不让出事件循环的洪水，子进程自己死掉，主进程照样拿到结局', async () => {
    // 上一条的对照面。脚本不 await，stdout 全堆在子进程里，父进程的截断闸门根本收不到东西——
    // 子进程最后自己撑爆（实测 SIGABRT）。这一支同样不许静默成功：结局要如实回来，
    // 而且执行器本身不能坏。第一版把这种情况当成了"截断成功"，是错的。
    const result = await runBrowserScript({
      code: 'const line = "x".repeat(10000); while (true) console.log(line)',
      timeoutMs: 20_000
    })

    expect(result.completed, '子进程撑爆了却被报成成功').toBe(false)
    const after = await runBrowserScript({ code: 'return "alive"' })
    expect(after.completed && after.value, '子进程撑爆之后执行器不能用了').toBe('alive')
  }, 60_000)

  it('脚本自己 process.exit(0) 退出，不算跑完', async () => {
    // 退出码 0 但没有结果帧。"没报错"不等于"跑完了"——这一支若当成功返回，Agent 会收到一个
    // `completed: true, value: undefined`，与"脚本正常返回 undefined"完全无法区分
    // （AGENTS.md:32-52：分不清的不许当成好的）。
    const result = await runBrowserScript({ code: 'process.exit(0)' })

    expect(result.completed, 'process.exit(0) 被当成了正常跑完').toBe(false)
    expect(!result.completed && result.failure.kind).toBe('crashed')
    expect(!result.completed && 'reason' in result.failure && result.failure.reason).toContain(
      'without reporting a result'
    )
  }, SPAWN_TIMEOUT_MS)

  it('脚本正常返回 undefined 是成功，跟上一条区分得开', async () => {
    // 反向那一半。只判上一条的话，"永远不算成功"也会绿。
    const result = await runBrowserScript({ code: 'console.log("done")' })

    expect(result.completed, '什么都不返回的脚本被判成失败了').toBe(true)
    expect(result.completed && result.value).toBeUndefined()
  }, SPAWN_TIMEOUT_MS)

  it('脚本绕过 console 直接写 stdout，输出也不会消失', async () => {
    // 接管的是 console，不是 stdout——脚本仍然可以 `process.stdout.write`。那些字节解不成帧，
    // 但也不能丢：丢掉的话，一个用裸 write 调试的脚本会"什么都没输出"，Agent 无从发现自己写错了
    // 出口。Node 自己在崩溃前打的诊断也走这条路。
    const result = await runBrowserScript({
      code: 'process.stdout.write("raw junk\\n"); return "ok"'
    })

    expect(result.completed).toBe(true)
    expect(result.logs, '非帧输出被静默丢掉了').toContain('raw junk')
  }, SPAWN_TIMEOUT_MS)

  it('子进程带着 ELECTRON_RUN_AS_NODE 起来', async () => {
    // 在 Electron 主进程里，`process.execPath` 是 Electron 二进制，不带这个变量它会去开一个
    // GUI 应用而不是跑 Node。测试自己跑在纯 Node 下，看不到那个后果——所以判的是"变量到没到
    // 子进程手里"这个可观测的前提，而不是赌一个在本环境里不可观测的性质
    //（见 MEMORY「判别器可能在别的环境缺席」）。
    const result = await runBrowserScript({
      code: 'return process.env.ELECTRON_RUN_AS_NODE ?? "unset"'
    })

    expect(result.completed).toBe(true)
    expect(result.completed && result.value, '子进程没收到 ELECTRON_RUN_AS_NODE').toBe('1')
  }, SPAWN_TIMEOUT_MS)

  it('宿主的 NODE_OPTIONS 不会注入到脚本进程里', async () => {
    // workspace-files.ts:376 删掉它是有原因的：开发机上一个 --require 会跟着跑进
    // 每一段 Agent 脚本里，脚本的行为就取决于是谁在哪台机器上开的 AgentMux。
    const previous = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = '--throw-deprecation'
    try {
      const result = await runBrowserScript({ code: 'return process.env.NODE_OPTIONS ?? "unset"' })
      expect(result.completed, `设了 NODE_OPTIONS 之后脚本跑不起来了：${JSON.stringify(result)}`).toBe(true)
      expect(result.completed && result.value).toBe('unset')
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = previous
    }
  }, SPAWN_TIMEOUT_MS)
})
