import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Admin-gated server for the INTERNAL OpenAPI specs. The specs live outside
// /public (in web/openapi-internal) so they are never statically downloadable.
// A caller must present an admin Bearer token, which we validate against
// auth-service /auth/me before returning the spec.
//
// next.config bundles ./openapi-internal/** into the standalone output for this
// route via outputFileTracingIncludes.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_HOST = process.env.NEXT_PUBLIC_API_URL || 'https://api.verivyx.com';

// Whitelist of servable internal specs (no path traversal).
const SPECS: Record<string, string> = {
  internal: 'internal.yaml',
  wordpress: 'wordpress-plugin.yaml',
};

async function isAdmin(authHeader: string | null): Promise<boolean> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  try {
    const r = await fetch(`${API_HOST}/api/v1/auth/me`, {
      headers: { Authorization: authHeader },
      cache: 'no-store',
    });
    if (!r.ok) return false;
    const data = (await r.json()) as { user?: { role?: string } };
    return data.user?.role === 'ADMIN';
  } catch {
    return false;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const file = SPECS[name];
  if (!file) {
    return NextResponse.json({ error: 'unknown_spec' }, { status: 404 });
  }
  if (!(await isAdmin(req.headers.get('authorization')))) {
    return NextResponse.json({ error: 'admin_required' }, { status: 401 });
  }
  try {
    const yaml = await readFile(path.join(process.cwd(), 'openapi-internal', file), 'utf8');
    return new NextResponse(yaml, {
      headers: {
        'content-type': 'application/yaml; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
      },
    });
  } catch {
    return NextResponse.json({ error: 'spec_unavailable' }, { status: 500 });
  }
}
