// Copyright (c) 2025-present Mohamed Boudra. Apache-2.0.
// Vendored from Paseo 3c6e4e39ec57fc1ecec35cd848ba259893d5e298; see LICENSE and NOTICE.
/**
 * Relay connection types and interfaces.
 *
 * The relay bridges two WebSocket connections:
 * - Server (daemon): The Paseo server connecting to the relay
 * - Client (app): The mobile/web app connecting to the relay
 *
 * Messages are forwarded bidirectionally without modification.
 */

export type ConnectionRole = "server" | "client";

export interface RelaySessionAttachment {
  serverId: string;
  role: ConnectionRole;
  /**
   * Relay protocol version carried by this socket.
   * v1: single server/client socket pair
   * v2: control + per-client data sockets
   */
  version?: "1" | "2";
  /**
   * Unique id for the connection. Allows the daemon to create an
   * independent socket + E2EE channel per connected connection.
   */
  connectionId?: string | null;
  createdAt: number;
}
