const Router = require("@koa/router");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth.middleware");
const {
  calculateRemainingDays,
  checkLicenseStatus,
  getAdminCustomerType,
} = require("../services/license.service");
const {
  normalizeShopDomain: normalizeSettingsShopDomain,
  getShopCartSyncSettings,
  getShopBookingBlockSettings,
  setShopCartSyncEnabled,
  setShopBookingBlockEnabled,
} = require("../services/shop-settings.service");
const { syncShopifyInventoryByVariantId } = require("../services/shopify-inventory.service");
const { activateRentalCartTransformForShop } = require("../services/cart-transform.service");
const shopify = require("../shopify");

const router = new Router();

function toDbVariantId(rawId) {
  if (!rawId) return "";
  const value = String(rawId).trim();
  const match = value.match(/\/(\d+)$/);
  return match ? match[1] : value;
}

function toNumericId(rawId) {
  if (!rawId) return "";
  const value = String(rawId).trim();
  const match = value.match(/\/(\d+)$/);
  return match ? match[1] : value;
}

function toExternalKey(rawId) {
  const id = toDbVariantId(rawId);
  return id ? `shopify:${id}` : "";
}

function toSafeBigIntString(value) {
  const v = String(value || "").trim();
  return /^\d+$/.test(v) ? v : null;
}

async function loadConfigByVariantId(rawVariantId, rawProductId = "") {
  const dbVariantId = toDbVariantId(rawVariantId);
  const externalKey = toExternalKey(dbVariantId);
  const dbProductId = toNumericId(rawProductId);

  const itemRes = await pool.query(
    `SELECT id, item_type, daily_rate, weekly_rate, monthly_rate,
            total_quantity, available, on_rent, maintenance, reserved, sold,
            is_deleted, is_rental_item,
            ns_id, serial_name, serial_number, stock, rental_status, item_status, visibility
     FROM nst_rms_item_details
     WHERE (sku = $1 OR product_id::text = $2 OR ($3 <> '' AND product_id::text = $3))
     ORDER BY id ASC`,
    [externalKey, dbVariantId, dbProductId]
  );

  const rows = itemRes.rows || [];
  const configured = rows.length > 0;
  const activeRows = rows.filter((r) => !Boolean(r.is_deleted));
  const item = (activeRows[0] || rows[0] || {});
  const rentalEnabled = activeRows.some((r) => Boolean(r.is_rental_item));

  const detailsType = item.item_type === "lot" ? "lot" : "serial";

  const serialItems = activeRows
    .filter((r) => r.item_type === detailsType)
    .filter((r) => {
      const nsId = String(r.ns_id || "").trim();
      const serialName = String(r.serial_name || "").trim();
      const serialNumber = String(r.serial_number || "").trim();
      return nsId || serialName || serialNumber;
    })
    .map((r) => ({
      id: r.id,
      ns_id: r.ns_id || "",
      serial_name: r.serial_name || "",
      serial_number: r.serial_number || "",
      stock: Number(r.stock) || 1,
      rental_status: r.rental_status || "Available",
      item_status: r.item_status || "Active",
      visibility: r.visibility || "visible",
    }));

  const summaryFromRows = serialItems.reduce(
    (acc, row) => {
      const qty = detailsType === "lot" ? Math.max(1, Number(row.stock) || 1) : 1;
      acc.total += qty;
      const status = (row.rental_status || "").toLowerCase();
      if (status === "available") acc.available += qty;
      if (status === "on rent") acc.on_rent += qty;
      if (status === "maintenance") acc.maintenance += qty;
      if (status === "reserved") acc.reserved += qty;
      if (status === "sold") acc.sold += qty;
      return acc;
    },
    { total: 0, available: 0, on_rent: 0, maintenance: 0, reserved: 0, sold: 0 }
  );

  const summaryFromCounters = {
    total: Math.max(0, Number(item.total_quantity) || 0),
    available: Math.max(0, Number(item.available) || 0),
    on_rent: Math.max(0, Number(item.on_rent) || 0),
    maintenance: Math.max(0, Number(item.maintenance) || 0),
    reserved: Math.max(0, Number(item.reserved) || 0),
    sold: Math.max(0, Number(item.sold) || 0),
  };

  const serialSummary = detailsType === "lot"
    ? summaryFromCounters
    : {
        total: summaryFromRows.total,
        available: summaryFromRows.available,
        on_rent: summaryFromRows.on_rent,
        maintenance: summaryFromRows.maintenance,
        reserved: summaryFromRows.reserved,
        sold: summaryFromRows.sold,
      };

  return {
    configured,
    rentalEnabled,
    itemType: configured ? (item.item_type || "") : "",
    rates: {
      daily_rate: item.daily_rate || "",
      weekly_rate: item.weekly_rate || "",
      monthly_rate: item.monthly_rate || "",
    },
    serialSummary,
    serialDetails: {
      id: (serialItems[serialItems.length - 1]?.id) || item.id || "",
      ns_id: (serialItems[serialItems.length - 1]?.ns_id) || item.ns_id || "",
      serial_name: (serialItems[serialItems.length - 1]?.serial_name) || item.serial_name || "",
      serial_number: (serialItems[serialItems.length - 1]?.serial_number) || item.serial_number || "",
      stock: Number((serialItems[serialItems.length - 1]?.stock) || item.stock || 1),
      rental_status: (serialItems[serialItems.length - 1]?.rental_status) || item.rental_status || "Available",
      item_status: (serialItems[serialItems.length - 1]?.item_status) || item.item_status || "Active",
      visibility: (serialItems[serialItems.length - 1]?.visibility) || item.visibility || "visible",
    },
    serialItems,
  };
}

