import { fstatSync, ftruncateSync, readSync, writeSync } from 'node:fs'

/** Above this size at startup the Host's output file is cut back to its most recent part. */
export const HOST_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024
/** How much of the previous output survives the cut: the last runs, including why the last Host stopped. */
export const HOST_OUTPUT_KEPT_BYTES = 512 * 1024

/**
 * launchd appends the Host's stdout and stderr to one file and never rotates it, so warnings and
 * crash loops grow it for the life of the install. At startup, keep only the newest `keep` bytes
 * (from a line start) of an inherited output file larger than `limit`.
 *
 * It works on the inherited descriptors, not a path: whatever file the service manager attached is
 * the one bounded, and a pipe or terminal is left alone. launchd opens the file for reading and
 * appending, so the tail is read first, and after the truncate the tail and every later write land
 * at the new end. A descriptor that cannot be read leaves its file as it is.
 */
export function boundInheritedOutput(fds: readonly number[] = [1, 2], limit = HOST_OUTPUT_LIMIT_BYTES, keep = HOST_OUTPUT_KEPT_BYTES): void {
  for (const fd of fds) {
    try {
      // stdout and stderr usually share one file; once cut, the second sees it within the limit.
      const file = fstatSync(fd)
      if (!file.isFile() || file.size <= limit) continue
      const tail = Buffer.alloc(Math.min(keep, file.size))
      const read = readSync(fd, tail, 0, tail.length, file.size - tail.length)
      const lineStart = tail.subarray(0, read).indexOf(0x0a) + 1
      ftruncateSync(fd, 0)
      writeSync(fd, tail.subarray(lineStart, read))
    } catch {
      // Diagnostic retention never stops the Host from starting.
    }
  }
}
