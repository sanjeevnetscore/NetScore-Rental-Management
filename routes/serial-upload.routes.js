const Router = require("@koa/router");
const multer = require("@koa/multer");   // ✅ FIXED
const fs = require("fs");
const csv = require("csv-parser");
const pool = require("../db");

const upload = multer({ dest: "uploads/" });
const router = new Router();

router.post(
  "/api/admin/serial-upload",
  upload.single("file"),
  async (ctx) => {
    const results = [];

    await new Promise((resolve, reject) => {
      fs.createReadStream(ctx.file.path)
        .pipe(csv())
        .on("data", (data) => results.push(data))
        .on("end", resolve)
        .on("error", reject);
    });

    for (const row of results) {
      await pool.query(
        `INSERT INTO rms_item_units
         (shop, variant_id, unit_type, serial_number, serial_name, status)
         VALUES ($1, $2, 'serial', $3, $4, 'available')`,
        [
          ctx.state.shop,
          row.variant_id,
          row.serial_number,
          row.serial_name,
        ]
      );
    }

    ctx.body = { success: true, count: results.length };
  }
);

module.exports = router;
