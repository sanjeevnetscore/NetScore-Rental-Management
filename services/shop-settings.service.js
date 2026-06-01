const pool = require("../db");
const shopify = require("../shopify");
const {
  activateRentalCartTransformForShop,
  deactivateRentalCartTransformForShop,
} = require("./cart-transform.service");

function normalizeShopDomain(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  return value.endsWith(".myshopify.com") ? value : `${value}.myshopify.com`;
}

async function getStoredShopSession(preferredShop = "") {
  const normalizedPreferredShop = normalizeShopDomain(preferredShop);
  if (!normalizedPreferredShop) {
    return null;
  }

  const { rows } = await pool.query(
    `SELECT shop, access_token
     FROM shops
     WHERE lower(shop) = lower($1)
       AND access_token IS NOT NULL
     LIMIT 1`,
    [normalizedPreferredShop],
  );

  return rows[0] || null;
}

async function graphqlRequest(client, query, variables = {}) {
  const response = await client.request(query, { variables });
  return { body: { data: response?.data || {} } };
}

async function getShopifyPlusStatus(preferredShop = "") {
  const shopSession = await getStoredShopSession(preferredShop);
  if (!shopSession) {
    return {
      shopifyPlus: false,
      planDisplayName: "",
    };
  }

  const client = new shopify.clients.Graphql({
    session: {
      id: `offline_${shopSession.shop}`,
      shop: shopSession.shop,
      accessToken: shopSession.access_token,
      isOnline: false,
    },
  });

  const response = await graphqlRequest(
    client,
    `
        query ShopPlanForCartSync {
          shop {
            plan {
              displayName
              shopifyPlus
            }
          }
        }
      `,
  );

  const plan = response?.body?.data?.shop?.plan || {};
  return {
    shopifyPlus: Boolean(plan.shopifyPlus),
    planDisplayName: String(plan.displayName || "").trim(),
  };
}

async function getShopCartSyncSettings(preferredShop = "") {
  const normalizedPreferredShop = normalizeShopDomain(preferredShop);
  if (!normalizedPreferredShop) {
    return {
      shop: "",
      cartPriceSyncEnabled: false,
      shopifyPlus: false,
      planDisplayName: "",
      cartPriceSyncSupported: false,
    };
  }

  const { rows } = await pool.query(
    `SELECT
       shop,
       COALESCE(cart_price_sync_enabled, false) AS cart_price_sync_enabled
     FROM shops
     WHERE lower(shop) = lower($1)
     LIMIT 1`,
    [normalizedPreferredShop],
  );

  const row = rows[0] || {};
  let planInfo = {
    shopifyPlus: false,
    planDisplayName: "",
  };

  try {
    planInfo = await getShopifyPlusStatus(normalizedPreferredShop);
  } catch (_error) {
    planInfo = {
      shopifyPlus: false,
      planDisplayName: "",
    };
  }

  return {
    shop: String(row.shop || normalizedPreferredShop).trim(),
    cartPriceSyncEnabled: Boolean(row.cart_price_sync_enabled),
    shopifyPlus: planInfo.shopifyPlus,
    planDisplayName: planInfo.planDisplayName,
    cartPriceSyncSupported: planInfo.shopifyPlus,
  };
}

async function getShopBookingBlockSettings(preferredShop = "") {
  const normalizedPreferredShop = normalizeShopDomain(preferredShop);
  if (!normalizedPreferredShop) {
    return {
      shop: "",
      rentalBookingEnabled: false,
    };
  }

  const { rows } = await pool.query(
    `SELECT
       shop,
       COALESCE(rental_booking_enabled, false) AS rental_booking_enabled
     FROM shops
     WHERE lower(shop) = lower($1)
     LIMIT 1`,
    [normalizedPreferredShop],
  );

  const row = rows[0] || {};
  return {
    shop: String(row.shop || normalizedPreferredShop).trim(),
    rentalBookingEnabled:
      typeof row.rental_booking_enabled === "boolean"
        ? row.rental_booking_enabled
        : false,
  };
}

async function setShopCartSyncEnabled(preferredShop = "", enabled = false) {
  const normalizedShop = normalizeShopDomain(preferredShop);
  if (!normalizedShop) {
    throw new Error("Shop domain is required");
  }

  let shopifyPlus = false;
  try {
    ({ shopifyPlus } = await getShopifyPlusStatus(normalizedShop));
  } catch (_error) {
    shopifyPlus = false;
  }

  const nextValue = Boolean(enabled);

  const { rows } = await pool.query(
    `INSERT INTO shops (shop, cart_price_sync_enabled)
     VALUES ($1, $2)
     ON CONFLICT (shop)
     DO UPDATE SET
       cart_price_sync_enabled = EXCLUDED.cart_price_sync_enabled,
       updated_at = NOW()
     RETURNING shop, COALESCE(cart_price_sync_enabled, false) AS cart_price_sync_enabled`,
    [normalizedShop, nextValue],
  );

  const row = rows[0] || {};

  if (nextValue && shopifyPlus) {
    await activateRentalCartTransformForShop(normalizedShop);
  } else {
    await deactivateRentalCartTransformForShop(normalizedShop).catch(() => {});
  }

  return {
    shop: String(row.shop || normalizedShop).trim(),
    cartPriceSyncEnabled: Boolean(row.cart_price_sync_enabled),
    cartPriceSyncSupported: shopifyPlus,
  };
}

async function setShopBookingBlockEnabled(preferredShop = "", enabled = false) {
  const normalizedShop = normalizeShopDomain(preferredShop);
  if (!normalizedShop) {
    throw new Error("Shop domain is required");
  }

  const { rows } = await pool.query(
    `INSERT INTO shops (shop, rental_booking_enabled)
     VALUES ($1, $2)
     ON CONFLICT (shop)
     DO UPDATE SET
       rental_booking_enabled = EXCLUDED.rental_booking_enabled,
       updated_at = NOW()
     RETURNING shop, COALESCE(rental_booking_enabled, false) AS rental_booking_enabled`,
    [normalizedShop, Boolean(enabled)],
  );

  const row = rows[0] || {};
  return {
    shop: String(row.shop || normalizedShop).trim(),
    rentalBookingEnabled: Boolean(row.rental_booking_enabled),
  };
}

module.exports = {
  normalizeShopDomain,
  getShopCartSyncSettings,
  getShopBookingBlockSettings,
  setShopCartSyncEnabled,
  setShopBookingBlockEnabled,
};
