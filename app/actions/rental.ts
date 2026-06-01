'use server'

import { db } from '@/lib/db'
import { bookings, rentalProducts, inventory, returns } from '@/lib/db/schema'
import { eq, and, gte, lte } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { getUserId } from './auth'

// ============== BOOKING ACTIONS ==============
export async function createBooking(
  productId: number,
  rentalStartDate: Date,
  rentalEndDate: Date,
  rentalDays: number
) {
  const userId = await getUserId()

  // Get product to calculate price
  const product = await db.query.rentalProducts.findFirst({
    where: eq(rentalProducts.id, productId),
  })

  if (!product) throw new Error('Product not found')

  // Find available inventory
  const availableItem = await db.query.inventory.findFirst({
    where: and(
      eq(inventory.productId, productId),
      eq(inventory.status, 'available')
    ),
  })

  if (!availableItem) throw new Error('No available inventory')

  // Calculate price based on rental days
  let totalPrice = Number(product.pricePerDay) * rentalDays
  const depositAmount = Number(product.pricePerDay) * 1 // 1 day deposit

  // Create booking
  const [booking] = await db
    .insert(bookings)
    .values({
      userId,
      productId,
      inventoryId: availableItem.id,
      rentalStartDate,
      rentalEndDate,
      totalPrice: String(totalPrice),
      depositAmount: String(depositAmount),
      status: 'pending',
    })
    .returning()

  revalidatePath('/customer')
  return booking
}

export async function getCustomerBookings() {
  const userId = await getUserId()

  return db.query.bookings.findMany({
    where: eq(bookings.userId, userId),
    with: {
      product: true,
      inventory: true,
    },
  })
}

export async function confirmBooking(bookingId: number) {
  const userId = await getUserId()

  // Verify ownership
  const booking = await db.query.bookings.findFirst({
    where: and(eq(bookings.id, bookingId), eq(bookings.userId, userId)),
  })

  if (!booking) throw new Error('Booking not found or unauthorized')

  // Update booking status
  await db
    .update(bookings)
    .set({ status: 'confirmed' })
    .where(eq(bookings.id, bookingId))

  revalidatePath('/customer')
}

export async function cancelBooking(bookingId: number) {
  const userId = await getUserId()

  // Verify ownership
  const booking = await db.query.bookings.findFirst({
    where: and(eq(bookings.id, bookingId), eq(bookings.userId, userId)),
  })

  if (!booking) throw new Error('Booking not found or unauthorized')

  // Update booking status
  await db.update(bookings).set({ status: 'cancelled' }).where(eq(bookings.id, bookingId))

  // Mark inventory as available again
  if (booking.inventoryId) {
    await db
      .update(inventory)
      .set({ status: 'available' })
      .where(eq(inventory.id, booking.inventoryId))
  }

  revalidatePath('/customer')
}

// ============== RETURN ACTIONS ==============
export async function processReturn(
  bookingId: number,
  conditionAssessment: string,
  damageDescription?: string,
  damageCost?: number,
  lateFees?: number
) {
  const userId = await getUserId()

  // Verify booking exists and belongs to user
  const booking = await db.query.bookings.findFirst({
    where: and(eq(bookings.id, bookingId), eq(bookings.userId, userId)),
  })

  if (!booking) throw new Error('Booking not found')

  const totalCharges = (damageCost || 0) + (lateFees || 0)
  const depositRefund = (booking.depositAmount ? Number(booking.depositAmount) : 0) - totalCharges

  // Create return record
  await db.insert(returns).values({
    bookingId,
    returnDateActual: new Date(),
    conditionAssessment,
    damageDescription: damageDescription || null,
    damageCost: damageCost ? String(damageCost) : null,
    lateFees: lateFees ? String(lateFees) : null,
    totalCharges: String(totalCharges),
    depositRefund: String(Math.max(depositRefund, 0)),
  })

  // Update booking status
  await db.update(bookings).set({ status: 'returned' }).where(eq(bookings.id, bookingId))

  // Mark inventory as available
  if (booking.inventoryId) {
    await db
      .update(inventory)
      .set({ status: 'available' })
      .where(eq(inventory.id, booking.inventoryId))
  }

  revalidatePath('/customer')
}

// ============== ADMIN ACTIONS ==============
export async function getAllBookings() {
  return db.query.bookings.findMany({
    with: {
      user: true,
      product: true,
      inventory: true,
    },
  })
}

export async function getDashboardStats() {
  const totalProducts = await db.query.rentalProducts.findMany()
  const allInventory = await db.query.inventory.findMany()
  const availableCount = allInventory.filter((i) => i.status === 'available').length
  const activeBookings = await db.query.bookings.findMany({
    where: eq(bookings.status, 'checked_out'),
  })

  const allReturns = await db.query.returns.findMany()
  const totalRevenue = allReturns.reduce((sum, r) => sum + Number(r.totalCharges || 0), 0)

  return {
    totalProducts: totalProducts.length,
    availableInventory: availableCount,
    activeBookings: activeBookings.length,
    pendingReturns: allReturns.filter((r) => !r.returnDateActual).length,
    totalRevenue,
  }
}
