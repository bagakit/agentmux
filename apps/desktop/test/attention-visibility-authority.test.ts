import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// STRUCTURAL guard: the attention path must not hold a SECOND "is this on screen" predicate.
//
// The defect was three independent answers to one question. The recyclers read the single authority
// `surfaceNavigationVisibility`; the attention path answered it a third time by reading
// `layouts[ws].groups` RAW, and the two had diverged on Scratch Topics. The fix routes the attention
// path through the same authority, via `session-visibility`. This guard pins that wiring so a future
// edit cannot quietly grow a fourth predicate back.
//
// It is judged by IMPORT RELATION — which module the on-screen value actually comes from — NOT by a
// text ban like `not.toContain('someName(')`. A bare identifier or a different spelling trivially
// bypasses a text ban, and a text ban also misfires on legitimately same-shaped code. Every positive
// claim below carries a self-check that the expected import IS found, so a renamed file makes the scan
// fail loudly instead of passing by finding nothing.
//
// Why this is separate from `surface-navigation-visibility.test.ts`'s structural guard: that one only
// scans files that PRODUCE `{ navigationContextActive }`. `session-visibility.ts` consumes the
// authority's `tabVisible` but produces no such field, so it is invisible to that guard — this new
// consumer needs its own.
//
// Why a structural guard can't be the whole story (see the known `row-attention.test.ts` trap): source
// text does not execute, so an early `return` could no-op the implementation while this stays green.
// The behavior seam in `attention-topic-visibility.test.ts` runs the real notifier against the real
// authority; the two together are the guard.

const RENDERER = new URL('../src/renderer/src/', import.meta.url).pathname
const HOOK = 'hooks/useAgentAttentionNotifications.ts'
const SESSION_VISIBILITY = 'lib/session-visibility.ts'
const AUTHORITY = 'lib/surface-navigation-visibility.ts'

function read(relative: string): string {
  const source = readFileSync(join(RENDERER, relative), 'utf8')
  // Vacuity self-check: an empty/missing file must not let the assertions below pass by having nothing
  // to match. Reading a missing path already throws; this pins that a moved file is a loud failure.
  expect(source.length, `${relative} 读到空内容——扫描对象不在了，下面的断言会假绿`).toBeGreaterThan(0)
  return source
}

