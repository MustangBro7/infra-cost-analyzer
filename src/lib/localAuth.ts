import { cookies } from "next/headers"
import type { NextRequest, NextResponse } from "next/server"
import { createOrUpdateUserSession, deleteSession, getUserBySessionId } from "./localStore"
import type { LocalUser } from "./types"

export const SESSION_COOKIE = "ica_session"

export async function currentUserFromCookies(): Promise<LocalUser | null> {
  const cookieStore = await cookies()
  return getUserBySessionId(cookieStore.get(SESSION_COOKIE)?.value)
}

export async function currentUserFromRequest(request: NextRequest): Promise<LocalUser | null> {
  return getUserBySessionId(request.cookies.get(SESSION_COOKIE)?.value)
}

export async function requireUserFromRequest(request: NextRequest): Promise<LocalUser> {
  const user = await currentUserFromRequest(request)
  if (!user) {
    throw new AuthRequiredError()
  }
  return user
}

export async function signInLocalUser(input: { email: string; name?: string | null }) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
    throw new Error("Enter a valid email address.")
  }
  return createOrUpdateUserSession(input)
}

export function setSessionCookie(response: NextResponse, sessionId: string) {
  response.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  })
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.delete(SESSION_COOKIE)
}

export async function signOutSession(request: NextRequest) {
  await deleteSession(request.cookies.get(SESSION_COOKIE)?.value)
}

export class AuthRequiredError extends Error {
  constructor() {
    super("Sign in is required.")
    this.name = "AuthRequiredError"
  }
}
