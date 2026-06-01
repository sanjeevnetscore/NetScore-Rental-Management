'use server'

import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { staff } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { headers } from 'next/headers'

export async function getUserId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

export async function getUser() {
  const session = await auth.api.getSession({ headers: await headers() })
  return session?.user
}

export async function getUserRole() {
  const userId = await getUserId()
  const staffRecord = await db.query.staff.findFirst({
    where: eq(staff.userId, userId),
  })
  return staffRecord?.role || 'customer'
}

export async function isAdmin() {
  const role = await getUserRole()
  return role === 'admin'
}

export async function isCheckoutStaff() {
  const role = await getUserRole()
  return role === 'checkout_staff'
}

export async function isWarehouseStaff() {
  const role = await getUserRole()
  return role === 'warehouse_staff'
}
