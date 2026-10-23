import { normalizeDirectoryIdentity as normalize } from '@agentmux/host/mote-resources'
import { resolve } from 'node:path'
export * from '@agentmux/host/mote-resources'
export function normalizeDirectoryIdentity(directory, original, options = {}) { return normalize(directory, original, { ...options, helperPath: options.helperPath ?? resolve(import.meta.dirname, '../../resources/bin/agentmux-workspace-move') }) }
