const Router = require("@koa/router");
const pool = require("../db");
const { requireAuth } = require("../middleware/auth.middleware");

const router = new Router();


// ✅ Get Lots
router.get("/api/admin/lots/:variantId", requireAuth, async (ctx) => {
  const { variantId } = ctx.params;

  const { rows } = await pool.query(
    `SELECT * FROM rms_item_units
     WHERE variant_id = $1
     AND unit_type = 'lot'`,
    [variantId]
  );

  ctx.body = rows;
});


// ✅ Save Lot
router.post("/api/admin/lots", requireAuth, async (ctx) => {
  const { variantId, lot_number, lot_name, quantity } = ctx.request.body;

  const { rows } = await pool.query(
    `INSERT INTO rms_item_units
     (shop, variant_id, unit_type, lot_number, lot_name, quantity)
     VALUES ($1, $2, 'lot', $3, $4, $5)
     RETURNING *`,
    [ctx.state.shop, variantId, lot_number, lot_name, quantity]
  );

  ctx.body = rows[0];
});

module.exports = router;