describe('attention 路径的在屏判定只有一处来源', () => {
  it('hook 的在屏集合取自 session-visibility，而不是自己再算一遍', () => {
    const hook = read(HOOK)

    // Positive + self-check: the hook MUST source its on-screen set from session-visibility. If this
    // import is renamed away, this line fails rather than the negative checks passing vacuously.
    expect(
      hook,
      'attention hook 不再从 session-visibility 取在屏集合——它要么自己算了一遍，要么换了来源'
    ).toMatch(/import \{[^}]*\bvisibleSessionIdsForState\b[^}]*\} from '\.\.\/lib\/session-visibility'/)
    expect(
      hook.match(/\bvisibleSessionIdsForState\(/g) ?? [],
      'attention hook import 了在屏取值器却没有调用它——import 是死的，正是原缺陷的一种形状'
    ).toHaveLength(1)

    // Negative, by import relation: the hook must NOT become topic-aware on its own. The only
    // legitimate way for the attention path to see through Topics is via the authority (reached through
    // session-visibility). A direct import of the projection primitives here would be a second predicate
    // growing back at the call site.
    expect(
      /import [^\n]*\b(activeTopicIdFromLayout|layoutForActiveTopic)\b[^\n]*from '[^']*scratch-topic-layout'/.test(hook),
      'attention hook 直接 import 了 Topic 投影原语——它在绕过唯一实现自己判在屏'
    ).toBe(false)
    // And it must not reach into raw layout groups to reconstruct the on-screen set the way the deleted
    // predicate did.
    expect(
      /\.layouts\b[\s\S]{0,120}\.groups\b/.test(hook),
      'attention hook 直接读 layouts[...].groups——那正是被删掉的 Topic-盲 的原始读法'
    ).toBe(false)
  })

  it('hook 的每一个用户选择都取自 config 解析器，而不是写死一个常量', () => {
    // 同一条规则的另一个字段。这个 hook 是「把配置里的选择翻译成一次投递」的那一层，它有两个这样的
    // 选择：停留档位与声音。两者都必须经解析器从 config 取——把任意一个写成字面量，界面上的开关就
    // 变成装饰品，而 tsc 完全沉默（`sound: false` 类型正确）、所有行为测试照旧全绿（实测：把
    // `resolveNotificationSound(state.config)` 换成 `false`，三个相关文件 15 条一条不红）。
    //
    // 声音这一维尤其需要这条：它的前身是 main 请求类型上一个可选的 `silent`，投递侧认真读它，而**没有
    // 任何调用方传过它**——一个声明了、被兑现了、却谁也够不着的能力。那种缺陷正是靠「没有人检查这根
    // 线接上没有」活下来的。
    const hook = read(HOOK)
    for (const resolver of ['resolveNotificationModeId', 'resolveNotificationSound']) {
      expect(
        hook,
        `attention hook 不再 import ${resolver}——用户的这个选择没有来源了`
      ).toMatch(new RegExp(`import \\{[^}]*\\b${resolver}\\b[^}]*\\} from '[^']*notification-presentation'`))
      expect(
        hook.match(new RegExp(`\\b${resolver}\\(state\\.config\\)`, 'g')) ?? [],
        `attention hook 没有用 ${resolver} 读 config——这个选择要么写死了，要么读的是别处`
      ).toHaveLength(1)
    }
  })

  it('session-visibility 的在屏判定取自那处唯一实现 surfaceNavigationVisibility', () => {
    const sv = read(SESSION_VISIBILITY)

    // The subject import: session-visibility must obtain its visibility decision by importing the single
    // authority. Delete this import and the attention path no longer reads the shared answer — this line
    // goes red (the required "delete the structural guard's subject import" mutation).
    expect(
      sv,
      'session-visibility 不再从 surface-navigation-visibility import——在屏判定脱离了唯一实现'
    ).toMatch(/import \{[^}]*\bsurfaceNavigationVisibility\b[^}]*\} from '\.\/surface-navigation-visibility'/)
    // Not a dead import: it must actually be called, exactly once. An imported-but-unused authority is
    // the original bug class (see surface-navigation-visibility.test.ts).
    expect(
      sv.match(/\bsurfaceNavigationVisibility\(/g) ?? [],
      'session-visibility import 了唯一实现却没恰好调用一次——要么没调（死 import），要么调了不止一处'
    ).toHaveLength(1)

    // Negative, by import relation: session-visibility must NOT re-derive Topic visibility itself. If it
    // imported the projection primitives directly it would be answering the question a second time
    // instead of delegating — exactly the divergence this fix removes.
    expect(
      /import [^\n]*\b(activeTopicIdFromLayout|layoutForActiveTopic)\b[^\n]*from '[^']*scratch-topic-layout'/.test(sv),
      'session-visibility 自己 import 了 Topic 投影原语——它在唯一实现之外又判了一遍在屏'
    ).toBe(false)
  })

  it('那处唯一实现确实是 Topic-aware 的（否则整条链把 Topic 判丢也不会红）', () => {
    // A backstop self-check for the chain above: the authority we route through must be the Topic-aware
    // one — it must import and apply `layoutForActiveTopic`. If it were not, delegating to it would be
    // no better than the deleted raw read, and every assertion above would still pass while the defect
    // silently returned. This anchors the whole guard to the fact that made the fix a fix.
    const authority = read(AUTHORITY)
    expect(
      authority,
      '唯一实现不再 import Topic 投影——它若不 Topic-aware，整条链等于没修'
    ).toMatch(/import \{[^}]*\blayoutForActiveTopic\b[^}]*\} from '\.\/scratch-topic-layout'/)
    expect(
      authority.match(/\blayoutForActiveTopic\(/g) ?? [],
      '唯一实现 import 了 layoutForActiveTopic 却没有应用它——投影没发生，Topic 又被判丢'
    ).not.toHaveLength(0)
  })
})
