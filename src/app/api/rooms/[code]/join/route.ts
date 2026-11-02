import type { NextRequest } from 'next/server';
import { joinSession } from '@/lib/service';
import { assertSameOrigin, authToken, handleRoute, jsonResponse, rateLimit, readJson, roomCode, setAuthCookie } from '@/lib/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    rateLimit(request, 'join', 120);
    const code = roomCode((await context.params).code);
    const result = joinSession(code, await readJson(request), authToken(request, code, 'player'));
    const response = jsonResponse({ playerId: result.playerId }, 201);
    setAuthCookie(response, request, code, 'player', result.token, result.expiresAt);
    return response;
  });
}
