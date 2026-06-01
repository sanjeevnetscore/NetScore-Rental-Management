const pool = require("../db");
const shopify = require("../shopify");

function normalizeVariantId(rawId) {
  const value = String(rawId || "").trim();
  const match = value.match(/\/(\d+)$/);
  return match ? match[1] : value;
}

function toExternalKey(rawId) {
  const id = normalizeVariantId(rawId);
  return id ? `shopify:${id}` : "";
}

function normalizeShopDomain(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  return value.endsWith(".myshopify.com") ? value : `${value}.myshopify.com`;
}

function extractPreferredShop(ctx) {
  const fromQuery = normalizeShopDomain(ctx?.query?.shop || "");
  if (fromQuery) return fromQuery;

  const fromHeader = normalizeShopDomain(ctx?.get?.("x-shopify-shop-domain") || "");
  if (fromHeader) return fromHeader;

  try {
    const referer = String(ctx?.get?.("referer") || "");
    if (!referer) return "";
    const url = new URL(referer);
    const fromRefererQuery = normalizeShopDomain(url.searchParams.get("shop") || "");
    if (fromRefererQuery) return fromRefererQuery;

    const match = url.pathname.match(/\/store\/([^/]+)/i);
    if (match?.[1]) return normalizeShopDomain(match[1]);
  } catch {
    // ignore
  }

  return "";
}

function toGid(type, rawId) {
  const id = String(rawId || "").trim();
  if (!id) return "";
  return id.startsWith("gid://") ? id : `gid://shopify/${type}/${id}`;
}

function toNumericId(rawId) {
  const value = String(rawId || "").trim();
  const match = value.match(/\/(\d+)$/);
  const resolved = match ? match[1] : value;
  return /^\d+$/.test(resolved) ? resolved : "";
}

function hasItemSummaryIdentity(row) {
  return Boolean(
    String(row?.ns_id || "").trim() ||
      String(row?.serial_name || "").trim() ||
      String(row?.serial_number || "").trim(),
  );
}

function computeAvailableFromRows(rows = [], itemType = "serial") {
  const safeType = String(itemType || "").toLowerCase();
  const detailRows = rows.filter(hasItemSummaryIdentity);

  if (safeType === "serial") {
    return detailRows.filter((row) => String(row.rental_status || "").trim().toLowerCase() === "available").length;
  }

  if (safeType === "lot" || safeType === "inventory") {
    const availableSum = detailRows.reduce((sum, row) => {
      if (String(row.rental_status || "").trim().toLowerCase() !== "available") return sum;
      const rowAvailable = Math.max(0, Number(row.available) || 0);
      if (rowAvailable > 0) return sum + rowAvailable;
      const rowStock = Math.max(0, Number(row.stock) || 0);
      if (rowStock > 0) return sum + rowStock;
      const totalQuantity = Math.max(0, Number(row.total_quantity) || 0);
      if (totalQuantity > 0) return sum + totalQuantity;
      return sum;
    }, 0);
    return availableSum;
  }

  return 0;
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
  }

  const fallback = await pool.query(
    `SELECT shop, access_token
     FROM shops
     WHERE access_token IS NOT NULL
     ORDER BY shop ASC
     LIMIT 1`,
  );

  return fallback.rows[0] || null;
}

async function getInventoryContext(session, variantNumericId) {
  const client = new shopify.clients.Graphql({
    session: {
      id: `offline_${session.shop}`,
      shop: session.shop,
      accessToken: session.access_token,
      isOnline: false,
    },
  });

  const variantGid = toGid("ProductVariant", variantNumericId);
  const inventoryQuery = `
    query InventoryContext($id: ID!) {
      productVariant(id: $id) {
        id
        inventoryItem {
          id
          legacyResourceId
          inventoryLevels(first: 20) {
            nodes {
              location {
                id
                legacyResourceId
              }
            }
          }
        }
      }
      locations(first: 1) {
        nodes {
          id
          legacyResourceId
        }
      }
    }
  `;

  const response = await client.query({
    data: {
      query: inventoryQuery,
      variables: { id: variantGid },
    },
  });

  const variant = response?.body?.data?.productVariant;
  const inventoryItem = variant?.inventoryItem;

  if (!inventoryItem?.legacyResourceId) {
    throw new Error("Could not resolve Shopify inventory item for this variant");
  }

  const configuredLocationId = toNumericId(process.env.SHOPIFY_LOCATION_ID || "");
  const levelLocations = inventoryItem?.inventoryLevels?.nodes || [];
  const levelLocationIds = levelLocations
    .map((node) => toNumericId(node?.location?.legacyResourceId || ""))
    .filter(Boolean);

  let locationNumericId = "";
  if (configuredLocationId && levelLocationIds.includes(configuredLocationId)) {
    locationNumericId = configuredLocationId;
  }

  if (!locationNumericId && levelLocationIds.length) {
    locationNumericId = levelLocationIds[0];
  }

  if (!locationNumericId) {
    locationNumericId = toNumericId(response?.body?.data?.locations?.nodes?.[0]?.legacyResourceId || "");
  }

  if (!locationNumericId) {
    throw new Error("Could not resolve Shopify location for inventory sync");
  }

  return {
    inventoryItemId: toNumericId(inventoryItem.legacyResourceId),
    locationId: locationNumericId,
    levelLocationIds,
  };
}

async function syncShopifyInventoryByVariantId(variantId, preferredShop = "") {
  const normalizedVariantId = normalizeVariantId(variantId);
  if (!normalizedVariantId) throw new Error("Variant ID is required for inventory sync");

  const externalKey = toExternalKey(normalizedVariantId);

  const detailsRes = await pool.query(
    `SELECT item_type, stock, rental_status, ns_id, serial_name, serial_number
     FROM nst_rms_item_details
     WHERE is_deleted = FALSE
       AND sku = $1
     ORDER BY id ASC`,
    [externalKey],
  );

  if (!detailsRes.rows.length) {
    throw new Error("Rental configuration not found for this variant");
  }

  const itemType = String(detailsRes.rows[0]?.item_type || "").toLowerCase();
  const availableQty = itemType === "non_inventory"
    ? 0
    : computeAvailableFromRows(detailsRes.rows, itemType);

  const shopSession = await getStoredShopSession(preferredShop);
  if (!shopSession) {
    throw new Error("No Shopify offline token found. Re-auth required");
  }

  const { inventoryItemId, locationId, levelLocationIds } = await getInventoryContext(
    shopSession,
    normalizedVariantId,
  );

  const restClient = new shopify.clients.Rest({
    session: {
      id: `offline_${shopSession.shop}`,
      shop: shopSession.shop,
      accessToken: shopSession.access_token,
      isOnline: false,
    },
  });

  const allLocationIds = Array.from(
    new Set([...(levelLocationIds || []), String(locationId)].filter(Boolean)),
  );

  for (const locId of allLocationIds) {
    const qtyForLocation = String(locId) === String(locationId) ? Number(availableQty) : 0;
    await restClient.post({
      path: "inventory_levels/set",
      data: {
        location_id: Number(locId),
        inventory_item_id: Number(inventoryItemId),
        available: qtyForLocation,
      },
      type: "application/json",
    });
  }

  return {
    variantId: normalizedVariantId,
    inventoryItemId,
    locationId,
    syncedLocations: allLocationIds,
    availableQty,
  };
}

async function syncShopifyInventory(ctx, variantId) {
  const preferredShop = extractPreferredShop(ctx);
  return syncShopifyInventoryByVariantId(variantId, preferredShop);
}

module.exports = {
  syncShopifyInventory,
  syncShopifyInventoryByVariantId,
};
