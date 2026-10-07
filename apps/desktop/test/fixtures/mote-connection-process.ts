import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { moteConnectionOwner } from './mote-connection-owner.js'
const root = process.argv[2]!,
  mode = process.argv[3]
const owner = await moteConnectionOwner(root, {
  generic: true,
  ...(mode === 'lose-ack'
    ? {
        afterFileWrite: async () => {
          process.send?.({ kind: 'file-published' })
          await new Promise(() => {})
        }
      }
    : {})
})
await writeFile(join(root, 'request.json'), JSON.stringify(await owner.input()))
process.send?.({ kind: 'ready' })
