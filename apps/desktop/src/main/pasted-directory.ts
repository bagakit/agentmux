import { join } from 'node:path'

/**
 * The one directory pasted and captured images live in.
 *
 * It sits OUTSIDE any workspace (`<home>/.agentmux/pasted`) on purpose: a CLI Agent reads a pasted
 * image from disk, so the paste becomes a file, and the app owns that file rather than any repo. Three
 * call sites depend on this exact path — the paste write (`ipc.ts`), the screenshot write
 * (`composer-screenshot.ts`), and the image read (the read IPC). They MUST agree: the read's trust
 * boundary is precisely the write sites' target, so a second hand-copied `join(home, '.agentmux',
 * 'pasted')` would let the targets drift silently, and the drift shows up only as "the screenshot
 * shows but the paste does not" — a defect that appears in half the cases. One derivation, no copies.
 */
export function pastedDirectory(home: string): string {
  return join(home, '.agentmux', 'pasted')
}
