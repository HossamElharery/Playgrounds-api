const MAX_EVENT_NAME = 128;
const MAX_PACKET_ARGUMENTS = 2; // one payload plus an optional acknowledgement callback
const MAX_DEPTH = 8;
const MAX_NODES = 2_048;
const MAX_OBJECT_KEYS = 64;
const MAX_ARRAY_ITEMS = 4_096;
const MAX_STRING_LENGTH = 32 * 1024;
const MAX_BINARY_BYTES = 48 * 1024;
const EVENT_NAME = /^[a-z][a-zA-Z0-9_.:-]*$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const IDENTIFIER_KEY = /(?:^id$|Id$|Ids$|^code$)/;

interface Budget {
  nodes: number;
}

function validIdentifierField(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.length > 0 && value.length <= 128;
  return (
    Array.isArray(value) &&
    value.length <= 256 &&
    value.every(
      (item) =>
        typeof item === 'string' && item.length > 0 && item.length <= 128,
    )
  );
}

function validValue(value: unknown, depth: number, budget: Budget): boolean {
  budget.nodes++;
  if (budget.nodes > MAX_NODES || depth > MAX_DEPTH) return false;
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.length <= MAX_STRING_LENGTH;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  }
  if (typeof value === 'function') return true; // Socket.IO acknowledgement
  if (typeof value !== 'object') return false;

  if (Buffer.isBuffer(value)) return value.byteLength <= MAX_BINARY_BYTES;
  if (ArrayBuffer.isView(value)) return value.byteLength <= MAX_BINARY_BYTES;
  if (value instanceof ArrayBuffer) return value.byteLength <= MAX_BINARY_BYTES;

  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) return false;
    return value.every((item) => validValue(item, depth + 1, budget));
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_OBJECT_KEYS) return false;
  return entries.every(
    ([key, item]) =>
      key.length <= 128 &&
      !FORBIDDEN_KEYS.has(key) &&
      (!IDENTIFIER_KEY.test(key) || validIdentifierField(item)) &&
      validValue(item, depth + 1, budget),
  );
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key));
}

function validSessionDescription(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const description = value as Record<string, unknown>;
  return (
    hasOnlyKeys(description, ['type', 'sdp']) &&
    typeof description['type'] === 'string' &&
    description['type'].length <= 16 &&
    typeof description['sdp'] === 'string' &&
    description['sdp'].length <= MAX_STRING_LENGTH
  );
}

function validIceCandidate(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    hasOnlyKeys(candidate, [
      'candidate',
      'sdpMid',
      'sdpMLineIndex',
      'usernameFragment',
    ]) &&
    typeof candidate['candidate'] === 'string' &&
    candidate['candidate'].length <= 8_192 &&
    (candidate['sdpMid'] === null ||
      candidate['sdpMid'] === undefined ||
      (typeof candidate['sdpMid'] === 'string' &&
        candidate['sdpMid'].length <= 256)) &&
    (candidate['sdpMLineIndex'] === null ||
      candidate['sdpMLineIndex'] === undefined ||
      (typeof candidate['sdpMLineIndex'] === 'number' &&
        Number.isInteger(candidate['sdpMLineIndex']) &&
        candidate['sdpMLineIndex'] >= 0 &&
        candidate['sdpMLineIndex'] <= 65_535)) &&
    (candidate['usernameFragment'] === null ||
      candidate['usernameFragment'] === undefined ||
      (typeof candidate['usernameFragment'] === 'string' &&
        candidate['usernameFragment'].length <= 256))
  );
}

function validRealtimeSignal(event: string, payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return false;
  const body = payload as Record<string, unknown>;
  if (event === 'voice.offer' || event === 'voice.answer') {
    return (
      hasOnlyKeys(body, ['squadId', 'toUserId', 'sdp']) &&
      validSessionDescription(body['sdp'])
    );
  }
  if (event === 'call.offer' || event === 'call.answer') {
    return (
      hasOnlyKeys(body, ['callId', 'sdp']) &&
      validSessionDescription(body['sdp'])
    );
  }
  if (event === 'voice.ice') {
    return (
      hasOnlyKeys(body, ['squadId', 'toUserId', 'candidate']) &&
      validIceCandidate(body['candidate'])
    );
  }
  if (event === 'call.ice') {
    return (
      hasOnlyKeys(body, ['callId', 'candidate']) &&
      validIceCandidate(body['candidate'])
    );
  }
  return true;
}

/** Validate a decoded Socket.IO packet before any gateway handler sees it. */
export function validSocketPacket(packet: unknown[]): boolean {
  const [event, ...args] = packet;
  if (
    typeof event !== 'string' ||
    !event.length ||
    event.length > MAX_EVENT_NAME ||
    !EVENT_NAME.test(event) ||
    args.length > MAX_PACKET_ARGUMENTS
  ) {
    return false;
  }
  const payloads = args.filter((value) => typeof value !== 'function');
  if (payloads.length > 1) return false;
  const payload = payloads[0];
  if (!validValue(payload, 0, { nodes: 0 })) return false;
  return validRealtimeSignal(event, payload);
}
