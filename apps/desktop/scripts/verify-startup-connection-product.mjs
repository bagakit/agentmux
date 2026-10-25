import { mkdir, mkdtemp } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureStartupProduct } from './fixtures/startup-agent-availability/capture.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const base = resolve(root, '.local/runtime-startup-host-progress/product')
await mkdir(base, { recursive: true })
const evidence = await mkdtemp(resolve(base, 'run-'))
console.log('startup-connection-evidence=' + relative(root, evidence))
const receipt = await captureStartupProduct({ root, evidence, connectionProgress: true })
console.log(JSON.stringify({ completed: receipt.completed, sourceIdentity: receipt.sourceIdentity,
  capture: relative(root, resolve(evidence, 'capture.json')), frames: receipt.frames.map(frame => frame.file) }))
