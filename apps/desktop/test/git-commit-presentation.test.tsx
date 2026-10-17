// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { act, useState, type ComponentProps } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixturePath, fixtureTime } from '../scripts/lib/fixture-values.mjs'
import type { GitCommitDetailsResult, GitCommitSnapshot } from '../src/shared/git-contracts'
import { GitCommitDetails } from '../src/renderer/src/features/git/commit/GitCommitDetails'
import { useGitCommitDetails } from '../src/renderer/src/features/git/commit/useGitCommitDetails'
import { createClientUiRoot } from './helpers/client-ui-render'

type ReadyCommit = Extract<GitCommitDetailsResult, { kind: 'ready' }>
const commitOid = 'a'.repeat(40)
const firstParent = 'b'.repeat(40)
const secondParent = 'c'.repeat(40)
const workspace = { id: 'presentation-repository', hostId: 'local', path: fixturePath('git-presentation/repository'), name: 'Repository', kind: 'folder' as const }
const scope = { hostId: workspace.hostId, repoPath: workspace.path }
const onReload = vi.fn()
const onSelectParent = vi.fn<(snapshot: GitCommitSnapshot) => void>()
const onSelectFile = vi.fn<(file: ReadyCommit['entries'][number]) => void>()
const commitDetails = vi.fn<(workspaceId: string, input: { oid: string; parentOid?: string }) => Promise<GitCommitDetailsResult>>()
const fetchRequest = vi.fn()
let host: HTMLDivElement
let root: ReturnType<typeof createClientUiRoot>
let stylesheet: HTMLStyleElement
const originalBridge = Object.getOwnPropertyDescriptor(window, 'agentmux')

function fixedCommit(message = 'feat(core)!: Read fixed commit details\n\nKeep the original message.\n'): ReadyCommit {
  return {
    kind: 'ready', snapshot: { ...scope, commitOid, parentOid: firstParent },
    commit: { oid: commitOid, parents: [firstParent, secondParent], subject: 'Not a substitute for the full message', message,
      author: 'Ada Example', authorEmail: '', committer: 'Commit Robot', authoredAt: fixtureTime(-60_000), committedAt: fixtureTime(), refs: [] },
    entries: [
      { path: 'src/added.ts', origPath: null, change: 'added' },
      { path: 'src/another.ts', origPath: null, change: 'added' },
      { path: 'src/modified.ts', origPath: null, change: 'modified' },
      { path: 'src/deleted.ts', origPath: null, change: 'deleted' },
      { path: 'src/renamed.ts', origPath: 'src/original.ts', change: 'renamed' },
      { path: 'src/linked.ts', origPath: null, change: 'type-changed' }
    ], warnings: []
  }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', fetchRequest)
  onReload.mockReset(); onSelectParent.mockReset(); onSelectFile.mockReset(); fetchRequest.mockReset()
  commitDetails.mockReset().mockResolvedValue(fixedCommit())
  Object.defineProperty(window, 'agentmux', { configurable: true, value: { git: { commitDetails } } })
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
  stylesheet = document.createElement('style')
  stylesheet.textContent = readFileSync('apps/desktop/src/renderer/src/styles/git-workbench.css', 'utf8')
  document.head.append(stylesheet)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); stylesheet.remove(); window.getSelection()?.removeAllRanges()
  if (originalBridge) Object.defineProperty(window, 'agentmux', originalBridge)
  else Reflect.deleteProperty(window, 'agentmux')
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function renderDetails(result = fixedCommit(), overrides: Partial<ComponentProps<typeof GitCommitDetails>> = {}) {
  await act(async () => root.render(<GitCommitDetails regionId="fixed-commit-region"
    selection={{ commitOid: result.snapshot.commitOid, parentOid: result.snapshot.parentOid }} result={result}
    loading={false} error={null} onReload={onReload} onSelectParent={onSelectParent} onSelectFile={onSelectFile} {...overrides} />))
}

function metadata(label: string) {
  return [...host.querySelectorAll('dt')].find(term => term.textContent === label)?.nextElementSibling ?? null
}

function fileSummary() {
  return [...host.querySelectorAll('[aria-label="File change summary"] li')].map(item => item.textContent)
}

