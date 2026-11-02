import type { NextRequest } from 'next/server';
import { getState } from '@/lib/service';
import { authToken, baseUrl, handleRoute, HttpError, jsonResponse, roomCode } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  return handleRoute(async () => {
    const code = roomCode((await context.params).code);
    const view = request.nextUrl.searchParams.get('view') ?? 'player';
    if (view !== 'host' && view !== 'player' && view !== 'projector') throw new HttpError(400, 'invalid_view', 'Choose host, player or projector view.');
    const token = view === 'projector' ? request.nextUrl.searchParams.get('token') ?? undefined : authToken(request, code, view);
    return jsonResponse(getState(code, view, token, baseUrl(request)));
  });
}
