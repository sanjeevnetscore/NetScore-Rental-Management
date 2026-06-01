const pool = require("../db");

async function runStatusAutomation() {
  const updated = [];

  const onRentResult = await pool.query(`
    UPDATE rentals
    SET status = 'On Rent',
        updated_at = NOW()
    WHERE status = 'Reserved'
      AND start_date <= NOW()
    RETURNING shop, shopify_order_id, status
  `);
  updated.push(...(onRentResult.rows || []));

  const returnResult = await pool.query(`
    UPDATE rentals
    SET status = 'Return',
        updated_at = NOW()
    WHERE status IN ('On Rent', 'Rented')
      AND end_date <= NOW()
    RETURNING shop, shopify_order_id, status
  `);
  updated.push(...(returnResult.rows || []));

  return updated;
}

module.exports = { runStatusAutomation };
