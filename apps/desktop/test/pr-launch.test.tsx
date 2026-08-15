import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ReactElement, ReactNode } from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

import type { WorkspaceRecord } from '../src/shared/contracts.js'
import type { PrReadiness } from '../src/shared/git-contracts.js'
import { PrLaunchSurface } from '../src/renderer/src/components/PrLaunchSurface.js'
import {
  PR_BLOCKER_MESSAGES,
  type PrBlockerKey
} from '../src/renderer/src/lib/pr-eligibility.js'
import {
  beginPrLaunch,
  draftPrTitleFromBranch,
  planPrLaunch,
  type PrLaunchPlan
} from '../src/renderer/src/lib/pr-launch.js'
import { resolveHostElement } from './helpers/component-host-element.js'

/** 被测那个面自己的源码路径——`resolveHostElement` 从这里出发跟着 import 走。 */
const SURFACE_PATH = fileURLToPath(
  new URL('../src/renderer/src/components/PrLaunchSurface.tsx', import.meta.url)
)

const workspace: WorkspaceRecord = {
  id: 'ws-1',
  name: 'repo',
  hostId: 'local',
  path: '/repo',
  kind: 'folder'
}

/**
 * A readiness read that clears every rung of the ladder. Overrides break exactly one condition per
 * test, so a blocker under test is the only one in the list and a test cannot pass because some other
 * rung happened to fail too.
 */
function readiness(overrides: Partial<PrReadiness> = {}): PrReadiness {
  return {
    auth: { kind: 'authenticated', account: 'octocat' },
    branch: 'feature/add-retry',
    baseRef: 'main',
    baseSource: 'remote-head',
    baseExistsOnRemote: true,
    upstream: 'origin/feature/add-retry',
    ahead: 2,
    behind: 0,
    hasUncommittedChanges: false,
    checkedAt: 1_700_000_000_000,
    ...overrides
  }
}

/**
 * The decision layer, exercised directly.
 *
 * The reason this file exists rather than only asserting through the panel: the whole point of
 * `planPrLaunch` is that ONE readiness read produces the ladder's input, the form's copy and the
 * submitted token together. That property is about the relationship between fields of one return value,
 * so it is observable here and nowhere else — through the component it would only ever be visible as
 * "some branch name rendered".
 */
