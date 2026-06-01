import { pgTable, text, timestamp, serial, decimal, date, varchar, boolean, check, index } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

// ============== BETTER AUTH TABLES ==============
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name'),
  email: text('email').unique().notNull(),
  emailVerified: boolean('emailVerified').default(false),
  image: text('image'),
  createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).defaultNow(),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  token: text('token').unique().notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).defaultNow(),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: timestamp('accessTokenExpiresAt', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).defaultNow(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }),
  updatedAt: timestamp('updatedAt', { withTimezone: true }),
})

// ============== RENTAL MANAGEMENT TABLES ==============
export const staff = pgTable('staff', {
  id: serial('id').primaryKey(),
  userId: text('userId')
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 50 }).notNull(),
  createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).defaultNow(),
})

export const rentalProducts = pgTable('rental_products', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  pricePerDay: decimal('price_per_day', { precision: 10, scale: 2 }).notNull(),
  pricePerWeek: decimal('price_per_week', { precision: 10, scale: 2 }),
  pricePerMonth: decimal('price_per_month', { precision: 10, scale: 2 }),
  category: varchar('category', { length: 100 }),
  createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).defaultNow(),
})

export const inventory = pgTable(
  'inventory',
  {
    id: serial('id').primaryKey(),
    productId: serial('product_id')
      .notNull()
      .references(() => rentalProducts.id, { onDelete: 'cascade' }),
    serialNumber: varchar('serial_number', { length: 255 }).unique(),
    status: varchar('status', { length: 50 }).notNull().default('available'),
    condition: varchar('condition', { length: 50 }).default('good'),
    purchasePrice: decimal('purchase_price', { precision: 10, scale: 2 }),
    purchaseDate: date('purchase_date'),
    lastMaintenanceDate: date('last_maintenance_date'),
    createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    statusIndex: index('idx_inventory_status').on(table.status),
  })
)

export const bookings = pgTable(
  'bookings',
  {
    id: serial('id').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    productId: serial('product_id')
      .notNull()
      .references(() => rentalProducts.id, { onDelete: 'cascade' }),
    inventoryId: serial('inventory_id').references(() => inventory.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 50 }).notNull().default('pending'),
    rentalStartDate: date('rental_start_date').notNull(),
    rentalEndDate: date('rental_end_date').notNull(),
    pickupDate: timestamp('pickup_date', { withTimezone: true }),
    returnDate: timestamp('return_date', { withTimezone: true }),
    totalPrice: decimal('total_price', { precision: 10, scale: 2 }),
    depositAmount: decimal('deposit_amount', { precision: 10, scale: 2 }),
    createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    userIdIndex: index('idx_bookings_userId').on(table.userId),
    statusIndex: index('idx_bookings_status').on(table.status),
  })
)

export const returns = pgTable(
  'returns',
  {
    id: serial('id').primaryKey(),
    bookingId: serial('booking_id')
      .notNull()
      .unique()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    checkedByStaffId: serial('checked_by_staff_id').references(() => staff.id),
    returnDateActual: timestamp('return_date_actual', { withTimezone: true }).notNull(),
    conditionAssessment: varchar('condition_assessment', { length: 50 }),
    damageDescription: text('damage_description'),
    damagePhotos: text('damage_photos').array(),
    damageCost: decimal('damage_cost', { precision: 10, scale: 2 }),
    lateFees: decimal('late_fees', { precision: 10, scale: 2 }),
    totalCharges: decimal('total_charges', { precision: 10, scale: 2 }),
    depositRefund: decimal('deposit_refund', { precision: 10, scale: 2 }),
    createdAt: timestamp('createdAt', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updatedAt', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    bookingIdIndex: index('idx_returns_bookingId').on(table.bookingId),
  })
)

// ============== RELATIONS ==============
export const userRelations = relations(user, ({ many, one }) => ({
  staff: one(staff),
  bookings: many(bookings),
  sessions: many(session),
  accounts: many(account),
}))

export const staffRelations = relations(staff, ({ one, many }) => ({
  user: one(user, { fields: [staff.userId], references: [user.id] }),
  returns: many(returns),
}))

export const rentalProductsRelations = relations(rentalProducts, ({ many }) => ({
  inventory: many(inventory),
  bookings: many(bookings),
}))

export const inventoryRelations = relations(inventory, ({ one, many }) => ({
  product: one(rentalProducts, { fields: [inventory.productId], references: [rentalProducts.id] }),
  bookings: many(bookings),
}))

export const bookingsRelations = relations(bookings, ({ one }) => ({
  user: one(user, { fields: [bookings.userId], references: [user.id] }),
  product: one(rentalProducts, { fields: [bookings.productId], references: [rentalProducts.id] }),
  inventory: one(inventory, { fields: [bookings.inventoryId], references: [inventory.id] }),
  return: one(returns),
}))

export const returnsRelations = relations(returns, ({ one }) => ({
  booking: one(bookings, { fields: [returns.bookingId], references: [bookings.id] }),
  checkedByStaff: one(staff, { fields: [returns.checkedByStaffId], references: [staff.id] }),
}))
