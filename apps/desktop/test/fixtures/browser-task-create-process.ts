import { readFile } from 'node:fs/promises'
import { BrowserTaskAssets, BrowserTaskAssetFileStore } from '../../src/main/browser-task-assets.js'
import { BrowserDemonstrationRecorder, BrowserDemonstrationFileStore } from '../../src/main/browser-demonstration-recorder.js'
import type { BrowserTaskCreateInput } from '@agentmux/core/control'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'

const [mode, assetPath, recordingPath, inputPath] = process.argv.slice(2)
const input = JSON.parse(await readFile(inputPath!, 'utf8')) as BrowserTaskCreateInput
const disk = new BrowserTaskAssetFileStore(assetPath!)
const recorder = new BrowserDemonstrationRecorder(new BrowserDemonstrationFileStore(recordingPath!))
let reads = 0
const owner = new BrowserTaskAssets({ load: () => disk.load(), save: async document => {
  if (mode === 'fail-before') throw new Error('Private write unavailable')
  await disk.save(document)
  if (mode === 'fail-after') throw new Error('Private write acknowledgement unavailable')
} }, { id: () => { throw new Error('Original proposed asset identity must be retained') } })
try {
  if (mode === 'read-spatial') process.stdout.write(JSON.stringify(await new AgentMuxSpatialStateStore(assetPath!).read()))
  else if (mode === 'inspect') process.stdout.write(JSON.stringify(await owner.inspectCreation(input)))
  else {
    const asset = await owner.importRecording(input, async () => { reads++; return recorder.get(input.browserId) })
    if (mode !== 'commit-no-reply') process.stdout.write(JSON.stringify({ assetId: asset.id, count: (await owner.state(input.browserId)).assets.length, reads }))
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ code: (error as { code?: string }).code, count: (await owner.state(input.browserId)).assets.length, reads }))
}
