import { readFile } from 'node:fs/promises'
import { BrowserTaskAssets, BrowserTaskAssetFileStore } from '../../src/main/browser-task-assets.js'
import type { BrowserTaskImportInput } from '@agentmux/core/control'

const [mode, assetPath, inputPath] = process.argv.slice(2)
const input = JSON.parse(await readFile(inputPath!, 'utf8')) as BrowserTaskImportInput
const assets = new BrowserTaskAssets(new BrowserTaskAssetFileStore(assetPath!))
if (mode === 'inspect') process.stdout.write(JSON.stringify(await assets.inspectPortableImport(input)))
else {
  const asset = await assets.importPortable(input)
  process.stdout.write(JSON.stringify({ id: asset.id, creation: asset.creation, draft: asset.draft, count: (await assets.state()).assets.length }))
}
