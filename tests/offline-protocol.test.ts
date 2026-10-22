import { describe, expect, it } from 'vitest';
import { parseOfflineNotification, parseOfflineReply, parseOfflineRequest } from '../src/offline/protocol';

const a = 'a'.repeat(64), b = 'b'.repeat(64);
const request = { protocol: 1, requestId: 'request-1', type: 'PIN', deploymentId: a, sessionId: 'session-1' };
const reply = { protocol: 1, requestId: 'request-1', ok: true,
  status: { current: a, preferred: b, ready: true, available: b } };
describe('offline cache protocol', () => {
  it('keeps the exact caller, deployment and request identity', () => {
    expect(parseOfflineRequest(request)).toEqual(request);
    expect(parseOfflineReply(reply, 'request-1')).toEqual(reply);
    expect(parseOfflineRequest({ ...request, type: 'PREPARE_NAVIGATION' })).toEqual({ ...request, type: 'PREPARE_NAVIGATION' });
  });
  it.each([
    { ...request, protocol: 2 }, { ...request, type: 'RELOAD_NOW' }, { ...request, requestId: '../request' },
    { ...request, deploymentId: 'A'.repeat(64) }, { ...request, sessionId: undefined },
    { ...request, clientId: 'payload-has-no-client-authority' }, { ...request, type: 'CANCEL_NAVIGATION', ticket: '../token' },
    { ...request, type: 'RECONCILE_REPLY' },
  ])('refuses malformed ownership and unsupported requests %j', value => {
    expect(() => parseOfflineRequest(value)).toThrow();
  });
  it.each([
    { ...reply, requestId: 'retired-request' }, { ...reply, protocol: 2 }, { ...reply, reload: true },
    { ...reply, status: { ...reply.status, current: null } },
    { ...reply, status: { ...reply.status, available: a } },
    { ...reply, status: { ...reply.status, preferred: '../cohort' } },
    { ...reply, ticket: 'url?query' }, { ...reply, status: { ...reply.status, ready: 1 } },
  ])('refuses a foreign or ambiguous acknowledgement %j', value => {
    expect(() => parseOfflineReply(value, 'request-1')).toThrow();
  });
  it('permits an unavailable admitted build and a bounded explicit refusal', () => {
    const unavailable = { ...reply, status: { current: a, preferred: b, available: b, ready: false, error: 'Not fully cached.' } };
    expect(parseOfflineReply(unavailable, 'request-1')).toEqual(unavailable);
    expect(parseOfflineReply({ protocol: 1, requestId: 'request-1', ok: false, error: 'Quota refused.' }, 'request-1').ok).toBe(false);
    expect(() => parseOfflineReply({ protocol: 1, requestId: 'request-1', ok: false, error: 'x'.repeat(4097) }, 'request-1')).toThrow();
  });
  it('notifications request status or reconciliation and cannot authorize navigation', () => {
    expect(parseOfflineNotification({ protocol: 1, type: 'CHANGED' })).toEqual({ protocol: 1, type: 'CHANGED' });
    expect(parseOfflineNotification({ protocol: 1, type: 'RECONCILE', round: 'round-1' })).toEqual({ protocol: 1, type: 'RECONCILE', round: 'round-1' });
    expect(parseOfflineNotification({ protocol: 1, type: 'CHANGED', reload: true })).toBeUndefined();
    expect(parseOfflineNotification({ protocol: 1, type: 'RECONCILE', deploymentId: b, round: 'round-1' })).toBeUndefined();
    expect(parseOfflineNotification({ protocol: 2, type: 'CHANGED' })).toBeUndefined();
  });
});