it('mounts the real details with a clean subject, restrained format, unchanged body and copyable full raw message', async () => {
  const message = 'feat(core)!: Read fixed commit details\r\n\r\nKeep the first paragraph.\r\n\r\nBREAKING CHANGE: the old command is removed.\r\n  Preserve indentation.\r\n'
  await renderDetails(fixedCommit(message))
  expect(host.querySelector('h2')?.textContent).toBe('Read fixed commit details')
  expect([...host.querySelectorAll('.git-workbench__message-format > span')].map(item => item.textContent)).toEqual(['feat', 'core', 'Breaking change'])
  expect(host.querySelector('.git-workbench__message-body')).toBeNull()
  const raw = host.querySelector<HTMLPreElement>('.git-workbench__message')!
  const disclosure = host.querySelector<HTMLDetailsElement>('.git-workbench__raw-message')!
  expect(raw.textContent).toBe(message)
  expect(disclosure.open).toBe(true)
  expect(disclosure.querySelector('summary')?.textContent).toBe('Full commit message')
  const range = document.createRange(); range.selectNodeContents(raw)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  expect(window.getSelection()!.toString()).toBe(message)
  expect(window.getComputedStyle(raw).whiteSpace).toBe('pre-wrap')
  expect(window.getComputedStyle(raw).userSelect).toBe('text')
  expect(commitDetails).not.toHaveBeenCalled()
  expect(fetchRequest).not.toHaveBeenCalled()
})

it.each([
  ['fix: Keep reload available', 'Keep reload available', 'fix', null, false],
  ['docs(reading): Explain the original message', 'Explain the original message', 'docs', 'reading', false],
  ['chore!: Remove the old flag', 'Remove the old flag', 'chore', null, true],
  ['custom-type(ui/core): Keep native scope', 'Keep native scope', 'custom-type', 'ui/core', false]
] as const)('presents conventional subject %s without replacing the full message', async (message, heading, type, messageScope, breaking) => {
  await renderDetails(fixedCommit(message))
  expect(host.querySelector('h2')?.textContent).toBe(heading)
  expect(host.querySelector('.git-workbench__message-format > span')?.textContent).toBe(type)
  expect(host.querySelector('[aria-label^="Scope:"]')?.textContent ?? null).toBe(messageScope)
  expect(Boolean(host.querySelector('.git-workbench__message-breaking'))).toBe(breaking)
  expect(host.querySelector('.git-workbench__message')?.textContent).toBe(message)
})

it.each([
  'A plain commit subject\n\nA second paragraph.\n',
  "Merge branch 'topic'\n\nConflicts were resolved.\n",
  'Revert "feat: original subject"\n\nThis reverts an earlier commit.\n',
  'feat(core: missing closing scope\n\nKeep all of this.\n',
  'feat(): empty scope\n',
  'feat(core)!: \n\nMissing subject.\n',
  'feat(core)! subject without a colon\n',
  '  Keep leading and trailing spaces  \n\n  Body indentation.\n',
  '<img src="https://invalid.example/author.png" onerror="alert(1)">\n\n<script>alert(1)</script>\n![avatar](https://invalid.example/photo.png)'
])('keeps unknown, merge, revert and malformed text literal: %s', async message => {
  await renderDetails(fixedCommit(message))
  expect(host.querySelector('h2')?.textContent).toBe(message.split('\n')[0])
  expect(host.querySelector('.git-workbench__message-format')).toBeNull()
  expect(host.querySelector('.git-workbench__message')?.textContent).toBe(message)
  expect(host.querySelectorAll('img, script, iframe, a[href]')).toHaveLength(0)
  expect(fetchRequest).not.toHaveBeenCalled()
})

it('leaves a footer-only breaking declaration readable without inventing a subject marker', async () => {
  const message = 'fix(core): Keep compatibility\n\nBREAKING CHANGE: follow the migration notes.\n'
  await renderDetails(fixedCommit(message))
  expect(host.querySelector('.git-workbench__message-breaking')).toBeNull()
  expect(host.querySelector('.git-workbench__message')?.textContent).toContain('BREAKING CHANGE: follow the migration notes.')
  expect(host.querySelector('.git-workbench__message')?.textContent).toBe(message)
})

it('keeps a missing first line distinct from an empty message and resets raw disclosure for another commit', async () => {
  await renderDetails(fixedCommit('\nBody without a subject\n'))
  expect(host.querySelector('h2')?.textContent).toBe('(No subject)')
  expect(host.querySelector('.git-workbench__message')?.textContent).toBe('\nBody without a subject\n')
  await act(async () => host.querySelector('summary')!.click())
  const empty = fixedCommit(''); empty.commit.oid = 'd'.repeat(40); empty.snapshot.commitOid = empty.commit.oid
  await renderDetails(empty)
  expect(host.querySelector('h2')?.textContent).toBe('(No commit message)')
  expect(host.querySelector<HTMLDetailsElement>('details')!.open).toBe(true)
})

