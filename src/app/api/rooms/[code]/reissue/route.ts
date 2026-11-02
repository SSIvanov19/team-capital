import type { NextRequest } from 'next/server';
import { reissuePlayer } from '@/lib/service';
import { assertSameOrigin, authToken, handleRoute, jsonResponse, rateLimit, readJson, roomCode } from '@/lib/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, context: { params: Promise<{ code: string }> }) {
  return handleRoute(async () => {
    assertSameOrigin(request);
    rateLimit(request, 'reissue', 120);
    const code = roomCode((await context.params).code);
    return jsonResponse(reissuePlayer(code, authToken(request, code, 'host'), await readJson(request)));
  });
}
