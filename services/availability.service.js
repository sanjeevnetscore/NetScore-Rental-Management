const pool = require("../db");

function normalizeVariantId(rawId) {
  const value = String(rawId || "").trim();
  const match = value.match(/\/(\d+)$/);
  return match ? match[1] : value;
}

function toExternalKey(rawId) {
  const id = normalizeVariantId(rawId);
  return id ? `shopify:${id}` : "";
}

function hasItemSummaryIdentity(row) {
  return Boolean(
    String(row?.ns_id || "").trim() ||
      String(row?.serial_name || "").trim() ||
      String(row?.serial_number || "").trim(),
  );
}

function isAvailableStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return true;
  return normalized === "available";
}

function getStockRows(rows, itemType) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (itemType === "serial") {
    const identified = sourceRows.filter((row) => hasItemSummaryIdentity(row) || Math.max(0, Number(row?.available) || 0) > 0 || Math.max(0, Number(row?.stock) || 0) > 0 || Math.max(0, Number(row?.total_quantity) || 0) > 0);
    return identified.length ? identified : sourceRows;
  }

  if (itemType === "lot" || itemType === "inventory") {
    const inStock = sourceRows.filter((row) => Math.max(0, Number(row.available) || 0) > 0 || Math.max(0, Number(row.stock) || 0) > 0 || Math.max(0, Number(row.total_quantity) || 0) > 0);
    return inStock.length ? inStock : sourceRows;
  }

  return sourceRows;
}

async function checkAvailability(variantId, startDate, endDate, qty) {
  const normalizedVariantId = normalizeVariantId(variantId);
  const externalKey = toExternalKey(normalizedVariantId);

  let booked = 0;
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(quantity), 0) AS booked
       FROM rentals
       WHERE variant_id = $1
       AND status IN ('Reserved', 'On Rent', 'Rented', 'Return')
       AND start_date <= $3
       AND end_date >= $2`,
      [normalizedVariantId, startDate, endDate]
    );
    booked = parseInt(rows?.[0]?.booked || 0, 10) || 0;
  } catch (error) {
    // If rentals table is not created yet, don't block storefront pricing/availability checks.
    if (error && error.code !== "42P01") throw error;
  }

  const itemRes = await pool.query(
    `SELECT item_type, stock, total_quantity, available, on_rent, maintenance, reserved, sold, rental_status, ns_id, serial_name, serial_number
     FROM nst_rms_item_details
     WHERE is_deleted = FALSE
       AND (
         ($1 <> '' AND sku = $1) OR
         ($2 <> '' AND sku = $2) OR
         ($2 <> '' AND product_id::text = $2)
       )`,
    [externalKey, normalizedVariantId]
  );

  if (!itemRes.rows.length) throw new Error("Item not found");

  const itemType = String(itemRes.rows[0].item_type || "").toLowerCase();

  if (itemType === "non_inventory") {
    return true;
  }

  const detailRows = getStockRows(itemRes.rows, itemType);

  let available = 0;

  if (itemType === "serial") {
    available = detailRows.reduce((count, row) => {
      const availableCount = Math.max(0, Number(row?.available) || 0);
      if (availableCount > 0) return count + availableCount;
      const rowStock = Math.max(0, Number(row?.stock) || 0);
      if (rowStock > 0) return count + rowStock;
      const totalQuantity = Math.max(0, Number(row?.total_quantity) || 0);
      if (totalQuantity > 0) return count + totalQuantity;
      return count + (hasItemSummaryIdentity(row) ? 1 : 0);
    }, 0);
    if (available <= 0) {
      available = detailRows.length;
    }
  } else {
    const summaryAvailable = Math.max(0, Number(itemRes.rows[0]?.available) || 0);
    if (summaryAvailable > 0) {
      available = summaryAvailable;
    } else {
      const availableSum = detailRows.reduce((sum, row) => {
        return sum + Math.max(0, Number(row?.available) || 0);
      }, 0);
      if (availableSum > 0) {
        available = availableSum;
      } else {
        const stockSum = detailRows.reduce((sum, row) => {
          return sum + Math.max(0, Number(row?.stock) || 0);
        }, 0);
        if (stockSum > 0) {
          available = stockSum;
        } else {
          available = detailRows.reduce((sum, row) => {
            return sum + Math.max(0, Number(row?.total_quantity) || 0);
          }, 0);
        }
      }
    }
  }

  return available - booked >= qty;
}

module.exports = { checkAvailability };
