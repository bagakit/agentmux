// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import type { BrowserProfileSummary } from '../src/shared/contracts.js'
import { BrowserProfilesPanel } from '../src/renderer/src/components/BrowserProfilesPanel.js'
import { api } from '../src/renderer/src/lib/api.js'

const profile: BrowserProfileSummary = {
  id: 'profile-work', label: 'Work', createdAt: 1, isDefault: false, source: null
}
const other: BrowserProfileSummary = { ...profile, id: 'profile-other', label: 'Personal' }
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(api.browser, 'listProfiles').mockResolvedValue([profile, other])
  vi.spyOn(api.browser, 'deleteProfile').mockResolvedValue(undefined)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function mount(browsers: Parameters<typeof BrowserProfilesPanel>[0]['allBrowsers'] = []) {
  await act(async () => root.render(<BrowserProfilesPanel browsers={[]} allBrowsers={browsers} />))
}
async function click(selector: string) {
  const target = container.querySelector<HTMLButtonElement>(selector)
  expect(target).not.toBeNull()
  await act(async () => target!.click())
}

describe('Browser Profile current user approval', () => {
  it('explains the named irreversible scope and Cancel performs no deletion', async () => {
    await mount()
    await click('[aria-label="Delete Work"]')
    expect(api.browser.deleteProfile).not.toHaveBeenCalled()
    expect(container.querySelector('.browser-profiles__delete-impact')?.textContent).toContain('Delete Work?')
    expect(container.querySelector('.browser-profiles__delete-impact')?.textContent).toContain('Cookies and site data will be permanently removed')
    expect(container.querySelector('.browser-profiles__delete-impact')?.textContent).toContain('All sign-ins in this Profile will be lost')
    await click('.browser-profiles__delete-confirm button:first-child')
    expect(api.browser.deleteProfile).not.toHaveBeenCalled()
    expect(container.querySelector('.browser-profiles__delete-confirm')).toBeNull()
    expect(container.querySelector('[aria-label="Delete Work"]')).not.toBeNull()
  })
  it('sends only the confirmed Profile approval on the second action', async () => {
    await mount()
    await click('[aria-label="Delete Work"]')
    expect(api.browser.deleteProfile).not.toHaveBeenCalled()
    await click('.browser-profiles__delete-confirm button:last-child')
    expect(api.browser.deleteProfile).toHaveBeenCalledExactlyOnceWith(profile.id, {
      kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: profile.id
    })
    expect(container.querySelector('[aria-label="Delete Work"]')).toBeNull()
    expect(container.querySelector('[aria-label="Delete Personal"]')).not.toBeNull()
  })
  it('retains the Profile and reason when Main refuses a newly opened Browser', async () => {
    vi.mocked(api.browser.deleteProfile).mockRejectedValue(new Error('Browser Profile is still used by an open Browser'))
    await mount()
    await click('[aria-label="Delete Work"]')
    await click('.browser-profiles__delete-confirm button:last-child')
    expect(container.textContent).toContain('Work')
    expect(container.textContent).toContain('Browser Profile is still used by an open Browser')
    expect(container.querySelector('.browser-profiles__delete-confirm')).not.toBeNull()
  })
  it('withdraws confirmation when the Profile becomes in use before the second action', async () => {
    await mount()
    await click('[aria-label="Delete Work"]')
    await mount([{ browserId: 'browser-other-workspace', profileId: profile.id, title: 'Active', url: 'https://example.test/' }])
    expect(container.querySelector('.browser-profiles__delete-confirm')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Delete Work"]')?.disabled).toBe(true)
    expect(api.browser.deleteProfile).not.toHaveBeenCalled()
  })
})

// Execute the actual registered handler without constructing unrelated Electron services.
// The callback comes from the production AST; no hand-written mirror of its checks.
function productionDeleteHandler(dependencies: {
  requireTrustedSender: (channel: string, event: unknown) => void
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
  return new Function('requireTrustedSender', 'browsers', 'browserProfiles', compiled)(
    dependencies.requireTrustedSender, dependencies.browsers, dependencies.browserProfiles
  ) as ReturnType<typeof productionDeleteHandler>
}

describe('production Browser deletion IPC callback', () => {
  it('rejects an untrusted sender before consulting or clearing Profiles', async () => {
    const usesProfile = vi.fn(() => false)
    const deleteProfile = vi.fn(async () => {})
    const handler = productionDeleteHandler({
      requireTrustedSender: () => { throw new Error('Untrusted Browser Profile sender') },
      browsers: { usesProfile }, browserProfiles: { deleteProfile }
    })
    await expect(handler({}, profile.id, {})).rejects.toThrow('Untrusted Browser Profile sender')
    expect(usesProfile).not.toHaveBeenCalled()
    expect(deleteProfile).not.toHaveBeenCalled()
  })
  it('rechecks current usage and forwards the exact target approval only when unused', async () => {
    const usesProfile = vi.fn(() => true)
    const deleteProfile = vi.fn(async () => {})
    const requireTrustedSender = vi.fn()
    const approval = { kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: profile.id }
    const handler = productionDeleteHandler({ requireTrustedSender, browsers: { usesProfile }, browserProfiles: { deleteProfile } })
    await expect(handler({}, profile.id, approval)).rejects.toThrow('Browser Profile is still used by an open Browser')
    expect(usesProfile).toHaveBeenCalledWith(profile.id)
    expect(deleteProfile).not.toHaveBeenCalled()
    usesProfile.mockReturnValue(false)
    await handler({}, profile.id, approval)
    expect(requireTrustedSender).toHaveBeenCalledWith('browser:deleteProfile', {})
    expect(deleteProfile).toHaveBeenCalledExactlyOnceWith(profile.id, approval)
  })
})
