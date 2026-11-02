import type { NextRequest } from 'next/server';
import { recoverSession } from '@/lib/service';
import { assertSameOrigin, handleRoute, jsonResponse, rateLimit, readJson, roomCode, setAuthCookie } from '@/lib/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    rateLimit(request, 'recover', 60);
    const code = roomCode((await context.params).code);
    const result = recoverSession(code, await readJson(request));
    const response = jsonResponse({ ok: true });
    setAuthCookie(response, request, code, result.kind, result.token, result.expiresAt);
    return response;
  });
}