function normalizeShopDomain(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  return value.endsWith(".myshopify.com") ? value : `${value}.myshopify.com`;
}

function isUnauthorizedError(err) {
  const message = String(err?.message || "");
  const responseStatus =
    err?.response?.status ||
    err?.status ||
    err?.code ||
    err?.body?.status;
  if (responseStatus === 401 || responseStatus === 403) return true;
  return /unauthorized|access denied|forbidden|invalid api key|invalid access token|401|403/i.test(
    message,
  );
}

function buildReauthError(preferredShop = "") {
  const suggestedShop =
    normalizeShopDomain(preferredShop) || "rental-management-app-2.myshopify.com";
  const err = new Error("Shopify re-authentication required");
  err.status = 401;
  err.reauthUrl = `/auth?shop=${suggestedShop}`;
  return err;
}

function respondWithError(ctx, err, fallbackMessage, preferredShop = "") {
  let finalError = err || new Error(fallbackMessage || "Unknown error");
  if (!finalError.reauthUrl && isUnauthorizedError(finalError)) {
    finalError = buildReauthError(preferredShop);
  }

  ctx.status = finalError?.status || 500;
  ctx.body = {
    error: true,
    message: fallbackMessage,
    detail: finalError?.message || "Unknown error",
    reauthUrl: finalError?.reauthUrl || "",
  };
}

function extractShopFromReferer(referer) {
  try {
    if (!referer) return "";
    const url = new URL(referer);
    const fromQuery = normalizeShopDomain(url.searchParams.get("shop"));
    if (fromQuery) return fromQuery;

    // admin.shopify.com/store/{shop-handle}/... -> {shop-handle}.myshopify.com
    const match = url.pathname.match(/\/store\/([^/]+)/i);
    if (match?.[1]) {
      return normalizeShopDomain(match[1]);
    }

    return "";
  } catch {
    return "";
  }
}

async function getStoredShopSession(preferredShop = "") {
  const normalizedPreferredShop = normalizeShopDomain(preferredShop);
  if (normalizedPreferredShop) {
    const preferred = await pool.query(
      `SELECT shop, access_token
       FROM shops
       WHERE lower(shop) = lower($1)
         AND access_token IS NOT NULL
       LIMIT 1`,
      [normalizedPreferredShop],
    );

    if (preferred.rows.length) return preferred.rows[0];
    return null;
  }

  const fallback = await pool.query(
    `SELECT shop, access_token
     FROM shops
     WHERE access_token IS NOT NULL
     ORDER BY shop ASC
     LIMIT 1`,
  );

  if (!fallback.rows.length) return null;
  return fallback.rows[0];
}

async function resolveFirstVariantIdForProduct(productId, preferredShop = "") {
  if (!productId) return "";

  const shopSession = await getStoredShopSession(preferredShop);
  if (!shopSession) {
    throw buildReauthError(preferredShop);
  }

  const normalizedProductId = productId.startsWith("gid://")
    ? productId
    : `gid://shopify/Product/${productId}`;

  const client = new shopify.clients.Graphql({
    session: {
      id: `offline_${shopSession.shop}`,
      shop: shopSession.shop,
      accessToken: shopSession.access_token,
      isOnline: false,
    },
  });

  const response = await client.query({
    data: {
      query: `
        query ResolveFirstVariant($id: ID!) {
          product(id: $id) {
            variants(first: 1) {
              nodes {
                id
              }
            }
          }
        }
      `,
      variables: { id: normalizedProductId },
    },
  });

  return response?.body?.data?.product?.variants?.nodes?.[0]?.id || "";
}

