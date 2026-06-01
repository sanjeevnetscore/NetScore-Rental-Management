const Router = require("@koa/router");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth.middleware");

const { logSerialEvent } = require("../services/history.service");
const { syncInventoryCounters } = require("../services/inventory.service");
const { syncShopifyInventory } = require("../services/shopify-inventory.service");

const router = new Router();

router.put("/api/admin/serial-status/:id", requireAuth, async (ctx) => {
  const { id } = ctx.params;
  const { status } = ctx.request.body;

  const validStatuses = [
    "available",
    "reserved",
    "rented",
    "maintenance",
    "damaged",
  ];

  if (!validStatuses.includes(status)) {
    ctx.throw(400, "Invalid status");
  }

  await pool.query("BEGIN");

  try {
    // 🔒 Lock serial row
    const serialRes = await pool.query(
      `SELECT * FROM rms_item_units
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );

    if (!serialRes.rows.length) {
      throw new Error("Serial not found");
    }

    const serial = serialRes.rows[0];

    // ✅ Update status
    await pool.query(
      `UPDATE rms_item_units
       SET status = $1,
           updated_at = NOW()
       WHERE id = $2`,
      [status, id]
    );

    // 🕒 Log history event
    await logSerialEvent(id, status.toUpperCase(), "Status updated");

    // 📦 Sync counters in item_details
    await syncInventoryCounters(serial.variant_id);

    // 🛒 Sync Shopify inventory
    await syncShopifyInventory(ctx, serial.variant_id);

    await pool.query("COMMIT");

    ctx.body = { success: true };

  } catch (err) {
    await pool.query("ROLLBACK");
    ctx.throw(400, err.message);
  }
});

module.exports = router;
