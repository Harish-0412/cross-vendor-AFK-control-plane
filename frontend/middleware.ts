import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const LEGACY_HOST = 'odysseus-control-center.vercel.app';
const CANONICAL_HOST = 'cross-vendor-afk-control-plane.vercel.app';

export function middleware(request: NextRequest) {
  // Keep one browser origin in production. The Control Plane authenticates
  // WebSocket upgrades by Origin, so serving the same build on an old alias
  // can otherwise leave the REST UI working while the live socket gets a 403.
  if (request.headers.get('host')?.split(':', 1)[0] === LEGACY_HOST) {
    const canonicalUrl = request.nextUrl.clone();
    canonicalUrl.protocol = 'https:';
    canonicalUrl.host = CANONICAL_HOST;
    return NextResponse.redirect(canonicalUrl, 308);
  }

  const { pathname } = request.nextUrl;

  // Exclude public paths and static assets
  if (
    pathname === '/' ||
    pathname === '/health' ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  // Check auth cookies (either auth_token set on login or refreshToken cookie from Control Plane)
  const isAuthenticated = request.cookies.has('auth_token') || request.cookies.has('refreshToken');

  // If going to an auth page but already authenticated, redirect to destination or dashboard
  if (pathname.startsWith('/login') || pathname.startsWith('/register') || pathname.startsWith('/mfa')) {
    if (isAuthenticated) {
      const redirectTarget = request.nextUrl.searchParams.get('redirect') || '/dashboard';
      return NextResponse.redirect(new URL(redirectTarget, request.url));
    }
    return NextResponse.next();
  }

  // If going to an app page but not authenticated, redirect to login preserving destination
  if (!isAuthenticated) {
    const loginUrl = new URL('/login', request.url);
    const target = pathname + (request.nextUrl.search || '');
    loginUrl.searchParams.set('redirect', target);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
