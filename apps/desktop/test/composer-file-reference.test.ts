import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import {
  appendFileReferences,
  appendNamedFileReference,
  appendSelectedFileReferences,
  workspaceRelativePath
} from '@agentmux/client-ui/composer-file-reference'
import { expandSemanticReferences, parseComposerDraft } from '@agentmux/client-ui/composer-semantic-reference'
import { draftDocument, documentDraft } from '@agentmux/client-ui/components/InlineComposer'

describe('composer file references', () => {
  it('writes paths inside the workspace relative to it', () => {
    // The Agent runs with the workspace as its working directory, so that is the form it can resolve.
    expect(workspaceRelativePath(_hygiene_fixturePath("repo/src/index.ts"), _hygiene_fixturePath("repo"))).toBe('src/index.ts')
    expect(workspaceRelativePath(_hygiene_fixturePath("repo/src/index.ts"), _hygiene_fixturePath("repo/"))).toBe('src/index.ts')
  })

  it('leaves paths outside the workspace absolute', () => {
    expect(workspaceRelativePath('/etc/hosts', _hygiene_fixturePath("repo"))).toBe('/etc/hosts')
    // A sibling directory that merely shares a prefix is still outside.
    expect(workspaceRelativePath(_hygiene_fixturePath("repo-other/file.ts"), _hygiene_fixturePath("repo"))).toBe(_hygiene_fixturePath("repo-other/file.ts"))
  })

  it('keeps the absolute path when there is no workspace to relativize against', () => {
    expect(workspaceRelativePath(_hygiene_fixturePath("repo/src/index.ts"), undefined)).toBe(_hygiene_fixturePath("repo/src/index.ts"))
  })

  it('appends references with exactly one separating space', () => {
    expect(appendFileReferences('look at', [_hygiene_fixturePath("repo/a.ts")], _hygiene_fixturePath("repo"))).toBe('look at @a.ts ')
    // A draft that already ends in a space must not gain a second one.
    expect(appendFileReferences('look at ', [_hygiene_fixturePath("repo/a.ts")], _hygiene_fixturePath("repo"))).toBe('look at @a.ts ')
    // An empty draft starts clean, with no leading space.
    expect(appendFileReferences('', [_hygiene_fixturePath("repo/a.ts")], _hygiene_fixturePath("repo"))).toBe('@a.ts ')
  })

  it('appends every chosen file in one edit', () => {
    expect(appendFileReferences('diff', [_hygiene_fixturePath("repo/a.ts"), _hygiene_fixturePath("repo/b.ts")], _hygiene_fixturePath("repo"))).toBe('diff @a.ts @b.ts ')
  })

  it('leaves the draft untouched when the picker was dismissed', () => {
    expect(appendFileReferences('unchanged', [], _hygiene_fixturePath("repo"))).toBe('unchanged')
  })

  it('keeps a chosen filename compact while round-tripping and sending its complete original path', () => {
    const path = _hygiene_fixturePath("host-private/original operation/attachment.png")
    const draft = appendNamedFileReference('请阅读', path, '头像参考.png')
    expect(parseComposerDraft(draft)).toContainEqual(expect.objectContaining({ reference: expect.objectContaining({ kind: 'file', label: '头像参考.png', reference: '@' + path }) }))
    expect(documentDraft(draftDocument(draft))).toBe(draft)
    expect(expandSemanticReferences(draft)).toBe('请阅读 @' + path + ' ')
  })
})

it('uses named references only for explicit selection and preserves every original expanded path', () => {
  const workspace = _hygiene_fixturePath('selected/workspace')
  const first = workspace + '/src/a [draft].txt', outside = _hygiene_fixturePath('outside/a [draft].txt')
  const draft = appendSelectedFileReferences('Read', [first, outside], workspace)
  const parts = parseComposerDraft(draft).filter(part => 'reference' in part)
  expect(parts).toHaveLength(2)
  expect(parts.every(part => 'reference' in part && part.reference.label.endsWith('.txt'))).toBe(true)
  expect(documentDraft(draftDocument(draft))).toBe(draft)
  expect(expandSemanticReferences(draft)).toBe('Read @src/a [draft].txt @' + outside + ' ')
  expect(appendSelectedFileReferences('unchanged', [], workspace)).toBe('unchanged')
})

it('keeps an app-owned pasted image as its original node while other selected files use the existing codec', () => {
  const path = _hygiene_fixturePath('original-home/.agentmux/pasted/original.png')
  const draft = appendSelectedFileReferences('', [path, _hygiene_fixturePath('ordinary/image.png')])
  const doc = draftDocument(draft)
  expect(doc.content![0]!.content?.map(node => node.type)).toEqual(['pastedImage', 'text', 'toolReference', 'text'])
  expect(documentDraft(doc)).toBe(draft)
})

it('keeps a selected reference parsable when label cleanup leaves no display characters', () => {
  const path = _hygiene_fixturePath('special/[]')
  const draft = appendNamedFileReference('', path, '[]')
  expect(parseComposerDraft(draft)).toContainEqual(expect.objectContaining({ reference: expect.objectContaining({ kind: 'file', reference: '@' + path }) }))
  expect(documentDraft(draftDocument(draft))).toBe(draft)
  expect(expandSemanticReferences(draft)).toBe('@' + path + ' ')
})
