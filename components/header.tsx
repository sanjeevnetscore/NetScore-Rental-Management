'use client'

import { authClient } from '@/lib/auth-client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useEffect, useState } from 'react'

export function Header() {
  const router = useRouter()
  const [user, setUser] = useState<{ name: string | null; email: string } | null>(null)

  useEffect(() => {
    const { data: session } = authClient.useSession()
    if (session?.user) {
      setUser({ name: session.user.name, email: session.user.email })
    }
  }, [])

  async function handleLogout() {
    await authClient.signOut({ fetchOptions: { onSuccess: () => router.push('/sign-in') } })
  }

  return (
    <header className="border-b border-neutral-200 bg-white">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between py-4">
          <Link href="/" className="text-xl font-bold text-primary">
            NetScore Rentals
          </Link>

          <div className="flex items-center gap-4">
            {user && (
              <>
                <div className="text-sm">
                  <p className="font-medium text-neutral-900">{user.name || 'User'}</p>
                  <p className="text-neutral-600">{user.email}</p>
                </div>
                <button onClick={handleLogout} className="btn-secondary text-sm">
                  Logout
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  )
}
