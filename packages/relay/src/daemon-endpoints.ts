// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0.
// Adapted from Paseo 3c6e4e39ec57fc1ecec35cd848ba259893d5e298: local imports and AgentMux RPC metadata.
export interface HostPortParts {
  host: string;
  port: number;
  isIpv6: boolean;
}

export type RelayRole = "server" | "client";

function parsePort(portStr: string, context: string): number {
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${context}: port must be between 1 and 65535`);
  }
  return port;
}

export function parseHostPort(input: string): HostPortParts {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Host is required");
  }

  // IPv6: [::1]:6767
  if (trimmed.startsWith("[")) {
    const match = trimmed.match(/^\[([^\]]+)\]:(\d{1,5})$/);
    if (!match) {
      throw new Error("Invalid host:port (expected [::1]:6767)");
    }
    const host = match[1].trim();
    if (!host) throw new Error("Host is required");
    const port = parsePort(match[2], "Invalid host:port");
    return { host, port, isIpv6: true };
  }

  const match = trimmed.match(/^(.+):(\d{1,5})$/);
  if (!match) {
    throw new Error("Invalid host:port (expected localhost:6767)");
  }
  const host = match[1].trim();
  if (!host) throw new Error("Host is required");
  const port = parsePort(match[2], "Invalid host:port");
  return { host, port, isIpv6: false };
}

export function buildRelayWebSocketUrl(params: {
  endpoint: string;
  useTls: boolean;
  serverId: string;
  role: RelayRole;
  /**
   * Per-connection routing identifier used by the daemon to open server data sockets.
   * Clients should NOT provide this — the relay assigns a routing ID on connect.
   */
  connectionId?: string;
  version?: "2" | 2;
}): string {
  const { host, port, isIpv6 } = parseHostPort(params.endpoint);
  const protocol = params.useTls ? "wss" : "ws";
  const hostPart = isIpv6 ? `[${host}]` : host;
  const url = new URL(`${protocol}://${hostPart}:${port}/ws`);
  url.searchParams.set("serverId", params.serverId);
  url.searchParams.set("role", params.role);
  url.searchParams.set("v", "2");
  if (params.connectionId) {
    url.searchParams.set("connectionId", params.connectionId);
  }
  return url.toString();
}

