const axios = require("axios");

async function validateNetSuite({ licenceUrl, ...payload }) {
  try {
    console.log("──────── NetSuite Validation Start ────────");

    const formattedPayload = {
      licenseCode: payload.licenseKey,
      productCode: payload.productCode,
      accountId: payload.accountId,
    };

    console.log("➡ Licence URL:", licenceUrl);
    console.log("➡ Payload:", formattedPayload);

    const res = await axios.post(
      licenceUrl,
      formattedPayload,
      {
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": "Basic " + payload.authCode,
        },
        timeout: 10000,
      }
    );

    console.log("✅ Raw API Response:", res.data);
    console.log("──────── NetSuite Validation End ─────────");

    if (!res.data) {
      throw new Error("Empty response from License API");
    }

    const data = res.data;

    /* ---------------- API ERROR CHECK ---------------- */

    if (data.success === false || data.ResponseCode !== "200") {
      const errorMsg =
        data?.ErrorMessage ||
        data?.message ||
        "License validation rejected";
      throw new Error(errorMsg);
    }

    /* ---------------- NORMALIZE RESPONSE ---------------- */

    const normalized = {
      success: true,

      // Map plan start date
      plan_start_date:
        data.plan_start_date ||
        data.planStartDate ||
        data.CreatedDate ||   // ✅ fallback from your API
        null,

      // Map expiry date (CRITICAL FIX)
      plan_end_date:
        data.plan_end_date ||
        data.planEndDate ||
        data.ExtendedExpiryDate ||  // ✅ PRIMARY for your API
        data.ExpiredDate ||         // ✅ FALLBACK
        null,

      // Determine active status
      plan_active:
        data.plan_active ??
        data.planActive ??
        (data.Status?.toLowerCase() === "active"),
      
      // Remaining days (prefer API value if available)
      remainingDays:
        data.RemainingDays !== undefined
          ? parseFloat(data.RemainingDays)
          : null,

      // Extra info (optional but useful)
      companyName: data.CompanyName || null,
      accountId: data.AccountId || payload.accountId,
      productCode: data.ProductCode || payload.productCode,
      licenseCode: data.LicenseCode || payload.licenseKey,
      status: data.Status || null,
    };

    console.log("✅ Normalized Response:", normalized);

    /* ---------------- VALIDATION ---------------- */

    if (!normalized.plan_end_date) {
      throw new Error(
        "License API did not return expiry date (ExpiredDate / ExtendedExpiryDate)"
      );
    }

    if (normalized.plan_active === false) {
      throw new Error("License is not active");
    }

    return normalized;

  } catch (err) {
    console.log("❌ NetSuite API FAILED");
    console.log("Status:", err.response?.status);
    console.log("Response:", err.response?.data);
    console.log("Error:", err.message);
    console.log("──────── NetSuite Validation End ─────────");

    const errorMsg =
      typeof err.response?.data === "string"
        ? err.response.data
        : err.response?.data?.ErrorMessage ||
          err.response?.data?.message ||
          err.message ||
          "NetSuite validation failed";

    throw new Error(errorMsg);
  }
}

module.exports = { validateNetSuite };
