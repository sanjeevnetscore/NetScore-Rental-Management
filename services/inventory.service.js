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

function isAvailableStatus(status) {
  return String(status || "").trim().toLowerCase() === "available";
}

function hasItemSummaryIdentity(row) {
  return Boolean(
    String(row?.ns_id || "").trim() ||
      String(row?.serial_name || "").trim() ||
      String(row?.serial_number || "").trim(),
  );
}

function getRowQuantity(row, itemType) {
  if (String(itemType || "").trim().toLowerCase() === "serial") {
    return 1;
  }

  const rowAvailable = Math.max(0, Number(row?.available) || 0);
  if (rowAvailable > 0) return rowAvailable;

  const rowStock = Math.max(0, Number(row?.stock) || 0);
  if (rowStock > 0) return rowStock;

  const totalQuantity = Math.max(0, Number(row?.total_quantity) || 0);
  if (totalQuantity > 0) return totalQuantity;

  return 0;
}

async function loadInventoryRows(clientOrPool, normalizedVariantId) {
  const externalKey = toExternalKey(normalizedVariantId);
  const { rows } = await clientOrPool.query(
    `SELECT id, item_type, stock, rental_status, ns_id, serial_name, serial_number
     FROM nst_rms_item_details
     WHERE is_deleted = FALSE
       AND sku = $1
     ORDER BY id ASC`,
    [externalKey],
  );
  return rows || [];
}

async function loadRentalCounts(clientOrPool, normalizedVariantId) {
  try {
    const { rows } = await clientOrPool.query(
      `SELECT
          COALESCE(SUM(CASE WHEN status = 'Reserved' THEN quantity ELSE 0 END), 0)::int AS reserved,
          COALESCE(SUM(CASE WHEN status IN ('On Rent', 'Rented') THEN quantity ELSE 0 END), 0)::int AS on_rent
       FROM rentals
       WHERE variant_id = $1`,
      [normalizedVariantId],
    );
    return {
      reserved: Math.max(0, Number(rows?.[0]?.reserved) || 0),
      on_rent: Math.max(0, Number(rows?.[0]?.on_rent) || 0),
    };
  } catch (error) {
    if (error?.code === "42P01") {
      return { reserved: 0, on_rent: 0 };
    }
    throw error;
  }
}

