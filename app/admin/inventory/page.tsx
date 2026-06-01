'use client'

import { useEffect, useState } from 'react'
import { getInventoryStats } from '@/app/actions/admin'

interface InventoryStats {
  total: number
  available: number
  rented: number
  maintenance: number
  damaged: number
}

export default function AdminInventoryPage() {
  const [stats, setStats] = useState<InventoryStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadStats()
  }, [])

  async function loadStats() {
    try {
      const data = await getInventoryStats()
      setStats(data)
    } catch (error) {
      console.error('Error loading inventory stats:', error)
    } finally {
      setLoading(false)
    }
  }

  const statItems = [
    { label: 'Total Items', value: stats?.total, color: 'bg-blue-50 text-blue-900' },
    { label: 'Available', value: stats?.available, color: 'bg-green-50 text-green-900' },
    { label: 'Rented Out', value: stats?.rented, color: 'bg-orange-50 text-orange-900' },
    { label: 'Maintenance', value: stats?.maintenance, color: 'bg-yellow-50 text-yellow-900' },
    { label: 'Damaged', value: stats?.damaged, color: 'bg-red-50 text-red-900' },
  ]

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <h1 className="text-2xl font-bold text-neutral-900">Inventory Management</h1>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {loading ? (
          <div className="text-center text-neutral-600">Loading inventory data...</div>
        ) : (
          <div className="space-y-8">
            {/* Inventory Stats */}
            <div className="grid gap-4 md:grid-cols-5">
              {statItems.map((item) => (
                <div key={item.label} className={`card ${item.color}`}>
                  <p className="text-sm font-medium opacity-75">{item.label}</p>
                  <p className="mt-2 text-3xl font-bold">{loading ? '...' : item.value}</p>
                </div>
              ))}
            </div>

            {/* Inventory List Placeholder */}
            <div className="card">
              <h2 className="mb-4 text-lg font-semibold text-neutral-900">Inventory Items</h2>
              <div className="text-center text-neutral-600">
                <p>Detailed inventory list coming soon</p>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
