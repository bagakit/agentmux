import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

// Compile the production Profile handlers from ipc.ts with their collaborators replaced.
function productionHandlers(names: string[], scope: Record<string, unknown>): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const source = readFileSync(new NodeURL('../src/main/ipc.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true)
  const found: Record<string, string> = {}
  let publish = ''
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'handleWithEvent' && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && names.includes(node.arguments[0].text)) {
      found[node.arguments[0].text] = node.arguments[1]!.getText(parsed)
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'publishProfiles' && node.initializer) publish = node.initializer.getText(parsed)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  expect(Object.keys(found).sort()).toEqual([...names].sort())
  expect(publish).not.toBe('')
  const body = `const publishProfiles = ${publish}; return { ${names.map(n => `${JSON.stringify(n)}: ${found[n]}`).join(', ')} };`
  const compiled = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(scope), compiled)(...Object.values(scope))
}

describe('Main publishes the committed Profile list after every change', () => {
  it('sends the list once per create, update, default move and import, and never for reads or failures', async () => {
    let revision = 0
    const profiles = [{ id: 'p1', label: 'Personal', createdAt: 1, isDefault: true, source: null }]
    const commit = <T>(value: T) => async () => { revision += 1; return value }
    const browserProfiles = {
      initialize: vi.fn(async () => {}),
      listRevision: () => revision, listProfiles: () => profiles,
      createProfile: vi.fn(commit({ id: 'p2' })), updateProfile: vi.fn(commit({ id: 'p1' })),
      setDefaultProfile: vi.fn(commit(undefined)), importProfile: vi.fn(commit({ id: 'p3' })),
      deleteProfile: vi.fn(commit(undefined))
    }
    const sent: Array<[string, unknown]> = []
    const contents = { isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push([channel, payload]) }
    const h = productionHandlers(['browser:readProfiles', 'browser:createProfile', 'browser:updateProfile', 'browser:setDefaultProfile', 'browser:importProfile'], {
      browserProfiles, contents
    })
    expect(await h['browser:readProfiles']!({})).toEqual({ revision: 0, profiles })
    expect(sent).toHaveLength(0)
    await h['browser:createProfile']!({}, 'Work')
    await h['browser:updateProfile']!({}, 'p1', { label: 'Me' }, 1)
    await h['browser:setDefaultProfile']!({}, 'p1', 2)
    await h['browser:importProfile']!({}, 'token', 'Imported')
    expect(sent.map(([channel, payload]) => [channel, (payload as { revision: number }).revision])).toEqual([
      ['browser:profilesChanged', 1], ['browser:profilesChanged', 2], ['browser:profilesChanged', 3], ['browser:profilesChanged', 4]
    ])
    browserProfiles.updateProfile.mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'BROWSER_PROFILE_REVISION_CONFLICT' }))
    await expect(h['browser:updateProfile']!({}, 'p1', { label: 'Late' }, 0)).rejects.toMatchObject({ code: 'BROWSER_PROFILE_REVISION_CONFLICT' })
    expect(sent).toHaveLength(4)
  })
})