it('shows recorded author and committer differences, real timestamps and every reference without identity or network lookup', async () => {
  const result = fixedCommit()
  result.commit.refs = [
    { kind: 'local', name: 'refs/heads/main', oid: commitOid },
    { kind: 'remote', name: 'refs/remotes/origin/topic-with-a-long-readable-name', oid: commitOid },
    { kind: 'head', name: 'HEAD', oid: commitOid },
    { kind: 'tag', name: 'refs/tags/release', oid: commitOid }
  ]
  await renderDetails(result)
  expect(metadata('Author')?.querySelector('.git-workbench__person')?.textContent).toBe('Ada Example')
  expect(metadata('Committed')?.querySelector('.git-workbench__person')?.textContent).toBe('Commit Robot')
  expect([...host.querySelectorAll('time')].map(time => time.dateTime)).toEqual([
    new Date(result.commit.authoredAt!).toISOString(), new Date(result.commit.committedAt!).toISOString()
  ])
  const initials = host.querySelector('[role="img"]')!
  expect(initials.textContent?.trim()).toBe('AE')
  expect(initials.getAttribute('aria-label')).toBe('Local author initials, not a verified photo or identity')
  expect(host.querySelectorAll('img, [src]')).toHaveLength(0)
  expect([...host.querySelectorAll('.git-workbench__reference')].map(reference => reference.getAttribute('title')))
    .toEqual(result.commit.refs.map(reference => reference.kind + ' · ' + reference.name + '\n' + reference.oid))
  expect([...host.querySelectorAll('.git-workbench__reference > span')].map(reference => reference.textContent)).toEqual(result.commit.refs.map(reference => reference.name))
  expect(metadata('Parents')?.textContent).toBe(firstParent + secondParent)
  expect(commitDetails).not.toHaveBeenCalled(); expect(fetchRequest).not.toHaveBeenCalled()
})

it('compresses identical recorded name/time fields, supports local Unicode initials and retains differing commit time', async () => {
  const result = fixedCommit()
  result.commit.author = '李明'; result.commit.committer = '李明'; result.commit.committedAt = result.commit.authoredAt
  await renderDetails(result)
  expect(host.querySelector('[role="img"]')?.textContent?.trim()).toBe('李明')
  expect(metadata('Committed')).toBeNull()
  result.commit.committedAt = fixtureTime()
  await renderDetails(result)
  expect(metadata('Committed')?.querySelector('time')?.dateTime).toBe(new Date(result.commit.committedAt).toISOString())
  expect(metadata('Committed')?.querySelector('.git-workbench__person')).toBeNull()
})

it('keeps differing recorded committer names visible even when the timestamps match', async () => {
  const result = fixedCommit(); result.commit.committedAt = result.commit.authoredAt
  await renderDetails(result)
  expect(metadata('Committed')?.querySelector('.git-workbench__person')?.textContent).toBe('Commit Robot')
  expect(host.querySelectorAll('time')).toHaveLength(2)
})

it.each([null, Number.NaN, Number.POSITIVE_INFINITY])('shows unknown dates without throwing or substituting the current time: %s', async value => {
  const result = fixedCommit(); result.commit.authoredAt = value; result.commit.committedAt = value
  result.commit.author = ''; result.commit.committer = ''
  await renderDetails(result)
  expect(host.querySelector('[role="img"]')?.textContent?.trim()).toBe('?')
  expect(metadata('Author')?.textContent).toContain('Unknown author')
  expect(host.querySelectorAll('time')).toHaveLength(0)
  expect(host.textContent).toContain('Unknown date')
  if (value === null) expect(metadata('Committed')?.textContent).toContain('Unknown date')
  expect(host.querySelector('.git-workbench__files button')).not.toBeNull()
})

it('counts actual file kinds for the fixed parent and passes the unchanged rename entry to the original diff action', async () => {
  const result = fixedCommit()
  await renderDetails(result, { selectedPath: 'src/renamed.ts' })
  expect(host.querySelector('.git-workbench__files-title > span')?.textContent).toBe('6 files')
  expect(fileSummary()).toEqual(['2 added', '1 modified', '1 deleted', '1 renamed', '1 type changed'])
  expect(host.querySelectorAll('.git-workbench__files button')).toHaveLength(result.entries.length)
  const rename = host.querySelector<HTMLButtonElement>('[aria-label="Open diff for src/renamed.ts"]')!
  expect(rename.getAttribute('aria-pressed')).toBe('true')
  expect(rename.title).toBe('src/original.ts → src/renamed.ts')
  await act(async () => rename.click())
  expect(onSelectFile).toHaveBeenCalledExactlyOnceWith(result.entries[4])
  expect(onSelectFile.mock.calls[0]![0]).toBe(result.entries[4])
  expect(host.querySelector('progress, [role="progressbar"]')).toBeNull()
  expect(host.textContent).not.toMatch(/insertions|deletions|lines changed/)
})

