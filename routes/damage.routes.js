router.put("/api/admin/serial-damage/:id", async (ctx) => {
  const { id } = ctx.params;
  const { notes } = ctx.request.body;

  await pool.query(
    `UPDATE rms_item_units
     SET status='damaged'
     WHERE id=$1`,
    [id]
  );

  await logSerialEvent(id, "DAMAGED", notes);

  ctx.body = { success: true };
});
