import type { NextRequest } from 'next/server';
import { createSession } from '@/lib/service';
import { assertSameOrigin, handleRoute, jsonResponse, rateLimit, readJson, setAuthCookie } from '@/lib/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    rateLimit(request, 'create', 12);
    const result = createSession(await readJson(request));
    const response = jsonResponse({ code: result.code, recoveryCode: result.recoveryCode, projectorToken: result.projectorToken }, 201);
    setAuthCookie(response, request, result.code, 'host', result.token, result.expiresAt);
    return response;
  });
}
