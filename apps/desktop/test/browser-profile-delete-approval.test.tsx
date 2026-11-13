import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import type { BrowserProfileSummary } from '../src/shared/contracts.js'

const profile: BrowserProfileSummary = {
  id: 'profile-work', label: 'Work', createdAt: 1, isDefault: false, source: null
}
// Execute the actual registered handler without constructing unrelated Electron services.
// The callback comes from the production AST; no hand-written mirror of its checks.
function productionDeleteHandler(dependencies: {
  browsers: { usesProfile: (id: string) => boolean }
  browserProfiles: { deleteProfile: (id: string, approval: unknown) => Promise<void> }
}): (event: unknown, id: string, approval: unknown) => Promise<void> {
  const source = readFileSync(new NodeURL('../src/main/ipc.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true)
  const callbacks: ts.Node[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'handleWithEvent' &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'browser:deleteProfile') {
      callbacks.push(node.arguments[1]!)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  expect(callbacks).toHaveLength(1)
  expect(ts.isArrowFunction(callbacks[0]!)).toBe(true)
  const compiled = ts.transpileModule(`const handler = ${callbacks[0]!.getText(parsed)}; return handler;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return new Function('browsers', 'spatialState', 'savedBrowsersUsingProfile', 'browserProfiles', 'browserRecoveryPreviews', 'publishProfiles', compiled)(
    dependencies.browsers, { read: async () => null }, () => [], dependencies.browserProfiles, { clearProfile: async () => ({ status: 'cleared' }) },
    (change: Promise<unknown>) => change
  ) as ReturnType<typeof productionDeleteHandler>
}

describe('production Browser deletion IPC callback', () => {

  it('rechecks current usage and forwards the exact target approval only when unused', async () => {
    const usesProfile = vi.fn(() => true)
    const deleteProfile = vi.fn(async () => {})
    const approval = { kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: profile.id }
    const handler = productionDeleteHandler({  browsers: { usesProfile }, browserProfiles: { deleteProfile } })
    await expect(handler({}, profile.id, approval)).rejects.toThrow('Browser Profile is still used by an open Browser')
    expect(usesProfile).toHaveBeenCalledWith(profile.id)
    expect(deleteProfile).not.toHaveBeenCalled()
    usesProfile.mockReturnValue(false)
    await handler({}, profile.id, approval)
    expect(deleteProfile).toHaveBeenCalledExactlyOnceWith(profile.id, approval)
  })
})
