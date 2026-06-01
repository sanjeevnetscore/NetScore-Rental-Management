'use client'

import { useEffect, useState } from 'react'
import { createRentalProduct, getAllProducts } from '@/app/actions/admin'

interface Product {
  id: number
  name: string
  description: string | null
  category: string | null
  pricePerDay: string
  pricePerWeek: string | null
  pricePerMonth: string | null
}

export default function AdminProductsPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    pricePerDay: '',
    pricePerWeek: '',
    category: '',
  })

  useEffect(() => {
    loadProducts()
  }, [])

  async function loadProducts() {
    try {
      const data = await getAllProducts()
      setProducts(data as Product[])
    } catch (error) {
      console.error('Error loading products:', error)
    } finally {
      setLoading(false)
    }
  }

  async function handleAddProduct(e: React.FormEvent) {
    e.preventDefault()
    try {
      await createRentalProduct(
        formData.name,
        formData.description,
        parseFloat(formData.pricePerDay),
        formData.pricePerWeek ? parseFloat(formData.pricePerWeek) : undefined,
        undefined,
        formData.category
      )
      setFormData({ name: '', description: '', pricePerDay: '', pricePerWeek: '', category: '' })
      setShowForm(false)
      await loadProducts()
    } catch (error) {
      console.error('Error creating product:', error)
      alert('Failed to create product')
    }
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-neutral-900">Manage Products</h1>
            <button onClick={() => setShowForm(!showForm)} className="btn-primary">
              {showForm ? 'Cancel' : 'Add Product'}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {showForm && (
          <div className="card mb-8">
            <h2 className="mb-4 text-lg font-semibold">Add New Product</h2>
            <form onSubmit={handleAddProduct} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-700">Product Name</label>
                <input
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="input-base mt-1"
                  placeholder="e.g., Mountain Bike"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="input-base mt-1"
                  placeholder="Product description"
                  rows={3}
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-700">Price/Day</label>
                  <input
                    type="number"
                    required
                    step="0.01"
                    value={formData.pricePerDay}
                    onChange={(e) => setFormData({ ...formData, pricePerDay: e.target.value })}
                    className="input-base mt-1"
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-700">Price/Week</label>
                  <input
                    type="number"
                    step="0.01"
                    value={formData.pricePerWeek}
                    onChange={(e) => setFormData({ ...formData, pricePerWeek: e.target.value })}
                    className="input-base mt-1"
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-700">Category</label>
                  <input
                    type="text"
                    value={formData.category}
                    onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                    className="input-base mt-1"
                    placeholder="Equipment"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3">
                <button type="submit" className="btn-primary">
                  Create Product
                </button>
              </div>
            </form>
          </div>
        )}

        {loading ? (
          <div className="text-center text-neutral-600">Loading products...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-neutral-200 bg-white">
                <tr>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-900">Name</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-900">Category</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-900">Price/Day</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-900">Price/Week</th>
                  <th className="px-4 py-3 text-left text-sm font-semibold text-neutral-900">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200">
                {products.map((product) => (
                  <tr key={product.id} className="hover:bg-neutral-50">
                    <td className="px-4 py-3 text-sm text-neutral-900">{product.name}</td>
                    <td className="px-4 py-3 text-sm text-neutral-600">{product.category || '—'}</td>
                    <td className="px-4 py-3 text-sm text-neutral-600">${product.pricePerDay}</td>
                    <td className="px-4 py-3 text-sm text-neutral-600">{product.pricePerWeek ? `$${product.pricePerWeek}` : '—'}</td>
                    <td className="px-4 py-3">
                      <button className="text-sm text-primary hover:underline">Edit</button>
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
