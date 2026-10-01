import { moteConfig, moteTopics } from '../../../test/fixtures/mote-workface'
import defaultAvatar from '../../../src/renderer/src/assets/pmo-teams-topic-avatar.png'

// Visual-only bridge for the AgentMux Browser preview of the maintained real App fixture.
// The isolated native probe keeps the real ScratchTopics file owner and restart proof.
const image = { kind: 'image' as const, fileName: 'a'.repeat(64) + '.png' }
const saved = new Map<string, string>()
export const browserPaperdollBridge: Window['motePaperdollNative'] = {
  bootstrap: async () => ({ config: structuredClone(moteConfig), image, phase: localStorage.getItem('agentmux-workbench-v1') && localStorage.getItem('agentmux.leader-topic-floating.v1') ? 'restore' : 'seed' }),
  config: async () => structuredClone(moteConfig),
  listTopics: async () => structuredClone(moteTopics),
  readTopic: async (_workspace, id) => structuredClone(moteTopics.find(topic => topic.id === id) ?? null),
  ensureMote: async (_workspace, id) => { const topic = moteTopics.find(topic => topic.id === id); if (!topic) throw new Error('Unknown preview Mote'); return structuredClone(topic) },
  readMoteAvatar: async (_workspace, _topic, choice) => ({ dataUrl: saved.get(choice.fileName) ?? defaultAvatar, width: 256, height: 256 }),
  previewMoteAvatar: async (_workspace, _topic, input) => ({ dataUrl: input.dataUrl, width: 256, height: 256 }),
  saveMoteAvatar: async (_workspace, _topic, input) => { const bytes = new TextEncoder().encode(input.dataUrl); const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join(''); const fileName = hash + '.png'; saved.set(fileName, input.dataUrl); return { kind: 'image', fileName } },
  flushStorage: async () => {}
}
