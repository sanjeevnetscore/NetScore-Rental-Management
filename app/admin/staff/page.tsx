'use client'

import { useState } from 'react'

interface StaffMember {
  id: number
  name: string
  email: string
  role: 'admin' | 'checkout_staff' | 'warehouse_staff'
  joinDate: string
}

export default function AdminStaffPage() {
  const [staff, setStaff] = useState<StaffMember[]>([])
  const [showForm, setShowForm] = useState(false)

  const roleDescriptions: Record<string, string> = {
    admin: 'Full system access and management',
    checkout_staff: 'Handle rental pickups and payments',
    warehouse_staff: 'Manage inventory and returns',
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-neutral-900">Staff Management</h1>
            <button onClick={() => setShowForm(!showForm)} className="btn-primary">
              {showForm ? 'Cancel' : 'Add Staff'}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {showForm && (
          <div className="card mb-8">
            <h2 className="mb-4 text-lg font-semibold">Add Staff Member</h2>
            <form className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-700">Name</label>
                  <input type="text" className="input-base mt-1" placeholder="Staff name" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-700">Email</label>
                  <input type="email" className="input-base mt-1" placeholder="email@example.com" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700">Role</label>
                <select className="input-base mt-1">
                  <option>checkout_staff</option>
                  <option>warehouse_staff</option>
                  <option>admin</option>
                </select>
              </div>
              <div className="flex justify-end gap-3">
                <button type="button" className="btn-secondary" onClick={() => setShowForm(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Add Staff Member
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Staff Grid */}
        {staff.length === 0 ? (
          <div className="card text-center">
            <p className="mb-4 text-neutral-600">No staff members yet</p>
            <button onClick={() => setShowForm(true)} className="btn-primary">
              Add Your First Staff Member
            </button>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {staff.map((member) => (
              <div key={member.id} className="card">
                <div className="mb-3 flex items-start justify-between">
                  <div>
                    <h3 className="font-semibold text-neutral-900">{member.name}</h3>
                    <p className="text-sm text-neutral-600">{member.email}</p>
                  </div>
                  <span className="badge-primary">{member.role.replace('_', ' ')}</span>
                </div>
                <p className="mb-4 text-xs text-neutral-600">{roleDescriptions[member.role]}</p>
                <div className="flex gap-2">
                  <button className="btn-secondary flex-1 text-xs">Edit</button>
                  <button className="btn-secondary flex-1 text-xs">Remove</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
