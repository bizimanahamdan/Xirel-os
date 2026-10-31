/**
 * Connector factory (Phase 8): feature detection ONLY. A connector
 * exists when its credentials exist — nothing here fabricates clients,
 * and unimplemented kinds return undefined rather than a stub that
 * pretends. Missing env → the connector is honestly absent.
 */

import 'server-only';
import type { ConnectorStatus } from './types';

export type ConnectorKind =
  | 'github'
  | 'vercel'
  | 'supabase_management'
  | 'clips_forge'
  | 'object_storage'
  | 'browser_execution';

/** Env vars each connector kind REQUIRES to be considered configured. */
const REQUIRED_ENV: Record<ConnectorKind, string[]> = {
  github: ['GITHUB_TOKEN'],
  vercel: ['VERCEL_API_TOKEN'],
  supabase_management: ['SUPABASE_MANAGEMENT_API_KEY'],
  clips_forge: ['CLIPS_FORGE_API_URL', 'CLIPS_FORGE_API_KEY'],
  object_storage: [
    'STORAGE_ACCESS_KEY_ID',
    'STORAGE_SECRET_ACCESS_KEY',
    'STORAGE_BUCKET',
    'STORAGE_ENDPOINT',
  ],
  browser_execution: ['BROWSER_SERVICE_URL', 'BROWSER_SERVICE_TOKEN'],
};

export interface ConnectorAvailability extends ConnectorStatus {
  kind: ConnectorKind;
}

export function connectorAvailability(kind: ConnectorKind): ConnectorAvailability {
  const required = REQUIRED_ENV[kind];
  const missing = required.filter((key) => !process.env[key]);
  return {
    kind,
    configured: missing.length === 0,
    missing: missing.length > 0 ? missing : undefined,
  };
}

/**
 * Real connector constructors do NOT exist yet — every kind returns
 * undefined. This is the honest state: interfaces are shipped, clients
 * are not. When a connector is implemented, its constructor goes here
 * behind the availability check.
 */
export function getConnector(kind: ConnectorKind): undefined {
  // No connector implementations exist yet — returning undefined is the
  // truthful answer. Callers must handle absence explicitly.
  void kind;
  return undefined;
}

/** Registry view for the command center / diagnostics. */
export function listConnectorAvailability(): ConnectorAvailability[] {
  return (Object.keys(REQUIRED_ENV) as ConnectorKind[]).map((kind) =>
    connectorAvailability(kind),
  );
}
