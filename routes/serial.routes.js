const Router = require("@koa/router");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth.middleware");

const router = new Router();


// ✅ Get Serials
router.get("/api/admin/serials/:variantId", requireAuth, async (ctx) => {
  const { variantId } = ctx.params;

  const { rows } = await pool.query(
    `SELECT * FROM rms_item_units
     WHERE variant_id = $1
     AND unit_type = 'serial'
     ORDER BY id DESC`,
    [variantId]
  );

  ctx.body = rows;
});


// ✅ Serial Counts
router.get("/api/admin/serials-count/:variantId", requireAuth, async (ctx) => {
  const { variantId } = ctx.params;

  const { rows } = await pool.query(
    `SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status='available') AS available,
        COUNT(*) FILTER (WHERE status='rented') AS rented,
        COUNT(*) FILTER (WHERE status='reserved') AS reserved
     FROM rms_item_units
     WHERE variant_id = $1
     AND unit_type='serial'`,
    [variantId]
  );

  ctx.body = rows[0];
});


// ✅ Save Serial
router.post("/api/admin/serials", requireAuth, async (ctx) => {
  const { variantId, serial_number, serial_name } = ctx.request.body;

  const { rows } = await pool.query(
    `INSERT INTO rms_item_units
     (shop, variant_id, unit_type, serial_number, serial_name, status)
     VALUES ($1, $2, 'serial', $3, $4, 'available')
     RETURNING *`,
    [ctx.state.shop, variantId, serial_number, serial_name]
  );

  ctx.body = rows[0];
});


// ✅ Update Serial
router.put("/api/admin/serials/:id", requireAuth, async (ctx) => {
  const { id } = ctx.params;
  const { status } = ctx.request.body;

  await pool.query(
    `UPDATE rms_item_units
     SET status = $1
     WHERE id = $2`,
    [status, id]
  );

  ctx.body = { success: true };
});


// ✅ Delete Serial
router.delete("/api/admin/serials/:id", requireAuth, async (ctx) => {
  const { id } = ctx.params;

  await pool.query(
    `DELETE FROM rms_item_units WHERE id = $1`,
    [id]
  );

  ctx.body = { success: true };
});

module.exports = router;