describe('planPrLaunch', () => {
  it('clears a ready branch and carries the branch/base pair into both the token and the intent state', () => {
    const plan = planPrLaunch({ readiness: readiness(), workspace, now: 1234 })
    expect(plan.kind).toBe('ready')
    if (plan.kind !== 'ready') return

    // The pair the form shows.
    expect(plan.branch).toBe('feature/add-retry')
    expect(plan.baseRef).toBe('main')
    // The pair the store's intent guard will compare, and the pair main will actually target. All three
    // readings are ONE decision: `token.baseRef` is what gh receives as `--base`, `current` is what the
    // guard compares it against, and `branch` is what the user was shown. Any two of them disagreeing is
    // a pull request opened against something nobody looked at.
    expect(plan.token.branch).toBe(plan.branch)
    expect(plan.token.baseRef).toBe(plan.baseRef)
    expect(plan.current.branch).toBe(plan.branch)
    expect(plan.current.baseRef).toBe(plan.baseRef)
    // ...and the ladder judged that same pair, not another one.
    expect(plan.eligibility.branch).toBe(plan.branch)
    expect(plan.eligibility.baseRef).toBe(plan.baseRef)
    // Identity comes from the workspace, on both the token and the state the guard compares to.
    expect(plan.token.worktreeId).toBe(workspace.id)
    expect(plan.token.worktreePath).toBe(workspace.path)
    expect(plan.current.worktreeId).toBe(workspace.id)
    // `startedAt` is the caller's moment, passed in — not read from a clock inside a pure function.
    expect(plan.token.startedAt).toBe(1234)
  })

  /**
   * Every rung of the ladder is reachable THROUGH the plan.
   *
   * `pr-eligibility.test.ts` already covers the ladder itself, so this is deliberately not a second copy
   * of that: what it pins is the projection. `planPrLaunch` names the eight fields it forwards one by one
   * rather than spreading, and a field dropped from that list is silently ignored — the ladder then never
   * sees the condition, and a branch that should be blocked gets cleared. Driving each blocker through the
   * plan is what makes a dropped field red: the corresponding readiness override stops mattering.
   */
  it('every blocker the readiness can express reaches the plan — no forwarded field is dropped', () => {
    const cases: Array<{ key: PrBlockerKey; overrides: Partial<PrReadiness> }> = [
      { key: 'gh-not-installed', overrides: { auth: { kind: 'not-installed' } } },
      { key: 'gh-not-authenticated', overrides: { auth: { kind: 'not-authenticated' } } },
      { key: 'no-branch', overrides: { branch: null } },
      { key: 'branch-equals-base', overrides: { branch: 'main' } },
      { key: 'no-upstream', overrides: { upstream: null } },
      { key: 'not-ahead', overrides: { ahead: 0 } },
      { key: 'behind-upstream', overrides: { behind: 3 } },
      { key: 'uncommitted-changes', overrides: { hasUncommittedChanges: true } },
      { key: 'base-missing-on-remote', overrides: { baseExistsOnRemote: false } }
    ]
    // Self-check: the table covers every key in the SSOT. A blocker added to the ladder without a row
    // here would otherwise be a rung nobody drove through the projection.
    expect(cases.map((entry) => entry.key).sort()).toEqual(
      (Object.keys(PR_BLOCKER_MESSAGES) as PrBlockerKey[]).sort()
    )

    for (const { key, overrides } of cases) {
      const plan = planPrLaunch({ readiness: readiness(overrides), workspace, now: 1 })
      expect(plan.kind, `${key} did not block the launch — that readiness field reaches nothing`).toBe(
        'blocked'
      )
      if (plan.kind !== 'blocked') continue
      expect(plan.blockers, `${key} is not among the blockers the plan reports`).toContain(key)
      // The copy travels with the key, in the same order, so the panel never has to look one up.
      expect(plan.messages).toEqual(plan.blockers.map((blocker) => PR_BLOCKER_MESSAGES[blocker]))
    }
  })

  it('reports every unmet condition at once, not just the first', () => {
    // Three broken rungs from three separate `if`s. Early-returning after the first would leave the user
    // to fix one, click again, and discover the next — a checklist turned into N round trips.
    const plan = planPrLaunch({
      readiness: readiness({ upstream: null, ahead: 0, hasUncommittedChanges: true }),
      workspace,
      now: 1
    })
    expect(plan.kind).toBe('blocked')
    if (plan.kind !== 'blocked') return
    expect(plan.blockers).toContain('no-upstream')
    expect(plan.blockers).toContain('not-ahead')
    expect(plan.blockers).toContain('uncommitted-changes')
  })

  it('never emits a ready plan whose token has no branch', () => {
    // A detached HEAD is `no-branch`, so this looks like belt-and-braces — and it partly is: measured,
    // dropping the `readiness.branch === null` disjunct is caught by tsc (three narrowing errors), so it is
    // not a silent mutation. The assertion stays because it is about *behaviour under a real input* rather
    // than about that disjunct: a rebuilt guard that satisfies the type checker some other way (a non-null
    // assertion, a `?? ''` default) is type-clean and would ship a token whose branch matches nothing —
    // aborting a pull request the user is entitled to open, with a reason that describes nothing.
    const plan = planPrLaunch({ readiness: readiness({ branch: null }), workspace, now: 1 })
    expect(plan.kind).toBe('blocked')
    // And no empty-string stand-in slipped through in place of a real refusal.
    expect(plan.kind === 'ready' && plan.token.branch).not.toBe('')
  })

  it('carries the base source through, so a guessed base can be labelled as one', () => {
    // Both values, because a projection that hardcodes either one is green on the other's test alone.
    const guessed = planPrLaunch({
      readiness: readiness({ baseSource: 'fallback' }),
      workspace,
      now: 1
    })
    const known = planPrLaunch({
      readiness: readiness({ baseSource: 'remote-head' }),
      workspace,
      now: 1
    })
    expect(guessed.kind === 'ready' && guessed.baseSource).toBe('fallback')
    expect(known.kind === 'ready' && known.baseSource).toBe('remote-head')
  })
})

