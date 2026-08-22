import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { browserPageCapabilityNames } from '@agentmux/core'
import {
  BROWSER_PAGE_FUNCTION_NAMES,
  runBrowserScript
} from '../src/main/browser-script-runner.js'

/**
 * 页面函数库：注入子进程的那批函数，每次调用回主进程执行。
 *
 * 这里判的是**通道**——名字到没到脚本手里、参数有没有原样送回、应答有没有回到那次调用上、
 * 脚本能不能伪造应答。每个函数具体干什么（真的去点那个元素）属于主进程那一侧，
 * 由 T-010 在真机上验；在这里用一个记账的替身反而更能把通道本身暴露出来。
 */

const SPAWN_TIMEOUT_MS = 30_000

/** 记下每一次页面调用，并按预设返回。 */
function recordingHost(reply: (name: string, args: unknown[]) => unknown = () => null) {
  const calls: { name: string; args: unknown[] }[] = []
  return {
    calls,
    onPageCall: async (name: string, args: unknown[]) => {
      calls.push({ name, args })
      return reply(name, args)
    }
  }
}

describe('页面函数库', () => {
  it('五组函数都注入到了脚本里，一个不少', async () => {
    // 清单本身是承重的：少注入一个，Agent 写出来的程序就会报 "xxx is not defined"，
    // 而那看起来像是 Agent 自己写错了名字。
    const host = recordingHost()
    const result = await runBrowserScript({
      code: `return [${BROWSER_PAGE_FUNCTION_NAMES.map((n) => `typeof ${n}`).join(',')}]`,
      onPageCall: host.onPageCall
    })

    expect(result.completed, `脚本没跑完：${JSON.stringify(result)}`).toBe(true)
    expect(BROWSER_PAGE_FUNCTION_NAMES.length, '清单空了，这条在对空气生效').toBeGreaterThan(0)
    expect(result.completed && result.value).toEqual(BROWSER_PAGE_FUNCTION_NAMES.map(() => 'function'))
  }, SPAWN_TIMEOUT_MS)

  it('五组能力一组都不缺，且分组取自能力表不是手抄', async () => {
    // 此前这里是一份手写的分组映射（观察/动作/等待/导航/逃生口 → 名字）。它是这份事实的第四份
    // 副本，而且方向是反的：手抄的那份里少写一个名字，这条测试只会少判一项，不会红。
    //
    // f-27c8fr4x2 之后分组取能力表上的 `effect` 字段（core 的 browser-page-capability.ts），
    // 而**那个字段是被生产代码消费的**——人工接管之后拒绝谁就按它算。所以这里与生产判据同源：
    // 分组错了会在接管行为上显形，不只是文档不好看。
    const byEffect = {
      观察: browserPageCapabilityNames('observe'),
      动作: browserPageCapabilityNames('act'),
      等待: browserPageCapabilityNames('wait'),
      导航: browserPageCapabilityNames('navigate')
    }

    // 每一组都必须非空：某一组取空时下面的循环对它一条不跑，而空集合上的遍历恒真
    // （MEMORY「空集合上的谓词断言恒成立」）。四组各钉一次，不是只钉总数。
    for (const [group, names] of Object.entries(byEffect)) {
      expect(names.length, `${group}组是空的——这一组的判据在对空气生效`).toBeGreaterThan(0)
      for (const name of names) {
        expect(BROWSER_PAGE_FUNCTION_NAMES, `${group}组少了 ${name}`).toContain(name)
      }
    }

    // 分组是对全表的**划分**：并集必须等于全表，不许有名字落在四组之外。少了这一条，
    // 往表里加一个新的 effect 取值就会让那个能力从所有分组里消失，而没有东西会红。
    expect(
      Object.values(byEffect).flat().slice().sort(),
      '有能力不属于任何一组，或被算进了两组——分组不是对全表的划分'
    ).toEqual([...BROWSER_PAGE_FUNCTION_NAMES].sort())

    // 逃生口按动作计（它们能做任何事，漏掉任何一个都等于没拦），单独钉一次它们在 act 里。
    for (const hatch of ['js', 'cdp']) {
      expect(browserPageCapabilityNames('act'), `逃生口 ${hatch} 没算成动作——接管之后它不会被拒`)
        .toContain(hatch)
    }

    // 反向的一半：注入一个派发层服务不了的名字，比不注入更糟——Agent 会把它当成可用能力去规划，
    // 然后在半途撞上拒绝，而此时前面的动作已经做过了。一个 Browser 就是一个页面，没有标签页。
    for (const name of ['openOrReuseTab', 'switchTab', 'listTabs']) {
      expect(BROWSER_PAGE_FUNCTION_NAMES, `注入了 ${name}，但一个 Browser 只有一个页面，它必定失败`)
        .not.toContain(name)
    }
  })

  it('每个注入的名字派发层都有自己的 case，没有会落到 default 的', () => {
    // **这条守的是能力表与派发 switch 之间的缺口，它此前没有任何守卫。**
    //
    // `createBrowserPageDispatch` 是一个 `switch (name)`，而 `name` 的类型是 `string`——不是能力表
    // 派生的联合。这是刻意的：名字从子进程经 IPC 送来，可以是任意字符串，所以 `default` 分支必须在。
    // 代价是 **tsc 看不见漏掉的 case**：往能力表里加一个名字而忘了加 case，编译全绿、注入也成功，
    // Agent 调它时才撞上 default 那句「injected but this Browser cannot serve it」——而那句话说的是
    // 「这个 Browser 服务不了」，听起来像页面的问题，实际是我们漏了一行。
    //
    // 判据从**派发源码**反推 case 标签，与能力表比对。不真的调一遍派发，是因为那需要一个完整的
    // CDP 替身，而那条路上任何一个细节不对都会抛，与「这个名字有没有 case」混在一起不可区分。
    const dispatchSource = readFileSync(
      new URL('../src/main/browser-page-dispatch.ts', import.meta.url),
      'utf8'
    )
    // 只取 switch (name) 那一段，否则文件里别处的字符串字面量会混进来充数。
    const switchStart = dispatchSource.indexOf('switch (name)')
    expect(switchStart, '派发层里找不到 switch (name)——判据的范围落空，它什么都不检查').toBeGreaterThan(-1)
    const switchBody = dispatchSource.slice(switchStart)
    const defaultAt = switchBody.indexOf('default:')
    expect(defaultAt, '派发 switch 没有 default 分支——未知名字会静默返回 undefined').toBeGreaterThan(0)

    // case 标签只数 default 之前的那一段：default 之后是那句拒绝文案，里面也含名字。
    const served = new Set(
      [...switchBody.slice(0, defaultAt).matchAll(/case '([a-zA-Z]+)':/g)].map((match) => match[1]!)
    )
    // 非空自检：正则一条都没匹配上时，下面的循环恒真（MEMORY「扫到空内容」）。
    expect(served.size, '一个 case 标签都没解析出来——判据失效').toBeGreaterThan(10)

    for (const name of BROWSER_PAGE_FUNCTION_NAMES) {
      expect(served, `注入了 ${name} 但派发层没有它的 case，Agent 调用时会撞上 default 那句拒绝`)
        .toContain(name)
    }
    // 反向：派发层不该有能力表里没有的 case——那是个注入不到、永远走不到的死分支。
    for (const name of served) {
      expect(BROWSER_PAGE_FUNCTION_NAMES, `派发层有 ${name} 的 case，但它不在能力表里，永远不会被调到`)
        .toContain(name)
    }
  })

  it('脚本调页面函数，名字和参数原样送回主进程', async () => {
    const host = recordingHost()
    const result = await runBrowserScript({
      code: 'await click("@e3"); await fillInput("@e7", "hello")',
      onPageCall: host.onPageCall
    })

    expect(result.completed, `脚本没跑完：${JSON.stringify(result)}`).toBe(true)
    expect(host.calls).toEqual([
      { name: 'click', args: ['@e3'] },
      { name: 'fillInput', args: ['@e7', 'hello'] }
    ])
  }, SPAWN_TIMEOUT_MS)

  it('主进程的返回值回到脚本手里', async () => {
    const host = recordingHost((name) => (name === 'pageInfo' ? { url: 'https://x.invalid/' } : null))
    const result = await runBrowserScript({
      code: 'const info = await pageInfo(); return info.url',
      onPageCall: host.onPageCall
    })

    expect(result.completed, `脚本没跑完：${JSON.stringify(result)}`).toBe(true)
    expect(result.completed && result.value).toBe('https://x.invalid/')
  }, SPAWN_TIMEOUT_MS)

  it('多次调用各回各的，不会串台', async () => {
    // 承重的一条。只发一次调用的话，"永远把最后一个应答给所有人"也能绿——而那种缺陷
    // 在真实脚本里表现为"点了 A 却拿到 B 的结果"，极难查。
    const host = recordingHost((_name, args) => `answer-for-${String(args[0])}`)
    const result = await runBrowserScript({
      code: 'const a = await snapshot("one"); const b = await snapshot("two"); return [a, b]',
      onPageCall: host.onPageCall
    })

    expect(result.completed, `脚本没跑完：${JSON.stringify(result)}`).toBe(true)
    expect(result.completed && result.value).toEqual(['answer-for-one', 'answer-for-two'])
  }, SPAWN_TIMEOUT_MS)

  it('并发的调用按 callId 各自落位，不按到达顺序', async () => {
    // 应答乱序返回时，靠的必须是 callId 而不是"先来先配"。故意让先发的那个后答。
    const host = {
      onPageCall: async (_name: string, args: unknown[]) => {
        const delay = args[0] === 'slow' ? 300 : 0
        await new Promise((resolve) => setTimeout(resolve, delay))
        return `done-${String(args[0])}`
      }
    }
    const result = await runBrowserScript({
      code: 'return await Promise.all([snapshot("slow"), snapshot("fast")])',
      onPageCall: host.onPageCall
    })

    expect(result.completed, `脚本没跑完：${JSON.stringify(result)}`).toBe(true)
    expect(result.completed && result.value, '应答配错了调用——按到达顺序而不是 callId 在配').toEqual([
      'done-slow',
      'done-fast'
    ])
  }, SPAWN_TIMEOUT_MS)

  it('主进程那边失败，脚本里长成一个真的异常', async () => {
    // 脚本作者用 try/catch 接它。若返回 { ok:false } 让脚本自己检查，没人会记得检查——
    // 失败会被当成成功一路走下去。
    const host = {
      onPageCall: async () => {
        throw new Error('element is gone')
      }
    }
    const result = await runBrowserScript({
      code: 'try { await click("@e1") } catch (error) { return "caught: " + error.message }',
      onPageCall: host.onPageCall
    })

    expect(result.completed, `脚本没跑完：${JSON.stringify(result)}`).toBe(true)
    expect(result.completed && result.value).toBe('caught: element is gone')
  }, SPAWN_TIMEOUT_MS)

  it('没给页面能力时，调用被明确拒绝，而不是挂在那儿', async () => {
    // 不接浏览器就跑脚本是合法的（纯计算）。这时候调 click 必须立刻拿到一句说得清的拒绝——
    // 挂起看起来和"页面没响应"一模一样，Agent 会一直等到整体超时才知道出事。
    const result = await runBrowserScript({
      code: 'try { await click("@e1") } catch (error) { return error.message }',
      timeoutMs: 8_000
    })

    expect(result.completed, '没有页面能力时调用挂住了，拖到了超时').toBe(true)
    expect(result.completed && String(result.value)).toContain('no page access')
  }, SPAWN_TIMEOUT_MS)

  it('伪造的 page-call 重放不会让动作执行两次', async () => {
    // IPC 通道对脚本是藏不住的（实测：`delete process.channel` 会让 inbound 失效——Node 每次
    // 投递都要读它；只摘 `process.send` 则脚本仍能拿到 `process.channel.fd` 写裸消息）。所以防线
    // 不建立在"够不着"，而建立在父进程只服务自己欠着的每个 callId 一次。没有这条，脚本重放一条
    // page-call 就能让一次 click 真的点两下——在真实场景里就是"下单被点了两次"。
    const host = recordingHost(() => 'ok')
    const result = await runBrowserScript({
      code: [
        'const { writeSync } = await import("node:fs")',
        'await click("@e1")',
        // 走裸 fd，因为 process.send 已经被摘掉了。复用第一次调用的 callId（runner 从 1 发号）。
        'const forged = JSON.stringify({ kind: "page-call", callId: 1, name: "click", args: ["@e1"] })',
        'let wrote = false',
        'try { writeSync(process.channel.fd, forged + "\\n"); wrote = true } catch {}',
        'await new Promise((resolve) => setTimeout(resolve, 400))',
        'return wrote'
      ].join('\n'),
      onPageCall: host.onPageCall,
      timeoutMs: 12_000
    })

    expect(result.completed, `脚本没跑完：${JSON.stringify(result)}`).toBe(true)
    // 先证伪造这一步真的发生了，否则下面那条在对空气生效（AGENTS.md:85-88）。
    expect(result.completed && result.value, '脚本根本没写出伪造消息，这条守卫没被考验到').toBe(true)
    expect(
      host.calls.filter((call) => call.name === 'click'),
      '同一个 callId 被服务了两次——重放能让页面动作重复执行'
    ).toHaveLength(1)
  }, SPAWN_TIMEOUT_MS)

  it('脚本看不到 process.send——挡住无心之失（有心的挡不住，见上一条）', async () => {
    // 摘掉 send 买到的是"脚本不会顺手拿它当普通 IPC 用"。这不是安全边界（channel.fd 还在），
    // 但也不是没用：真正的防线是父进程的 callId 去重，这一层只是别让通道看起来像公开 API。
    // 不判的话，"其实没摘"和"摘了"没有任何可观测差别——注释就成了单方面声明。
    const host = recordingHost(() => 'ok')
    const result = await runBrowserScript({
      code: 'return typeof process.send',
      onPageCall: host.onPageCall
    })

    expect(result.completed).toBe(true)
    expect(result.completed && result.value, 'process.send 还挂在 process 上').toBe('undefined')
  }, SPAWN_TIMEOUT_MS)

  it('页面调用挂住时，整体超时仍然收得住', async () => {
    // 不给每次调用单独设超时（那是第二套超时机制）。挂住的调用由脚本整体超时兜底——
    // 这条就是在证那个兜底真的兜得住，而不是主进程侧跟着一起等。
    const host = { onPageCall: () => new Promise<never>(() => {}) }
    const result = await runBrowserScript({
      code: 'await click("@e1"); return "should not get here"',
      onPageCall: host.onPageCall,
      timeoutMs: 1_500
    })

    expect(result.completed).toBe(false)
    expect(!result.completed && result.failure.kind).toBe('timeout')
  }, SPAWN_TIMEOUT_MS)

  it('这些函数不进对外的 Control 契约', async () => {
    // 「内部 API 不是对外协议」这条如果只写在注释里，迟早有人把它们加进 control.ts 换取
    // "CLI 也能调"。那一步之后改名就要走版本化契约了，方案的核心优势当场消失。
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = join(import.meta.dirname, '..', '..', '..')
    const control = readFileSync(join(root, 'packages/core/src/control.ts'), 'utf8')

    // 先证扫描面真的读到了东西，否则路径写错时这条恒绿（AGENTS.md:85-88）。
    expect(control, 'control.ts 没读到内容，这条在对空气生效').toContain('AgentMuxControlRequest')

    // 只点名那几个专属这套库的名字：click / wait 这种词在任何代码库里都可能作为别的东西出现，
    // 拿它们判会误伤。
    for (const name of ['snapshotText', 'waitForNetworkIdle', 'openOrReuseTab']) {
      expect(control, `${name} 进了对外 Control 契约——库函数被提升成协议了`).not.toContain(name)
    }
  })
})
