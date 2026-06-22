import { ClerkProvider } from "@clerk/nextjs"

export default function SignUpLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <ClerkProvider>{children}</ClerkProvider>
}
