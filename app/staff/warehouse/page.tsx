'use client'

import { useState } from 'react'

interface ReturnItem {
  id: number
  bookingId: number
  customerName: string
  productName: string
  returnDate: string
  status: 'pending' | 'assessed' | 'completed'
}

export default function WarehouseReturnsPage() {
  const [returns, setReturns] = useState<ReturnItem[]>([])
  const [selectedReturn, setSelectedReturn] = useState<number | null>(null)
  const [assessmentForm, setAssessmentForm] = useState({
    condition: 'good',
    damageDescription: '',
    damageCost: '',
    lateFees: '',
  })
  const [processing, setProcessing] = useState(false)

  const selectedItem = returns.find((r) => r.id === selectedReturn)

  const handleSubmitAssessment = async () => {
    if (!selectedItem) return

    setProcessing(true)
    try {
      const response = await fetch(`/api/staff/warehouse/return/${selectedItem.bookingId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conditionAssessment: assessmentForm.condition,
          damageDescription: assessmentForm.damageDescription,
          damageCost: assessmentForm.damageCost ? parseFloat(assessmentForm.damageCost) : 0,
          lateFees: assessmentForm.lateFees ? parseFloat(assessmentForm.lateFees) : 0,
        }),
      })

      if (!response.ok) throw new Error('Assessment failed')

      // Update local state
      setReturns(returns.map((r) => (r.id === selectedReturn ? { ...r, status: 'completed' } : r)))
      setSelectedReturn(null)
      setAssessmentForm({ condition: 'good', damageDescription: '', damageCost: '', lateFees: '' })
    } catch (error) {
      console.error('Error submitting assessment:', error)
      alert('Failed to submit assessment')
    } finally {
      setProcessing(false)
    }
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <h1 className="text-2xl font-bold text-neutral-900">Rental Returns & Damage Assessment</h1>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid gap-6 md:grid-cols-3">
          {/* Returns Queue */}
          <div className="md:col-span-1">
            <div className="card">
              <h2 className="mb-4 font-semibold text-neutral-900">Pending Returns</h2>
              {returns.length === 0 ? (
                <p className="text-sm text-neutral-600">No pending returns</p>
              ) : (
                <div className="space-y-2">
                  {returns.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        setSelectedReturn(item.id)
                        setAssessmentForm({ condition: 'good', damageDescription: '', damageCost: '', lateFees: '' })
                      }}
                      className={`w-full rounded border p-3 text-left text-sm transition ${
                        selectedReturn === item.id
                          ? 'border-primary bg-primary-light'
                          : 'border-neutral-200 hover:bg-neutral-50'
                      }`}
                    >
                      <div className="font-medium">{item.customerName}</div>
                      <div className="text-xs text-neutral-600">{item.productName}</div>
                      <div className="mt-1 text-xs text-neutral-500">{new Date(item.returnDate).toLocaleDateString()}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Assessment Form */}
          <div className="md:col-span-2">
            {selectedReturn === null ? (
              <div className="card text-center">
                <p className="text-neutral-600">Select a return to begin assessment</p>
              </div>
            ) : selectedItem ? (
              <div className="card">
                <h3 className="mb-4 text-lg font-semibold">{selectedItem.customerName}</h3>

                <div className="space-y-4">
                  <div>
                    <label className="text-sm font-medium text-neutral-700">Product</label>
                    <p className="mt-1 text-neutral-900">{selectedItem.productName}</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-neutral-700">Item Condition</label>
                    <select
                      value={assessmentForm.condition}
                      onChange={(e) =>
                        setAssessmentForm({ ...assessmentForm, condition: e.target.value })
                      }
                      className="input-base mt-1"
                    >
                      <option value="excellent">Excellent - No damage</option>
                      <option value="good">Good - Minor wear</option>
                      <option value="fair">Fair - Some damage</option>
                      <option value="poor">Poor - Major damage</option>
                      <option value="damaged">Damaged - Non-functional</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-neutral-700">Damage Description</label>
                    <textarea
                      value={assessmentForm.damageDescription}
                      onChange={(e) =>
                        setAssessmentForm({ ...assessmentForm, damageDescription: e.target.value })
                      }
                      className="input-base mt-1"
                      placeholder="Describe any damage observed..."
                      rows={3}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-neutral-700">Damage Cost ($)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={assessmentForm.damageCost}
                        onChange={(e) =>
                          setAssessmentForm({ ...assessmentForm, damageCost: e.target.value })
                        }
                        className="input-base mt-1"
                        placeholder="0.00"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-neutral-700">Late Fees ($)</label>
                      <input
                        type="number"
                        step="0.01"
                        value={assessmentForm.lateFees}
                        onChange={(e) =>
                          setAssessmentForm({ ...assessmentForm, lateFees: e.target.value })
                        }
                        className="input-base mt-1"
                        placeholder="0.00"
                      />
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={handleSubmitAssessment}
                      disabled={processing}
                      className="btn-primary flex-1"
                    >
                      {processing ? 'Submitting...' : 'Submit Assessment'}
                    </button>
                    <button
                      onClick={() => setSelectedReturn(null)}
                      className="btn-secondary flex-1"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  )
}
