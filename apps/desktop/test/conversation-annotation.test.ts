import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })

import { useAppStore } from '../src/renderer/src/store.js'

const activity = readFileSync(new URL('../src/renderer/src/components/ActivityView.tsx', import.meta.url), 'utf8')
const pane = readFileSync(new URL('../src/renderer/src/components/SessionPane.tsx', import.meta.url), 'utf8')

/**
 * 选中的引文进入当前 Agent 草稿，而不是另起一条发送路径。
 *
 * 病史（2026-09-25）：这份判据原先三条全是读源码文本——`toContain('messageId: string')` 命中的是
 * 一行**类型标注**，`toContain('const reference = `Regarding this message:')` 命中的是一个字符串
 * 字面量。它们证明不了拼出来的东西长什么样。实测变异：把注解弹层改成永不渲染，整条能力断掉，
 * 这份 gate **6 条全绿**。渲染与交互那一半现在由 `conversation-annotation-flow.test.tsx` 守。
 *
 * 这一份守剩下的那半：**引文落进草稿之后是什么样子**。
 *
 * 同一轮还修了一个真缺陷：「把一段引文追加进当前草稿」这个决定有**两份实现**——浏览器标注走
 * store 的 `appendAgentComposerDraft`，而 `SessionPane.annotateMessage` 手写了一份读-改-写。
 * 两份在尾部空白上不一致（实测：草稿为 `'Existing\n'` 时手写那份给 `Existing\n\nREF`、
 * store 给 `Existing\n\n\nREF`），而只有 store 那份有判据。现在只剩一份。
 */

const initialState = useAppStore.getState()

/** 产品里那句拼装：`SessionPane.annotateMessage` 交给 store 的正是这一串。 */
function reference(quote: string, note: string): string {
  return `Regarding this message:\n> ${quote.replace(/\n/gu, '\n> ')}\n\nNote: ${note}`
}

describe('conversation annotation contract', () => {
  afterEach(() => { useAppStore.setState(initialState, true) })

  it('引文与注解拼成一段可读的引用块，多行引文每一行都带引用记号', () => {
    const composed = reference('first line\nsecond line', 'Why this branch?')
    expect(composed).toBe(
      'Regarding this message:\n> first line\n> second line\n\nNote: Why this branch?'
    )
    // 产品源码里那一句必须就是这一句：拼装逻辑写在组件里，判据在这里重述，两边靠这条对齐。
    // 只钉前缀（老写法）会放过 `\n> ` 被改成 `\n`——多行引文从此和正文混在一起。
    expect(
      pane,
      'SessionPane 的引用拼装与判据不一致了；若确实要改格式，两处一起改'
    ).toContain('`Regarding this message:\\n> ${annotation.quote.replace(/\\n/gu, \'\\n> \')}\\n\\nNote: ${annotation.note}`')
  })

  it('追加进已有草稿，不覆盖用户已经写下的字', () => {
    const state = useAppStore.getState()
    state.setAgentComposerDraft('agent-1', 'Already typing this')
    state.appendAgentComposerDraft('agent-1', reference('the worker reported back', 'Check this'))

    const draft = useAppStore.getState().agentComposerDrafts['agent-1']!
    expect(draft, '用户已经写下的字被覆盖了').toContain('Already typing this')
    expect(draft, '引文没进草稿').toContain('> the worker reported back')
    expect(draft, '注解没进草稿').toContain('Note: Check this')
    // 空行分隔：两段之间没有空行，Agent 读到的是粘在一起的一段。
    expect(draft).toBe(`Already typing this\n\n${reference('the worker reported back', 'Check this')}`)
  })

  it('草稿是空的时候不带头部空行', () => {
    useAppStore.getState().appendAgentComposerDraft('agent-2', reference('one line', 'A note'))
    expect(
      useAppStore.getState().agentComposerDrafts['agent-2'],
      '空草稿上追加却带了前导空行——发出去的第一行是空的'
    ).toBe(reference('one line', 'A note'))
  })

  it('注解只走这一条路：追加进草稿，不自己发送', () => {
    // `annotateMessage` 里出现任何直接发送，就等于第二条发送路径——用户点「Add note to reply」
    // 的预期是"写进我的输入框，我再决定什么时候发"。
    const body = pane.slice(pane.indexOf('const annotateMessage'), pane.indexOf('const openFile'))
    expect(body.length, 'annotateMessage 的函数体没切出来——这条判据在空转').toBeGreaterThan(80)
    expect(body, '注解路径里直接发送了').not.toMatch(/\bsend\(|enqueueAgentSteer\(/u)
    expect(body, '注解没有走共用的草稿追加动作').toContain('appendAgentComposerDraft(sessionId')

    // 宿主没接 onAnnotate 时不该往下传一个假的：Gallery 这类只读场景靠缺席关掉这条路。
    expect(activity).toContain('...(onAnnotate ? { onAnnotate } : {})')
  })
})
