const PRODUCTION_APP_ORIGIN = "https://ambrium.io"

function browserSafeLocalOrigin(origin: string) {
  try {
    const url = new URL(origin)
    if (url.hostname === "0.0.0.0") url.hostname = "localhost"
    return url.origin
  } catch {
    return origin
  }
}

/**
 * Returns the browser-facing application origin.
 *
 * Production callbacks must never inherit the workers.dev or API hostname from
 * the incoming request because Clerk's session cookie belongs to ambrium.io.
 * Local development still uses the actual localhost origin.
 */
export function appOrigin(
  requestOrigin: string,
  env: Record<string, string | undefined> = process.env,
) {
  const configured = env.APP_URL?.trim()
  if (configured) return new URL(configured).origin

  const origin = browserSafeLocalOrigin(requestOrigin)
  try {
    const url = new URL(origin)
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return url.origin
  } catch {
    return origin
  }
  return PRODUCTION_APP_ORIGIN
}

export function appUrl(
  path: string,
  requestOrigin: string,
  env: Record<string, string | undefined> = process.env,
) {
  return new URL(path, appOrigin(requestOrigin, env))
}
