import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'

const c = JSON.parse(await readFile(process.argv[2], 'utf8'))
const store = new AgentMuxNotebookStore(c.path), state = await store.read()
assert.equal(Object.keys(state.pages).length, c.count)
assert.equal((await readdir(join(c.target.workspacePath, c.destination))).length, c.count + 1)
for (let index = 0; index < c.count; index++) {
  const id = 'capacity-note-' + String(index).padStart(4, '0'), path = c.destination + '/' + id + '.note.md'
  assert.deepEqual(state.pages[id].resource, { ...c.target, path })
  assert.equal(await readFile(join(c.target.workspacePath, path), 'utf8'), '---\nschema: agentmux.note.md.v1\nnote-id: ' + id + '\n---\n\nOriginal ' + id + '\n\n^original\n')
}
for (const probe of c.probes) {
  const resource = { ...probe.resource, path: c.destination + probe.resource.path.slice(c.source.length) }
  const history = await store.readHistoryOperation(probe.eventId)
  for (const [key, value] of Object.entries({ actor: c.actor, content: probe.content, originalResource: probe.resource, resource })) assert.deepEqual(history[key], value)
  const provenance = await store.readProvenance({ noteId: probe.id, resource, revision: probe.revision, blockIds: ['original'] })
  assert.deepEqual(provenance.blocks, probe.provenance.blocks)
}
process.stdout.write(JSON.stringify({ pid: process.pid, count: c.count, histories: c.probes.length, exactBodies: true, exactCreators: true }) + '\n')
