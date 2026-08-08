import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { earlyExitConditionsBefore, findCallsToIdentifier, findCallsToMember, readAndParse } from './helpers/effect-reachability.js'

// Supplemental terminal wiring proof; EditorPane's async lifecycle is exercised with React DOM.
const terminal = new URL('../src/renderer/src/components/TerminalView.tsx', import.meta.url)
const editor = new URL('../src/renderer/src/components/EditorPane.tsx', import.meta.url)

describe('caret consumer entry points', () => {
  for (const url of [terminal, editor]) {
    it(`${url.pathname.split('/').pop()} handles both mounted updates and late surface creation`, () => {
      const { sourceFile } = readAndParse(url.pathname)
      const calls = findCallsToIdentifier(sourceFile, 'consumeCaretFocus')
      expect(calls).toHaveLength(2)
      expect(calls.some((call) => {
        let parent: ts.Node | undefined = call.parent
        while (parent) {
          if (ts.isCallExpression(parent) && parent.expression.getText() === 'useEffect') return true
          parent = parent.parent
        }
        return false
      })).toBe(true)
    })
  }
  it('terminal waits for a visible, live target before consuming keyboard focus', () => {
    const { sourceFile } = readAndParse(terminal.pathname)
    const focus = findCallsToMember(sourceFile, 'focus').filter((call) => {
      let parent: ts.Node | undefined = call.parent
      while (parent) {
        if (ts.isFunctionDeclaration(parent) && parent.name?.text === 'consumeCaretFocus') return true
        parent = parent.parent
      }
      return false
    })
    expect(focus).toHaveLength(1)
    expect(earlyExitConditionsBefore(focus[0]!).map((s) => s.replace(/\s/g, ''))).toEqual([
      '!regionCaretFocusTargets(request,linkOriginRef.current.regionId)', '!visibleRef.current', '!target'
    ])
  })
})
