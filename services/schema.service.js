const pool = require("../db");

async function ensureDatabaseSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shops (
      shop TEXT PRIMARY KEY,
      access_token TEXT,
      cart_price_sync_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      rental_booking_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS access_token TEXT`);
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS cart_price_sync_enabled BOOLEAN`);
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS rental_booking_enabled BOOLEAN`);
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`
    UPDATE shops
    SET cart_price_sync_enabled = COALESCE(cart_price_sync_enabled, FALSE)
    WHERE cart_price_sync_enabled IS NULL
  `);
  await pool.query(`
    UPDATE shops
    SET rental_booking_enabled = COALESCE(rental_booking_enabled, FALSE)
    WHERE rental_booking_enabled IS NULL
  `);
  await pool.query(`
    ALTER TABLE shops
    ALTER COLUMN cart_price_sync_enabled SET DEFAULT FALSE
  `);
  await pool.query(`
    ALTER TABLE shops
    ALTER COLUMN cart_price_sync_enabled SET NOT NULL
  `);
  await pool.query(`
    ALTER TABLE shops
    ALTER COLUMN rental_booking_enabled SET DEFAULT FALSE
  `);
  await pool.query(`
    ALTER TABLE shops
    ALTER COLUMN rental_booking_enabled SET NOT NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rentals (
      id BIGSERIAL PRIMARY KEY,
      shop TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      rate_type TEXT,
      rate_amount NUMERIC(12, 2),
      status TEXT NOT NULL DEFAULT 'Reserved',
      shopify_order_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rentals_variant_dates
    ON rentals (variant_id, start_date, end_date)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rentals_status
    ON rentals (status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_rentals_shopify_order_id
    ON rentals (shopify_order_id)
  `);

  const sharedCustomerUpdates = [
    `ALTER TABLE IF EXISTS nst_rms_users ADD COLUMN IF NOT EXISTS licensekey TEXT`,
    `ALTER TABLE IF EXISTS nst_rms_users ADD COLUMN IF NOT EXISTS productcode TEXT`,
    `ALTER TABLE IF EXISTS nst_rms_users ADD COLUMN IF NOT EXISTS licenceurl TEXT`,
    `ALTER TABLE IF EXISTS nst_rms_users ADD COLUMN IF NOT EXISTS plan_start_date DATE`,
    `ALTER TABLE IF EXISTS nst_rms_users ADD COLUMN IF NOT EXISTS plan_end_date DATE`,
    `ALTER TABLE IF EXISTS nst_rms_users ADD COLUMN IF NOT EXISTS plan_active BOOLEAN`,
    `ALTER TABLE IF EXISTS nst_rms_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ`,
    `ALTER TABLE IF EXISTS nst_rms_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
    `ALTER TABLE IF EXISTS nst_rms_netsuite_users ADD COLUMN IF NOT EXISTS licensekey TEXT`,
    `ALTER TABLE IF EXISTS nst_rms_netsuite_users ADD COLUMN IF NOT EXISTS productcode TEXT`,
    `ALTER TABLE IF EXISTS nst_rms_netsuite_users ADD COLUMN IF NOT EXISTS licenceurl TEXT`,
    `ALTER TABLE IF EXISTS nst_rms_netsuite_users ADD COLUMN IF NOT EXISTS plan_start_date DATE`,
    `ALTER TABLE IF EXISTS nst_rms_netsuite_users ADD COLUMN IF NOT EXISTS plan_end_date DATE`,
    `ALTER TABLE IF EXISTS nst_rms_netsuite_users ADD COLUMN IF NOT EXISTS plan_active BOOLEAN`,
    `ALTER TABLE IF EXISTS nst_rms_netsuite_users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ`,
    `ALTER TABLE IF EXISTS nst_rms_netsuite_users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`,
  ];

  for (const statement of sharedCustomerUpdates) {
    await pool.query(statement);
  }

  await pool.query(`
    UPDATE nst_rms_users
    SET plan_active = COALESCE(plan_active, FALSE)
    WHERE plan_active IS NULL
  `).catch(() => {});

  await pool.query(`
    UPDATE nst_rms_netsuite_users
    SET plan_active = COALESCE(plan_active, FALSE)
    WHERE plan_active IS NULL
  `).catch(() => {});
}

module.exports = {
  ensureDatabaseSchema,
};
