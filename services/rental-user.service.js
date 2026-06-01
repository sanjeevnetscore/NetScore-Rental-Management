const pool = require("../db");
const bcrypt = require("bcryptjs");

async function validateRentalUser({ licenseKey, username, password }) {
  const { rows } = await pool.query(
    `SELECT * FROM nst_rms_users WHERE license = $1`,
    [licenseKey]
  );

  if (!rows.length) throw new Error("Invalid license");

  const user = rows[0];

  const valid = await bcrypt.compare(password, user.password);

  if (!valid || user.username !== username)
    throw new Error("Invalid credentials");

  return user;
}

async function findUnifiedRentalAccount({ licenseKey, productCode, licenceUrl }) {
  const normalizedLicenseKey = String(licenseKey || "").trim();
  if (!normalizedLicenseKey) {
    throw new Error("License key is required");
  }

  const rentalResult = await pool.query(
    `
    SELECT
      *,
      'nst_rms_users' AS source_table
    FROM nst_rms_users
    WHERE COALESCE(NULLIF(licensekey, ''), NULLIF(license, '')) = $1
    LIMIT 1
    `,
    [normalizedLicenseKey],
  ).catch(() => ({ rows: [] }));

  const rentalRow = rentalResult.rows?.[0] || null;
  if (rentalRow) {
    if (productCode && rentalRow.productcode && String(rentalRow.productcode).trim() !== String(productCode).trim()) {
      throw new Error("Product code does not match the stored rental account");
    }
    if (licenceUrl && rentalRow.licenceurl && String(rentalRow.licenceurl).trim() !== String(licenceUrl).trim()) {
      throw new Error("Licence URL does not match the stored rental account");
    }
    return rentalRow;
  }

  const netsuiteResult = await pool.query(
    `
    SELECT
      *,
      'nst_rms_netsuite_users' AS source_table
    FROM nst_rms_netsuite_users
    WHERE licensekey = $1
    LIMIT 1
    `,
    [normalizedLicenseKey],
  ).catch(() => ({ rows: [] }));

  const netsuiteRow = netsuiteResult.rows?.[0] || null;
  if (netsuiteRow) {
    if (productCode && netsuiteRow.productcode && String(netsuiteRow.productcode).trim() !== String(productCode).trim()) {
      throw new Error("Product code does not match the stored account");
    }
    if (licenceUrl && netsuiteRow.licenceurl && String(netsuiteRow.licenceurl).trim() !== String(licenceUrl).trim()) {
      throw new Error("Licence URL does not match the stored account");
    }
    return netsuiteRow;
  }

  throw new Error("No matching rental account found");
}

async function upsertRentalAccount({
  licenseKey,
  productCode,
  licenceUrl,
  sourceRow = null,
  planStartDate = null,
  planEndDate = null,
  planActive = null,
}) {
  const normalizedLicenseKey = String(licenseKey || "").trim();
  if (!normalizedLicenseKey) {
    throw new Error("License key is required");
  }

  const finalPlanStartDate = planStartDate || sourceRow?.plan_start_date || null;
  const finalPlanEndDate = planEndDate || sourceRow?.plan_end_date || null;
  const finalPlanActive =
    planActive ?? sourceRow?.plan_active ?? Boolean(finalPlanEndDate);

  const updateResult = await pool.query(
    `
    UPDATE nst_rms_users
    SET
      license = $2,
      licensekey = $2,
      productcode = $3,
      licenceurl = $4,
      plan_start_date = $5,
      plan_end_date = $6,
      plan_active = $7,
      updated_at = NOW()
    WHERE COALESCE(NULLIF(licensekey, ''), NULLIF(license, '')) = $1
    `,
    [
      normalizedLicenseKey,
      normalizedLicenseKey,
      productCode || sourceRow?.productcode || null,
      licenceUrl || sourceRow?.licenceurl || null,
      finalPlanStartDate,
      finalPlanEndDate,
      finalPlanActive,
    ],
  );

  if (updateResult.rowCount > 0) {
    return {
      licenseKey: normalizedLicenseKey,
      productCode: productCode || sourceRow?.productcode || null,
      licenceUrl: licenceUrl || sourceRow?.licenceurl || null,
      plan_start_date: finalPlanStartDate,
      plan_end_date: finalPlanEndDate,
      plan_active: finalPlanActive,
    };
  }

  await pool.query(
    `
    INSERT INTO nst_rms_users
      (license, licensekey, productcode, licenceurl, plan_start_date, plan_end_date, plan_active, created_at, updated_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
    `,
    [
      normalizedLicenseKey,
      normalizedLicenseKey,
      productCode || sourceRow?.productcode || null,
      licenceUrl || sourceRow?.licenceurl || null,
      finalPlanStartDate,
      finalPlanEndDate,
      finalPlanActive,
    ],
  );

  return {
    licenseKey: normalizedLicenseKey,
    productCode: productCode || sourceRow?.productcode || null,
    licenceUrl: licenceUrl || sourceRow?.licenceurl || null,
    plan_start_date: finalPlanStartDate,
    plan_end_date: finalPlanEndDate,
    plan_active: finalPlanActive,
  };
}

module.exports = {
  validateRentalUser,
  findUnifiedRentalAccount,
  upsertRentalAccount,
};
