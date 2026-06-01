'use client'

import { useState } from 'react'

interface PendingCheckout {
  id: number
  customerName: string
  productName: string
  rentalStart: string
  rentalEnd: string
  depositAmount: number
}

export default function CheckoutStaffPage() {
  const [checkouts, setCheckouts] = useState<PendingCheckout[]>([])
  const [selectedCheckout, setSelectedCheckout] = useState<number | null>(null)
  const [processing, setProcessing] = useState(false)

  const handleCheckout = async (checkoutId: number) => {
    setProcessing(true)
    try {
      const response = await fetch(`/api/staff/checkout/${checkoutId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!response.ok) throw new Error('Checkout failed')

      // Remove from list
      setCheckouts(checkouts.filter((c) => c.id !== checkoutId))
      setSelectedCheckout(null)
    } catch (error) {
      console.error('Error processing checkout:', error)
      alert('Failed to process checkout')
    } finally {
      setProcessing(false)
    }
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <h1 className="text-2xl font-bold text-neutral-900">Checkout - Rental Pickup</h1>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="grid gap-6 md:grid-cols-3">
          {/* Pending List */}
          <div className="md:col-span-1">
            <div className="card">
              <h2 className="mb-4 font-semibold text-neutral-900">Pending Checkouts</h2>
              {checkouts.length === 0 ? (
                <p className="text-sm text-neutral-600">No pending checkouts</p>
              ) : (
                <div className="space-y-2">
                  {checkouts.map((checkout) => (
                    <button
                      key={checkout.id}
                      onClick={() => setSelectedCheckout(checkout.id)}
                      className={`w-full rounded border p-3 text-left text-sm transition ${
                        selectedCheckout === checkout.id
                          ? 'border-primary bg-primary-light'
                          : 'border-neutral-200 hover:bg-neutral-50'
                      }`}
                    >
                      <div className="font-medium">{checkout.customerName}</div>
                      <div className="text-xs text-neutral-600">{checkout.productName}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Details and Actions */}
          <div className="md:col-span-2">
            {selectedCheckout === null ? (
              <div className="card text-center">
                <p className="text-neutral-600">Select a checkout to continue</p>
              </div>
            ) : (
              <div className="card">
                {(() => {
                  const checkout = checkouts.find((c) => c.id === selectedCheckout)
                  return checkout ? (
                    <>
                      <h3 className="mb-4 text-lg font-semibold">{checkout.customerName}</h3>
                      <div className="space-y-4">
                        <div>
                          <label className="text-sm font-medium text-neutral-700">Product</label>
                          <p className="mt-1 text-neutral-900">{checkout.productName}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className="text-sm font-medium text-neutral-700">Start Date</label>
                            <p className="mt-1 text-neutral-900">{checkout.rentalStart}</p>
                          </div>
                          <div>
                            <label className="text-sm font-medium text-neutral-700">End Date</label>
                            <p className="mt-1 text-neutral-900">{checkout.rentalEnd}</p>
                          </div>
                        </div>
                        <div>
                          <label className="text-sm font-medium text-neutral-700">Deposit</label>
                          <p className="mt-1 text-neutral-900">${checkout.depositAmount.toFixed(2)}</p>
                        </div>
                      </div>
                      <div className="mt-6 flex gap-3">
                        <button
                          onClick={() => handleCheckout(checkout.id)}
                          disabled={processing}
                          className="btn-primary flex-1"
                        >
                          {processing ? 'Processing...' : 'Confirm Pickup'}
                        </button>
                        <button
                          onClick={() => setSelectedCheckout(null)}
                          className="btn-secondary flex-1"
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : null
                })()}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
