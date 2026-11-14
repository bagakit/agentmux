// A private OS descriptor owner for read-only Provider qualification tests.
// This is not an Agent CLI, model, Runtime or semantic Core owner.
import { open } from 'node:fs/promises'
const paths = process.argv.slice(2).filter(value => value !== '--read-only')
const files = await Promise.all(paths.map(path => open(path, process.argv.includes('--read-only') ? 'r' : 'a')))
process.stdout.write(JSON.stringify({ pid: process.pid, ready: true }) + '\n')
process.stdin.resume()
process.stdin.once('end', async () => { await Promise.all(files.map(file => file.close())); process.exit(0) })
