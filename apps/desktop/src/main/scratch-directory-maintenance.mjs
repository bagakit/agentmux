import { migrateTopicDirectories as migrate } from '@agentmux/host/mote-resources'
import { resolve } from 'node:path'
export function migrateTopicDirectories(options = {}) { return migrate({ ...options, helperPath: options.helperPath ?? resolve(import.meta.dirname, '../../resources/bin/agentmux-workspace-move') }) }