async function searchProducts(rawTerm, rawLimit = 12, preferredShop = "") {
  const shopSession = await getStoredShopSession(preferredShop);
  if (!shopSession) {
    throw buildReauthError(preferredShop);
  }

  const limit = Math.min(Math.max(Number(rawLimit) || 12, 1), 50);
  const term = String(rawTerm || "").trim();

  const client = new shopify.clients.Graphql({
    session: {
      id: `offline_${shopSession.shop}`,
      shop: shopSession.shop,
      accessToken: shopSession.access_token,
      isOnline: false,
    },
  });

  const safeTerm = term.replace(/"/g, '\\"');
  const searchQuery = term
    ? `title:*${safeTerm}* OR sku:*${safeTerm}*`
    : "";

  const gqlQuery = term
    ? `
      query SearchProducts($first: Int!, $query: String!) {
        products(first: $first, query: $query, sortKey: RELEVANCE) {
          nodes {
            id
            title
            variants(first: 1) {
              nodes {
                id
                sku
              }
            }
          }
        }
      }
    `
    : `
      query RecentProducts($first: Int!) {
        products(first: $first, sortKey: UPDATED_AT, reverse: true) {
          nodes {
            id
            title
            variants(first: 1) {
              nodes {
                id
                sku
              }
            }
          }
        }
      }
    `;

  const variables = term
    ? { first: limit, query: searchQuery }
    : { first: limit };

  const response = await client.query({
    data: {
      query: gqlQuery,
      variables,
    },
  });

  const nodes = response?.body?.data?.products?.nodes || [];
  const products = nodes.map((p) => {
    const firstVariant = p?.variants?.nodes?.[0] || {};
    return {
      id: p?.id || "",
      numericId: toNumericId(p?.id || ""),
      title: p?.title || "",
      variantId: firstVariant?.id || "",
      variantNumericId: toNumericId(firstVariant?.id || ""),
      sku: firstVariant?.sku || "",
    };
  });

  return products.slice(0, 12);
}

async function getProductsByIds(productIds = [], preferredShop = "") {
  const uniqueIds = [...new Set((productIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!uniqueIds.length) return [];

  const shopSession = await getStoredShopSession(preferredShop);
  if (!shopSession) {
    throw buildReauthError(preferredShop);
  }

  const client = new shopify.clients.Graphql({
    session: {
      id: `offline_${shopSession.shop}`,
      shop: shopSession.shop,
      accessToken: shopSession.access_token,
      isOnline: false,
    },
  });

  const gqlIds = uniqueIds.map((id) =>
    id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`,
  );

  const response = await client.query({
    data: {
      query: `
        query ProductNodes($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              title
              variants(first: 1) {
                nodes {
                  id
                  sku
                }
              }
            }
          }
        }
      `,
      variables: { ids: gqlIds },
    },
  });

  const nodes = Array.isArray(response?.body?.data?.nodes) ? response.body.data.nodes : [];
  return nodes
    .filter(Boolean)
    .map((p) => {
      const firstVariant = p?.variants?.nodes?.[0] || {};
      return {
        id: p?.id || "",
        numericId: toNumericId(p?.id || ""),
        title: p?.title || "",
        variantId: firstVariant?.id || "",
        variantNumericId: toNumericId(firstVariant?.id || ""),
        sku: firstVariant?.sku || "",
      };
    });
}

async function getProductsByVariantIds(variantIds = [], preferredShop = "") {
  const uniqueIds = [
    ...new Set((variantIds || []).map((id) => toNumericId(id)).filter(Boolean)),
  ];
  if (!uniqueIds.length) return [];

  const shopSession = await getStoredShopSession(preferredShop);
  if (!shopSession) {
    throw buildReauthError(preferredShop);
  }

  const client = new shopify.clients.Graphql({
    session: {
      id: `offline_${shopSession.shop}`,
      shop: shopSession.shop,
      accessToken: shopSession.access_token,
      isOnline: false,
    },
  });

  const gqlIds = uniqueIds.map((id) =>
    id.startsWith("gid://") ? id : `gid://shopify/ProductVariant/${id}`,
  );

  const response = await client.query({
    data: {
      query: `
        query VariantNodes($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on ProductVariant {
              id
              sku
              product {
                id
                title
              }
            }
          }
        }
      `,
      variables: { ids: gqlIds },
    },
  });

  const nodes = Array.isArray(response?.body?.data?.nodes)
    ? response.body.data.nodes
    : [];

  return nodes
    .filter(Boolean)
    .map((variant) => ({
      id: variant?.product?.id || "",
      numericId: toNumericId(variant?.product?.id || ""),
      title: variant?.product?.title || "",
      variantId: variant?.id || "",
      variantNumericId: toNumericId(variant?.id || ""),
      sku: variant?.sku || "",
    }));
}

async function getShopInfo(preferredShop = "") {
  const shopSession = await getStoredShopSession(preferredShop);
  if (!shopSession) {
    throw buildReauthError(preferredShop);
  }

  const client = new shopify.clients.Graphql({
    session: {
      id: `offline_${shopSession.shop}`,
      shop: shopSession.shop,
      accessToken: shopSession.access_token,
      isOnline: false,
    },
  });

  const response = await client.query({
    data: {
      query: `
        query ShopInfo {
          shop {
            currencyCode
          }
        }
      `,
    },
  });

  return {
    shop: shopSession.shop,
    currencyCode: response?.body?.data?.shop?.currencyCode || "USD",
  };
}

async function getCartTransformStatus(preferredShop = "") {
  const shopSession = await getStoredShopSession(preferredShop);
  if (!shopSession) {
    throw buildReauthError(preferredShop);
  }

  const client = new shopify.clients.Graphql({
    session: {
      id: `offline_${shopSession.shop}`,
      shop: shopSession.shop,
      accessToken: shopSession.access_token,
      isOnline: false,
    },
  });

  const response = await client.query({
    data: {
      query: `
        query CartTransformStatus {
          shop {
            name
            plan {
              displayName
              partnerDevelopment
              shopifyPlus
            }
          }
          cartTransforms(first: 10) {
            nodes {
              id
              functionId
              blockOnFailure
            }
          }
          shopifyFunctions(first: 50) {
            nodes {
              id
              title
              apiType
              app {
                title
              }
            }
          }
        }
      `,
    },
  });

  const body = response?.body?.data || {};
  const functions = Array.isArray(body?.shopifyFunctions?.nodes)
    ? body.shopifyFunctions.nodes.filter((node) => String(node?.apiType || "").toLowerCase() === "cart_transform")
    : [];

  return {
    shop: shopSession.shop,
    plan: body?.shop?.plan || null,
    cartTransforms: body?.cartTransforms?.nodes || [],
    shopifyFunctions: functions,
  };
}

router.get("/api/admin/license", async (ctx) => {
  // Check if user is logged in
  if (!ctx.session.user) {
    ctx.status = 401;
    ctx.body = { error: "Not logged in" };
    return;
  }

  const sessionUser = { ...ctx.session.user };
  if (sessionUser.plan_end_date) {
    const remainingDays = calculateRemainingDays(sessionUser.plan_end_date);
    sessionUser.remainingDays = remainingDays;
    sessionUser.plan_active = remainingDays >= 0;
  } else {
    const liveStatus = await checkLicenseStatus();
    if (liveStatus && !liveStatus.error) {
      sessionUser.plan_end_date = liveStatus.planEndDate || sessionUser.plan_end_date || null;
      sessionUser.remainingDays = liveStatus.remainingDays;
      sessionUser.plan_active = !liveStatus.isExpired;
      sessionUser.customerType = liveStatus.customerType || sessionUser.customerType || null;
    } else {
      sessionUser.remainingDays = 0;
      sessionUser.plan_active = false;
    }
  }

  ctx.session.user = sessionUser;
  ctx.body = sessionUser;
});

/**
 * Get detailed license status
 */
router.get("/api/admin/license/status", async (ctx) => {
  try {
    const sessionUser = ctx.session?.user;
    if (sessionUser?.plan_end_date) {
      const remainingDays = calculateRemainingDays(sessionUser.plan_end_date);
      ctx.body = {
        isExpired: remainingDays < 0,
        planEndDate: sessionUser.plan_end_date,
        remainingDays: Math.max(0, remainingDays),
        customerType: sessionUser.customerType || sessionUser.loginType || null,
      };
      return;
    }

    const status = await checkLicenseStatus();
    ctx.body = status;
  } catch (err) {
    console.error("License status error:", err.message);
    ctx.status = 500;
    ctx.body = { error: "Failed to check license status" };
  }
});

/**
 * Get customer type (netsuite or rental)
 */
router.get("/api/admin/license/customer-type", async (ctx) => {
  try {
    const customerType =
      ctx.session?.user?.customerType ||
      ctx.session?.user?.loginType ||
      (await getAdminCustomerType());
    ctx.body = { customerType };
  } catch (err) {
    console.error("Customer type error:", err.message);
    ctx.status = 500;
    ctx.body = { error: "Failed to get customer type" };
  }
});

router.get("/api/admin/cart-sync-settings", requireAuth, async (ctx) => {
  try {
    const preferredShop =
      normalizeSettingsShopDomain(ctx.query.shop) ||
      normalizeSettingsShopDomain(ctx.get("x-shopify-shop-domain")) ||
      normalizeSettingsShopDomain(ctx.session?.shop?.shop) ||
      normalizeSettingsShopDomain(ctx.session?.user?.shop || "");

    const settings = await getShopCartSyncSettings(preferredShop);
    ctx.body = {
      success: true,
      ...settings,
    };
  } catch (err) {
    console.error("Cart sync settings load error:", err?.message || err);
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: "Failed to load cart sync settings",
    };
  }
});

