import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentInteractionCard } from '../src/renderer/src/components/AgentInteractionCard.js'
import { permissionTierClassName } from '../src/renderer/src/lib/agent-interaction-plan.js'
import { RISK_TIERS } from '@agentmux/core'
import type { AgentMuxPermissionOption } from '@agentmux/core'

/**
 * 未声明风险档的选项**不得**被画成任何一档——尤其不得画成 'safe'。
 *
 * `tier` 在 `AgentMuxPermissionOption` 上可选，而缺席真可达：`acp-adapter.ts` 里
 * `options: event.options.map((option) => ({ ...option }))` 把外部 ACP 客户端的选项整份带过来，它们可以
 * 不带 tier。此前组件写 `option.tier ?? 'safe'`，于是「我不知道这有多危险」被显示成「这是安全的」。
 *
 * 判据分两层，因为两层各自能独立坏掉：
 *  - 取值层（下面这个 describe）钉 `permissionTierClassName` 本身，且**逐档遍历 RISK_TIERS**——不抽样，
 *    否则新增一档时这里静默不覆盖（记忆 sampled-pair-can-be-the-blind-spot）。
 *  - 渲染层（scoped 那条用例里新增的两条断言）钉「组件真的走了这个函数」：只有取值层是绿的、而组件
 *    自己又内联拼了一次 class 时，取值层照旧全绿——所以必须有一条断言看真 markup。
 *
 * 盲点（明说）：这里不判 CSS。基类 `.agent-interaction__tier` 的中性底色（`var(--text-3)`）由
 * `styles/agent.css` 提供，本文件不读 CSS；那条规则被删会让无档位的点变透明而这些断言全绿。
 */
const UNCLASSIFIED_OPTION: AgentMuxPermissionOption = {
  id: 'acp-external',
  label: 'Allow (from an external ACP client)',
  kind: 'allow-once'
}

describe('风险档的 class：未声明时不许冒充任何一档', () => {
  it('缺席 tier 只给基类，不带任何档位修饰类', () => {
    const className = permissionTierClassName(UNCLASSIFIED_OPTION)
    expect(className, '基类必须仍在场——点与它的槽位不能因为没分类就消失').toBe('agent-interaction__tier')
    // 遍历全集而不是只否掉 'safe'：把兜底改成 'caution' 之类同样是在瞎猜，也必须红。
    for (const tier of RISK_TIERS) {
      expect(
        className,
        `未分类的选项被画成了 ${tier} 档——那是把「不知道」说成「已知」`
      ).not.toContain(`agent-interaction__tier--${tier}`)
    }
  })

  it('声明了 tier 的选项逐档都拿到自己的修饰类', () => {
    // 反向自证：若实现退化成「永远只给基类」，上面那条会绿而这条会红。
    for (const tier of RISK_TIERS) {
      expect(permissionTierClassName({ ...UNCLASSIFIED_OPTION, tier })).toBe(
        `agent-interaction__tier agent-interaction__tier--${tier}`
      )
    }
  })
})

