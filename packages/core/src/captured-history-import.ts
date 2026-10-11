import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { constants, createReadStream } from 'node:fs';
import { copyFile, open, stat } from 'node:fs/promises';
import parser from 'stream-json/parser.js';
import Assembler from 'stream-json/assembler.js';
import type { Token } from 'stream-json/parser.js';
import { AgentMuxError } from './errors.js';
import { normalizeAgentTimelineItem, normalizeAgentTimelineMutation } from './session-timeline.js';
import type { AgentTimelineItem, AgentTimelineMutation } from './types.js';
export type CapturedImportUnit = {
  kind: 'item';
  item: AgentTimelineItem;
} | {
  kind: 'snapshot';
  revision: number;
} | {
  kind: 'mutation';
  mutation: AgentTimelineMutation;
};
export async function capturedFileWitness(path: string): Promise<string | null> {
  try {
    const s = await stat(path, { bigint: true });
    if (!s.isFile())
      throw new AgentMuxError('Captured source is not a file.', 'INVALID_AGENT_TIMELINE_STORE');
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return null;
    throw error;
  }
}
/** One physical handover of the original JSONL. Bounded tokens/items/batches, never a full-file string. */
export async function importCapturedFile(path: string, id: string, consume: (batch: readonly CapturedImportUnit[]) => Promise<void>, signal?: AbortSignal): Promise<{
  gaps: Array<{
    code: string;
    message: string;
  }>;
  sha256: string;
}> {
  const source = createReadStream(path, { highWaterMark: 64 * 1024, ...(signal ? { signal } : {}) });
  const tokens = source.pipe(parser.asStream({ jsonStreaming: true, streamKeys: false, streamStrings: false, streamNumbers: false }));
  // A source read error must close the token iterator, and vice versa.
  source.on('error', error => tokens.destroy(error));
  let root = new Assembler<Record<string, unknown>>(), item: Assembler | undefined, depth = 0, roots = 0, inItems = false, key = '', hadItems = false, snapshotComplete = false;
  let batch: CapturedImportUnit[] = [];
  const gaps: Array<{
    code: string;
    message: string;
  }> = [];
  const flush = async () => { if (batch.length) {
    const pending = batch;
    batch = [];
    await consume(pending);
  } };
  const emit = async (unit: CapturedImportUnit) => { batch.push(unit); if (batch.length >= 32)
    await flush(); };
  try {
    for await (const raw of tokens) {
      signal?.throwIfAborted();
      const token = raw as Token, before = depth;
      if (token.name === 'startObject' || token.name === 'startArray')
        depth++;
      if (token.name === 'endObject' || token.name === 'endArray')
        depth--;
      if (roots === 0 && inItems) {
        if (before === 2 && token.name === 'endArray') {
          inItems = false;
          root.consume(token);
          continue;
        }
        if (!item)
          item = new Assembler();
        item.consume(token);
        if (item.done) {
          const value = normalizeAgentTimelineItem(item.current);
          if (value.agentSessionId !== id)
            throw new AgentMuxError('Captured item belongs to another Session.', 'INVALID_AGENT_TIMELINE_STORE');
          await emit({ kind: 'item', item: value });
          item = undefined;
        }
        continue;
      }
      if (roots === 0 && before === 1 && token.name === 'keyValue')
        key = token.value;
      if (roots === 0 && before === 1 && token.name === 'startArray' && key === 'items') {
        inItems = true;
        hadItems = true;
        root.consume(token);
        continue;
      }
      root.consume(token);
      if (depth === 0 && root.done) {
        const value = root.current!;
        if (roots === 0) {
          if (value.version !== 3 || value.agentSessionId !== id || !hadItems || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0)
            throw new AgentMuxError('Original captured snapshot is invalid.', 'INVALID_AGENT_TIMELINE_STORE');
          await emit({ kind: 'snapshot', revision: value.revision as number });
          snapshotComplete = true;
        }
        else {
          const mutation = normalizeAgentTimelineMutation(value);
          if (mutation.agentSessionId !== id)
            throw new AgentMuxError('Captured mutation belongs to another Session.', 'INVALID_AGENT_TIMELINE_STORE');
          await emit({ kind: 'mutation', mutation });
        }
        roots++;
        root = new Assembler<Record<string, unknown>>();
      }
    }
    if (!snapshotComplete)
      throw new AgentMuxError('Original captured snapshot is incomplete; its bytes remain preserved.', 'INVALID_AGENT_TIMELINE_STORE');
  }
  catch (error) {
    if (signal?.aborted)
      throw signal.reason;
    if (!snapshotComplete)
      throw error;
    // Preserve the valid prefix. Neither a torn tail nor a damaged later range is silently skipped.
    gaps.push({ code: 'CAPTURED_ORIGINAL_RANGE_UNREAD', message: `Original JSONL stops after ${roots} complete records: ${error instanceof Error ? error.message : String(error)}. Its complete original bytes are retained for repair.` });
  }
  finally {
    source.destroy();
    tokens.destroy();
  }
  await flush();
  // The complete original archive, not the parsed prefix hash, identifies damaged suffixes too.
  const all = createHash('sha256');
  for await (const bytes of createReadStream(path, { highWaterMark: 64 * 1024, ...(signal ? { signal } : {}) }))
    all.update(bytes);
  return { gaps, sha256: all.digest('hex') };
}
export async function archiveCapturedOriginal(path: string, sha256: string): Promise<string> {
  const archive = `${path}.original-${sha256}`;
  try {
    await copyFile(path, archive, constants.COPYFILE_EXCL);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw error;
  }
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(archive))
    digest.update(bytes);
  if (digest.digest('hex') !== sha256)
    throw new AgentMuxError('Original captured archive identity is unconfirmed.', 'AGENT_SESSION_HISTORY_CAPTURE_UNCONFIRMED');
  const handle = await open(archive, 'r');
  try {
    await handle.sync();
  }
  finally {
    await handle.close();
  }
  const directory = await open(dirname(archive), 'r');
  try {
    await directory.sync();
  }
  finally {
    await directory.close();
  }
  return archive;
}
