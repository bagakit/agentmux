import { expandCliOptionAssignments } from './cli-option-assignments.js'
import { AgentMuxError } from './errors.js';
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js';
import { parseSpaceAuthorityParams } from './space-authority.js';
import { readControlJsonInput } from './cli-json-input.js';
export const SPACE_AUTHORITY_CLI_COMMANDS: readonly AgentMuxCliCommand[] = (['space.snapshot', 'space.watch', 'space.sessions.watch', 'space.apply'] as const).map(method => ({
    method, usage: '--runtime ORIGINAL_RUNTIME --space ORIGINAL_SPACE' + (method === 'space.apply' ? ' --revision N --input FILE|-' : method === 'space.watch' ? ' [--after-runtime R --after-revision N]' : ''),
    summary: method === 'space.snapshot' ? 'Read one original authority-qualified Space, its members and exact Session references.' : method === 'space.watch' ? 'Follow this original Space without reading unrelated Spaces or terminal output.' : method === 'space.sessions.watch' ? 'Observe only this Space’s original Session metadata and process facts; no terminal or history preload.' : 'Apply exact source-Space entity changes at the original CAS revision; preserve unrelated Spaces.',
    flags: { '--runtime': 'data', '--space': 'data', ...(method === 'space.apply' ? { '--revision': 'value', '--input': 'data' } : method === 'space.watch' ? { '--after-runtime': 'data', '--after-revision': 'value' } : {}) } as NonNullable<AgentMuxCliCommand['flags']>,
    details: 'The selected RPC endpoint must own --runtime. Host aliases and a matching Space ID never substitute another authority. Snapshot scope is a read projection, not a whole graph. Changes use optional zones/tabs/regions upserts, an exact Space bindings list and explicit removal lists. Window layouts, focus, drafts and opaque client resources are excluded; existing names and Core-owned metadata retain their original mutation owners. Revision is the source graph CAS; unrelated edits can advance it. Watch opens a full scoped snapshot with explicit resnapshot gap, then coalesced ordered entity deltas; it is not an event history. Unknown/unavailable preserves the last confirmed view. Cancel releases only this reader; it does not stop Sessions, Runs or tools. Do not automatically repeat an unknown write.',
    parse: async (args) => {
      args = expandCliOptionAssignments(args)
        const flags = new Map<string, string>();
        const allowed = method === 'space.apply' ? ['--runtime', '--space', '--revision', '--input'] : method === 'space.watch' ? ['--runtime', '--space', '--after-runtime', '--after-revision'] : ['--runtime', '--space'];
        for (let i = 0; i < args.length; i += 2) {
            const flag = args[i]!, value = args[i + 1];
            if (!allowed.includes(flag) || flags.has(flag) || value === undefined)
                throw new AgentMuxError('Use the exact Space command flags once each; see --help.', 'INVALID_CLI_ARGUMENT');
            flags.set(flag, value);
        }
        const reference = { runtimeId: flags.get('--runtime'), spaceId: flags.get('--space') };
        return parseSpaceAuthorityParams(method === 'space.sessions.watch' ? 'space.snapshot' : method, method === 'space.apply' ? { reference, expectedRevision: Number(flags.get('--revision')), changes: await readControlJsonInput(flags.get('--input') ?? '', 'Space changes') }
            : method === 'space.watch' && (flags.has('--after-runtime') || flags.has('--after-revision')) ? { reference, after: { runtimeId: flags.get('--after-runtime'), revision: Number(flags.get('--after-revision')) } } : { reference }) as unknown as Record<string, unknown>;
    }
}));
