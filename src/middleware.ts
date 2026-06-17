import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// /api/cron is called server-to-server by the separate cron Worker and
// authenticates with its own CRON_SECRET header, not a Clerk session, so it must
// bypass Clerk's session protection.
const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)", "/api/cron(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
