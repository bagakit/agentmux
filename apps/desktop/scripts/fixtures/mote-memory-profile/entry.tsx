// Keep the original Profile, Editor, Launcher, navigation and theme; only the Files transport is controlled.
import '../mote-companion-workflows/persona-entry'
import { api } from '../../../src/renderer/src/lib/api'
import { useAppStore } from '../../../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicDirectoryName } from '../../../src/shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../../../src/shared/space-addresses'
import type { FileReadResult } from '@agentmux/core'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'

mountThemeRuntime(window, { appAppearance: 'dark' })
const workspacePath = new URLSearchParams(location.search).get('workspacePath')!
const rootPath = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID), path = rootPath + '/MEMORY.md'
const original = '# Working together\n\n- Start with the conclusion, then explain the evidence.\n- This project values a small working result before expanding scope.\n\nSource: our project discussion, 16 October. Scope: this project.\n\n## Open commitment\n\nReview the small experiment when its result is ready.\n'
let content = original, mode: 'saved' | 'unknown' | 'missing' = 'saved'
const calls: { kind: string; path: string }[] = []
// This Memory scene has no linked Goals; old unrelated Goal fixture shapes must not pollute it.
api.demands.list = async () => []
const hash = async (value: string) => 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
const readPublic = api.files.readPublic, read = api.files.read, write = api.files.write
api.files.readPublic = async params => {
  if (params.path !== 'MEMORY.md' || params.zoneId !== homeZoneId(directoryIdentity('local', workspacePath + '/' + rootPath))) return readPublic(params)
  calls.push({ kind: 'file.read', path: params.path })
  if (mode === 'unknown') return { resource: null, result: { status: 'unknown', code: 'PRIVATE_MEMORY_READ_UNKNOWN', message: 'Saved memory is temporarily unavailable. Try again when the connection returns.' } }
  const resource = { ...params.expectedResource, zoneId: params.zoneId, zonePath: workspacePath + '/' + rootPath, path }
  if (mode === 'missing') return { resource, result: { status: 'deleted' } } as FileReadResult
  return { resource, result: { status: 'read', document: { path, content, revision: await hash(content) } } }
}
api.files.read = async (workspace, source) => {
  if (source !== path) return read(workspace, source)
  calls.push({ kind: 'editor.read', path: source })
  return { status: 'read', document: { path, content, revision: await hash(content) } }
}
api.files.write = async (workspace, input) => {
  if (input.path !== path) return write(workspace, input)
  calls.push({ kind: 'editor.write', path: input.path })
  if (input.expectedRevision !== await hash(content)) return { status: 'conflict', document: { path, content, revision: await hash(content) } }
  content = input.content
  return { status: 'written', revision: await hash(content) }
}
Object.assign(window, { moteMemoryScenario: {
  theme: (light: boolean) => updateThemeSelection({ appAppearance: light ? 'light' : 'dark' }),
  set(kind: 'saved' | 'unknown' | 'missing' | 'long') {
    mode = kind === 'long' ? 'saved' : kind
    if (kind === 'saved') content = original
    if (kind === 'long') content = original + '\n## Details and source links\n\n' + Array.from({ length: 10 }, (_, index) => `### Decision ${index + 1}\n\nKeep each choice in its own original source, explain where it applies, and retain the user’s correction. [Open the context](./topic.md).\n`).join('\n')
  },
  facts: () => ({ calls, content, mode, drafts: useAppStore.getState().agentComposerDrafts, selected: useAppStore.getState().workbenchSpaceSelection }),
  path
} })