router.post("/api/admin/cart-sync-settings", requireAuth, async (ctx) => {
  try {
    const payload = ctx.request.body || {};
    const preferredShop =
      normalizeSettingsShopDomain(payload.shop) ||
      normalizeSettingsShopDomain(ctx.query.shop) ||
      normalizeSettingsShopDomain(ctx.get("x-shopify-shop-domain")) ||
      normalizeSettingsShopDomain(ctx.session?.shop?.shop) ||
      normalizeSettingsShopDomain(ctx.session?.user?.shop || "");
    const enabled = Boolean(payload.enabled);

    const settings = await setShopCartSyncEnabled(preferredShop, enabled);
    ctx.body = {
      success: true,
      ...settings,
    };
  } catch (err) {
    console.error("Cart sync settings save error:", err?.message || err);
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: err?.message || "Failed to save cart sync settings",
    };
  }
});

router.get("/api/admin/booking-settings", requireAuth, async (ctx) => {
  try {
    const preferredShop =
      normalizeSettingsShopDomain(ctx.query.shop) ||
      normalizeSettingsShopDomain(ctx.get("x-shopify-shop-domain")) ||
      normalizeSettingsShopDomain(ctx.session?.shop?.shop) ||
      normalizeSettingsShopDomain(ctx.session?.user?.shop || "");

    const settings = await getShopBookingBlockSettings(preferredShop);
    ctx.body = {
      success: true,
      ...settings,
    };
  } catch (err) {
    console.error("Booking settings load error:", err?.message || err);
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: "Failed to load booking settings",
    };
  }
});