async function updateSerialRowStatuses(clientOrPool, normalizedVariantId, qty, fromStatuses, nextStatus) {
  const rows = await loadInventoryRows(clientOrPool, normalizedVariantId);
  if (!rows.length) return;

  const wantedStatuses = new Set(
    (Array.isArray(fromStatuses) ? fromStatuses : []).map((status) =>
      String(status || "").trim().toLowerCase(),
    ),
  );

  let remaining = Math.max(0, Number(qty) || 0);
  for (const row of rows) {
    if (remaining <= 0) break;
    if (String(row.item_type || "").trim().toLowerCase() !== "serial") break;
    if (!hasItemSummaryIdentity(row)) continue;

    const currentStatus = String(row.rental_status || "").trim().toLowerCase();
    if (!wantedStatuses.has(currentStatus)) continue;

    await clientOrPool.query(
      `UPDATE nst_rms_item_details
       SET rental_status = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [row.id, nextStatus],
    );
    remaining -= 1;
  }
}

async function deductInventory(variantId, qty) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const normalizedVariantId = normalizeVariantId(variantId);
    const externalKey = toExternalKey(normalizedVariantId);

    const { rows } = await client.query(
      `SELECT id, item_type, stock, rental_status, ns_id, serial_name, serial_number
       FROM nst_rms_item_details
       WHERE is_deleted = FALSE
         AND sku = $1
       FOR UPDATE`,
      [externalKey],
    );

    if (!rows.length) {
      throw new Error("Inventory item not found");
    }

    const itemType = String(rows[0].item_type || "").toLowerCase();
    if (itemType === "non_inventory") {
      await client.query("COMMIT");
      return;
    }

    const availableRows = rows
      .filter((row) => hasItemSummaryIdentity(row) && isAvailableStatus(row.rental_status))
      .sort((a, b) => Number(a.id) - Number(b.id));

    const totalAvailable = availableRows.reduce((sum, row) => {
      const rowQty = itemType === "serial" ? 1 : Math.max(0, Number(row.stock) || 0);
      return sum + rowQty;
    }, 0);

    if (totalAvailable < qty) {
      throw new Error("Insufficient stock");
    }

    let remaining = Number(qty) || 0;

    for (const row of availableRows) {
      if (remaining <= 0) break;

      if (itemType === "serial") {
        await client.query(
          `UPDATE nst_rms_item_details
           SET rental_status = 'Reserved',
               updated_at = NOW()
           WHERE id = $1`,
          [row.id],
        );
        remaining -= 1;
        continue;
      }

      const currentStock = Math.max(0, Number(row.stock) || 0);
      if (currentStock <= 0) continue;

      const deduct = Math.min(currentStock, remaining);
      const nextStock = currentStock - deduct;
      const nextStatus = nextStock > 0 ? "Available" : "Reserved";

      await client.query(
        `UPDATE nst_rms_item_details
         SET stock = $2,
             rental_status = $3,
             updated_at = NOW()
         WHERE id = $1`,
        [row.id, nextStock, nextStatus],
      );

      remaining -= deduct;
    }

    await client.query("COMMIT");
    await syncInventoryCounters(normalizedVariantId);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Deduct Inventory Error:", error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function restoreInventory(variantId, qty) {
  try {
    const normalizedVariantId = normalizeVariantId(variantId);
    const externalKey = toExternalKey(normalizedVariantId);

    const { rows } = await pool.query(
      `SELECT id, stock, rental_status, item_type, ns_id, serial_name, serial_number
       FROM nst_rms_item_details
       WHERE is_deleted = FALSE
         AND sku = $1
       ORDER BY id DESC`,
      [externalKey],
    );

    if (!rows.length) {
      throw new Error("Inventory item not found");
    }

    const itemType = String(rows[0].item_type || "").toLowerCase();
    let remaining = Number(qty) || 0;

    for (const row of rows) {
      if (remaining <= 0) break;
      if (!hasItemSummaryIdentity(row)) continue;

      if (itemType === "serial") {
        const currentStatus = String(row.rental_status || "").toLowerCase();
        if (currentStatus !== "reserved" && currentStatus !== "on rent" && currentStatus !== "rented") continue;
        await pool.query(
          `UPDATE nst_rms_item_details
           SET rental_status = 'Available',
               updated_at = NOW()
           WHERE id = $1`,
          [row.id],
        );
        remaining -= 1;
        continue;
      }

      const currentStock = Math.max(0, Number(row.stock) || 0);
      await pool.query(
        `UPDATE nst_rms_item_details
         SET stock = $2,
             rental_status = 'Available',
             updated_at = NOW()
         WHERE id = $1`,
        [row.id, currentStock + remaining],
      );
      remaining = 0;
    }

    await syncInventoryCounters(normalizedVariantId);
  } catch (error) {
    console.error("Restore Inventory Error:", error.message);
    throw error;
  }
}

async function syncInventoryCounters(variantId) {
  const normalizedVariantId = normalizeVariantId(variantId);
  const externalKey = toExternalKey(normalizedVariantId);
  const rows = await loadInventoryRows(pool, normalizedVariantId);

  if (!rows.length) return;

  const itemType = String(rows[0].item_type || "").toLowerCase();
  const detailRows = rows.filter((row) => hasItemSummaryIdentity(row));
  const rentalCounts = await loadRentalCounts(pool, normalizedVariantId);

  const counters = detailRows.reduce(
    (acc, row) => {
      const rowQty = getRowQuantity(row, itemType);
      if (itemType === "serial") {
        acc.total += rowQty;
      }

      const status = String(row.rental_status || "").trim().toLowerCase();
      if (status === "available") acc.available += rowQty;
      if (status === "on rent" || status === "rented") acc.on_rent += rowQty;
      if (status === "maintenance") acc.maintenance += rowQty;
      if (status === "reserved") acc.reserved += rowQty;
      if (status === "sold") acc.sold += rowQty;
      return acc;
    },
    { total: 0, available: 0, on_rent: 0, maintenance: 0, reserved: 0, sold: 0 },
  );

  if (itemType === "lot" || itemType === "inventory") {
    counters.reserved = rentalCounts.reserved;
    counters.on_rent = rentalCounts.on_rent;
    counters.total =
      counters.available +
      counters.on_rent +
      counters.reserved +
      counters.maintenance +
      counters.sold;
  }

  await pool.query(
    `UPDATE nst_rms_item_details
     SET total_quantity = $2,
         available = $3,
         on_rent = $4,
         maintenance = $5,
         reserved = $6,
         sold = $7,
         updated_at = NOW()
     WHERE sku = $1`,
    [
      externalKey,
      counters.total,
      counters.available,
      counters.on_rent,
      counters.maintenance,
      counters.reserved,
      counters.sold,
    ],
  );
}

async function syncInventoryStateForOrder(orderId, nextStatus) {
  const cleanOrderId = String(orderId || "").trim();
  const cleanStatus = String(nextStatus || "").trim();
  if (!cleanOrderId || !cleanStatus) return;

  let rentalRows;
  try {
    const result = await pool.query(
      `SELECT variant_id, COALESCE(SUM(quantity), 0)::int AS quantity
       FROM rentals
       WHERE shopify_order_id = $1
       GROUP BY variant_id`,
      [cleanOrderId],
    );
    rentalRows = result.rows || [];
  } catch (error) {
    if (error?.code === "42P01") return;
    throw error;
  }

  for (const row of rentalRows) {
    const variantId = normalizeVariantId(row.variant_id);
    const quantity = Math.max(0, Number(row.quantity) || 0);
    if (!variantId || quantity <= 0) continue;

    const inventoryRows = await loadInventoryRows(pool, variantId);
    if (!inventoryRows.length) continue;

    const itemType = String(inventoryRows[0].item_type || "").trim().toLowerCase();

    if (cleanStatus === "On Rent" && itemType === "serial") {
      await updateSerialRowStatuses(pool, variantId, quantity, ["reserved"], "On Rent");
    }

    if (cleanStatus === "Return") {
      await restoreInventory(variantId, quantity);
      continue;
    }

    await syncInventoryCounters(variantId);
  }
}

module.exports = { deductInventory, restoreInventory, syncInventoryCounters, syncInventoryStateForOrder };
