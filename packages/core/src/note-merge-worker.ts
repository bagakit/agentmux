import { parentPort, workerData } from 'node:worker_threads'
import { mergeNoteText } from './note-merge.js'
const { base, current, proposed } = workerData as { base: string; current: string; proposed: string }
parentPort!.postMessage(mergeNoteText(base, current, proposed))