router.post("/api/admin/booking-settings", requireAuth, async (ctx) => {
  try {
    const payload = ctx.request.body || {};
    const preferredShop =
      normalizeSettingsShopDomain(payload.shop) ||
      normalizeSettingsShopDomain(ctx.query.shop) ||
      normalizeSettingsShopDomain(ctx.get("x-shopify-shop-domain")) ||
      normalizeSettingsShopDomain(ctx.session?.shop?.shop) ||
      normalizeSettingsShopDomain(ctx.session?.user?.shop || "");
    const enabled = Boolean(payload.enabled);

    const settings = await setShopBookingBlockEnabled(preferredShop, enabled);
    ctx.body = {
      success: true,
      ...settings,
    };
  } catch (err) {
    console.error("Booking settings save error:", err?.message || err);
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: err?.message || "Failed to save booking settings",
    };
  }
});

/**
 * Simple rates update endpoint (legacy)
 */
router.post("/api/admin/rates", requireAuth, async (ctx) => {
  const { daily_rate, weekly_rate, monthly_rate } = ctx.request.body;

  await pool.query(
    `UPDATE nst_rms_item_details
     SET daily_rate = $1,
         weekly_rate = $2,
         monthly_rate = $3
     WHERE variant_id = $4`,
    [daily_rate, weekly_rate, monthly_rate, ctx.request.body.variantId]
  );

  ctx.body = { success: true };
});

/**
 * Unified Rental Configuration - LOAD
 *
 * This powers the ProductConfiguration page for a given variant.
 * It aggregates item type + rates + serial items into a single payload
 * shaped exactly as the frontend expects.
 */
router.get("/api/admin/config/:variantId", async (ctx) => {
  const { variantId } = ctx.params;
  ctx.body = await loadConfigByVariantId(decodeURIComponent(variantId));
});

router.get("/api/admin/resolve-variant/:productId", async (ctx) => {
  const { productId } = ctx.params;
  if (!productId) ctx.throw(400, "Product ID is required");
  const preferredShop =
    normalizeShopDomain(ctx.query.shop) ||
    normalizeShopDomain(ctx.get("x-shopify-shop-domain")) ||
    extractShopFromReferer(ctx.get("referer"));

  try {
    const variantId = await resolveFirstVariantIdForProduct(productId, preferredShop);
    ctx.body = { variantId };
  } catch (err) {
    console.error("Resolve variant error:", err);
    respondWithError(ctx, err, "Failed to resolve variant for this product", preferredShop);
  }
});

router.get("/api/admin/products/search", async (ctx) => {
  const preferredShop =
    normalizeShopDomain(ctx.query.shop) ||
    normalizeShopDomain(ctx.get("x-shopify-shop-domain")) ||
    extractShopFromReferer(ctx.get("referer"));

  try {
    const q = ctx.query.q || "";
    const limit = ctx.query.limit || 12;
    const products = await searchProducts(q, limit, preferredShop);
    ctx.body = { products };
  } catch (err) {
    console.error("Product search error:", err);
    respondWithError(ctx, err, "Failed to search products", preferredShop);
  }
});

router.get("/api/admin/products/by-ids", async (ctx) => {
  const preferredShop =
    normalizeShopDomain(ctx.query.shop) ||
    normalizeShopDomain(ctx.get("x-shopify-shop-domain")) ||
    extractShopFromReferer(ctx.get("referer"));

  try {
    const rawIds = String(ctx.query.ids || "");
    const ids = rawIds
      .split(",")
      .map((v) => toNumericId(v))
      .filter(Boolean);

    const products = await getProductsByIds(ids, preferredShop);
    ctx.body = { products };
  } catch (err) {
    console.error("Product by-ids error:", err);
    respondWithError(ctx, err, "Failed to load products", preferredShop);
  }
});

