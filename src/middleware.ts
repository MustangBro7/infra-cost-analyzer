import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { appUrl } from "@/lib/appUrl";

// /api/cron is called server-to-server by the separate cron Worker and
// authenticates with its own CRON_SECRET header, not a Clerk session, so it must
// bypass Clerk's session protection. The companion-CLI endpoints below
// authenticate with a device code or a minted cliToken (not a Clerk session), so
// they bypass too — but /api/cli/pair/approve and the /pair page stay protected
// because the user must be signed in to approve a pairing.
const isPublicRoute = createRouteMatcher([
  "/",
  "/pricing",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/api/cron(.*)",
  "/api/cli/pair/start",
  "/api/cli/pair/poll",
  "/api/cli/status",
  "/api/cli/aws/params",
  "/api/cli/connect/(.*)",
  "/api/cli/ai-usage",
  // Agent-facing custom-provider endpoints authenticate with a cliToken in the
  // route handler (requireUserFromCliToken), so they bypass Clerk's session
  // gate — same model as /api/cli/connect/*.
  "/api/cli/custom-providers(.*)",
  // Dodo webhooks are server-to-server and are verified in the route handler
  // with DODO_PAYMENTS_WEBHOOK_KEY, not a Clerk browser session.
  "/api/billing/webhook/dodo",
  // Public, machine-readable extension guide (no secrets) the AI agent reads.
  "/api/extend/(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  // The workers.dev route exists only as an infrastructure fallback. Browser
  // traffic must stay on ambrium.io so Clerk session cookies and third-party
  // callbacks always share one origin.
  if (request.nextUrl.hostname.endsWith(".workers.dev")) {
    return NextResponse.redirect(appUrl(`${request.nextUrl.pathname}${request.nextUrl.search}`, request.nextUrl.origin), 308);
  }
  if (isPublicRoute(request)) return;
  const { userId, redirectToSignIn } = await auth();
  if (userId) {
    // Authenticated pages render per-user, always-dynamic data. Without an
    // explicit directive the browser applies heuristic caching to the HTML
    // document, so a fresh deploy or data refresh wouldn't show until a hard
    // reload. no-store keeps the dashboard always fresh (and per-user private).
    const response = NextResponse.next();
    response.headers.set("Cache-Control", "no-store, must-revalidate");
    return response;
  }
  // Unauthenticated on a protected route: send page visitors to the sign-in page
  // (instead of a bare 404), and answer API requests with a 401 their callers
  // expect rather than an HTML redirect.
  if (request.nextUrl.pathname.startsWith("/api")) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  return redirectToSignIn();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
