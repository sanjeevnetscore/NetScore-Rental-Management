'use client'

import { useEffect, useState } from 'react'
import { getAllBookings } from '@/app/actions/rental'

interface Booking {
  id: number
  status: string
  rentalStartDate: Date
  rentalEndDate: Date
  totalPrice: number
  user?: { name: string | null; email: string }
  product?: { name: string }
}

export default function AdminBookingsPage() {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  useEffect(() => {
    loadBookings()
  }, [])

  async function loadBookings() {
    try {
      const data = await getAllBookings()
      setBookings(data as Booking[])
    } catch (error) {
      console.error('Error loading bookings:', error)
    } finally {
      setLoading(false)
    }
  }

  const filteredBookings =
    filter === 'all' ? bookings : bookings.filter((b) => b.status === filter)

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'pending':
        return 'bg-yellow-100 text-yellow-800'
      case 'confirmed':
        return 'bg-blue-100 text-blue-800'
      case 'checked_out':
        return 'bg-green-100 text-green-800'
      case 'returned':
        return 'bg-gray-100 text-gray-800'
      case 'cancelled':
        return 'bg-red-100 text-red-800'
      default:
        return 'bg-gray-100 text-gray-800'
    }
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <h1 className="text-2xl font-bold text-neutral-900">Bookings</h1>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Filter Buttons */}
        <div className="mb-6 flex gap-2">
          {['all', 'pending', 'confirmed', 'checked_out', 'returned'].map((status) => (
            <button
              key={status}
              onClick={() => setFilter(status)}
              className={`rounded px-3 py-2 text-sm font-medium transition ${
                filter === status
                  ? 'bg-primary text-white'
                  : 'bg-white text-neutral-700 hover:bg-neutral-100'
              }`}
            >
              {status.charAt(0).toUpperCase() + status.slice(1).replace('_', ' ')}
            </button>
          ))}
        </div>

        {/* Bookings Table */}
        {loading ? (
          <div className="text-center text-neutral-600">Loading bookings...</div>
        ) : filteredBookings.length === 0 ? (
          <div className="card text-center">
            <p className="text-neutral-600">No bookings found</p>
          </div>
        ) : (
          <div className="overflow-x-auto card">
            <table className="w-full">
              <thead className="border-b border-neutral-200">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-900">Customer</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-900">Product</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-900">Dates</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-900">Status</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-900">Price</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-900">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {filteredBookings.map((booking) => (
                  <tr key={booking.id} className="hover:bg-neutral-50">
                    <td className="px-4 py-3 text-sm">
                      <div className="font-medium text-neutral-900">{booking.user?.name || 'N/A'}</div>
                      <div className="text-xs text-neutral-600">{booking.user?.email}</div>
                    </td>
                    <td className="px-4 py-3 text-sm text-neutral-900">{booking.product?.name}</td>
                    <td className="px-4 py-3 text-sm text-neutral-600">
                      {new Date(booking.rentalStartDate).toLocaleDateString()} -{' '}
                      {new Date(booking.rentalEndDate).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span className={`badge ${getStatusBadgeClass(booking.status)}`}>
                        {booking.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-neutral-900">
                      ${booking.totalPrice?.toFixed(2)}
                    </td>
                    <td className="px-4 py-3">
                      <button className="text-sm text-primary hover:underline">View</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  )
}
