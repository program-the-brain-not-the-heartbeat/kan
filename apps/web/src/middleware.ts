import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

function normalizeUploadsPath(pathname: string | undefined) {
  const trimmed = (pathname ?? "").trim();
  const value = trimmed.length > 0 ? trimmed : "/uploads";

  if (value === "/") {
    return null;
  }

  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

export function middleware(request: NextRequest) {
  // Middleware runs in the Edge runtime; avoid packages that rely on Node APIs.
  const uploadsPath = normalizeUploadsPath(
    process.env.NEXT_PUBLIC_UPLOADS_PATH,
  );
  if (uploadsPath) {
    const pathname = request.nextUrl.pathname;
    if (pathname === uploadsPath || pathname.startsWith(`${uploadsPath}/`)) {
      const remainder = pathname.slice(uploadsPath.length);
      const destination = request.nextUrl.clone();
      destination.pathname = `/api/uploads${remainder}`;
      return NextResponse.rewrite(destination);
    }
  }

  if (request.nextUrl.pathname === "/") {
    if (process.env.NEXT_PUBLIC_KAN_ENV !== "cloud") {
      const loginUrl = new URL("/login", request.url);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/:path*"],
};
