// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GitCommitDetails } from '../src/renderer/src/features/git/commit/GitCommitDetails'
import type { GitCommitDetailsResult } from '../src/shared/git-contracts'
import { createClientUiRoot } from './helpers/client-ui-render'
import { fixturePath, fixtureTime } from '../scripts/lib/fixture-values.mjs'

const requests: Array<{ src: string; referrerPolicy: string; crossOrigin: string; onload: null | (() => void); onerror: null | (() => void) }> = []
let host: HTMLDivElement
let root: ReturnType<typeof createClientUiRoot>
const oid = 'a'.repeat(40)
function details(email: string): Extract<GitCommitDetailsResult, { kind: 'ready' }> {
  return { kind: 'ready', snapshot: { hostId: 'local', repoPath: fixturePath('git-avatar'), commitOid: oid, parentOid: null },
    commit: { oid, parents: [], subject: 'Read the message', message: 'Read the message\n\nThe files stay readable.',
      author: 'Original Author', authorEmail: email, authoredAt: null, committer: 'Original Author', committedAt: null, refs: [] },
    entries: [{ path: 'source.ts', origPath: null, change: 'added' }], warnings: [] }
}
async function render(email: string) {
  await act(async () => root.render(<GitCommitDetails regionId="avatar-reader" selection={{ commitOid: oid, parentOid: null }}
    result={details(email)} loading={false} error={null} onReload={() => {}} onSelectParent={() => {}} onSelectFile={() => {}} />))
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  requests.length = 0
  vi.stubGlobal('Image', class {
    src = ''; referrerPolicy = ''; crossOrigin = ''; onload = null; onerror = null
    constructor() { requests.push(this) }
  })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers()
})

it('renders original content immediately, uses only recorded email and shares successful image lookup', async () => {
  const email = 'original+reserved&name@example.test'
  await render(email)
  expect(host.querySelector<HTMLDetailsElement>('.git-workbench__raw-message')?.open).toBe(true)
  expect(host.querySelector('.git-workbench__message')?.textContent).toContain('The files stay readable.')
  expect(host.querySelector('[aria-label="Open diff for source.ts"]')).not.toBeNull()
  expect(host.querySelector('.git-workbench__author-initials')?.textContent).toBe('OA')
  expect(requests).toHaveLength(1)
  const request = requests[0]!, url = new URL(request.src)
  expect(url.origin + url.pathname).toBe('https://avatars.githubusercontent.com/u/e')
  expect(url.searchParams.get('email')).toBe(email)
  expect(request.referrerPolicy).toBe('no-referrer'); expect(request.crossOrigin).toBe('anonymous')
  await act(async () => request.onload!())
  expect(host.querySelector('img')?.getAttribute('src')).toBe(request.src)
  expect(host.querySelector('[aria-label="GitHub author avatar, not a verified identity"]')).not.toBeNull()
  await render(''); await render(email)
  expect(requests).toHaveLength(1)
  expect(host.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer')
})

it('keeps the local author on failure and rechecks only after the negative cache expires', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(fixtureTime())
  const email = 'unavailable@example.test'
  await render(email)
  await act(async () => requests[0]!.onerror!())
  await render(''); await render(email)
  expect(requests).toHaveLength(1)
  expect(host.querySelector('.git-workbench__author-initials')?.textContent).toBe('OA')
  expect(host.querySelector('.git-workbench__person')?.textContent).toBe('Original Author')
  expect(host.querySelector('[aria-label="Open diff for source.ts"]')).not.toBeNull()
  vi.setSystemTime(fixtureTime(5 * 60_000 + 1))
  await render(''); await render(email)
  expect(requests).toHaveLength(2)
})

it('rejects stale photos after selecting a different email and skips absent or malformed addresses', async () => {
  await render('first@example.test'); const first = requests[0]!
  await render('second@example.test'); const second = requests[1]!
  expect(host.querySelector('img')).toBeNull()
  await act(async () => second.onload!())
  await act(async () => first.onload!())
  expect(host.querySelector('img')?.getAttribute('src')).toBe(second.src)
  await render(''); await render('not an email')
  expect(host.querySelector('img')).toBeNull(); expect(requests).toHaveLength(2)
})
