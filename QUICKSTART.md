# Quick Start Guide

## Getting Started

### 1. Prerequisites
- Node.js 18+
- pnpm package manager
- Neon PostgreSQL database (already connected)
- BETTER_AUTH_SECRET environment variable set

### 2. Installation

```bash
# Clone the repository (if needed)
git clone <repo>
cd NetScore-Rental-Management

# Install dependencies
pnpm install

# Start development server
pnpm run dev
```

The app will be available at `http://localhost:3000`

### 3. First-Time Setup

#### Create Admin Account
1. Go to `http://localhost:3000/sign-up`
2. Enter name, email, password
3. After sign-up, manually set role to `admin` via database
   ```sql
   INSERT INTO staff (user_id, role)
   SELECT id, 'admin' FROM "user" WHERE email = 'your-email@example.com';
   ```

#### Add Sample Products
1. Log in as admin at `/admin`
2. Click "Manage Products"
3. Add test products (e.g., Mountain Bike, Canoe, Camera)

#### Add Inventory Items
1. Go to Inventory management
2. Click "Add Item" for each product
3. Set initial condition and purchase info

### 4. Test the Full Workflow

#### As Admin
1. Navigate to `/admin`
2. View dashboard metrics
3. Browse products, inventory, bookings

#### As Customer
1. Log out and create new account
2. Navigate to `/customer`
3. Create a new booking
4. Track booking status

#### As Checkout Staff
1. Create staff account, set role to `checkout_staff`
2. Navigate to `/staff/checkout`
3. Confirm pickups
4. Calculate and process deposits

#### As Warehouse Staff
1. Create staff account, set role to `warehouse_staff`
2. Navigate to `/staff/warehouse`
3. Process returns
4. Assess damage and calculate fees

### 5. Database Commands

#### View Users
```sql
SELECT id, name, email FROM "user" ORDER BY created_at DESC;
```

#### Assign Admin Role
```sql
INSERT INTO staff (user_id, role) VALUES ('user-id', 'admin');
```

#### View All Bookings
```sql
SELECT b.*, u.email, rp.name FROM bookings b
JOIN "user" u ON b.user_id = u.id
JOIN rental_products rp ON b.product_id = rp.id
ORDER BY b.created_at DESC;
```

#### Check Inventory Status
```sql
SELECT i.*, rp.name FROM inventory i
JOIN rental_products rp ON i.product_id = rp.id
ORDER BY i.status;
```

### 6. Key Endpoints

| Role | Path | Purpose |
|------|------|---------|
| Admin | `/admin` | Dashboard & management |
| Admin | `/admin/products` | Manage rental products |
| Admin | `/admin/inventory` | Track inventory items |
| Admin | `/admin/bookings` | View all bookings |
| Admin | `/admin/staff` | Manage staff members |
| Checkout Staff | `/staff/checkout` | Handle pickups |
| Warehouse Staff | `/staff/warehouse` | Process returns |
| Customer | `/customer` | View & create bookings |
| All | `/sign-in` | Login |
| All | `/sign-up` | Register |

### 7. Troubleshooting

#### "Database connection error"
- Verify DATABASE_URL environment variable is set
- Check Neon dashboard for active database

#### "BETTER_AUTH_SECRET not set"
- Generate: `openssl rand -base64 32`
- Add to project environment variables
- Restart dev server

#### "User has no role assigned"
- Insert staff record with user's ID
- Verify staff table has entry before login

#### "Changes not reflected in UI"
- Clear browser cache
- Refresh page
- Check dev server logs for errors

### 8. File Structure Reference

```
app/
├── admin/              # Admin pages
├── customer/           # Customer portal  
├── staff/              # Staff interfaces
├── actions/            # Server actions
├── api/                # API routes
├── sign-in/            # Auth pages
├── sign-up/
└── page.tsx            # Home router

lib/
├── auth.ts             # Auth config
├── db/
│   ├── index.ts        # Drizzle setup
│   └── schema.ts       # Database schema

components/
└── auth-form.tsx       # Shared components
```

### 9. Development Tips

- Use `console.log("[v0] ...")` for debugging
- All server actions validate with `getUserId()`
- Database queries use Drizzle with type safety
- Tailwind classes available for all components

### 10. Next Features to Add

- [ ] Email notifications for bookings/returns
- [ ] Photo upload for damage documentation
- [ ] PDF invoice/receipt generation
- [ ] Shopify product sync
- [ ] Stripe payment integration
- [ ] Mobile app for customers
- [ ] SMS notifications
- [ ] Analytics dashboard

## Need Help?

1. Check `README.md` for detailed documentation
2. Review `BUILD_SUMMARY.md` for feature overview
3. Check server action files in `app/actions/`
4. Review page components for UI patterns

Happy renting! 🚴
