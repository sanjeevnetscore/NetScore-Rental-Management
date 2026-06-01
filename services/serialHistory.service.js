const pool = require("../db");

/**
 * Logs a serial lifecycle event
 * @param {number} serialId
 * @param {string} eventType
 * @param {string} notes
 * @param {object|null} client  // optional transaction client
 */
async function logSerialEvent(serialId, eventType, notes = "", client = null) {
  const executor = client || pool;

  try {
    await executor.query(
      `INSERT INTO serial_history 
       (serial_id, event_type, notes, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [serialId, eventType, notes]
    );

    console.log(
      `🧾 Serial Event Logged | Serial: ${serialId} | Event: ${eventType}`
    );

  } catch (error) {
    console.error("❌ Serial History Log Error:", error.message);
    throw error;
  }
}

module.exports = { logSerialEvent };
