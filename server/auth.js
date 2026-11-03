// auth.js: the engine API's login. The engine token IS the user's Cyber
// Supplies user token (usr_…), set once with PUT /api/settings (the setup).
// After that every request must carry it as `Authorization: Bearer <token>`;
// anything else gets 401. Before setup, every request gets 401 with
// `setupRequired: true`, except the setup call itself (see index.js).
//
// Rules:
//  - only the Authorization header counts (never a query string or body);
//  - tokens are compared as SHA-256 digests with timingSafeEqual, so the
//    time an answer takes says nothing about how close a guess was;
//  - the token is never logged or echoed back.

import { createHash, timingSafeEqual } from 'node:crypto';

const MAX_TOKEN = 4096;

// bearerToken returns the token from an Authorization header, or null.
// The scheme is case-insensitive (RFC 9110); the token is visible ASCII.
export function bearerToken(header) {
  if (typeof header !== 'string' || header.length > MAX_TOKEN + 16) return null;
  const m = header.match(/^Bearer +([\x21-\x7e]+) *$/i);
  return m ? m[1] : null;
}

const digest = (value) => createHash('sha256').update(value, 'utf8').digest();

// sameToken: true only when both are non-empty strings and equal.
export function sameToken(sent, stored) {
  if (typeof sent !== 'string' || typeof stored !== 'string' || !sent || !stored) return false;
  return timingSafeEqual(digest(sent), digest(stored));
}

export const UNAUTHORIZED = {
  setup: { error: 'The engine is not set up yet: set your Cyber Supplies user token first (PUT /api/settings {"token": "usr_…"})', setupRequired: true },
  token: { error: 'Missing or wrong engine token: send Authorization: Bearer <your Cyber Supplies user token>', setupRequired: false },
};

export const tooManyMessage = (seconds) => `Too many wrong engine tokens: the engine refuses requests for ${seconds} more second${seconds === 1 ? '' : 's'}`;

// AuthLimiter: after `max` wrong tokens within `windowMs`, every request
// (except /api/health) gets 429 for `lockMs`, the right token included: if
// the right token still worked during a lockout, an attacker could keep
// guessing and tell a hit (200) from a miss (429), which would make the
// lockout useless. Only requests that PRESENT a token count (a wrong Bearer
// header, a refused setup); a missing header is not a guess. In memory: a
// restart clears it.
export class AuthLimiter {
  constructor({ max = 10, windowMs = 60_000, lockMs = 60_000, now = Date.now } = {}) {
    Object.assign(this, { max, windowMs, lockMs, now });
    this.failures = [];
    this.lockedUntil = 0;
  }

  // lockedFor: ms left in the current lockout (0 = not locked).
  lockedFor() {
    return Math.max(0, this.lockedUntil - this.now());
  }

  // fail records one wrong token; returns true when it starts a lockout.
  fail() {
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < this.windowMs);
    this.failures.push(t);
    if (this.failures.length < this.max) return false;
    this.failures = [];
    this.lockedUntil = t + this.lockMs;
    return true;
  }
}

// A queue so settings changes (and the first setup) happen one at a time:
// two setups racing each other cannot both win.
let queue = Promise.resolve();
export function oneAtATime(fn) {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}
