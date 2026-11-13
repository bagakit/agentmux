import { parseFileReadResult, type AgentMuxRpcFilesOwner, type FileDocument, type FileReadResult } from '@agentmux/core/files'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { MOTE_QUICK_MODE_PATH, parseMoteQuickMode, type MoteQuickDefaults, type MoteQuickMode } from './mote-quick-mode.js'

/** The one Host read of the original MOTE.md. The Files owner's ENOENT confirms nothing was saved yet;
 * any other result that is not a text read stays unconfirmed. A saved version is the original Files revision. */
export async function readMoteQuickModeSource(files: Pick<AgentMuxRpcFilesOwner, 'read'>, target: MotePreferencesTarget):
  Promise<{ source: FileReadResult; document: FileDocument | null; mode: MoteQuickMode }> {
  const input = { ...target, path: MOTE_QUICK_MODE_PATH }, source = parseFileReadResult(await files.read(input), input), { resource, result } = source
  if (resource && result.status === 'deleted') return { source, document: null, mode: { status: 'missing' } }
  if (!resource || result.status !== 'read') return { source, document: null, mode: { status: 'unconfirmed',
    message: `MOTE.md could not be read. Inspect the file; its saved settings are kept. ${'message' in result ? result.message : 'It is not a text file.'}` } }
  const parsed = parseMoteQuickMode(result.document.content)
  return { source, document: result.document, mode: parsed.status === 'valid' ? { status: 'saved', defaults: parsed.defaults, version: result.document.revision } : parsed }
}

/** A confirmed absent MOTE.md holds the default settings: no current Main and the default presence. */
export function moteQuickModeDefaults(mode: MoteQuickMode): MoteQuickDefaults {
  switch (mode.status) {
    case 'saved': return mode.defaults
    case 'missing': return {}
    case 'unconfirmed': throw new Error(mode.message)
    default: return mode satisfies never
  }
}
