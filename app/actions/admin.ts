'use server'

import { db } from '@/lib/db'
import { rentalProducts, inventory } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { isAdmin } from './auth'

// ============== PRODUCT MANAGEMENT ==============
export async function createRentalProduct(
  name: string,
  description: string,
  pricePerDay: number,
  pricePerWeek?: number,
  pricePerMonth?: number,
  category?: string
) {
  await isAdmin() // Verify admin

  const [product] = await db
    .insert(rentalProducts)
    .values({
      name,
      description,
      pricePerDay: String(pricePerDay),
      pricePerWeek: pricePerWeek ? String(pricePerWeek) : null,
      pricePerMonth: pricePerMonth ? String(pricePerMonth) : null,
      category,
    })
    .returning()

  revalidatePath('/admin/products')
  return product
}

export async function getAllProducts() {
  return db.query.rentalProducts.findMany({
    with: {
      inventory: true,
    },
  })
}

export async function getProductById(id: number) {
  return db.query.rentalProducts.findFirst({
    where: eq(rentalProducts.id, id),
    with: {
      inventory: true,
    },
  })
}

export async function updateRentalProduct(
  id: number,
  updates: {
    name?: string
    description?: string
    pricePerDay?: number
    pricePerWeek?: number
    pricePerMonth?: number
    category?: string
  }
) {
  await isAdmin()

  const updateData: any = {}
  if (updates.name) updateData.name = updates.name
  if (updates.description) updateData.description = updates.description
  if (updates.pricePerDay) updateData.pricePerDay = String(updates.pricePerDay)
  if (updates.pricePerWeek) updateData.pricePerWeek = String(updates.pricePerWeek)
  if (updates.pricePerMonth) updateData.pricePerMonth = String(updates.pricePerMonth)
  if (updates.category) updateData.category = updates.category

  await db.update(rentalProducts).set(updateData).where(eq(rentalProducts.id, id))

  revalidatePath('/admin/products')
}

export async function deleteRentalProduct(id: number) {
  await isAdmin()

  await db.delete(rentalProducts).where(eq(rentalProducts.id, id))

  revalidatePath('/admin/products')
}

// ============== INVENTORY MANAGEMENT ==============
export async function addInventoryItem(
  productId: number,
  serialNumber?: string,
  condition?: string,
  purchasePrice?: number,
  purchaseDate?: Date
) {
  await isAdmin()

  const [item] = await db
    .insert(inventory)
    .values({
      productId,
      serialNumber: serialNumber || null,
      condition: condition || 'good',
      purchasePrice: purchasePrice ? String(purchasePrice) : null,
      purchaseDate,
      status: 'available',
    })
    .returning()

  revalidatePath('/admin/inventory')
  return item
}

export async function getProductInventory(productId: number) {
  return db.query.inventory.findMany({
    where: eq(inventory.productId, productId),
  })
}

export async function updateInventoryStatus(
  inventoryId: number,
  status: 'available' | 'rented' | 'maintenance' | 'damaged',
  condition?: string
) {
  await isAdmin()

  const updateData: any = { status }
  if (condition) updateData.condition = condition

  await db.update(inventory).set(updateData).where(eq(inventory.id, inventoryId))

  revalidatePath('/admin/inventory')
}

export async function getInventoryStats() {
  const allInventory = await db.query.inventory.findMany()

  return {
    total: allInventory.length,
    available: allInventory.filter((i) => i.status === 'available').length,
    rented: allInventory.filter((i) => i.status === 'rented').length,
    maintenance: allInventory.filter((i) => i.status === 'maintenance').length,
    damaged: allInventory.filter((i) => i.status === 'damaged').length,
  }
}