it('retains the exact parent callback and recomputes the summary from new entries only', async () => {
  const result = fixedCommit()
  await renderDetails(result)
  const parent = host.querySelector<HTMLSelectElement>('[aria-label="Comparison parent"]')!
  await act(async () => { parent.value = secondParent; parent.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(onSelectParent).toHaveBeenCalledExactlyOnceWith({ ...result.snapshot, parentOid: secondParent })
  expect(onSelectFile).not.toHaveBeenCalled()
  const updated = { ...result, snapshot: { ...result.snapshot, parentOid: secondParent }, entries: [result.entries[2]!] }
  await renderDetails(updated)
  expect(fileSummary()).toEqual(['1 modified'])
  expect(host.querySelector('.git-workbench__files-title > span')?.textContent).toBe('1 file')
  expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe(secondParent)
})

it('keeps root empty-tree facts, zero-file explanation and warning/error recovery alongside readable content', async () => {
  const result = fixedCommit('A root commit\n\nThe body is retained.')
  result.commit.parents = []; result.snapshot.parentOid = null; result.entries = []
  result.warnings = ['Commit references unavailable. Reload this fixed commit to retry.']
  await renderDetails(result, { error: 'Reload failed; the original target is retained.' })
  expect(metadata('Parents')?.textContent).toBe('None · root commit')
  expect(host.querySelector('.git-workbench__comparison')?.textContent).toContain('Empty tree')
  expect(host.querySelector('select')).toBeNull()
  expect(fileSummary()).toEqual([])
  expect(host.querySelector('.git-workbench__files-title > span')?.textContent).toBe('0 files')
  expect(host.querySelector('.git-workbench__empty')?.textContent).toBe('No file changes against this parent.')
  expect(host.querySelector('.git-workbench__message')?.textContent).toBe(result.commit.message)
  expect(host.querySelector('.git-workbench__warning')?.textContent).toBe(result.warnings[0])
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Reload failed')
  await act(async () => host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click())
  expect(onReload).toHaveBeenCalledOnce()
})

function FixedCommitConsumer() {
  const [selection, setSelection] = useState<{ commitOid: string; parentOid: string | null }>({ commitOid, parentOid: firstParent })
  const { read, reload } = useGitCommitDetails(workspace, scope, selection, true)
  const result = read?.result?.kind === 'ready' ? read.result : null
  return <GitCommitDetails regionId="fixed-commit-region" selection={selection} result={result} loading={read?.loading ?? false}
    error={read?.error ?? null} onReload={reload} onSelectParent={snapshot => setSelection({ commitOid: snapshot.commitOid, parentOid: snapshot.parentOid })} onSelectFile={onSelectFile} />
}

it('uses the production reader/bridge on parent change, never for formatting, disclosure, focus or hover', async () => {
  const original = fixedCommit()
  const next = { ...original, snapshot: { ...original.snapshot, parentOid: secondParent }, entries: [original.entries[2]!] }
  commitDetails.mockImplementation(async (_workspaceId, input) => input.parentOid === secondParent ? next : original)
  await act(async () => root.render(<FixedCommitConsumer />))
  await vi.waitFor(() => expect(host.querySelector('.git-workbench__message')?.textContent).toBe(original.commit.message))
  expect(commitDetails).toHaveBeenCalledExactlyOnceWith(workspace.id, { oid: commitOid, parentOid: firstParent })
  await act(async () => {
    host.querySelector('h2')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    host.querySelector('summary')!.focus(); host.querySelector('summary')!.click()
  })
  expect(commitDetails).toHaveBeenCalledOnce()
  const parent = host.querySelector<HTMLSelectElement>('select')!
  await act(async () => { parent.value = secondParent; parent.dispatchEvent(new Event('change', { bubbles: true })) })
  await vi.waitFor(() => expect(fileSummary()).toEqual(['1 modified']))
  expect(commitDetails.mock.calls).toEqual([
    [workspace.id, { oid: commitOid, parentOid: firstParent }], [workspace.id, { oid: commitOid, parentOid: secondParent }]
  ])
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Open diff for src/modified.ts"]')!.click())
  expect(onSelectFile).toHaveBeenCalledExactlyOnceWith(next.entries[0])
  expect(host.querySelector('.git-workbench__message')?.textContent).toBe(original.commit.message)
  expect(fetchRequest).not.toHaveBeenCalled()
})
