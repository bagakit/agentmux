import { mkdir, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { systemPreferences } from 'electron'
import { pastedDirectory } from './pasted-directory.js'

let captureOwner: { child?: ChildProcess } | null = null

function describe(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function captureFailure(reason: string): Error {
  let access: string
  try { access = systemPreferences.getMediaAccessStatus('screen') } catch { access = 'unknown (readout unavailable)' }
  return new Error(`${reason} Current screen access readout: ${access}; this does not establish the cause. Your draft and terminal remain available. Check the capture or save failure, then try again; if macOS requests permission, review Screen Recording for this running App in System Settings.`)
}

/** One system selection owner. Only child close is exit evidence; request settlement is not. */
export async function captureComposerScreenshot(home: string): Promise<string | null> {
  if (process.platform !== 'darwin') throw new Error('Screen selection is only available on macOS.')
  if (captureOwner) throw new Error('A screen capture is already in progress or its selector exit is not yet confirmed. Your draft and terminal remain available. Finish the existing selector, then try again.')
  const owner: { child?: ChildProcess } = {}
  captureOwner = owner
  const directory = pastedDirectory(home)
  const path = join(directory, `screen-${randomUUID()}.png`)
  try { await mkdir(directory, { recursive: true, mode: 0o700 }) } catch (error) {
    captureOwner = null
    throw new Error(`Could not create the screenshot save directory: ${describe(error)}. Your draft is kept; check the directory and try again.`)
  }
  let child: ChildProcess
  try { child = spawn('/usr/sbin/screencapture', ['-i', '-x', '-t', 'png', path], { stdio: ['ignore', 'ignore', 'pipe'] }) } catch (error) {
    captureOwner = null
    throw new Error(`Could not start the screen selector: ${describe(error)}. Your draft is kept; try again.`)
  }
  owner.child = child
  return await new Promise<string | null>((resolve, reject) => {
    let settled = false
    let closed = false
    let firstFailure: string | undefined
    let stderr = Buffer.alloc(0)
    let terminating = false
    let killTimer: NodeJS.Timeout | undefined
    let observationTimer: NodeJS.Timeout | undefined
    const fail = (reason: string) => {
      if (settled) return
      settled = true
      reject(captureFailure(reason))
    }
    const kill = (signal: NodeJS.Signals) => {
      try { child.kill(signal) } catch (error) {
        firstFailure ??= `The screen selector termination failed: ${describe(error)}.`
      }
    }
    const terminate = () => {
      if (terminating || closed) return
      terminating = true
      kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (closed) return
        kill('SIGKILL')
        observationTimer = setTimeout(() => {
          fail(`${firstFailure} Cannot confirm that the screen selector exited. Another capture will remain unavailable until its exit is observed.`)
        }, 1_000)
      }, 1_000)
    }
    const timeout = setTimeout(() => {
      firstFailure ??= 'The screen selector timed out.'
      terminate()
    }, 120_000)
    const onError = (error: Error) => {
      firstFailure ??= `The screen selector failed: ${describe(error)}.`
      terminate()
    }
    child.on('error', onError)
    child.stderr!.on('data', (chunk: Buffer | string) => {
      // Keep consuming stderr even after failure, but retain at most 16 KiB for this capture.
      if (firstFailure || stderr.length >= 16_384) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stderr = Buffer.concat([stderr, bytes.subarray(0, 16_384 - stderr.length)])
    })
    child.once('close', async (code, signal) => {
      closed = true
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      if (observationTimer) clearTimeout(observationTimer)
      try {
        let reason = firstFailure
        if (reason) reason += ` Actual close: code ${code}, signal ${signal}.`
        if (!reason && signal) reason = `The screen selector ended with signal ${signal}.`
        if (!reason && code === null) reason = 'The screen selector ended with no exit code.'
        if (!reason && code !== 0) reason = `The screen selector failed with exit code ${code}.`
        if (!reason) {
          try {
            const output = await stat(path)
            if (!output.isFile()) reason = 'The screenshot save did not produce a regular file.'
            else if (output.size === 0) reason = 'The screenshot save produced an empty image.'
          } catch (error) {
            reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'The screen selector produced no image. We cannot confirm whether selection was cancelled or capture failed.'
              : `Could not inspect the screenshot save: ${describe(error)}.`
          }
        }
        if (!reason) {
          if (!settled) { settled = true; resolve(path) }
          return
        }
        const detail = stderr.toString('utf8').trim()
        if (detail) reason += ` ${detail}`
        try { await rm(path, { force: true }) } catch (error) {
          reason += ` The partial screenshot could not be removed: ${describe(error)}.`
        }
        fail(reason)
      } finally {
        child.removeListener('error', onError)
        if (captureOwner === owner) captureOwner = null
      }
    })
  })
}
