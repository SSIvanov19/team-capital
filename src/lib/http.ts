import { NextRequest, NextResponse } from 'next/server';
import { cookieName, type AuthKind } from './auth';

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

const MAX_BODY_BYTES = 16 * 1024;
const buckets = new Map<string, { count: number; until: number }>();

export function rateLimit(request: Request, operation: string, limit: number, windowMs = 60_000): void {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'local';
  const key = `${operation}:${ip}`;
  const now = Date.now();
  const previous = buckets.get(key);
  if (!previous || previous.until <= now) buckets.set(key, { count: 1, until: now + windowMs });
  else {
    previous.count += 1;
    if (previous.count > limit) throw new HttpError(429, 'rate_limited', 'Too many attempts. Please wait a minute and try again.');
  }
  if (buckets.size > 2000) for (const [entry, bucket] of buckets) if (bucket.until <= now) buckets.delete(entry);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (declaredLength > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'This request is too large.');
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new HttpError(415, 'unsupported_content_type', 'Send a JSON request.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'invalid_json', 'A JSON request body is required.');
  const parts: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw new HttpError(413, 'payload_too_large', 'This request is too large.'); }
    parts.push(part.value);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new HttpError(400, 'invalid_json', 'The request must contain a JSON object.'); }
}

export function requestOrigin(request: Request): string {
  if (process.env.APP_URL) return new URL(process.env.APP_URL).origin;
  const url = new URL(request.url);
  // Next may use its bind address in request.url; Host retains the browser's address.
  const host = request.headers.get('host');
  return host ? new URL(`${url.protocol}//${host}`).origin : url.origin;
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  const allowedOrigin = requestOrigin(request);
  if (origin && origin !== allowedOrigin) throw new HttpError(403, 'cross_origin_request', 'This action must be sent from the game website.');
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'cross_origin_request', 'This action must be sent from the game website.');
}

export function roomCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) throw new HttpError(404, 'room_not_found', 'This room code was not found.');
  return code;
}

export function authToken(request: NextRequest, code: string, kind: AuthKind): string | undefined {
  return request.cookies.get(cookieName(code, kind))?.value;
}

export function jsonResponse(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export function setAuthCookie(response: NextResponse, request: Request, code: string, kind: AuthKind, token: string, expiresAt: number): void {
  response.cookies.set(cookieName(code, kind), token, {
    httpOnly: true, sameSite: 'lax', secure: new URL(requestOrigin(request)).protocol === 'https:',
    path: `/api/rooms/${code}`, expires: new Date(expiresAt),
  });
}

export function clearAuthCookie(response: NextResponse, request: Request, code: string, kind: AuthKind): void {
  response.cookies.set(cookieName(code, kind), '', {
    httpOnly: true, sameSite: 'lax', secure: new URL(requestOrigin(request)).protocol === 'https:',
    path: `/api/rooms/${code}`, expires: new Date(0), maxAge: 0,
  });
}

export function baseUrl(request: Request): string {
  return requestOrigin(request);
}

export async function handleRoute(fn: () => Promise<NextResponse> | NextResponse): Promise<NextResponse> {
  try { return await fn(); }
  catch (error) {
    if (error instanceof HttpError) return jsonResponse({ error: error.code, message: error.message }, error.status);
    if (error && typeof error === 'object' && 'code' in error && 'message' in error && 'status' in error) {
      const known = error as { code: string; message: string; status: number };
      if (Number.isInteger(known.status) && known.status >= 400 && known.status < 500) return jsonResponse({ error: known.code, message: known.message }, known.status);
    }
    console.error('Game request failed', error instanceof Error ? error.name : 'Unknown error');
    return jsonResponse({ error: 'internal_error', message: 'The game could not complete that action. Please try again.' }, 500);
  }
}
