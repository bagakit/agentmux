#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs'

const output = process.env.AGENTMUX_TEST_INPUT_WITNESS
if (!output || !process.stdin.isTTY) throw new Error('Private terminal witness needs its own PTY and output')
process.stdin.setRawMode(true)
let pending = Buffer.alloc(0)
process.stdin.on('data', chunk => {
  pending = Buffer.concat([pending, chunk])
  for (let boundary; (boundary = pending.indexOf(13)) >= 0;) {
    appendFileSync(output, JSON.stringify({ text: pending.subarray(0, boundary).toString('utf8') }) + '\n')
    pending = pending.subarray(boundary + 1)
  }
})
writeFileSync(output + '.ready', JSON.stringify({ pid: process.pid }))
