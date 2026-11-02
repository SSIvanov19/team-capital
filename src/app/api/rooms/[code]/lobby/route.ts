import type { NextRequest } from 'next/server';
import { getLobby } from '@/lib/service';
import { handleRoute, jsonResponse } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, context: { params: Promise<{ code: string }> }) {
  return handleRoute(async () => jsonResponse(getLobby((await context.params).code)));
}