describe('draftPrTitleFromBranch', () => {
  it('drops the prefix segments and reads as a sentence', () => {
    expect(draftPrTitleFromBranch('feature/add-retry-to-uploader')).toBe('Add retry to uploader')
    expect(draftPrTitleFromBranch('user/octocat/fix_the.thing')).toBe('Fix the thing')
    expect(draftPrTitleFromBranch('hotfix')).toBe('Hotfix')
  })

  it('yields an empty string rather than inventing a placeholder', () => {
    // The submit button is gated on a non-empty title, so an empty draft means "the user has to type
    // one". A placeholder here would be a title nobody wrote, one click away from being submitted.
    expect(draftPrTitleFromBranch('')).toBe('')
    expect(draftPrTitleFromBranch('///')).toBe('')
    expect(draftPrTitleFromBranch('feature/---')).toBe('')
  })
})

/**
 * What one click does, run for real.
 *
 * This describe exists because of a measured failure: with the same logic living inside the panel's click
 * handler, inserting one `return` at its top made the button a no-op and the whole suite stayed green — a
 * handler closed over component state cannot be called when there is no DOM, so every criterion collapsed
 * to "the call site is present in the source", and an early return leaves call sites exactly where they
 * were. Here the function is callable, so reading, planning and drafting are observed rather than inferred.
 */
describe('beginPrLaunch', () => {
  it('reads readiness exactly once and plans from what that read returned', async () => {
    const check = vi.fn(async () => readiness())
    const opening = await beginPrLaunch({ check, workspace, now: 99 })
    // Reached at all: an emptied body returns without calling this, and the count is zero.
    expect(check, 'readiness was never read — the click does nothing').toHaveBeenCalledTimes(1)
    expect(opening.plan?.kind).toBe('ready')
    // Planned from that read: the pair on the plan is the pair the read reported.
    expect(opening.plan?.kind === 'ready' && opening.plan.branch).toBe('feature/add-retry')
    expect(opening.plan?.kind === 'ready' && opening.plan.token.startedAt).toBe(99)
  })

  it('drafts the title from the branch the plan targets', async () => {
    const opening = await beginPrLaunch({
      check: async () => readiness({ branch: 'feature/add-retry-to-uploader' }),
      workspace,
      now: 1
    })
    expect(opening.title).toBe('Add retry to uploader')
    expect(opening.body).toBe('')
    // Same branch as the token: a draft describing one branch while the token targets another is a pull
    // request whose title is about something else.
    expect(opening.plan?.kind === 'ready' && opening.plan.token.branch).toBe(
      'feature/add-retry-to-uploader'
    )
  })

  it('a failed read yields no plan and no draft — and does not invent a blocker', async () => {
    // `check` writes the reason to its own error surface (bridge absent, gh threw). A blocker fabricated
    // here would be a second, weaker account of the same failure, shown next to the real one.
    const opening = await beginPrLaunch({ check: async () => null, workspace, now: 1 })
    expect(opening.plan).toBeNull()
    expect(opening.title).toBe('')
    expect(opening.body).toBe('')
  })

  it('a blocked plan carries no draft title', async () => {
    // Seeding a title for a plan that cannot be submitted leaves it in the box for the next attempt, where
    // it describes whatever branch was current the last time the ladder happened to clear.
    const opening = await beginPrLaunch({
      check: async () => readiness({ ahead: 0 }),
      workspace,
      now: 1
    })
    expect(opening.plan?.kind).toBe('blocked')
    expect(opening.title).toBe('')
  })
})

type SurfaceProps = Parameters<typeof PrLaunchSurface>[0]

function surfaceProps(overrides: Partial<SurfaceProps> = {}): SurfaceProps {
  return {
    plan: null,
    createdUrl: null,
    title: '',
    body: '',
    submitting: false,
    onTitleChange: vi.fn(),
    onBodyChange: vi.fn(),
    onDismiss: vi.fn(),
    onSubmit: vi.fn(),
    onOpenCreated: vi.fn(),
    ...overrides
  }
}

function markupOf(overrides: Partial<SurfaceProps> = {}): string {
  return renderToStaticMarkup(createElement(PrLaunchSurface, surfaceProps(overrides)))
}

