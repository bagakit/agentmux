import { AgentMuxError } from './errors.js';
import { rpcRecord } from './rpc-data.js';
/** IDs inside this reference retain the answering Core's namespace. Routes are client-local carriers. */
export type SpaceAuthorityRef = {
    runtimeId: string;
    spaceId: string;
};
export type SpaceAuthoritySource = {
    runtimeId: string;
    ownerInstanceId: string;
};
/** Same opaque identity contract as the original spatial graph; no new path-length/version gate. */
export function spaceIdentityString(value: unknown, label: string, code = 'INVALID_CONTROL_REQUEST'): string {
    if (typeof value !== 'string' || !value || value.includes('\0'))
        throw new AgentMuxError(`${label} requires its exact original identity.`, code);
    return value as string;
}
export function parseSpaceAuthorityRef(value: unknown, code = 'INVALID_CONTROL_REQUEST'): SpaceAuthorityRef {
    const p = rpcRecord(value, ['runtimeId', 'spaceId'], code);
    return { runtimeId: spaceIdentityString(p.runtimeId, 'Original Space Runtime', code), spaceId: spaceIdentityString(p.spaceId, 'Original Space', code) };
}
