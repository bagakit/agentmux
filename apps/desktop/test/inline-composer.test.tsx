import { describe, expect, it } from 'vitest'
import { draftDocument, documentDraft, keywordUnderlineExtension } from '../src/renderer/src/components/InlineComposer.js'
import { appendSemanticReference, expandSemanticReferences, type ComposerSemanticReference } from '../src/renderer/src/lib/composer-semantic-reference.js'

describe('inline composer durable reference surface', () => {
  const ref: ComposerSemanticReference = { token: '', label: 'review', kind: 'skill', reference: '@/skills/review/SKILL.md' }
  it('keeps full target in the durable draft while rendering a typed node', () => {
    const draft = appendSemanticReference('Please', ref)
    expect(draft).toContain('agentmux-skill:')
    expect(documentDraft(draftDocument(draft))).toBe(draft)
    expect(expandSemanticReferences(draft)).toBe('Please @/skills/review/SKILL.md ')
  })
  it('keeps ordinary newlines and multiple references ordered', () => {
    const a = appendSemanticReference('', ref)
    const b = appendSemanticReference(a + '\nnext', { ...ref, label: 'status', kind: 'subcommand', reference: '/status' })
    expect(expandSemanticReferences(b)).toContain('\nnext /status')
  })
})

/**
 * 识别词的下划线装饰。
 *
 * 判据直接调扩展的 `addDecorations().create({ state })` 并喂一个最小的 doc 替身：本仓 vitest 是 node
 * 环境，起不了真编辑器，而这个钩子的契约只要 `state.doc.descendants(fn)`。替身**不**冻结成常量返回
 * 固定内容——那样"读实时"与"读快照"两种实现结果一样，被测性质就藏起来了（本仓「替身写成常量会藏起
 * 被测性质」）。
 */
describe('识别词的下划线装饰', () => {
  /**
   * 一段纯文本的 doc 替身。pos 从 1 起（ProseMirror 的 doc 节点自己占 0）。
   *
   * 外层那个 `state` 不是多余的包装：`create` 的入参是 `{ editor, state, view }`，而**必须**读
   * 这个 `state` 而不是 `editor.state`——后者在 create 期间还指着事务前的旧文档。
   */
  function createProps(text: string) {
    return {
      state: {
        doc: {
          descendants(visit: (node: { isText: boolean; text?: string }, pos: number) => void) {
            visit({ isText: true, text }, 1)
          }
        }
      }
    }
  }

  function decorate(extension: ReturnType<typeof keywordUnderlineExtension>, text: string) {
    const spec = (extension as unknown as { config: { addDecorations(): { create(props: unknown): unknown[] } } })
      .config.addDecorations()
    return spec.create(createProps(text)) as Array<{ from: number; to: number; attrs: Record<string, string> }>
  }

  it('命中的裸词获得下划线类，未命中的不获得', () => {
    const decorations = decorate(keywordUnderlineExtension(() => ['eli5']), 'please eli5 now')
    expect(decorations).toHaveLength(1)
    // pos 1 + offset 7 = 8；词长 4。位置错了下划线就画在别的字上。
    expect(decorations[0]!.from).toBe(8)
    expect(decorations[0]!.to).toBe(12)
    expect(decorations[0]!.attrs.class).toBe('composer-keyword-hit')
    expect(decorations[0]!.attrs['data-composer-keyword']).toBe('eli5')

    // 反面：同一个扩展、同样的调用，未命中的文字一个装饰都不给。恒真的实现在这条上红。
    expect(decorate(keywordUnderlineExtension(() => ['eli5']), 'please explain now')).toEqual([])
    // 词的一部分不算命中（借的是 composerKeywordMatches 的边界判定）。
    expect(decorate(keywordUnderlineExtension(() => ['eli5']), 'preeli5x')).toEqual([])
  })

  it('keyword 列表**实时**读，不是构造时的快照', () => {
    // 这一条是承重的：扩展只在编辑器构造时装一次（InlineComposer 的 `useMemo(…, [])`），若把数组
    // 捕进闭包，用户在设置页新加的 keyword 永远不会划线——而开发时一路正常，只有改过配置才分岔。
    let keywords: string[] = []
    const extension = keywordUnderlineExtension(() => keywords)
    // 装的时候一条都没有。
    expect(decorate(extension, 'please eli5 now')).toEqual([])

    // 用户在设置页加了一条：**同一个扩展实例**必须立刻认它。
    keywords = ['eli5']
    expect(decorate(extension, 'please eli5 now'), 'keyword 被快照冻住了：设置页新加的词永远不划线').toHaveLength(1)

    // 删掉也要立刻不认（否则删了的词还在划线）。
    keywords = []
    expect(decorate(extension, 'please eli5 now')).toEqual([])
  })

  it('空 keyword 列表不产生装饰，空字符串 keyword 也不', () => {
    expect(decorate(keywordUnderlineExtension(() => []), 'anything')).toEqual([])
    // `''` 的 indexOf 在每个位置都命中——设置页允许一条还没填完 keyword 的草稿存在。
    expect(decorate(keywordUnderlineExtension(() => ['']), 'anything'), '空 keyword 把整段文字都划了线').toEqual([])
  })
})
