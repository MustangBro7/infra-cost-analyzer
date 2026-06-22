import { ClerkProvider } from "@clerk/nextjs"

export default function SignInLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <ClerkProvider>{children}</ClerkProvider>
}
