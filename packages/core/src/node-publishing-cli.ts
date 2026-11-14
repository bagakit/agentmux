import { AgentMuxError } from './errors.js';
import { readControlJsonInput } from './cli-json-input.js';
import { NODE_PUBLISHING_METHODS, parseNodePublishingParams, type NodePublishingMethod } from './node-publishing.js';
import type { AgentMuxCliCommand } from './agentmux-cli-commands.js';
const summaries: Record<NodePublishingMethod, string> = {
    'settings.node.inspect': 'Read this original Core’s private Node policy and original save receipt.',
    'settings.node.configure': 'Compare and durably save this Core’s Node publication policy once.',
    'settings.node.resources': 'Read this owner’s actual resources and Core I/O operation counters independently of public sharing.',
    'node.inspect': 'Read exactly one Node’s published identity, roots and landing reference.',
    'node.resources': 'Read permitted OS, Core-process and I/O operation measurements, or explicit withheld.',
    'node.files.list': 'Read one continuing page inside an original published root.',
    'node.files.read': 'Read one bounded original file block as base64.',
    'node.resolve': 'Match a published Node locator or pin its original Runtime across rename.'
};
const inputs: Record<NodePublishingMethod, string> = {
    'settings.node.inspect': '{operationId?}', 'settings.node.configure': '{expectedRevision,operationId,policy:{alias,shareResources,allowedPaths,deniedPaths,defaultPath}}',
    'settings.node.resources': '{}', 'node.inspect': '{hostId,expectedRuntimeId?}', 'node.resources': '{hostId,expectedRuntimeId?}',
    'node.files.list': '{hostId,expectedRuntimeId?,root:{runtimeId,rootId,policyRevision},path,offset?,limit?,expectedRevision?}',
    'node.files.read': '{hostId,expectedRuntimeId?,root:{runtimeId,rootId,policyRevision},path,offset?,maxBytes?,expectedRevision?}',
    'node.resolve': '{hostId,expectedRuntimeId?,alias?}'
};
export const NODE_PUBLISHING_CLI_COMMANDS: readonly AgentMuxCliCommand[] = (Object.keys(NODE_PUBLISHING_METHODS) as NodePublishingMethod[]).map(method => {
    const route = method === 'node.inspect' || method === 'node.resources' || method === 'node.resolve';
    const optional = method === 'settings.node.inspect' || method === 'settings.node.resources';
    return { method, usage: route ? '[--host ID] [--expected-runtime ID]' + (method === 'node.resolve' ? ' [--alias LABEL]' : '') : optional ? '[--input <FILE|->]' : '--input <FILE|->', summary: summaries[method],
        flags: route ? { '--host': 'value', '--expected-runtime': 'value', ...(method === 'node.resolve' ? { '--alias': 'data' as const } : {}) } : { '--input': 'data' },
        details: `JSON input: ${inputs[method]}. Node publication is not an OS sandbox or owner grant. Paths are literal; published references contain no private absolute path. Keep the original root/policy/file revision when paging. After an unknown policy save inspect the same operationId; never replay it. Read amux node --skill.`,
        parse: async (args: readonly string[]) => {
            let value: unknown;
            if (route) {
                const result: Record<string, unknown> = { hostId: 'local' }, seen = new Set<string>();
                for (let i = 0; i < args.length; i += 2) {
                    const flag = args[i]!, v = args[i + 1];
                    if (seen.has(flag) || v === undefined || !['--host', '--expected-runtime', ...(method === 'node.resolve' ? ['--alias'] : [])].includes(flag))
                        throw new AgentMuxError('Use the exact registered Node options once with literal values.', 'INVALID_CLI_ARGUMENT');
                    seen.add(flag);
                    result[flag === '--host' ? 'hostId' : flag === '--alias' ? 'alias' : 'expectedRuntimeId'] = v;
                }
                value = result;
            }
            else if (!args.length && optional)
                value = {};
            else {
                if (args.length !== 2 || args[0] !== '--input')
                    throw new AgentMuxError('This Node command accepts exactly --input <FILE|->.', 'INVALID_CLI_ARGUMENT');
                value = await readControlJsonInput(args[1]!, 'Node publication');
            }
            return parseNodePublishingParams(method, value) as unknown as Record<string, unknown>;
        } };
});
