/** Generic application-cache protocol. It is independent of native document messages. */
export const OFFLINE_PROTOCOL = 1 as const;
export const UPDATE_QUERY = '__splatview_update';
export const OFFLINE_REQUEST_TIMEOUT_MS = 60_000;
const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
export type OfflineRequestType = 'PIN' | 'STATUS' | 'CHECK_UPDATE' | 'PREPARE_NAVIGATION' | 'CANCEL_NAVIGATION' | 'RECONCILE_REPLY';
export interface OfflineRequest {
  protocol: 1; requestId: string; type: OfflineRequestType;
  deploymentId?: string; sessionId?: string; ticket?: string; round?: string;
}
export interface OfflineStatus {
  current: string | null; preferred: string | null; ready: boolean; available: string | null; error?: string;
}
export type OfflineReply = { protocol: 1; requestId: string; ok: true; status: OfflineStatus; ticket?: string }
  | { protocol: 1; requestId: string; ok: false; error: string };
export type OfflineNotification = { protocol: 1; type: 'RECONCILE'; round: string } | { protocol: 1; type: 'CHANGED' };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid offline-cache message.');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unexpected offline-cache message field.');
}
export function isDeploymentId(value: unknown): value is string { return typeof value === 'string' && HASH.test(value); }
export function isOfflineToken(value: unknown): value is string { return typeof value === 'string' && TOKEN.test(value); }
export function parseOfflineRequest(value: unknown): OfflineRequest {
  const message = object(value);
  keys(message, ['protocol', 'requestId', 'type', 'deploymentId', 'sessionId', 'ticket', 'round']);
  if (message.protocol !== OFFLINE_PROTOCOL || !isOfflineToken(message.requestId) ||
      !['PIN', 'STATUS', 'CHECK_UPDATE', 'PREPARE_NAVIGATION', 'CANCEL_NAVIGATION', 'RECONCILE_REPLY'].includes(String(message.type)))
    throw new Error('Unsupported offline-cache request.');
  for (const key of ['sessionId', 'ticket', 'round']) if (message[key] !== undefined && !isOfflineToken(message[key]))
    throw new Error('Invalid offline-cache owner.');
  if (message.deploymentId !== undefined && !isDeploymentId(message.deploymentId)) throw new Error('Invalid offline deployment identity.');
  if (['PIN', 'PREPARE_NAVIGATION', 'RECONCILE_REPLY'].includes(String(message.type)) &&
      (!isDeploymentId(message.deploymentId) || !isOfflineToken(message.sessionId))) throw new Error('Missing offline-cache owner.');
  if (message.type === 'CANCEL_NAVIGATION' && !isOfflineToken(message.ticket)) throw new Error('Missing offline navigation ticket.');
  if (message.type === 'RECONCILE_REPLY' && !isOfflineToken(message.round)) throw new Error('Missing offline reconciliation round.');
  return message as unknown as OfflineRequest;
}
export function parseOfflineReply(value: unknown, requestId: string): OfflineReply {
  const message = object(value);
  if (message.protocol !== OFFLINE_PROTOCOL || message.requestId !== requestId || typeof message.ok !== 'boolean')
    throw new Error('The offline-cache acknowledgement does not match this request.');
  if (!message.ok) {
    keys(message, ['protocol', 'requestId', 'ok', 'error']);
    if (typeof message.error !== 'string' || !message.error || message.error.length > 4096) throw new Error('Invalid offline-cache refusal.');
  } else {
    keys(message, ['protocol', 'requestId', 'ok', 'status', 'ticket']);
    const status = object(message.status);
    keys(status, ['current', 'preferred', 'ready', 'available', 'error']);
    for (const key of ['current', 'preferred', 'available']) if (status[key] !== null && !isDeploymentId(status[key]))
      throw new Error('Invalid acknowledged offline deployment.');
    if (typeof status.ready !== 'boolean' || status.ready && status.current === null ||
        status.available !== null && status.available === status.current ||
        status.error !== undefined && (typeof status.error !== 'string' || status.error.length > 4096) ||
        message.ticket !== undefined && !isOfflineToken(message.ticket)) throw new Error('Invalid offline-cache status.');
  }
  return message as unknown as OfflineReply;
}
export function parseOfflineNotification(value: unknown): OfflineNotification | undefined {
  try {
    const message = object(value);
    if (message.protocol !== OFFLINE_PROTOCOL) return;
    if (message.type === 'CHANGED') { keys(message, ['protocol', 'type']); return message as OfflineNotification; }
    if (message.type === 'RECONCILE' && isOfflineToken(message.round)) {
      keys(message, ['protocol', 'type', 'round']); return message as unknown as OfflineNotification;
    }
  } catch { /* An unrelated service-worker message has no authority over the app. */ }
}
