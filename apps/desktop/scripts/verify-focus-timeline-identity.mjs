import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const args = process.argv.slice(2)
assert.equal(args.length, 2); assert.equal(args[0], '--slice')
assert.ok(['current-name', 'mote-avatar'].includes(args[1]))
const slice = args[1], root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.bagakit/feature-tracker/focus-identity-consistency-artifacts', slice)
await mkdir(evidence, { recursive: true })
const component = 'apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx'
const test = 'apps/desktop/test/focus-timeline-identity.test.tsx'
const name = ("" + (slice) + "-mutants-" + (globalThis.crypto.randomUUID()) + "")
process.env.AGENTMUX_FOCUS_IDENTITY_SLICE = slice
const avatar = 'apps/desktop/src/renderer/src/components/SpaceObjectIcon.tsx'
const metadata = 'apps/desktop/src/renderer/src/lib/conversation-sender-details.ts'
const sources = [component, 'apps/desktop/test/helpers/composer-dom-fixture.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx', 'apps/desktop/test/fixtures/mote-workface.ts',
  ...(slice === 'mote-avatar' ? [avatar, metadata,
    'apps/desktop/src/renderer/src/components/ConversationSpeakerAvatar.tsx',
    'apps/desktop/src/renderer/src/components/ConversationMessageAvatar.tsx',
    'packages/client-ui/src/components/ConversationMessage.tsx',
    'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx',
    'apps/desktop/src/renderer/src/lib/mote-conversation-identity.ts',
    'apps/desktop/src/renderer/src/styles/focus.css',
    'apps/desktop/src/renderer/src/styles/mote-workface.css'] : [])]
const mutations = slice === 'current-name' ? [
  { label: 'current-alias-disconnected', file: component,
    before: 'const userName = useAppStore(state => state.agentNames[sessionId])', after: 'const userName = undefined' },
  { label: 'current-derived-name-disconnected', file: component,
    before: "firstPrompt: session?.kind === 'agent' ? firstPromptFromTimeline(timeline) : undefined,", after: 'firstPrompt: undefined,' }
] : [
  { label: 'confirmed-mote-appearance-disconnected', file: metadata,
    before: `const mote = target && sourceWorkspace && topic ? { workspaceId: sourceWorkspace.id, topicId: topic.id,
    objectKey: target.key, name: topic.title, icon: snapshot.spaceObjectIcons?.[target.key] ?? null } : undefined`, after: 'const mote = undefined' },
  { label: 'mounted-avatar-read-sharing-disconnected', file: avatar,
    before: 'const existing = activeMoteAvatarReads.get(key)', after: 'const existing = undefined' },
  { label: 'avatar-content-key-dropped', file: avatar,
    before: 'const key = JSON.stringify([workspaceId, topicId, objectKey, fileName])',
    after: 'const key = JSON.stringify([workspaceId, topicId, objectKey])' },
  { label: 'scratch-scope-check-bypassed', file: metadata,
    before: 'scratchTopicsForWorkspace(snapshot.scratchTopicSnapshots, sourceWorkspace)',
    after: 'snapshot.scratchTopicSnapshots[sourceWorkspace?.id ?? ""]?.topics' }
]
assert.ok(mutations.length > 0, 'The selected slice requires its own product mutations')
await verifyRendererSourceMutations({ name, tests: [test], sources, mutations, evidenceRoot: evidence })
const receipt = JSON.parse(await readFile(join(evidence, name, 'receipt.json'), 'utf8'))
const callers = {}
for (const [symbol, definition] of [
  ['<RecentFocusTimeline ', component],
  ...(slice === 'current-name' ? [['agentDisplayName(', 'apps/desktop/src/renderer/src/lib/workbench-tabs.ts']] : [
    ['currentConversationSpeakerMetadata(', metadata],
    ['<ConversationSpeakerAvatar ', 'apps/desktop/src/renderer/src/components/ConversationSpeakerAvatar.tsx'],
    ['<SpaceObjectIcon ', avatar]
  ])
]) {
  const result = spawnSync('rg', ['-n', '--fixed-strings', symbol, 'apps/desktop/src'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0)
  const hits = result.stdout.trim().split('\n').filter(line => !line.startsWith(definition + ':') && !/^.*:\d+:\s*import\b/.test(line))
  assert.ok(hits.length > 0, `No external production caller for ${symbol}`)
  callers[symbol] = hits
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const qualification = { schema: 'agentmux.focus-timeline-identity-qualification.v1', slice, passed: true,
  owningTests: test, mutations: receipt, callers,
  inputs: Object.fromEntries(await Promise.all([...sources, test].map(async file => [file, sha256(await readFile(join(root, file)))]))),
  boundary: 'Current compiled Renderer identity over the existing Store naming and public message projection owners. No Run control, restart, installation or whole-product claim.' }
await writeFile(join(evidence, 'qualification.json'), JSON.stringify(qualification, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, slice, qualification: join(evidence, 'qualification.json') }))
