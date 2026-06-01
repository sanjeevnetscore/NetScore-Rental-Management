const pool = require("../db");

async function logSerialEvent(serialId, eventType, notes = "") {
  await pool.query(
    `INSERT INTO serial_history (serial_id, event_type, notes)
     VALUES ($1, $2, $3)`,
    [serialId, eventType, notes]
  );
}

module.exports = { logSerialEvent };
