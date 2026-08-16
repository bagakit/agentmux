import { describe, expect, it } from 'vitest'
import { crashLogRevealNotice, type CrashLogReveal } from '../src/renderer/src/lib/crash-log-reveal.js'

// 崩溃证据一直在写（crash-log.ts 的 NDJSON），却从来没有读者——没人知道路径就等于没有。
// 加了「显示崩溃日志」之后，这条守卫盯的是**那个按钮会不会静默**。
//
// 判据为什么落在文案上：这条功能唯一的产出就是「让用户知道发生了什么」。文件不存在是最常见的一次点击
// （多数人从没崩过），而那一次如果什么都不说，用户分不清是没崩过还是按钮坏了——那就把本来要修的病
// 原样搬进了修复里。

describe('crashLogRevealNotice：四个结局都要出声', () => {
  it('三个结局各有一句话，且互不相同', () => {
    // 互不相同是重点：三条都返回同一句（比如都说 "Done"）会让每条断言单独看都通过，而用户仍然
    // 分不出「点开了」「没崩过」「打不开」。
    const spoken = (['revealed', 'absent', 'failed'] as const).map(crashLogRevealNotice)
    expect(spoken.every((line) => typeof line === 'string' && line.length > 0)).toBe(true)
    expect(new Set(spoken).size, `三个结局说了同一句话：${JSON.stringify(spoken)}`).toBe(3)
  })

  it('没崩过要说成没崩过，不能说成失败', () => {
    // 文件不存在是**好消息**。把它归到失败那一侧，等于每个从没崩过的用户都被告知出了错。
    const absent = crashLogRevealNotice('absent') ?? ''
    expect(absent).toContain('No crashes recorded')
    expect(absent.toLowerCase(), '把「没崩过」说成了错误').not.toContain('could not')
  })

  it('打不开要承认打不开，并给出文件在哪', () => {
    // 静默失败是这条功能本来要修的那个病。
    const failed = crashLogRevealNotice('failed') ?? ''
    expect(failed).toContain('Could not open')
    expect(failed, '说了失败却没说去哪找').toContain('folder')
  })

  it('没点过按钮时不说话——空态由调用方填隐私那句', () => {
    // 相反的世界。少了这条，把函数写成「永远返回一句话」也照样通过，而那会让 idle 态挂着一句
    // 「Opened in your file manager.」——一句关于从未发生过的事的陈述。
    expect(crashLogRevealNotice('idle')).toBeNull()
  })

  it('每一个状态取值都被覆盖到了，没有漏网的分支', () => {
    // 这条守的是「以后加了第五个状态」。类型上加一个成员不会让上面四条红——它们只点名自己那个。
    const every: CrashLogReveal[] = ['idle', 'revealed', 'absent', 'failed']
    for (const state of every) {
      const line = crashLogRevealNotice(state)
      expect(line === null || line.length > 0, `${state} 既不是沉默也不是一句话`).toBe(true)
    }
  })
})
