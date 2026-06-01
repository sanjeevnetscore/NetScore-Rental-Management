const pool = require("../db");

async function allocateSerial(variantId) {
  const { rows } = await pool.query(
    `SELECT id, serial_number
     FROM rms_item_units
     WHERE variant_id = $1
     AND unit_type = 'serial'
     AND status = 'available'
     LIMIT 1
     FOR UPDATE`,
    [variantId]
  );

  if (!rows.length)
    throw new Error("No serial available");

  const serial = rows[0];

  await pool.query(
    `UPDATE rms_item_units
     SET status = 'reserved'
     WHERE id = $1`,
    [serial.id]
  );

  return serial;
}

async function allocateLot(variantId, qty) {
  const { rows } = await pool.query(
    `SELECT id, quantity
     FROM rms_item_units
     WHERE variant_id = $1
     AND unit_type = 'lot'
     AND quantity > 0
     LIMIT 1
     FOR UPDATE`,
    [variantId]
  );

  if (!rows.length)
    throw new Error("No lot stock");

  const lot = rows[0];

  if (lot.quantity < qty)
    throw new Error("Lot insufficient");

  await pool.query(
    `UPDATE rms_item_units
     SET quantity = quantity - $2
     WHERE id = $1`,
    [lot.id, qty]
  );

  return lot;
}

module.exports = { allocateSerial, allocateLot };