type ButtonProps = {
  type?: string
  'aria-label'?: string
  onClick?: () => void
  children?: ReactNode
}

/** Every <button> in the returned tree, in document order. The surface is hookless, so this works. */
function buttonsOf(overrides: Partial<SurfaceProps> = {}): ButtonProps[] {
  const element = PrLaunchSurface(surfaceProps(overrides)) as ReactElement
  const out: ButtonProps[] = []
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (!node || typeof node !== 'object') return
    const candidate = node as ReactElement<ButtonProps & { children?: ReactNode }>
    if (candidate.type === 'button') out.push(candidate.props)
    if (candidate.props?.children) walk(candidate.props.children)
  }
  walk(element)
  return out
}

const READY: PrLaunchPlan = planPrLaunch({ readiness: readiness(), workspace, now: 1 })

/**
 * The behavioural layer: what a person actually sees for each plan shape.
 *
 * Kept separate from the wiring layer below on purpose — each reddens only under its own mutation. Empty
 * the blocker list rendering and this describe goes red while the wiring one stays green; stop passing
 * `prPlan` into the surface and the reverse happens.
 */
describe('PrLaunchSurface 的显示层', () => {
  it('nothing is shown before anything has been asked for', () => {
    // The panel must not carry a PR affordance it has no answer for yet. An unconditional region would
    // make every assertion below tautologically true.
    expect(markupOf()).toBe('')
  })

  it('lists every blocker as its own line of copy, not just the count or the key', () => {
    const plan = planPrLaunch({
      readiness: readiness({ upstream: null, ahead: 0, hasUncommittedChanges: true }),
      workspace,
      now: 1
    })
    expect(plan.kind).toBe('blocked')
    if (plan.kind !== 'blocked') return
    const markup = markupOf({ plan })

    for (const key of plan.blockers) {
      // The actionable sentence, not the key: `no-upstream` on screen tells a person nothing, and the
      // whole reason PR_BLOCKER_MESSAGES exists is that the fix differs per key.
      expect(markup, `blocker ${key} is not rendered as its copy`).toContain(PR_BLOCKER_MESSAGES[key])
      expect(markup, `the raw key ${key} leaked to the screen instead of its copy`).not.toContain(
        `>${key}<`
      )
    }
    // One <li> per blocker: rendering only the first would still contain "some" copy.
    expect(markup.split('<li>').length - 1).toBe(plan.blockers.length)
    // It interrupts — every blocker has a next action the user has to take.
    expect(markup).toContain('role="alert"')
    // And no compose form: offering both would let a click submit against a branch the ladder rejected.
    expect(markup, 'the form is offered alongside the blockers').not.toContain('pr-form')
  })

  it('shows the compose form for a ready plan, with the branch and the base it targets', () => {
    const markup = markupOf({ plan: READY, title: 'Add retry' })
    expect(markup).toContain('pr-form')
    // The pair is on screen. Opening a PR against the wrong base is not undone by clicking again, so
    // "which two branches is this about" cannot be implicit.
    expect(markup).toContain('feature/add-retry')
    expect(markup).toContain('main')
    // The blocker list is NOT shown at the same time.
    expect(markup, 'the blocker banner rendered for a ready plan').not.toContain('pr-blockers')
  })

  /**
   * The guessed base says it is a guess — and only when it is one.
   *
   * `origin/HEAD` is absent in any repository created locally and pushed (this one included), so the
   * fallback is the common path, not an edge. Both directions are asserted because either half alone is
   * green under the mutation that matters: an inverted condition passes the "hint appears" test if only
   * the fallback case is checked, and an unconditional hint passes it too.
   */
  it('labels a guessed base as a guess, and says nothing when the remote declared one', () => {
    const guessed = planPrLaunch({
      readiness: readiness({ baseSource: 'fallback' }),
      workspace,
      now: 1
    })
    expect(markupOf({ plan: guessed }), 'a guessed base is presented as if it were known').toContain(
      'pr-form__hint'
    )
    expect(
      markupOf({ plan: READY }),
      'a base the remote actually declared is presented as a guess'
    ).not.toContain('pr-form__hint')
  })

  it('the submit button is closed on an empty title and open on a real one', () => {
    // A submit that is reachable with no title is a request main will refuse; the button should say so
    // before the round trip.
    const empty = markupOf({ plan: READY, title: '   ' })
    const filled = markupOf({ plan: READY, title: 'Add retry' })
    const submitTag = (markup: string): string => {
      const at = markup.indexOf('<button type="submit"')
      expect(at, 'no submit button rendered — the assertions below would be vacuous').toBeGreaterThanOrEqual(0)
      return markup.slice(at, markup.indexOf('>', at))
    }
    expect(submitTag(empty).includes('disabled=""'), 'an empty title can be submitted').toBe(true)
    expect(submitTag(filled).includes('disabled=""'), 'a written title cannot be submitted').toBe(false)
  })

  it('locks both fields while a submit is in flight, and says it is working', () => {
    // Editing the title mid-flight would leave the screen describing something other than what was sent.
    const markup = markupOf({ plan: READY, title: 'Add retry', submitting: true })
    expect(markup.match(/disabled=""/gu)?.length ?? 0).toBeGreaterThanOrEqual(3)
    expect(markup).toContain('Opening…')
  })

  it('the created receipt is a receipt, not an alert, and hands the URL back out', () => {
    const markup = markupOf({ createdUrl: 'https://github.com/o/r/pull/7' })
    expect(markup).toContain('Pull request opened')
    // `status`, not `alert`: there is nothing to handle. And no bare <a href> — the renderer has no
    // external-navigation authority, so a link either does nothing or navigates the whole app away.
    expect(markup).toContain('role="status"')
    expect(markup, 'the receipt renders a bare link the host cannot follow').not.toContain('<a ')

    let opened: string | null = null
    const buttons = buttonsOf({
      createdUrl: 'https://github.com/o/r/pull/7',
      onOpenCreated: (url) => {
        opened = url
      }
    })
    const view = buttons.find((button) => button.children === 'View on GitHub')
    expect(view, 'no "View on GitHub" control — the URL is displayed and then unreachable').toBeDefined()
    view!.onClick?.()
    // The URL it emits is the one it was given, not a rebuilt or nearby one.
    expect(opened).toBe('https://github.com/o/r/pull/7')
  })

  it('both dismiss controls reach the same dismissal, and neither submits the form', () => {
    // Two exits (the blocker list's "Dismiss" and the form's X) for two shapes. A cancel button that
    // defaults to type="submit" inside a <form> opens the pull request it was meant to abandon.
    for (const plan of [READY, planPrLaunch({ readiness: readiness({ ahead: 0 }), workspace, now: 1 })]) {
      const dismissed = vi.fn()
      const buttons = buttonsOf({ plan, onDismiss: dismissed })
      const exits = buttons.filter((button) => button.onClick === dismissed)
      expect(exits.length, `plan ${plan.kind} has no way out`).toBeGreaterThan(0)
      for (const exit of exits) {
        expect(exit.type, `a dismiss control in the ${plan.kind} shape is not type="button"`).toBe('button')
      }
      exits[0]!.onClick?.()
      expect(dismissed).toHaveBeenCalled()
    }
  })

  /**
   * 「两个输入框真的可写」**刻意不在这里守**。
   *
   * 那一族的判据是 controlled-input-is-writable.test.tsx 里那套按目录扫全部 .tsx 的静态成对扫描
   * （受控 value 必须配 onChange/onInput，或显式无条件 readOnly/disabled），PrLaunchSurface.tsx 一落盘
   * 就自动进了它的扫描面——已实测：删掉这里 title 那个 onChange，那个文件立刻红，且它认得出
   * `disabled={submitting}` 是**有条件**的所以不算「显式只读」。
   *
   * 我先写的是「把 React 的 value-without-onChange 告警接成断言」，但那个检测器是瞎的：JSX 里的
   * `onChange={(event) => onTitleChange(...)}` 在把 `onTitleChange` 传成 undefined 之后**照旧在场**，
   * React 什么都不会说。自检那一条当场红，正是它该做的事——留着一条自己证不了任何事的断言，比没有
   * 这条断言更坏（记忆 comment-promises-more-than-assertion）。
   */
  it('两个输入框把每一次输入交回给调用方，而不是自己存', () => {
    // 上面那条注释说的是「可写」由别处守；这条守的是另一件事：写回口通到的是**调用方**。两个 handler
    // 各自只喂自己那一格——对调之后标题栏会改正文、正文栏会改标题，而 markup 逐字相同。
    let title: string | null = null
    let body: string | null = null
    const element = PrLaunchSurface(
      surfaceProps({
        plan: READY,
        onTitleChange: (value) => {
          title = value
        },
        onBodyChange: (value) => {
          body = value
        }
      })
    ) as ReactElement
    const fields: Array<{ tag: string; onChange?: (event: unknown) => void }> = []
    const walk = (node: ReactNode): void => {
      if (Array.isArray(node)) {
        for (const child of node) walk(child)
        return
      }
      if (!node || typeof node !== 'object') return
      const candidate = node as ReactElement<{
        children?: ReactNode
        onChange?: (event: unknown) => void
        onValueChange?: (value: string) => void
      }>
      if (candidate.type === 'input' || candidate.type === 'textarea') {
        fields.push({ tag: String(candidate.type), onChange: candidate.props.onChange })
      }
      // 这一格经过 ComposerTextarea 那层壳（#609/#622 把 8 个受控 textarea 都收进去了），所以
      // `candidate.type` 是个函数而不是 `'textarea'`。判据**跟着间接走**：解析那个组件自己的根元素，
      // 要求它是 textarea 且接住了调用方的属性——不是把它的名字加进允许清单（#736、#731）。
      // 写回口在这一层叫 onValueChange：壳内部把它接到 DOM 的 onChange 上（那条接线由
      // composer-ime.test.ts 的「壳里那份 ime 就是 composerCompositionHandlers 的结果」钉着，
      // 本文件引用它，不重抄一份）。
      if (typeof candidate.type === 'function') {
        const name = (candidate.type as { name?: string }).name
        if (name && /^[A-Z]/u.test(name)) {
          const host = resolveHostElement(SURFACE_PATH, name)
          expect(
            host.forwardsCallerProps,
            `${name} 没有把调用方的其余属性转发到根元素：这一格给的属性会被静默吞掉`
          ).toBe(true)
          const write = candidate.props.onValueChange
          fields.push({
            tag: host.tag,
            onChange: write ? (event) => write((event as { target: { value: string } }).target.value) : undefined
          })
        }
      }
      if (candidate.props?.children) walk(candidate.props.children)
    }
    walk(element)
    expect(fields.map((field) => field.tag), '表单里不是恰好一个 input 加一个 textarea').toEqual([
      'input',
      'textarea'
    ])
    fields[0]!.onChange?.({ target: { value: 'typed title' } })
    fields[1]!.onChange?.({ target: { value: 'typed body' } })
    expect(title, '标题格的输入没有交回给调用方').toBe('typed title')
    expect(body, '正文格的输入没有交回给调用方').toBe('typed body')
  })
})

