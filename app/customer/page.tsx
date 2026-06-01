'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

interface Booking {
  id: number
  productName: string
  rentalStartDate: string
  rentalEndDate: string
  status: string
  totalPrice: number
}

export default function CustomerDashboard() {
  const router = useRouter()
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchBookings()
  }, [])

  async function fetchBookings() {
    try {
      const response = await fetch('/api/customer/bookings')
      if (!response.ok) throw new Error('Failed to fetch bookings')
      const data = await response.json()
      setBookings(data)
    } catch (error) {
      console.error('Error fetching bookings:', error)
    } finally {
      setLoading(false)
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'confirmed':
        return 'bg-green-100 text-green-800'
      case 'checked_out':
        return 'bg-blue-100 text-blue-800'
      case 'returned':
        return 'bg-gray-100 text-gray-800'
      case 'cancelled':
        return 'bg-red-100 text-red-800'
      default:
        return 'bg-yellow-100 text-yellow-800'
    }
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-neutral-900">My Rentals</h1>
            <Link href="/customer/browse" className="btn-primary">
              Browse Rentals
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {loading ? (
          <div className="text-center text-neutral-500">Loading your bookings...</div>
        ) : bookings.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-300 bg-white p-12 text-center">
            <p className="mb-4 text-neutral-600">No active rentals yet</p>
            <Link href="/customer/browse" className="btn-primary">
              Start Browsing
            </Link>
          </div>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {bookings.map((booking) => (
              <div key={booking.id} className="card">
                <div className="mb-4">
                  <h3 className="text-lg font-semibold text-neutral-900">{booking.productName}</h3>
                  <p className={`badge mt-2 ${getStatusColor(booking.status)}`}>
                    {booking.status.replace('_', ' ')}
                  </p>
                </div>
                <div className="space-y-2 text-sm text-neutral-600">
                  <div>
                    <span className="font-medium">Start:</span> {new Date(booking.rentalStartDate).toLocaleDateString()}
                  </div>
                  <div>
                    <span className="font-medium">End:</span> {new Date(booking.rentalEndDate).toLocaleDateString()}
                  </div>
                  <div>
                    <span className="font-medium">Price:</span> ${booking.totalPrice.toFixed(2)}
                  </div>
                </div>
                <div className="mt-4 flex gap-2">
                  <button className="btn-secondary flex-1 text-xs">View Details</button>
                  <button className="btn-secondary flex-1 text-xs">Cancel</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
