import { getDatabase } from '@/lib/db';
import { jsonResponse } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try { getDatabase().prepare('SELECT 1').get(); return jsonResponse({ status: 'ok' }); }
  catch { return jsonResponse({ status: 'unavailable' }, 503); }
}