const PANEL_SOURCE = new URL('../src/renderer/src/components/ChangesPanel.tsx', import.meta.url)
const PANEL_AST = ts.createSourceFile(
  'ChangesPanel.tsx',
  readFileSync(PANEL_SOURCE, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)

/** The JSX attributes of one element by tag name, as `name -> expression text`. */
function jsxAttributes(tag: string): Record<string, string> | null {
  let found: Record<string, string> | null = null
  const walk = (node: ts.Node): void => {
    const opening = ts.isJsxSelfClosingElement(node)
      ? node
      : ts.isJsxElement(node)
        ? node.openingElement
        : null
    if (opening && opening.tagName.getText(PANEL_AST) === tag) {
      const out: Record<string, string> = {}
      for (const property of opening.attributes.properties) {
        if (!ts.isJsxAttribute(property)) continue
        const initializer = property.initializer
        if (!initializer) continue
        out[property.name.getText(PANEL_AST)] = ts.isJsxExpression(initializer)
          ? (initializer.expression?.getText(PANEL_AST) ?? '')
          : initializer.getText(PANEL_AST)
      }
      found = out
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(PANEL_AST, walk)
  return found
}

/** Every call site of `callee` in the panel, as argument-expression texts. */
function callSites(callee: string): string[][] {
  const out: string[][] = []
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(PANEL_AST) === callee) {
      out.push(node.arguments.map((argument) => argument.getText(PANEL_AST)))
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(PANEL_AST, walk)
  return out
}

/** One named function's full source (declaration included), found by name rather than line number. */
function functionBody(name: string): string | null {
  let found: string | null = null
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.getText(PANEL_AST) === name) {
      found = node.getText(PANEL_AST)
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(PANEL_AST, walk)
  return found
}

/** The object-literal properties of the first call to `callee`, as `key -> value text`. */
function firstCallObjectArgument(callee: string): Record<string, string> | null {
  let found: Record<string, string> | null = null
  const walk = (node: ts.Node): void => {
    if (found) return
    if (ts.isCallExpression(node) && node.expression.getText(PANEL_AST).endsWith(callee)) {
      const argument = node.arguments[0]
      if (argument && ts.isObjectLiteralExpression(argument)) {
        const out: Record<string, string> = {}
        for (const property of argument.properties) {
          if (!ts.isPropertyAssignment(property)) continue
          out[property.name.getText(PANEL_AST)] = property.initializer.getText(PANEL_AST)
        }
        found = out
      }
    }
    ts.forEachChild(node, walk)
  }
  ts.forEachChild(PANEL_AST, walk)
  return found
}

/**
 * The wiring layer: is the surface above actually reached, and is it fed the ONE plan?
 *
 * A component nobody renders is as silent as a branch nobody takes, and there is no DOM here to observe
 * the panel's own state — so this layer reads the panel's syntax. The criteria are relations ("the value
 * of this prop is that state", "the payload's token is that plan's token"), not text presence: a rename
 * must not redden, and a re-derivation must.
 */
describe('ChangesPanel 与 PR 决定层的接线（#207）', () => {
  it('renders the surface, and feeds it the plan state rather than a nearby literal', () => {
    const props = jsxAttributes('PrLaunchSurface')
    expect(
      props,
      'ChangesPanel does not render PrLaunchSurface — every assertion in the display layer above is ' +
        'about a component nobody reaches'
    ).not.toBeNull()
    // The plan comes from state, not from a fresh call: computing it during render would re-derive the
    // pair on every keystroke, and the token the user's click aimed at would drift out from under them.
    expect(props!.plan, 'the surface is not fed the stored plan').toBe('prPlan')
    expect(props!.createdUrl).toBe('prUrl')
    expect(props!.title).toBe('prTitle')
    expect(props!.body).toBe('prBody')
    expect(props!.submitting).toBe('prSubmitting')
    // Both writers are the state setters themselves — an input wired to a no-op is read-only, and the
    // display layer's controlled-input check cannot see the shell.
    expect(props!.onTitleChange).toBe('setPrTitle')
    expect(props!.onBodyChange).toBe('setPrBody')
  })

  it('the launch button reaches the opener, and nothing else re-reads or re-plans', () => {
    const sites = callSites('openPrForm')
    expect(
      sites.length,
      `openPrForm has ${sites.length} call sites, expected exactly 1 — 0 means the button is drawn and ` +
        'does nothing'
    ).toBe(1)
    // The decision is not re-made in the shell: readiness is read and the plan is built inside
    // beginPrLaunch, whose reachability the layer above actually executes. A second call to either from
    // here would be a second derivation of the pair — the exact hazard that module exists to prevent.
    expect(
      callSites('prReadiness.check').length,
      'the panel reads readiness itself as well — the ladder and the token can then disagree'
    ).toBe(0)
    expect(callSites('planPrLaunch').length, 'the panel plans a second time').toBe(0)
    expect(
      callSites('draftPrTitleFromBranch').length,
      'the panel drafts a title of its own instead of taking the one from the opening'
    ).toBe(0)
  })

  /**
   * The shell around `beginPrLaunch` has nowhere to hide.
   *
   * This is the layer that measurably failed before: inserting one `return` at the top of `openPrForm`
   * left the whole suite green, because a handler closed over component state cannot be called with no
   * DOM, so every criterion degrades to "the call site is present in the source" — and an early return
   * does not remove call sites. Moving the decision into a callable function fixed the decision half; this
   * assertion covers the other half, that what stayed behind is only forwarding. The criterion is that the
   * shell contains no branch and no early exit at all: with none, an emptied body is not a subtle
   * mutation, it is a deleted statement — and every statement here is pinned by the props test above.
   */
  it('openPrForm only forwards: no branch, no early return, one call to the decision', () => {
    const body = functionBody('openPrForm')
    expect(body, 'openPrForm is gone — the button reaches nothing').not.toBeNull()
    const source = ts.createSourceFile('shell.ts', body!, ts.ScriptTarget.Latest, true)
    const offenders: string[] = []
    let awaited = 0
    const walk = (node: ts.Node): void => {
      if (ts.isIfStatement(node) || ts.isConditionalExpression(node) || ts.isSwitchStatement(node)) {
        offenders.push(`条件分支：${node.getText(source).slice(0, 60)}`)
      }
      if (ts.isReturnStatement(node)) offenders.push('早退')
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'beginPrLaunch') awaited += 1
      ts.forEachChild(node, walk)
    }
    ts.forEachChild(source, walk)
    expect(
      offenders,
      'openPrForm 里有分支或早退——它就又成了一个「整段可以静默变 no-op」的壳，' +
        '而本仓没有 DOM 可以点它一下来发现（实测过一次全绿）'
    ).toEqual([])
    expect(awaited, 'openPrForm 不是恰好调一次 beginPrLaunch').toBe(1)
  })

  it('the plan is built from that read, and its `now` is not baked in', () => {
    const [argument] = callSites('beginPrLaunch')[0]!
    // The reader handed in is the panel's own — the one whose error surface the panel already renders, so
    // a failed read has exactly one account of itself.
    expect(argument).toMatch(/check:\s*prReadiness\.check/u)
    expect(argument).toMatch(/\bworkspace\b/u)
    // `now` comes from the caller, so the pure layer holds no clock.
    expect(argument).toMatch(/now:\s*Date\.now\(\)/u)
  })

  it('all three of the opening’s products are written, none dropped on the floor', () => {
    // The plan, the title draft and the body. Writing only the plan leaves the title at whatever the last
    // pull request left there — a stale title one click from being submitted.
    const body = functionBody('openPrForm')!
    for (const [setter, field] of [
      ['setPrPlan', 'plan'],
      ['setPrTitle', 'title'],
      ['setPrBody', 'body']
    ] as const) {
      expect(
        body,
        `\`${field}\` from the opening is never written — it is computed and then dropped`
      ).toMatch(new RegExp(`${setter}\\(opening\\.${field}\\)`, 'u'))
    }
  })

  /**
   * The submitted payload's three decision fields ARE that plan's, character for character.
   *
   * This is the mutation with the worst blast radius and the quietest symptom: rebuilding the token at
   * submit time, or passing a freshly-derived `current`, type-checks, renders identically, and leaves the
   * intent guard comparing a value to itself — so it clears every drift it exists to catch, and a pull
   * request lands against a base the user never saw. Nothing in the display layer moves.
   */
  it('createPullRequest is handed the plan’s own token, current and eligibility', () => {
    const payload = firstCallObjectArgument('createPullRequest')
    expect(payload, 'no createPullRequest call with an object payload was found').not.toBeNull()
    for (const field of ['token', 'current', 'eligibility'] as const) {
      expect(
        payload![field],
        `\`${field}\` is not read off the plan (found \`${payload![field]}\`) — it is derived a second ` +
          'time, so the intent guard compares the payload with itself and clears every drift'
      ).toBe(`prPlan.${field}`)
    }
    // The title is trimmed at the boundary: a whitespace-only title passes the button's gate under a
    // mutation and would otherwise reach gh.
    expect(payload!.title).toBe('prTitle.trim()')
    expect(payload!.workspaceId).toBe('workspace.id')
  })

  it('the title draft is seeded from the plan’s branch — asserted where it can be executed', () => {
    // The panel no longer drafts anything; `beginPrLaunch` does, and the behavioural layer above calls it
    // for real. This assertion only pins that the shell does not reintroduce a second draft of its own —
    // which would be free to disagree with the branch the token targets.
    const body = functionBody('openPrForm')!
    expect(
      body,
      'openPrForm computes a title of its own — it can then describe a different branch than the token targets'
    ).not.toMatch(/draftPrTitleFromBranch/u)
  })
})
