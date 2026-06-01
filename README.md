# NetScore Rental Management - Shopify App

A comprehensive Next.js + Neon PostgreSQL rental management system with role-based access control, inventory tracking, and complete rental lifecycle management.

## System Overview

### Tech Stack
- **Framework**: Next.js 16 with App Router
- **Database**: Neon PostgreSQL
- **ORM**: Drizzle ORM
- **Authentication**: Better Auth (email + password)
- **Styling**: Tailwind CSS v4
- **UI**: Custom components built with semantic HTML

### Database Schema

#### Authentication Tables (Better Auth)
- `user` - User accounts and profiles
- `session` - Active user sessions
- `account` - OAuth and password credentials
- `verification` - Email verification tokens

#### Rental Management Tables
- `staff` - Staff members with roles (admin, checkout_staff, warehouse_staff)
- `rental_products` - Available rental product catalog
- `inventory` - Individual rental items with status tracking
- `bookings` - Rental reservations and checkouts
- `returns` - Return records with damage assessment

## User Roles & Access

### 1. **Admin** (`/admin`)
Full system access and management capabilities:
- **Dashboard** - Overview of system metrics (products, inventory, bookings, revenue)
- **Products** - Create, update, and manage rental products with pricing tiers
- **Inventory** - Track individual items by status (available, rented, maintenance, damaged)
- **Bookings** - View and manage all customer bookings
- **Staff** - Add and manage staff members with role assignment

### 2. **Checkout Staff** (`/staff/checkout`)
Handle rental pickups and payment processing:
- View pending checkout requests
- Confirm pickup of rental items
- Process payment collection
- Generate pickup receipts

### 3. **Warehouse Staff** (`/staff/warehouse`)
Manage returns and item conditions:
- Process incoming returns
- Assess item condition (excellent, good, fair, poor, damaged)
- Record damage with photos and descriptions
- Calculate damage costs and late fees
- Process deposit refunds

### 4. **Customers** (`/customer`)
Self-service rental portal:
- Browse available rental products
- Create rental bookings with date selection
- View active and past rentals
- Track booking status
- Manage cancellations and returns

## Key Features

### Rental Lifecycle
1. **Booking Creation** - Customers browse products and create bookings
2. **Checkout** - Staff confirms pickup and collects deposit
3. **Rental Period** - Item is with customer
4. **Return Processing** - Warehouse staff assesses condition
5. **Final Charges** - Damage fees and late charges calculated
6. **Refund** - Deposit refund issued after assessment

### Pricing Models
- Per-day pricing (required)
- Per-week pricing (optional)
- Per-month pricing (optional)
- Automatic cost calculation based on rental duration

### Inventory Management
- Real-time availability tracking
- Condition assessment (excellent/good/fair/poor)
- Serial number tracking for high-value items
- Maintenance scheduling capability
- Damage documentation with cost tracking

### Financial Tracking
- Deposit collection at checkout
- Damage cost deduction from deposits
- Late fee calculation
- Automated refund calculations
- Revenue reporting and analytics

## API Endpoints

### Authentication
- `POST /api/auth/[...all]` - Better Auth handler

### Customer API
- `GET /api/customer/bookings` - Get user's bookings

### Admin API
- `GET /api/admin/stats` - Dashboard statistics
- `POST /api/admin/products` - Create rental product
- `PUT /api/admin/products/:id` - Update product
- `DELETE /api/admin/products/:id` - Delete product
- `POST /api/admin/inventory` - Add inventory item

### Staff API
- `POST /api/staff/checkout/:bookingId` - Confirm pickup
- `POST /api/staff/warehouse/return/:bookingId` - Process return assessment

## Server Actions

### Rental Management (`app/actions/rental.ts`)
- `createBooking()` - Create new rental booking
- `getCustomerBookings()` - Retrieve user's bookings
- `confirmBooking()` - Confirm pending booking
- `cancelBooking()` - Cancel active booking
- `processReturn()` - Process return with damage assessment
- `getAllBookings()` - Admin: get all bookings
- `getDashboardStats()` - Admin: system statistics

### Admin Functions (`app/actions/admin.ts`)
- `createRentalProduct()` - Add new product to catalog
- `getAllProducts()` - List all products
- `getProductById()` - Get product details
- `updateRentalProduct()` - Edit product information
- `deleteRentalProduct()` - Remove product
- `addInventoryItem()` - Add item to inventory
- `getProductInventory()` - List items for product
- `updateInventoryStatus()` - Update item status
- `getInventoryStats()` - Inventory overview

### Authentication Helpers (`app/actions/auth.ts`)
- `getUserId()` - Get current user ID (auth validation)
- `getUser()` - Get current user object
- `getUserRole()` - Get user's role
- `isAdmin()` - Check admin status
- `isCheckoutStaff()` - Check checkout staff status
- `isWarehouseStaff()` - Check warehouse staff status

## Setup Instructions

### Prerequisites
1. Node.js 18+ and pnpm
2. Neon PostgreSQL database connected
3. BETTER_AUTH_SECRET environment variable set

### Installation
```bash
# Install dependencies
pnpm install

# Set environment variables
# DATABASE_URL (auto from Neon integration)
# BETTER_AUTH_SECRET (generate with: openssl rand -base64 32)

# Run development server
pnpm run dev

# Build for production
pnpm run build
pnpm start
```

### Database Setup
All tables are created via Neon SQL runner. Schema defined in `lib/db/schema.ts` with Drizzle ORM relations.

## File Structure
```
app/
├── actions/              # Server actions for data mutations
│   ├── auth.ts          # Auth helpers
│   ├── admin.ts         # Admin operations
│   └── rental.ts        # Rental operations
├── api/                 # API routes
│   ├── auth/[...all]/   # Better Auth handler
│   ├── admin/           # Admin endpoints
│   ├── customer/        # Customer endpoints
│   └── staff/           # Staff endpoints
├── admin/               # Admin dashboard pages
├── staff/               # Staff interface pages
├── customer/            # Customer portal pages
├── sign-in/             # Authentication pages
├── sign-up/
├── layout.tsx           # Root layout
├── page.tsx             # Home/router page
└── globals.css          # Global styles
lib/
├── auth.ts              # Better Auth configuration
├── auth-client.ts       # Client-side auth
└── db/
    ├── index.ts         # Drizzle setup
    └── schema.ts        # Database schema
components/
├── auth-form.tsx        # Shared auth component
└── header.tsx           # Navigation header
```

## Security Notes

- **No RLS**: All user data scoped via `userId` in WHERE clauses
- **Auth Validation**: `getUserId()` validates session on every server action
- **Role Checking**: Admin and staff operations verify role before proceeding
- **CSRF Protection**: Better Auth handles session tokens
- **Input Validation**: Server actions validate inputs before database operations

## Next Steps

1. **Populate Sample Data**: Add sample products and inventory items
2. **Create Shopify Integration**: Connect to Shopify API for product sync
3. **Email Notifications**: Add email notifications for bookings/returns
4. **Mobile App**: Build mobile customer app for bookings on-the-go
5. **Analytics**: Build advanced reporting and analytics dashboard
6. **Payment Integration**: Integrate Stripe for online payments
7. **Image Upload**: Add photo upload for damage documentation
8. **PDF Invoices**: Generate rental agreements and invoices

## Contact & Support

For issues or questions about the NetScore Rental Management system, please refer to the Shopify app documentation or contact the development team.
