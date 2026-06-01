const pool = require("../db");

function calculateRemainingDays(endDate) {
  const expiry = new Date(endDate);
  if (Number.isNaN(expiry.getTime())) return 0;

  const today = new Date();
  const todayUtc = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    today.getUTCDate(),
  );
  const expiryUtc = Date.UTC(
    expiry.getUTCFullYear(),
    expiry.getUTCMonth(),
    expiry.getUTCDate(),
  );
  const diffDays = Math.ceil((expiryUtc - todayUtc) / (1000 * 60 * 60 * 24));

  return Number.isFinite(diffDays) ? diffDays : 0;
}

/**
 * Get the admin's customer type (netsuite or loyalty)
 * Checks database tables to determine customer type
 */
async function getAdminCustomerType() {
  try {
    // Query the netsuite users table
    const { rows: netsuiteRows } = await pool.query(
      `SELECT COUNT(*) as count FROM nst_rms_netsuite_users LIMIT 1`
    );

    if (netsuiteRows && netsuiteRows[0]?.count > 0) {
      console.log("✅ Customer type: NetSuite");
      return "netsuite";
    }

    // If no netsuite records, check rental users table
    const { rows: rentalRows } = await pool.query(
      `SELECT COUNT(*) as count FROM nst_rms_users LIMIT 1`
    ).catch(() => ({ rows: [] })); // Table might not exist

    if (rentalRows && rentalRows[0]?.count > 0) {
      console.log("✅ Customer type: Rental");
      return "rental";
    }

    console.log("⚠ No customer type found");
    return null;
  } catch (err) {
    console.error("❌ Error getting customer type:", err.message);
    return null;
  }
}

/**
 * Check if the site license is expired
 * Returns { isExpired: boolean, planEndDate: string, remainingDays: number, customerType: string }
 */
async function checkLicenseStatus() {
  try {
    const customerType = await getAdminCustomerType();

    if (!customerType) {
      return {
        isExpired: true,
        planEndDate: null,
        remainingDays: 0,
        customerType: null,
        error: "No active license found",
      };
    }

    let planEndDate = null;

    if (customerType === "netsuite") {
      const { rows } = await pool.query(
        `SELECT plan_end_date FROM nst_rms_netsuite_users 
         WHERE plan_active = true
         ORDER BY plan_end_date DESC LIMIT 1`
      );

      if (rows && rows[0]) {
        planEndDate = rows[0].plan_end_date;
      }
    } else if (customerType === "rental") {
      const { rows } = await pool.query(
        `SELECT plan_end_date FROM nst_rms_users 
         ORDER BY plan_end_date DESC LIMIT 1`
      ).catch(() => ({ rows: [] }));

      if (rows && rows[0]) {
        planEndDate = rows[0].plan_end_date;
      }
    }

    if (!planEndDate) {
      return {
        isExpired: true,
        planEndDate: null,
        remainingDays: 0,
        customerType,
        error: "No plan end date found",
      };
    }

    // Calculate remaining days
    const remainingDays = calculateRemainingDays(planEndDate);
    const isExpired = remainingDays < 0;

    console.log(
      `📅 License expires: ${planEndDate}, Remaining days: ${remainingDays}`
    );

    return {
      isExpired,
      planEndDate,
      remainingDays: Math.max(0, remainingDays),
      customerType,
    };
  } catch (err) {
    console.error("❌ Error checking license status:", err.message);
    return {
      isExpired: true,
      planEndDate: null,
      remainingDays: 0,
      customerType: null,
      error: err.message,
    };
  }
}

/**
 * Validate if license is active (not expired)
 */
async function isLicenseValid() {
  const status = await checkLicenseStatus();
  return !status.isExpired && status.customerType;
}

module.exports = {
  calculateRemainingDays,
  getAdminCustomerType,
  checkLicenseStatus,
  isLicenseValid,
};
