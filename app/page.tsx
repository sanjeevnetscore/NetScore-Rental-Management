import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { db } from '@/lib/db'
import { staff } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() })

  // Redirect unauthenticated users to sign-in
  if (!session?.user) {
    redirect('/sign-in')
  }

  // Get user role to determine redirect
  const staffRecord = await db.query.staff.findFirst({
    where: eq(staff.userId, session.user.id),
  })

  const role = staffRecord?.role || 'customer'

  // Route based on role
  if (role === 'admin') {
    redirect('/admin')
  } else if (role === 'checkout_staff') {
    redirect('/staff/checkout')
  } else if (role === 'warehouse_staff') {
    redirect('/staff/warehouse')
  } else {
    redirect('/customer')
  }
}
