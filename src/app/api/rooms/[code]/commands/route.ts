import type { NextRequest } from 'next/server';
import { executeCommand } from '@/lib/service';
import { assertSameOrigin, authToken, baseUrl, clearAuthCookie, handleRoute, HttpError, jsonResponse, readJson, roomCode } from '@/lib/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    const code = roomCode((await context.params).code);
    const view = request.nextUrl.searchParams.get('view') ?? 'player';
    if (view !== 'host' && view !== 'player') throw new HttpError(403, 'read_only_view', 'Projector access is read-only.');
    const result = executeCommand(code, view, authToken(request, code, view), await readJson(request), baseUrl(request));
    const response = jsonResponse(result);
    if ('left' in result) clearAuthCookie(response, request, code, 'player');
    return response;
  });
}
