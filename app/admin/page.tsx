'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface DashboardStats {
  totalProducts: number
  availableInventory: number
  activeBookings: number
  pendingReturns: number
  totalRevenue: number
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchStats()
  }, [])

  async function fetchStats() {
    try {
      const response = await fetch('/api/admin/stats')
      if (!response.ok) throw new Error('Failed to fetch stats')
      const data = await response.json()
      setStats(data)
    } catch (error) {
      console.error('Error fetching stats:', error)
    } finally {
      setLoading(false)
    }
  }

  const statCards = [
    { label: 'Total Products', value: stats?.totalProducts, icon: '📦' },
    { label: 'Available Inventory', value: stats?.availableInventory, icon: '✅' },
    { label: 'Active Bookings', value: stats?.activeBookings, icon: '📅' },
    { label: 'Pending Returns', value: stats?.pendingReturns, icon: '📥' },
    { label: 'Total Revenue', value: `$${stats?.totalRevenue?.toFixed(2)}`, icon: '💰' },
  ]

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <h1 className="text-2xl font-bold text-neutral-900">Admin Dashboard</h1>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Navigation Links */}
        <div className="mb-8 grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          <Link href="/admin/products" className="card hover:shadow-md transition-shadow">
            <div className="text-center">
              <div className="text-2xl mb-2">📦</div>
              <p className="font-medium text-neutral-900">Manage Products</p>
            </div>
          </Link>
          <Link href="/admin/inventory" className="card hover:shadow-md transition-shadow">
            <div className="text-center">
              <div className="text-2xl mb-2">📊</div>
              <p className="font-medium text-neutral-900">Inventory</p>
            </div>
          </Link>
          <Link href="/admin/bookings" className="card hover:shadow-md transition-shadow">
            <div className="text-center">
              <div className="text-2xl mb-2">📅</div>
              <p className="font-medium text-neutral-900">Bookings</p>
            </div>
          </Link>
          <Link href="/admin/staff" className="card hover:shadow-md transition-shadow">
            <div className="text-center">
              <div className="text-2xl mb-2">👥</div>
              <p className="font-medium text-neutral-900">Staff Management</p>
            </div>
          </Link>
          <Link href="/admin/reports" className="card hover:shadow-md transition-shadow">
            <div className="text-center">
              <div className="text-2xl mb-2">📈</div>
              <p className="font-medium text-neutral-900">Reports</p>
            </div>
          </Link>
        </div>

        {/* Stats */}
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-5">
          {statCards.map((stat) => (
            <div key={stat.label} className="card">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-neutral-600">{stat.label}</p>
                  <p className="mt-2 text-2xl font-bold text-neutral-900">
                    {loading ? '...' : stat.value}
                  </p>
                </div>
                <div className="text-3xl">{stat.icon}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Recent Activity */}
        <div className="mt-8 card">
          <h2 className="mb-4 text-lg font-semibold text-neutral-900">Recent Activity</h2>
          <p className="text-neutral-600">Coming soon...</p>
        </div>
      </main>
    </div>
  )
}
