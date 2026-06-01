const Router = require("@koa/router");
const router = new Router();

const pool = require("../db");
const { validateNetSuite } = require("../services/netsuite.service");
const {
  findUnifiedRentalAccount,
  upsertRentalAccount,
} = require("../services/rental-user.service");
const {
  calculateRemainingDays,
  checkLicenseStatus,
} = require("../services/license.service");

router.post("/api/login/netsuite", async (ctx) => {
  try {
    const payload = ctx.request.body;

    console.log("📥 NetSuite Login Payload:", payload);

    /* ---------------- VALIDATION ---------------- */

    if (!payload) {
      ctx.status = 400;
      ctx.body = { success: false, error: "Missing request body" };
      return;
    }

    const { licenseKey, productCode, accountId, licenceUrl, authCode } = payload;

    if (!licenseKey || !productCode || !accountId) {
      ctx.status = 400;
      ctx.body = {
        success: false,
        error: "licenseKey, productCode and accountId are required",
      };
      return;
    }

    /* ---------------- NETSUITE VALIDATION ---------------- */

    const result = await validateNetSuite(payload);

    console.log("✅ NetSuite Validation Result:", result);

    if (!result) {
      throw new Error("Empty response from NetSuite validation");
    }

    if (!result.plan_end_date) {
      throw new Error("Invalid NetSuite response: Missing plan_end_date");
    }

    const remainingDays = calculateRemainingDays(result.plan_end_date);

    /* ---------------- DATABASE UPSERT ---------------- */

    await pool.query(
      `
      INSERT INTO nst_rms_netsuite_users
      (licensekey, productcode, accountid, licenceurl,
       plan_start_date, plan_end_date, plan_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (licensekey)
      DO UPDATE SET
        productcode = EXCLUDED.productcode,
        accountid = EXCLUDED.accountid,
        licenceurl = EXCLUDED.licenceurl,
        plan_start_date = EXCLUDED.plan_start_date,
        plan_end_date = EXCLUDED.plan_end_date,
        plan_active = EXCLUDED.plan_active,
        updated_at = NOW()
      `,
      [
        licenseKey,
        productCode,
        accountId,
        licenceUrl,
        result.plan_start_date,
        result.plan_end_date,
        result.plan_active,
      ]
    );

    console.log("💾 NetSuite user stored/updated");

    /* ---------------- SESSION ---------------- */

    ctx.session.user = {
      ...result,
      remainingDays,
      loginType: "netsuite",
    };

    console.log("🔐 Session user set:", ctx.session.user);

    /* ---------------- LICENSE STATUS ---------------- */

    const licenseStatus = await checkLicenseStatus();

    /* ---------------- RESPONSE ---------------- */

    ctx.status = 200;
    ctx.body = {
      success: true,
      expiry: result.plan_end_date,
      remainingDays,
      licenseStatus,
      user: ctx.session.user,
    };
  } catch (err) {
    console.error("❌ NetSuite Login Error:", err);

    ctx.status = 500;
    ctx.body = {
      success: false,
      error:
        err.message ||
        "NetSuite validation failed. Please check credentials/license.",
    };
  }
});

router.post("/api/login/rental", async (ctx) => {
  try {
    const payload = ctx.request.body || {};
    console.log("📥 Rental Login Payload:", payload);

    const { licenseKey, productCode, licenceUrl } = payload;
    if (!licenseKey || !productCode || !licenceUrl) {
      ctx.status = 400;
      ctx.body = {
        success: false,
        error: "licenseKey, productCode and licenceUrl are required",
      };
      return;
    }

    const sourceRow = await findUnifiedRentalAccount(payload);
    const storedUser = await upsertRentalAccount({
      licenseKey,
      productCode,
      licenceUrl,
      sourceRow,
      planStartDate: sourceRow?.plan_start_date || null,
      planEndDate: sourceRow?.plan_end_date || null,
      planActive: sourceRow?.plan_active ?? null,
    });

    const remainingDays = storedUser.plan_end_date
      ? calculateRemainingDays(storedUser.plan_end_date)
      : null;

    ctx.session.user = {
      ...storedUser,
      ...sourceRow,
      remainingDays,
      loginType: "rental",
    };

    const licenseStatus = {
      isExpired: storedUser.plan_end_date ? remainingDays < 0 : false,
      planEndDate: storedUser.plan_end_date,
      remainingDays: Math.max(0, remainingDays || 0),
      customerType: "rental",
    };

    ctx.status = 200;
    ctx.body = {
      success: true,
      remainingDays,
      licenseStatus,
      user: ctx.session.user,
    };
  } catch (err) {
    console.error("❌ Rental Login Error:", err);
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: err.message || "Rental login failed. Please check your details.",
    };
  }
});

/* ---------------- LOGOUT ---------------- */

router.post("/api/logout", async (ctx) => {
  try {
    ctx.session = null;

    ctx.status = 200;
    ctx.body = {
      success: true,
      message: "Logged out successfully",
    };
  } catch (err) {
    console.error("❌ Logout Error:", err);

    ctx.status = 500;
    ctx.body = {
      success: false,
      error: "Logout failed",
    };
  }
});

module.exports = router;