router.get("/api/admin/configured-products", async (ctx) => {
  const preferredShop =
    normalizeShopDomain(ctx.query.shop) ||
    normalizeShopDomain(ctx.get("x-shopify-shop-domain")) ||
    extractShopFromReferer(ctx.get("referer"));

  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (COALESCE(NULLIF(product_id::text, ''), NULLIF(sku, '')))
          product_id,
          sku,
          item_type,
          updated_at,
          id
       FROM nst_rms_item_details
       WHERE COALESCE(is_rental_item, FALSE) = TRUE
         AND COALESCE(is_deleted, FALSE) = FALSE
         AND (
           NULLIF(product_id::text, '') IS NOT NULL
           OR NULLIF(sku, '') IS NOT NULL
         )
       ORDER BY COALESCE(NULLIF(product_id::text, ''), NULLIF(sku, '')), updated_at DESC, id DESC`,
    );

    const savedRows = rows || [];
    const productIds = savedRows
      .map((row) => toNumericId(row?.product_id || ""))
      .filter(Boolean);
    const variantIds = savedRows
      .map((row) => {
        const sku = String(row?.sku || "").trim();
        return sku.startsWith("shopify:") ? toNumericId(sku.slice("shopify:".length)) : "";
      })
      .filter(Boolean);

    const [productsById, productsByVariant] = await Promise.all([
      getProductsByIds(productIds, preferredShop),
      getProductsByVariantIds(variantIds, preferredShop),
    ]);

    const productIdMap = new Map(
      productsById.map((product) => [toNumericId(product?.numericId || product?.id || ""), product]),
    );
    const variantIdMap = new Map(
      productsByVariant.map((product) => [toNumericId(product?.variantNumericId || product?.variantId || ""), product]),
    );

    const products = savedRows
      .map((row) => {
        const productId = toNumericId(row?.product_id || "");
        const sku = String(row?.sku || "").trim();
        const variantId = sku.startsWith("shopify:")
          ? toNumericId(sku.slice("shopify:".length))
          : "";
        const product =
          productIdMap.get(productId) ||
          variantIdMap.get(variantId) ||
          null;

        return {
          id: String(product?.numericId || productId || ""),
          name: String(product?.title || ""),
          sku: String(product?.sku || sku || "-"),
          variantNumericId: String(product?.variantNumericId || variantId || ""),
          itemType: String(row?.item_type || ""),
        };
      })
      .filter((product) => Boolean(product.id));

    ctx.body = { products };
  } catch (err) {
    console.error("Configured products error:", err);
    respondWithError(ctx, err, "Failed to load configured rental products", preferredShop);
  }
});

router.get("/api/admin/shop-info", async (ctx) => {
  const preferredShop =
    normalizeShopDomain(ctx.query.shop) ||
    normalizeShopDomain(ctx.get("x-shopify-shop-domain")) ||
    extractShopFromReferer(ctx.get("referer"));

  try {
    const shopInfo = await getShopInfo(preferredShop);
    ctx.body = shopInfo;
  } catch (err) {
    console.error("Shop info error:", err);
    respondWithError(ctx, err, "Failed to load shop info", preferredShop);
  }
});

router.get("/api/admin/cart-transform-status", async (ctx) => {
  const preferredShop =
    normalizeShopDomain(ctx.query.shop) ||
    normalizeShopDomain(ctx.get("x-shopify-shop-domain")) ||
    extractShopFromReferer(ctx.get("referer"));

  try {
    ctx.body = await getCartTransformStatus(preferredShop);
  } catch (err) {
    console.error("Cart transform status error:", err);
    respondWithError(ctx, err, "Failed to load cart transform status", preferredShop);
  }
});

async function handleCartTransformRefresh(ctx) {
  const preferredShop =
    normalizeShopDomain(ctx.query.shop) ||
    normalizeShopDomain(ctx.get("x-shopify-shop-domain")) ||
    extractShopFromReferer(ctx.get("referer"));

  try {
    const cartTransform = await activateRentalCartTransformForShop(preferredShop);
    ctx.body = {
      success: true,
      cartTransform,
    };
  } catch (err) {
    console.error("Cart transform refresh error:", err);
    respondWithError(ctx, err, "Failed to refresh cart transform", preferredShop);
  }
}

router.get("/api/admin/cart-transform-refresh", handleCartTransformRefresh);
router.post("/api/admin/cart-transform-refresh", async (ctx) => {
  try {
    await handleCartTransformRefresh(ctx);
  } catch (_err) {}
});

router.get("/api/admin/config-by-product/:productId", async (ctx) => {
  const { productId } = ctx.params;
  if (!productId) ctx.throw(400, "Product ID is required");
  const preferredShop =
    normalizeShopDomain(ctx.query.shop) ||
    normalizeShopDomain(ctx.get("x-shopify-shop-domain")) ||
    extractShopFromReferer(ctx.get("referer"));

  let variantId = "";
  try {
    variantId = await resolveFirstVariantIdForProduct(productId, preferredShop);
  } catch (err) {
    console.error("Resolve variant for load error:", err);
    if (err?.reauthUrl) {
      respondWithError(ctx, err, "Failed to load product configuration", preferredShop);
      return;
    }
  }

  if (!variantId) {
    ctx.throw(400, "No variant found for this product");
  }
  ctx.body = await loadConfigByVariantId(variantId, productId);
});

router.get("/api/admin/config", async (ctx) => {
  const rawVariantId = ctx.query.variantId || "";
  const rawProductId = ctx.query.productId || "";
  if (!rawVariantId) {
    ctx.throw(400, "Variant ID is required");
  }

  ctx.body = await loadConfigByVariantId(rawVariantId, rawProductId);
});

router.post("/api/admin/sync-shopify-inventory", async (ctx) => {
  const rawVariantId = toDbVariantId(ctx.request.body?.variantId || "");
  const rawProductId = toNumericId(ctx.request.body?.productId || "");

  const preferredShop =
    normalizeShopDomain(ctx.query.shop) ||
    normalizeShopDomain(ctx.get("x-shopify-shop-domain")) ||
    extractShopFromReferer(ctx.get("referer"));

  let effectiveVariantId = rawVariantId;
  if (!effectiveVariantId && rawProductId) {
    try {
      const resolved = await resolveFirstVariantIdForProduct(rawProductId, preferredShop);
      effectiveVariantId = toDbVariantId(resolved);
    } catch (err) {
      console.error("Resolve variant for manual sync error:", err.message);
    }
  }

  if (!effectiveVariantId) {
    ctx.throw(400, "Variant ID or Product ID is required");
  }

  const syncResult = await syncShopifyInventoryByVariantId(effectiveVariantId, preferredShop);
  ctx.body = { success: true, syncResult };
});

router.post("/api/admin/config/load", async (ctx) => {
  const rawVariantId = ctx.request.body?.variantId || "";
  const rawProductId = ctx.request.body?.productId || "";
  if (!rawVariantId) {
    ctx.throw(400, "Variant ID is required");
  }

  ctx.body = await loadConfigByVariantId(rawVariantId, rawProductId);
});

router.post("/api/admin/serial-item/delete", async (ctx) => {
  const id = Number(ctx.request.body?.id || 0);
  const variantId = toDbVariantId(ctx.request.body?.variantId || "");
  const productId = toNumericId(ctx.request.body?.productId || "");

  if (!id) ctx.throw(400, "Serial item id is required");

  const externalKey = toExternalKey(variantId);

  const deleteRes = await pool.query(
    `UPDATE nst_rms_item_details
     SET is_deleted = TRUE,
         updated_at = NOW()
     WHERE id = $1
       AND (
         ($2 <> '' AND sku = $2)
         OR ($3 <> '' AND product_id::text = $3)
         OR ($4 <> '' AND product_id::text = $4)
       )`,
    [id, externalKey, variantId, productId]
  );

  if (deleteRes.rowCount === 0) {
    ctx.throw(404, "Serial item not found");
  }

  let syncResult = null;
  let syncError = null;
  if (variantId) {
    try {
      const preferredShop =
        normalizeShopDomain(ctx.query.shop) ||
        normalizeShopDomain(ctx.get("x-shopify-shop-domain")) ||
        extractShopFromReferer(ctx.get("referer"));
      syncResult = await syncShopifyInventoryByVariantId(variantId, preferredShop);
    } catch (syncErr) {
      console.error("Shopify inventory sync failed after serial delete:", syncErr.message);
      syncError = syncErr.message;
    }
  }

  ctx.body = { success: true, syncResult, syncError };
});

/**
 * Unified Rental Configuration - SAVE
 *
 * Updates item type + rates in nst_rms_item_details.
 */
router.post("/api/admin/config", async (ctx) => {
  const {
    variantId,
    productId,
    rentalEnabled,
    itemType,
    rates,
    serialDetails,
    saveSerialItem,
  } = ctx.request.body;

  let effectiveVariantId = toDbVariantId(variantId || "");
  if (!effectiveVariantId && productId) {
    const preferredShop =
      normalizeShopDomain(ctx.query.shop) ||
      normalizeShopDomain(ctx.get("x-shopify-shop-domain")) ||
      extractShopFromReferer(ctx.get("referer"));
    try {
      const resolved = await resolveFirstVariantIdForProduct(productId, preferredShop);
      effectiveVariantId = toDbVariantId(resolved);
    } catch (err) {
      console.error("Resolve variant for save error:", err);
    }
  }

  if (!effectiveVariantId) {
    ctx.throw(400, "Variant ID is required");
  }

  const safeItemType =
    itemType === "inventory" ||
    itemType === "serial" ||
    itemType === "lot" ||
    itemType === "non_inventory"
      ? itemType
      : "serial";

  const dailyRate = rates?.daily_rate || null;
  const weeklyRate = rates?.weekly_rate || null;
  const monthlyRate = rates?.monthly_rate || null;
  const softDeleted = rentalEnabled === false;
  const safeSerialDetails = serialDetails || {};
  const safeStock = safeItemType === "serial" ? 1 : Number(safeSerialDetails.stock) || 1;
  const externalKey = toExternalKey(effectiveVariantId);
  const normalizedProductId = toNumericId(productId || "");
  const safeProductIdBigInt = toSafeBigIntString(normalizedProductId);

  await pool.query("BEGIN");

  try {
    // Save one detail row when explicitly adding/editing serial/lot item.
    if (saveSerialItem && (safeItemType === "serial" || safeItemType === "lot")) {
      const safeSerialId = Number(safeSerialDetails.id || 0);
      if (safeSerialId > 0) {
        const updateSerialRes = await pool.query(
          `UPDATE nst_rms_item_details
           SET ns_id = $1,
               serial_name = $2,
               serial_number = $3,
               stock = $4,
               rental_status = $5,
               item_status = $6,
               visibility = $7,
               updated_at = NOW()
           WHERE id = $8
             AND (
               sku = $9 OR
               product_id::text = $10 OR
               ($11 <> '' AND product_id::text = $11) OR
               ($12 <> '' AND product_id::text = $12)
             )`,
          [
            safeSerialDetails.ns_id || null,
            safeSerialDetails.serial_name || null,
            safeSerialDetails.serial_number || null,
            safeStock,
            safeSerialDetails.rental_status || "Available",
            safeSerialDetails.item_status || "Active",
            safeSerialDetails.visibility || "visible",
            safeSerialId,
            externalKey,
            effectiveVariantId,
            normalizedProductId,
            safeProductIdBigInt || "",
          ]
        );

        if (updateSerialRes.rowCount === 0) {
          ctx.throw(404, "Serial item not found for update");
        }
      } else {
        await pool.query(
          `INSERT INTO nst_rms_item_details
           (product_id, sku, item_type, daily_rate, weekly_rate, monthly_rate, is_deleted,
            is_rental_item, is_serialised_inventory_item, is_inventory_item, is_lot_inventory_item,
            is_non_inventory_item,
            ns_id, serial_name, serial_number, stock, rental_status, item_status, visibility)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
                   $8, $9, $10, $11, $12,
                   $13, $14, $15, $16, $17, $18, $19)`,
          [
            safeProductIdBigInt,
            externalKey,
            safeItemType,
            dailyRate,
            weeklyRate,
            monthlyRate,
            softDeleted,
            rentalEnabled,
            itemType === "serial",
            itemType === "inventory",
            itemType === "lot",
            itemType === "non_inventory",
            safeSerialDetails.ns_id || null,
            safeSerialDetails.serial_name || null,
            safeSerialDetails.serial_number || null,
            safeStock,
            safeSerialDetails.rental_status || "Available",
            safeSerialDetails.item_status || "Active",
            safeSerialDetails.visibility || "visible",
          ]
        );
      }
    } else {
        // Persist rates/config across all rows for this product/variant.
        const updateRes = await pool.query(
          `UPDATE nst_rms_item_details
           SET item_type   = $1,
               daily_rate  = $2,
               weekly_rate = $3,
               monthly_rate = $4,
               is_deleted = $5,
               is_rental_item = $9,
               is_serialised_inventory_item = $10,
               is_inventory_item = $11,
               is_lot_inventory_item = $12,
               is_non_inventory_item = $13,
               product_id = COALESCE($8::bigint, product_id),
               updated_at = NOW()
           WHERE
             sku = $6 OR
             product_id::text = $7 OR
             ($14 <> '' AND product_id::text = $14)`,
          [
            safeItemType,
            dailyRate,
            weeklyRate,
            monthlyRate,
            softDeleted,
            externalKey,
            effectiveVariantId,
            safeProductIdBigInt,
            rentalEnabled,
            safeItemType === "serial",
            safeItemType === "inventory",
            safeItemType === "lot",
            safeItemType === "non_inventory",
            safeProductIdBigInt || "",
          ]
        );

      if (updateRes.rowCount === 0) {
        await pool.query(
          `INSERT INTO nst_rms_item_details
           (product_id, sku, item_type, daily_rate, weekly_rate, monthly_rate, is_deleted,
            is_rental_item, is_serialised_inventory_item, is_inventory_item, is_lot_inventory_item,
            is_non_inventory_item,
            ns_id, serial_name, serial_number, stock, rental_status, item_status, visibility)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
                   $8, $9, $10, $11, $12,
                   $13, $14, $15, $16, $17, $18, $19)`,
          [
            safeProductIdBigInt,
            externalKey,
            safeItemType,
            dailyRate,
            weeklyRate,
            monthlyRate,
            softDeleted,
            rentalEnabled,
            safeItemType === "serial",
            safeItemType === "inventory",
            safeItemType === "lot",
            safeItemType === "non_inventory",
            null,
            null,
            null,
            safeItemType === "serial" ? 1 : null,
            null,
            null,
            "visible",
          ]
        );
      }
    }

    await pool.query("COMMIT");

    let syncResult = null;
    let syncError = null;
    try {
      const preferredShop =
        normalizeShopDomain(ctx.query.shop) ||
        normalizeShopDomain(ctx.get("x-shopify-shop-domain")) ||
        extractShopFromReferer(ctx.get("referer"));
      syncResult = await syncShopifyInventoryByVariantId(effectiveVariantId, preferredShop);
    } catch (syncErr) {
      console.error("Shopify inventory sync failed after config save:", syncErr.message);
      syncError = syncErr.message;
    }

    ctx.body = { success: true, syncResult, syncError };
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error("Rental config save error:", err);
    ctx.status = 500;
    ctx.body = {
      error: true,
      message: "Failed to save rental configuration",
      detail: err.message,
    };
  }
});


module.exports = router;



