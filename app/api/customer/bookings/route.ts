import { getCustomerBookings } from '@/app/actions/rental'
import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { NextResponse } from 'next/server'

export async function GET() {
  try {
    const session = await auth.api.getSession({ headers: await headers() })
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const bookings = await getCustomerBookings()
    const formatted = bookings.map((booking) => ({
      id: booking.id,
      productName: booking.product?.name || 'Unknown Product',
      rentalStartDate: booking.rentalStartDate,
      rentalEndDate: booking.rentalEndDate,
      status: booking.status,
      totalPrice: booking.totalPrice,
    }))

    return NextResponse.json(formatted)
  } catch (error) {
    console.error('Error fetching bookings:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