describe('AgentInteractionCard', () => {
  it('renders only Core-owned permission choices', () => {
    const markup = renderToStaticMarkup(createElement(AgentInteractionCard, {
      request: {
        kind: 'permission',
        id: 'permission-1',
        agentSessionId: 'agent-1',
        title: 'Allow Bash?',
        toolName: 'Bash',
        toolInput: '{"command":"pnpm test"}',
        options: [
          { id: 'allow', label: 'Allow once', kind: 'allow-once' },
          { id: 'deny', label: 'Deny', kind: 'reject-once' }
        ],
        evidence: {
          source: 'native-hook',
          observedAt: 1,
          run: { runId: 'run-1' },
          hookReceiptId: 'permission-1'
        }
      },
      onRespond: async () => {}
    }))

    expect(markup).toContain('Allow Bash?')
    expect(markup).toContain('Allow once')
    expect(markup).toContain('Deny')
    expect(markup).toContain('pnpm test')
    // Only the affirmative option carries the solid brand fill; deny and dismiss stay secondary.
    expect(markup.match(/is-primary/gu) ?? []).toHaveLength(1)
    // Dismissing is not a verdict, so it is marked apart from the allow/deny pair.
    expect(markup).toContain('agent-interaction__dismiss')
  })

  it('disables every action when the Agent can no longer accept one', () => {
    const markup = renderToStaticMarkup(createElement(AgentInteractionCard, {
      request: {
        kind: 'permission',
        id: 'permission-1',
        agentSessionId: 'agent-1',
        title: 'Allow Bash?',
        options: [
          { id: 'allow', label: 'Allow once', kind: 'allow-once' },
          { id: 'deny', label: 'Deny', kind: 'reject-once' }
        ],
        evidence: { source: 'native-hook', observedAt: 1, run: { runId: 'run-1' } }
      },
      disabled: true,
      onRespond: async () => {}
    }))

    // Allow, Deny, and the dismiss control must all go inert together — a half-live card would let
    // the user answer a Run that cannot take the answer.
    expect(markup.match(/disabled=""/gu) ?? []).toHaveLength(3)
  })

  it('lays a second allow into a scoped vertical column instead of the action row', () => {
    const markup = renderToStaticMarkup(createElement(AgentInteractionCard, {
      request: {
        kind: 'permission',
        id: 'permission-scoped',
        agentSessionId: 'agent-1',
        title: 'Allow Edit?',
        toolName: 'Edit',
        options: [
          { id: 'allow-once', label: 'Allow once', kind: 'allow-once', tier: 'safe' },
          {
            id: 'allow-always',
            label: "Allow & don't ask again",
            description: 'This tool, this directory.',
            kind: 'allow-always',
            tier: 'caution'
          },
          { id: 'deny', label: 'Deny', kind: 'reject-once', tier: 'safe' }
        ],
        evidence: {
          source: 'native-hook',
          observedAt: 1,
          run: { runId: 'run-1' },
          hookReceiptId: 'permission-scoped'
        }
      },
      onRespond: async () => {}
    }))

    // A second allow promotes the affirmatives into the scoped vertical list; deny stays in the row.
    expect(markup).toContain('agent-interaction__grants')
    expect(markup).toContain('Allow once')
    expect(markup).toContain('ask again')
    expect(markup).toContain('This tool, this directory.')
    // Each affirmative carries exactly one tier dot; allow-once is safe, allow-always is caution.
    expect(markup).toContain('agent-interaction__tier--safe')
    expect(markup).toContain('agent-interaction__tier--caution')
    // Even across the scoped layout, allow-once is the sole primary; allow-always and deny are not.
    expect(markup.match(/is-primary/gu) ?? []).toHaveLength(1)
    expect(markup).toContain('agent-interaction__dismiss')
  })

  it('未分类的第三个 allow 在真 markup 里不带任何档位类', () => {
    // 这条是**渲染层**判据：组件若绕过 permissionTierClassName 自己拼一次 class（哪怕拼得和从前一样带
    // `?? 'safe'`），取值层那两条照旧全绿，只有这里会红。fixture 刻意混装——两个带 tier、一个不带——
    // 这样「档位类总数」这个判据不会被「一个都不画」满足。
    const markup = renderToStaticMarkup(createElement(AgentInteractionCard, {
      request: {
        kind: 'permission',
        id: 'permission-acp',
        agentSessionId: 'agent-1',
        title: 'Allow Write?',
        options: [
          { id: 'allow-once', label: 'Allow once', kind: 'allow-once', tier: 'safe' },
          { id: 'allow-always', label: 'Always allow', kind: 'allow-always', tier: 'danger' },
          // 外部 ACP 客户端声明的选项：合法、可达、且没有 tier。
          { id: 'acp-external', label: 'Allow (external client)', kind: 'allow-always' },
          { id: 'deny', label: 'Deny', kind: 'reject-once' }
        ],
        evidence: {
          source: 'acp',
          observedAt: 1,
          acpAdapterId: 'adapter-1',
          acpSessionId: 'acp-session-1'
        }
      },
      onRespond: async () => {}
    }))

    expect(markup).toContain('Allow (external client)')
    // 判据是**每个点的 class 属性整值**，不是「某个 token 出现几次」。
    //
    // 计数在这里守不住：`class="agent-interaction__tier--safe"` 也满足 `/class="agent-interaction__tier/`
    // 这个前缀匹配（BEM 的 `block__elem--modifier` 恰好是这个形状），于是把组件改成
    // `option.tier === undefined ? 'agent-interaction__tier' : `agent-interaction__tier--${tier}`` ——
    // 也就是**声明了档位的点反而丢掉基类**——「三个点」和「两个修饰类」两个计数照旧成立，7 条全绿（实测）。
    // 而基类才是给出 width/height/border-radius 的那条规则，丢了它那两个点直接不可见。
    // 同一族的更早一次是 `tier\b` 的 `\b` 在连字符处成立，把修饰类一起数成 5 个点。
    //
    // 所以这里把三个点的 class 整值列出来逐字对：多一个点、少一个点、任何一格丢基类或多带一个 token，
    // 都会让这个数组对不上。顺序按字符串排序，不依赖 DOM 出现次序。
    const tierClasses = [...markup.matchAll(/class="([^"]*agent-interaction__tier[^"]*)"/gu)]
      .map((match) => match[1])
      .sort()
    expect(
      tierClasses,
      '三个 allow 应各有一个点：两个带自己声明的档位、第三个只有基类（= 不知道）'
    ).toEqual([
      'agent-interaction__tier',
      'agent-interaction__tier agent-interaction__tier--danger',
      'agent-interaction__tier agent-interaction__tier--safe'
    ])
  })

  it('renders one Core-validated single-select question', () => {
    const markup = renderToStaticMarkup(createElement(AgentInteractionCard, {
      request: {
        kind: 'question',
        id: 'question-1',
        agentSessionId: 'agent-1',
        questions: [{
          id: 'scope',
          title: 'Scope',
          prompt: 'Which tests?',
          options: [
            { id: 'focused', label: 'Focused', description: 'Affected tests only' },
            { id: 'full', label: 'Full suite' }
          ]
        }],
        evidence: {
          source: 'native-hook',
          observedAt: 1,
          run: { runId: 'run-1' },
          hookReceiptId: 'question-1'
        }
      },
      onRespond: async () => {}
    }))

    expect(markup).toContain('Which tests?')
    expect(markup).toContain('Affected tests only')
    expect(markup).toContain('Full suite')
  })
})
