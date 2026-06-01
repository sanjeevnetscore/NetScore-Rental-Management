const Router = require("@koa/router");
const axios = require("axios");
const pool = require("../db");
const shopify = require("../shopify");

const { checkAvailability } = require("../services/availability.service");
const { deductInventory, syncInventoryStateForOrder, syncInventoryCounters } = require("../services/inventory.service");
const { allocateSerial, allocateLot } = require("../services/serial-lot.service");
const { runStatusAutomation } = require("../services/status.service");
const {
  getShopCartSyncSettings,
  getShopBookingBlockSettings,
} = require("../services/shop-settings.service");

const { requireAuth } = require("../middleware/auth.middleware");

const router = new Router();
let rentalQuantityBackfillComplete = false;

async function safeRunStatusAutomation(contextLabel = "public request") {
  try {
    const updatedRows = await runStatusAutomation();
    const nextStatusesByOrder = new Map();

    for (const row of Array.isArray(updatedRows) ? updatedRows : []) {
      const shop = normalizeShopDomain(row?.shop || "");
      const orderId = normalizeOrderId(row?.shopify_order_id || "");
      const status = String(row?.status || "").trim();
      if (!shop || !orderId || !status) continue;

      const key = `${shop}::${orderId}`;
      const current = nextStatusesByOrder.get(key) || { shop, orderId, status };
      if (rentalStatusRank(status) > rentalStatusRank(current.status)) {
        current.status = status;
      }
      nextStatusesByOrder.set(key, current);
    }

    for (const entry of nextStatusesByOrder.values()) {
      try {
        await updateAdminOrderStatusTag(entry.shop, entry.orderId, entry.status);
      } catch (syncError) {
        console.warn(
          `Status automation Shopify sync skipped during ${contextLabel} for order ${entry.orderId}:`,
          syncError?.message || syncError,
        );
      }
    }
  } catch (error) {
    console.warn(`Status automation skipped during ${contextLabel}:`, error?.message || error);
  }
}

function normalizeVariantId(rawId) {
  const value = String(rawId || "").trim();
  const match = value.match(/\/(\d+)$/);
  return match ? match[1] : value;
}

function toExternalKey(rawId) {
  const id = normalizeVariantId(rawId);
  return id ? `shopify:${id}` : "";
}

function normalizeShopDomain(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";

  const normalizeHost = (host = "") => {
    const clean = String(host || "").trim().toLowerCase();
    if (!clean) return "";
    if (clean.endsWith(".myshopify.com")) return clean;
    if (/^[a-z0-9][a-z0-9-]*$/.test(clean)) return `${clean}.myshopify.com`;
    return "";
  };

  const direct = normalizeHost(value);
  if (direct) return direct;

  try {
    const parsed = new URL(value);
    const host = normalizeHost(parsed.hostname || "");
    if (host) return host;

    const isShopifyHost =
      parsed.hostname === "admin.shopify.com" ||
      parsed.hostname === "shopify.com" ||
      parsed.hostname === "accounts.shopify.com";
    if (isShopifyHost) {
      const match = parsed.pathname.match(/\/store\/([^/?#]+)/i);
      if (match?.[1]) {
        return normalizeHost(decodeURIComponent(match[1]));
      }
    }

    return "";
  } catch {
    return "";
  }
}

function normalizeCustomerId(rawValue = "") {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  if (/gid:\/\/shopify\/CustomerAccount\//i.test(value)) return "";
  const match = value.match(/\/(\d+)$/);
  return match ? match[1] : value;
}

function normalizeFulfillmentStatus(rawValue = "") {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value) return "";
  if (value === "fulfilled") return "fulfilled";
  if (value === "partially_fulfilled" || value === "partial") return "partially_fulfilled";
  if (value === "unfulfilled") return "unfulfilled";
  return value;
}

function isFulfilledShopifyOrder(rawValue = "") {
  return normalizeFulfillmentStatus(rawValue) === "fulfilled";
}

function normalizeComparableEmail(rawValue = "") {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value || !value.includes("@")) return value;
  const [local, domain] = value.split("@");
  if (!local || !domain) return value;

  // Gmail aliases (dots and plus tags) should map to the same mailbox.
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const normalizedLocal = local.split("+")[0].replace(/\./g, "");
    return `${normalizedLocal}@gmail.com`;
  }

  return `${local}@${domain}`;
}

function extractCustomerIdFromBody(ctx) {
  return normalizeCustomerId(
    ctx.request?.body?.customerId ||
      ctx.request?.body?.customer_id ||
      "",
  );
}

function extractShopFromReferer(referer) {
  try {
    if (!referer) return "";
    const url = new URL(referer);
    const fromQuery = normalizeShopDomain(url.searchParams.get("shop"));
    if (fromQuery) return fromQuery;

    const match = url.pathname.match(/\/store\/([^/]+)/i);
    if (match?.[1]) return normalizeShopDomain(match[1]);
    return "";
  } catch {
    return "";
  }
}

function extractPreferredShop(ctx, bodyShop = "") {
  const fromBody = normalizeShopDomain(bodyShop);
  if (fromBody) return fromBody;

  const fromQuery = normalizeShopDomain(ctx?.query?.shop || "");
  if (fromQuery) return fromQuery;

  const fromHeader = normalizeShopDomain(ctx?.get?.("x-shopify-shop-domain") || "");
  if (fromHeader) return fromHeader;

  return extractShopFromReferer(ctx?.get?.("referer") || "");
}

async function getStoredShopSession(preferredShop = "") {
  const normalizedPreferredShop = normalizeShopDomain(preferredShop);
  if (normalizedPreferredShop) {
    const preferred = await pool.query(
      `SELECT shop, access_token
       FROM shops
       WHERE lower(shop) = lower($1)
         AND access_token IS NOT NULL
       LIMIT 1`,
      [normalizedPreferredShop],
    );
    if (preferred.rows.length) return preferred.rows[0];
  }

  const fallback = await pool.query(
    `SELECT shop, access_token
     FROM shops
     WHERE access_token IS NOT NULL
     ORDER BY shop ASC
     LIMIT 1`,
  );
  return fallback.rows[0] || null;
}

async function findRecentShopByCustomerEmail(customerEmail = "") {
  const normalizedEmail = String(customerEmail || "").trim().toLowerCase();
  if (!normalizedEmail) return "";

  try {
    const result = await pool.query(
      `SELECT shop
       FROM rentals
       WHERE shop IS NOT NULL
         AND TRIM(shop) <> ''
         AND lower(customer_email) = lower($1)
       GROUP BY shop
       ORDER BY MAX(created_at) DESC
       LIMIT 1`,
      [normalizedEmail],
    );
    return normalizeShopDomain(result.rows?.[0]?.shop || "");
  } catch (error) {
    if (error?.code === "42P01") return "";
    throw error;
  }
}

async function resolveCustomerShopSession(preferredShop = "", customerEmail = "") {
  const normalizedPreferredShop = normalizeShopDomain(preferredShop);
  if (normalizedPreferredShop) {
    const preferred = await pool.query(
      `SELECT shop, access_token
       FROM shops
       WHERE lower(shop) = lower($1)
         AND access_token IS NOT NULL
       LIMIT 1`,
      [normalizedPreferredShop],
    );
    if (preferred.rows.length) return preferred.rows[0];
  }

  const inferredShop = await findRecentShopByCustomerEmail(customerEmail);
  if (inferredShop) {
    const inferred = await getStoredShopSession(inferredShop);
    if (inferred) return inferred;
  }

  return getStoredShopSession("");
}

function toMoneyString(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return "0.00";
  return numeric.toFixed(2);
}

function toPropertyArray(rawProperties = {}) {
  const out = [];
  Object.entries(rawProperties || {}).forEach(([name, value]) => {
    if (value == null) return;
    const safeName = String(name || "").trim();
    const safeValue = String(value).trim();
    if (!safeName || !safeValue) return;
    out.push({ name: safeName, value: safeValue });
  });
  return out;
}

function toDraftAttributeArray(rawProperties = {}) {
  return toPropertyArray(rawProperties).map(({ name, value }) => ({
    key: name,
    value,
  }));
}

function toVariantGid(rawId) {
  const id = normalizeVariantId(rawId);
  return id ? `gid://shopify/ProductVariant/${id}` : "";
}

function isRentalLine(properties = {}) {
  const enabled = String(
    properties["Rental Enabled"] ||
      properties["_Rental Enabled"] ||
      properties["_RentalEnabled"] ||
      properties["_rental_enabled"] ||
      "",
  )
    .trim()
    .toLowerCase();
  if (enabled === "yes" || enabled === "true" || enabled === "1") return true;

  const legacyType = String(
    properties["Rental Frequency"] ||
      properties["_Rental Frequency"] ||
      properties["_RentalFrequency"] ||
      properties["_rental_frequency"] ||
      properties["Rental Type"] ||
      properties["_Rental Type"] ||
      properties["_RentalType"] ||
      properties["_rental_type"] ||
      "",
  ).trim();
  return Boolean(legacyType);
}

async function fetchRentalRowsByVariant(variantId) {
  const normalizedVariantId = normalizeVariantId(variantId);
  const externalKey = toExternalKey(normalizedVariantId);

  const { rows } = await pool.query(
    `SELECT id, item_type, daily_rate, weekly_rate, monthly_rate, stock, total_quantity,
            available, on_rent, maintenance, reserved, sold, rental_status,
            ns_id, serial_name, serial_number, sku, product_id, is_rental_item
     FROM nst_rms_item_details
     WHERE is_deleted = FALSE
       AND COALESCE(is_rental_item, FALSE) = TRUE
       AND (
         ($1 <> '' AND sku = $1) OR
         ($2 <> '' AND sku = $2) OR
         ($2 <> '' AND product_id::text = $2)
       )
     ORDER BY id ASC`,
    [externalKey, normalizedVariantId]
  );

  return rows || [];
}

function isAvailableStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return true;
  return normalized === "available";
}

function hasItemSummaryIdentity(row) {
  return Boolean(
    String(row?.ns_id || "").trim() ||
      String(row?.serial_name || "").trim() ||
      String(row?.serial_number || "").trim(),
  );
}

function normalizePositiveInt(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function getRateByType(item, rateType) {
  if (rateType === "daily") return Number(item.daily_rate) || 0;
  if (rateType === "weekly") return Number(item.weekly_rate) || 0;
  if (rateType === "monthly") return Number(item.monthly_rate) || 0;
  return 0;
}

function frequencyToDays(rateType) {
  if (rateType === "daily") return 1;
  if (rateType === "weekly") return 7;
  if (rateType === "monthly") return 30;
  return 0;
}

function computeDurationFromDates(startDate, endDate, rateType) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;

  const diffDays = Math.max(
    1,
    Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)),
  );
  const bucket = frequencyToDays(rateType) || 1;
  return Math.max(1, Math.ceil(diffDays / bucket));
}

function computeAvailableStock(rows, itemType) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (itemType === "serial") {
    const availableCount = sourceRows.reduce((sum, row) => {
      const rowAvailable = Math.max(0, Number(row?.available) || 0);
      if (rowAvailable > 0) return sum + rowAvailable;
      const rowStock = Math.max(0, Number(row?.stock) || 0);
      if (rowStock > 0) return sum + rowStock;
      const totalQuantity = Math.max(0, Number(row?.total_quantity) || 0);
      if (totalQuantity > 0) return sum + totalQuantity;
      return sum + (hasItemSummaryIdentity(row) ? 1 : 0);
    }, 0);
    if (availableCount > 0) return availableCount;
    return sourceRows.length;
  }
  if (itemType === "lot" || itemType === "inventory") {
    const availableSum = sourceRows.reduce((sum, row) => {
      return sum + Math.max(0, Number(row?.available) || 0);
    }, 0);
    if (availableSum > 0) return availableSum;

    const stockSum = sourceRows.reduce((sum, row) => {
      return sum + Math.max(0, Number(row?.stock) || 0);
    }, 0);
    if (stockSum > 0) return stockSum;

    return sourceRows.reduce((sum, row) => {
      return sum + Math.max(0, Number(row?.total_quantity) || 0);
    }, 0);
  }
  if (itemType === "non_inventory") return 9999;
  return 0;
}

function getSummaryAvailableStock(item, rows, itemType) {
  const safeType = String(itemType || "").trim().toLowerCase();
  if (safeType === "serial") {
    return computeAvailableStock(rows, safeType);
  }

  const available = Math.max(0, Number(item?.available) || 0);
  if (available > 0) return available;

  const stock = Math.max(0, Number(item?.stock) || 0);
  if (stock > 0) return stock;

  const totalQuantity = Math.max(0, Number(item?.total_quantity) || 0);
  if (totalQuantity > 0) return totalQuantity;

  return computeAvailableStock(rows, safeType);
}

function getStockRows(rows, itemType) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (itemType === "serial") {
    const identified = sourceRows.filter((row) => hasItemSummaryIdentity(row) || Math.max(0, Number(row?.available) || 0) > 0);
    return identified.length ? identified : sourceRows;
  }

  if (itemType === "lot" || itemType === "inventory") {
    const inStock = sourceRows.filter((row) => Math.max(0, Number(row.available) || 0) > 0 || Math.max(0, Number(row.stock) || 0) > 0);
    return inStock.length ? inStock : sourceRows;
  }

  return sourceRows;
}

async function fetchBookedQuantity(variantId, startDate, endDate) {
  if (!variantId || !startDate || !endDate) return 0;

  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(quantity), 0) AS booked
       FROM rentals
       WHERE variant_id = $1
         AND status IN ('Reserved', 'On Rent', 'Rented', 'Return')
         AND start_date <= $3
         AND end_date >= $2`,
      [normalizeVariantId(variantId), startDate, endDate],
    );
    return Math.max(0, Number(rows?.[0]?.booked) || 0);
  } catch (error) {
    if (error && error.code !== "42P01") throw error;
    return 0;
  }
}

function buildSubItems(rows, itemType) {
  if (itemType !== "serial" && itemType !== "lot" && itemType !== "inventory") {
    return [];
  }

  return rows
    .filter((r) => hasItemSummaryIdentity(r))
    .filter((r) => isAvailableStatus(r.rental_status))
    .filter((r) => (itemType === "serial" ? true : Math.max(0, Number(r.stock) || 0) > 0))
    .map((r) => ({
      id: String(r.id),
      ns_id: r.ns_id || "",
      serial_name: r.serial_name || "",
      serial_number: r.serial_number || "",
      stock: itemType === "serial" ? 1 : Math.max(0, Number(r.stock) || 0),
      rental_status: r.rental_status || "Available",
      display_name:
        String(r.serial_name || "").trim() ||
        String(r.serial_number || "").trim() ||
        String(r.ns_id || "").trim() ||
        `Item ${r.id}`,
    }));
}

function normalizeLookupText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s*\(stock:.*$/i, "")
    .trim();
}

function normalizeNumericSerialNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digitMatch = raw.match(/\d+/);
  if (digitMatch) return digitMatch[0];
  return raw;
}

function resolveSerialNumberDisplay(selectedItem, subItems = []) {
  const raw = String(selectedItem || "").trim();
  if (!raw) return "";

  const cleanedRaw = normalizeLookupText(raw);
  const prefix = normalizeLookupText(raw.split(/\s*\(/)[0]);

  const selected = (Array.isArray(subItems) ? subItems : []).find((item) => {
    const candidates = [
      item?.serial_number,
      item?.serial_name,
      item?.ns_id,
      item?.display_name,
    ]
      .map(normalizeLookupText)
      .filter(Boolean);

    return candidates.includes(cleanedRaw) || candidates.includes(prefix);
  });

  if (selected) {
    const resolved = String(
      selected.serial_number ||
        selected.serial_name ||
        selected.ns_id ||
        selected.display_name ||
        raw,
    ).trim();
    return normalizeNumericSerialNumber(resolved);
  }

  return normalizeNumericSerialNumber(raw);
}

function resolveItemNumberDisplay(line = {}, subItems = []) {
  const candidates = [
    ...(Array.isArray(subItems) ? subItems : []).flatMap((item) => [
      item?.serial_number,
      item?.serial_name,
    ]),
    line?.itemNumber,
    line?.selectedItem,
    line?.serialNumber,
    ...(Array.isArray(subItems) ? subItems : []).map((item) => item?.ns_id),
  ]
    .map((value) => normalizeNumericSerialNumber(String(value || "").trim()))
    .map((value) => String(value || "").trim())
    .filter((value) => /\d/.test(value));

  return candidates[0] || "";
}

function escapePrintableHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parsePrintablePayload(rawValue = "") {
  const raw = String(rawValue || "").trim();
  if (!raw) return null;

  const attempts = [raw];
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const normalized = padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "=");
    attempts.push(Buffer.from(normalized, "base64").toString("utf8"));
  } catch {}
  try {
    attempts.push(decodeURIComponent(raw));
  } catch {}

  for (const value of attempts) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }

  return null;
}

function buildPrintableRentalOrderHtml(order = {}) {
  const lines = Array.isArray(order.lines) ? order.lines : [];
  const addressLines = Array.isArray(order.shippingAddressLines) && order.shippingAddressLines.length
    ? order.shippingAddressLines
    : ["No billing address available"];
  const lineRows = lines
    .map((line) => {
      const cells = [
        line.title,
        line.quantity,
        line.rateType,
        line.duration,
        line.priceText,
        line.startDate,
        line.endDate,
      ]
        .map((cell) => `<td>${escapePrintableHtml(cell || "-")}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapePrintableHtml(`Rental Order Details - ${order.label || "Order"}`)}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 0; padding: 28px; color: #111827; background: #fff; }
      h1 { font-size: 30px; margin: 0 0 8px; }
      .muted { color: #6b7280; }
      .summary { margin-top: 18px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .summary-card { border: 1px solid #e5e7eb; border-radius: 14px; padding: 14px 16px; }
      .summary-label { font-size: 13px; color: #6b7280; margin-bottom: 8px; }
      .summary-value { font-size: 18px; font-weight: 700; }
      .section { margin-top: 24px; }
      .section h2 { font-size: 20px; margin: 0 0 12px; }
      table { width: 100%; border-collapse: collapse; border: 1px solid #e5e7eb; border-radius: 14px; overflow: hidden; }
      th, td { padding: 12px 10px; border-bottom: 1px solid #e5e7eb; text-align: left; }
      th { background: #f8fafc; font-weight: 700; }
      tr:last-child td { border-bottom: 0; }
      .totals { margin-top: 12px; border: 1px solid #e5e7eb; border-radius: 14px; overflow: hidden; }
      .totals-row { display: grid; grid-template-columns: 1fr auto; padding: 14px 16px; border-bottom: 1px solid #e5e7eb; }
      .totals-row:last-child { border-bottom: 0; }
      .legend { margin-top: 16px; line-height: 1.8; color: #6b7280; }
      .address { margin-top: 12px; line-height: 1.8; }
      @media print { body { padding: 0; } }
    </style>
  </head>
  <body>
    <h1>Rental Order Details</h1>
    <div class="muted">${escapePrintableHtml(`Order ${order.label || "Order"} Details`)}</div>
    <div class="summary">
      <div class="summary-card"><div class="summary-label">Order Date</div><div class="summary-value">${escapePrintableHtml(order.processedAt || "-")}</div></div>
      <div class="summary-card"><div class="summary-label">Rental Status</div><div class="summary-value">${escapePrintableHtml(order.statusLabel || "-")}</div></div>
      <div class="summary-card"><div class="summary-label">Total</div><div class="summary-value">${escapePrintableHtml(order.total || "-")}</div></div>
      <div class="summary-card"><div class="summary-label">Payment Method</div><div class="summary-value">${escapePrintableHtml(order.paymentMethod || "Shopify Checkout")}</div></div>
      <div class="summary-card"><div class="summary-label">Billing Email</div><div class="summary-value">${escapePrintableHtml(order.billingEmail || "Not available")}</div></div>
    </div>
    <div class="section">
      <h2>Order Items</h2>
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Qty</th>
            <th>RF</th>
            <th>RD</th>
            <th>Price</th>
            <th>Start Date</th>
            <th>End Date</th>
          </tr>
        </thead>
        <tbody>
          ${lineRows}
        </tbody>
      </table>
      <div class="totals">
        <div class="totals-row"><strong>Subtotal</strong><strong>${escapePrintableHtml(order.total || "-")}</strong></div>
        <div class="totals-row"><strong>Total</strong><strong>${escapePrintableHtml(order.total || "-")}</strong></div>
      </div>
      <div class="legend">RD: Rental Duration<br/>RF: Rental Frequency</div>
    </div>
    <div class="section">
      <h2>Billing Address</h2>
      <div class="address">${addressLines.map((line) => escapePrintableHtml(line)).join("<br/>")}</div>
    </div>
  </body>
</html>`;
}

async function rentalOrderPrintHandler(ctx) {
  const payload = parsePrintablePayload(ctx.query?.payload || "");
  if (!payload) {
    ctx.throw(400, "Missing printable rental order payload");
  }

  const mode = String(ctx.query?.mode || "print").trim().toLowerCase();
  const label = String(payload.label || "order").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase();
  const html = buildPrintableRentalOrderHtml(payload);

  ctx.set("Content-Type", "text/html; charset=utf-8");
  if (mode === "download") {
    ctx.set("Content-Disposition", `attachment; filename=\"rental-${label || "order"}.html\"`);
  }
  ctx.body = mode === "print"
    ? `${html}\n<script>window.onload = () => { window.print(); };</script>`
    : html;
}

function resolveDisplayedAvailableStock(itemType, totalAvailableStock, subItems = [], subItemId = "") {
  const safeTotal = Math.max(0, Number(totalAvailableStock) || 0);
  const selectedId = String(subItemId || "").trim();
  if (!selectedId) return safeTotal;

  const selected = (Array.isArray(subItems) ? subItems : []).find(
    (item) => String(item?.id || "") === selectedId,
  );
  if (!selected) return safeTotal;

  const selectedStock = Math.max(0, Number(selected.stock) || 0);
  if (String(itemType || "").toLowerCase() === "serial") {
    return Math.max(0, Math.min(selectedStock || 1, safeTotal));
  }
  return Math.max(0, Math.min(selectedStock, safeTotal));
}

function getPropertyValue(properties = {}, keys = []) {
  for (const key of keys) {
    const directValue = String(properties?.[key] || "").trim();
    if (directValue) return directValue;

    const normalizedKey = normalizeLookupText(key);
    const matchingEntry = Object.entries(properties || {}).find(
      ([propertyKey, propertyValue]) =>
        normalizeLookupText(propertyKey) === normalizedKey && String(propertyValue || "").trim(),
    );
    if (matchingEntry) {
      const matchedValue = String(matchingEntry[1] || "").trim();
      if (matchedValue) return matchedValue;
    }
  }
  return "";
}

function getBooleanProperty(properties = {}, keys = []) {
  const value = getPropertyValue(properties, keys).toLowerCase();
  return value === "yes" || value === "true" || value === "1";
}

function getNumericPropertyValue(properties = {}, keys = []) {
  for (const key of keys) {
    const raw = Number(properties?.[key]);
    if (Number.isFinite(raw) && raw > 0) return raw;
  }
  return 0;
}

function getRentalUnitPriceFromProperties(properties = {}, fallbackUnitPrice = 0, lineQuantity = 1) {
  const quantity = Math.max(1, Number(lineQuantity) || 1);
  const propertyQuantity = getNumericPropertyValue(properties, [
    "Rental Quantity",
    "_Rental Quantity",
    "_RentalQuantity",
    "_rental_quantity",
  ]);
  const directUnitPrice = getNumericPropertyValue(properties, [
    "Rental Unit Price",
    "_Rental Unit Price",
    "_RentalUnitPrice",
    "_rental_unit_price",
  ]);

  const linePrice = getNumericPropertyValue(properties, [
    "Rental Line Price",
    "_Rental Line Price",
    "_RentalLinePrice",
    "_rental_line_price",
  ]);
  if (directUnitPrice > 0) {
    if (linePrice > 0 && quantity > 1) {
      const directAsTotal = directUnitPrice * quantity;
      if (Math.abs(directAsTotal - linePrice) <= 0.01) {
        return directUnitPrice;
      }
      if (
        propertyQuantity > 0 &&
        propertyQuantity !== quantity &&
        Math.abs((directUnitPrice * propertyQuantity) - linePrice) <= 0.01
      ) {
        return directUnitPrice;
      }
      if (Math.abs(directUnitPrice - linePrice) <= 0.01) {
        if (propertyQuantity > 0 && propertyQuantity !== quantity) {
          return directUnitPrice;
        }
        return linePrice / quantity;
      }
    }
    return directUnitPrice;
  }

  if (linePrice > 0) return linePrice / quantity;

  const legacyPrice = getNumericPropertyValue(properties, [
    "Rental Price",
    "_Rental Price",
    "_RentalPrice",
    "_rental_price",
    "Rental Price USD",
    "_Rental Price USD",
  ]);
  if (legacyPrice > 0) {
    return legacyPrice / quantity;
  }

  return Math.max(0, Number(fallbackUnitPrice) || 0);
}

function getRentalQuantityFromProperties(properties = {}, fallbackQuantity = 1) {
  const propertyQuantity = getNumericPropertyValue(properties, [
    "Rental Quantity",
    "_Rental Quantity",
    "_RentalQuantity",
    "_rental_quantity",
  ]);
  if (propertyQuantity > 0) return Math.max(1, Math.floor(propertyQuantity));
  return Math.max(1, Math.floor(Number(fallbackQuantity) || 1));
}

function setRentalPropertyAliases(properties = {}, key, value, aliases = []) {
  const safeValue = value == null ? "" : String(value);
  [key, ...aliases].forEach((alias) => {
    if (!alias) return;
    properties[alias] = safeValue;
  });
}

function normalizeRentalDraftProperties(properties = {}, quantity = 1, unitPrice = 0) {
  const qty = Math.max(1, Number(quantity) || 1);
  const safeUnitPrice = Math.max(0, Number(unitPrice) || 0);
  const linePrice = safeUnitPrice * qty;

  setRentalPropertyAliases(properties, "Rental Enabled", "Yes", [
    "_Rental Enabled",
    "_RentalEnabled",
    "_rental_enabled",
  ]);
  setRentalPropertyAliases(properties, "Rental Quantity", String(qty), [
    "_Rental Quantity",
    "_RentalQuantity",
    "_rental_quantity",
  ]);
  setRentalPropertyAliases(properties, "Rental Unit Price", toMoneyString(safeUnitPrice), [
    "_Rental Unit Price",
    "_RentalUnitPrice",
    "_rental_unit_price",
  ]);
  setRentalPropertyAliases(properties, "Rental Line Price", toMoneyString(linePrice), [
    "_Rental Line Price",
    "_RentalLinePrice",
    "_rental_line_price",
  ]);
  setRentalPropertyAliases(properties, "Rental Price", toMoneyString(linePrice), [
    "_Rental Price",
    "_RentalPrice",
    "_rental_price",
  ]);

  return properties;
}

function normalizeDateOnly(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";

  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]) - 1;
    const day = Number(dateOnly[3]);
    const parsed = new Date(year, month, day);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Date(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate(),
  )
    .toISOString()
    .slice(0, 10);
}

function normalizeRentalStatus(rawStatus = "", startDate = "", endDate = "") {
  const explicit = String(rawStatus || "").trim().toLowerCase();
  if (explicit) {
    if (explicit.includes("on") && explicit.includes("rent")) return "on-rent";
    if (explicit.includes("reserved")) return "reserved";
    if (explicit.includes("return")) return "return";
    if (
      explicit.includes("closed") ||
      explicit.includes("complete") ||
      explicit.includes("returned")
    ) {
      return "return";
    }
  }

  const today = new Date();
  const now = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;

  if (start && !Number.isNaN(start.getTime()) && now < start) return "reserved";
  if (
    start &&
    end &&
    !Number.isNaN(start.getTime()) &&
    !Number.isNaN(end.getTime()) &&
    now >= start &&
    now <= end
  ) {
    return "on-rent";
  }
  if (end && !Number.isNaN(end.getTime()) && now > end) return "return";
  return "processing";
}

function statusLabel(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "on-rent") return "On Rent";
  if (normalized === "reserved") return "Pending Fulfillment";
  if (normalized === "return") return "Closed";
  if (normalized === "closed") return "Closed";
  if (normalized === "rejected") return "Rejected";
  return "Processing";
}

function normalizeLineItemPropertyMap(lineItem = {}) {
  const map = {};
  const properties = Array.isArray(lineItem?.properties)
    ? lineItem.properties
    : Array.isArray(lineItem?.custom_attributes)
      ? lineItem.custom_attributes
      : Array.isArray(lineItem?.customAttributes)
        ? lineItem.customAttributes
        : [];
  properties.forEach((entry) => {
    const key = String(entry?.name || entry?.key || "").trim();
    const value = String(entry?.value || "").trim();
    if (key) map[key] = value;
  });
  return map;
}

function getWebhookInitialStatus(startDate, endDate) {
  return "Reserved";
}

async function ensureProcessedWebhookTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_shopify_orders (
      order_id TEXT PRIMARY KEY,
      shop TEXT,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensureRentalOrderColumns() {
  try {
    await pool.query(`
      ALTER TABLE rentals
      ADD COLUMN IF NOT EXISTS shopify_order_id TEXT,
      ADD COLUMN IF NOT EXISTS customer_name TEXT,
      ADD COLUMN IF NOT EXISTS customer_email TEXT,
      ADD COLUMN IF NOT EXISTS customer_phone TEXT,
      ADD COLUMN IF NOT EXISTS return_quantity INTEGER,
      ADD COLUMN IF NOT EXISTS return_reason TEXT,
      ADD COLUMN IF NOT EXISTS return_requested_at TIMESTAMPTZ
    `);
    if (!rentalQuantityBackfillComplete) {
      rentalQuantityBackfillComplete = true;
      const existingRows = await pool.query(
        `SELECT
            shopify_order_id,
            variant_id,
            start_date,
            end_date,
            quantity,
            rate_type,
            rate_amount,
            status,
            return_reason,
            return_quantity
         FROM rentals
         WHERE COALESCE(return_quantity, 0) <= 0
           AND TRIM(COALESCE(return_reason, '')) <> ''
           AND LOWER(COALESCE(status, '')) IN ('return requested', 'return')`,
      );

      for (const row of existingRows.rows || []) {
        const parsedQuantity = parseRequestedReturnQuantity(row?.return_reason || "");
        if (parsedQuantity <= 0) continue;
        await pool.query(
          `UPDATE rentals
           SET return_quantity = $1
           WHERE shopify_order_id = $2
             AND variant_id = $3
             AND start_date = $4
             AND end_date = $5
             AND quantity = $6
             AND rate_type = $7
             AND rate_amount = $8
             AND COALESCE(return_quantity, 0) <= 0`,
          [
            parsedQuantity,
            String(row?.shopify_order_id || "").trim(),
            row?.variant_id,
            row?.start_date,
            row?.end_date,
            row?.quantity,
            row?.rate_type,
            row?.rate_amount,
          ],
        );
      }
    }
  } catch (error) {
    if (error && error.code !== "42P01") throw error;
  }
}

async function resolveRentalVariantId(preferredShop, lineItem = {}, properties = {}, cache = new Map()) {
  const directVariantId = normalizeVariantId(
    lineItem?.variant_id ||
      properties["Rental Variant ID"] ||
      properties["_Rental Variant ID"] ||
      properties["_RentalVariantId"] ||
      properties["_rental_variant_id"] ||
      "",
  );
  if (directVariantId) return directVariantId;

  const rawSku = String(lineItem?.sku || "").trim();
  const skuMatch = rawSku.match(/(\d{6,})/);
  if (skuMatch?.[1]) return skuMatch[1];

  const title = String(lineItem?.title || lineItem?.name || "").trim();
  if (!preferredShop || !title) return "";

  const cacheKey = `${normalizeShopDomain(preferredShop)}::${title.toLowerCase()}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) || "";

  const shopSession = await getStoredShopSession(preferredShop);
  if (!shopSession) {
    cache.set(cacheKey, "");
    return "";
  }

  try {
    const query = `
      query ResolveRentalProductByTitle($q: String!) {
        products(first: 5, query: $q) {
          nodes {
            id
            title
            variants(first: 10) {
              nodes {
                id
                title
              }
            }
          }
        }
      }
    `;

    const response = await axios.post(
      `https://${shopSession.shop}/admin/api/2025-01/graphql.json`,
      {
        query,
        variables: {
          q: `title:'${title.replace(/'/g, "\\'")}'`,
        },
      },
      {
        headers: {
          "X-Shopify-Access-Token": shopSession.access_token,
          "Content-Type": "application/json",
        },
      },
    );

    const nodes = response?.data?.data?.products?.nodes || [];
    const exact = nodes.find((node) => String(node?.title || "").trim().toLowerCase() === title.toLowerCase());
    const picked = exact || nodes[0] || null;
    const variantGid = picked?.variants?.nodes?.[0]?.id || "";
    const resolved = normalizeVariantId(variantGid);
    cache.set(cacheKey, resolved || "");
    return resolved || "";
  } catch (error) {
    console.warn(`Unable to resolve rental variant by title "${title}":`, error.message);
    cache.set(cacheKey, "");
    return "";
  }
}

async function extractRentalLinesFromOrderPayload(payload = {}, preferredShop = "") {
  const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
  const titleCache = new Map();
  const rentalTagged = String(payload?.tags || "")
    .toLowerCase()
    .includes("rental");

  const extracted = await Promise.all(
    lineItems.map(async (lineItem) => {
      const properties = normalizeLineItemPropertyMap(lineItem);
      const rentalEnabled = String(
        properties["Rental Enabled"] ||
          properties["_Rental Enabled"] ||
          properties["_RentalEnabled"] ||
          properties["_rental_enabled"] ||
          "",
      )
        .trim()
        .toLowerCase();

      const variantId = await resolveRentalVariantId(preferredShop, lineItem, properties, titleCache);
      const startDate = normalizeDateOnly(
        properties["Start Date"] ||
          properties["_Start Date"] ||
          properties["_Rental Start Date"] ||
          properties["_RentalStartDate"] ||
          properties["_start_date"] ||
          "",
      );
      const endDate = normalizeDateOnly(
        properties["End Date"] ||
          properties["_End Date"] ||
          properties["_Rental End Date"] ||
          properties["_RentalEndDate"] ||
          properties["_end_date"] ||
          "",
      );
      const rateType = String(
        properties["Rental Type"] ||
          properties["_Rental Type"] ||
          properties["_RentalType"] ||
          properties["_rental_type"] ||
          properties["Rental Frequency"] ||
          "",
      ).trim();
      const duration = normalizePositiveInt(
        properties["Rental Duration"] ||
          properties["_Rental Duration"] ||
          properties["_RentalDuration"] ||
          properties["_rental_duration"] ||
          "",
        0,
      );
      const quantity = Math.max(1, Number(lineItem?.quantity) || 1);
      const rateAmount = getRentalUnitPriceFromProperties(properties, 0, quantity) || null;

      const hasRentalDetails =
        Boolean(startDate) ||
        Boolean(endDate) ||
        Boolean(rateType) ||
        Boolean(duration) ||
        Boolean(rateAmount);

      const rentalFlag =
        rentalEnabled === "yes" ||
        rentalEnabled === "true" ||
        rentalEnabled === "1" ||
        rentalTagged;

      if (!rentalFlag && !hasRentalDetails) {
        return null;
      }

      let resolvedStartDate = startDate;
      let resolvedEndDate = endDate;

      if (!resolvedStartDate && payload?.created_at) {
        resolvedStartDate = normalizeDateOnly(payload.created_at);
      }

      if (!resolvedEndDate && resolvedStartDate && duration && rateType) {
        const days = Math.max(1, duration) * Math.max(1, frequencyToDays(rateType));
        const parsedStart = new Date(resolvedStartDate);
        if (!Number.isNaN(parsedStart.getTime())) {
          parsedStart.setDate(parsedStart.getDate() + days);
          resolvedEndDate = normalizeDateOnly(parsedStart.toISOString());
        }
      }

      if (!resolvedEndDate && resolvedStartDate && rentalTagged) {
        resolvedEndDate = resolvedStartDate;
      }

      if (!variantId || !resolvedStartDate || !resolvedEndDate) return null;

      return {
        variantId,
        startDate: resolvedStartDate,
        endDate: resolvedEndDate,
        rateType: rateType || null,
        rateAmount,
        quantity,
        status: getWebhookInitialStatus(resolvedStartDate, resolvedEndDate),
      };
    }),
  );

  return extracted.filter(Boolean);
}

function forceRentalLinesStatus(rentalLines = [], nextStatus = "Reserved") {
  return (Array.isArray(rentalLines) ? rentalLines : []).map((line) => ({
    ...line,
    status: String(nextStatus || "Reserved").trim() || "Reserved",
  }));
}

function rentalStatusRank(status = "") {
  switch (String(status || "").trim().toLowerCase()) {
    case "return requested":
      return 4;
    case "return":
      return 3;
    case "on rent":
    case "rented":
      return 2;
    case "reserved":
      return 1;
    default:
      return 0;
  }
}

function choosePreferredRentalStatus(existingStatus = "", incomingStatus = "Reserved") {
  const normalizedExisting = String(existingStatus || "").trim() || "Reserved";
  const normalizedIncoming = String(incomingStatus || "").trim() || "Reserved";
  return rentalStatusRank(normalizedExisting) >= rentalStatusRank(normalizedIncoming)
    ? normalizedExisting
    : normalizedIncoming;
}

function parseRequestedReturnQuantity(value = "") {
  const matches = String(value || "").match(/\bx(\d+)\b/gi) || [];
  return matches.reduce((sum, match) => {
    const qty = Number(String(match || "").replace(/[^0-9]/g, ""));
    return sum + (Number.isFinite(qty) ? qty : 0);
  }, 0);
}

function buildRentalQuantityState(row = {}, fallbackQuantity = 0) {
  const totalQuantity = Math.max(1, Number(row?.quantity) || Number(fallbackQuantity) || 1);
  const status = String(row?.status || "").trim().toLowerCase();
  if (status === "return" || status === "closed") {
    return {
      totalQuantity,
      returnedQuantity: totalQuantity,
      availableQuantity: 0,
    };
  }

  const returnedQuantity = Math.max(
    0,
    Number(row?.return_quantity) ||
      Number(row?.returned_quantity) ||
      Number(row?.returnedQuantity) ||
      Number(row?.returnedQty) ||
      (String(row?.status || "").trim().toLowerCase() === "return"
        ? parseRequestedReturnQuantity(row?.return_reason || "") || totalQuantity
        : parseRequestedReturnQuantity(row?.return_reason || "")),
  );
  const availableQuantity = Math.max(0, totalQuantity - returnedQuantity);

  return {
    totalQuantity,
    returnedQuantity,
    availableQuantity,
  };
}

function hasPendingReturnRequest(row = {}, statuses = [], tags = []) {
  const normalizedStatuses = (Array.isArray(statuses) ? statuses : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);

  const normalizedTags = Array.isArray(tags)
    ? tags.map((tag) => String(tag || "").trim().toLowerCase()).filter(Boolean)
    : [];
  const hasPendingTag = normalizedTags.includes("rental: return requested");
  const hasApprovedTag = normalizedTags.includes("rental: return");
  const hasRejectedTag = normalizedTags.includes("rental: rejected");

  const hasReturnMetadata =
    String(row?.return_reason || "").trim() ||
    String(row?.return_requested_at || "").trim();
  const hasPendingQuantity = Number(row?.return_quantity) > 0;
  const hasPendingStatus = normalizedStatuses.some((status) => status === "return requested");
  const hasFinalStatus =
    normalizedStatuses.some((status) => status === "return" || status === "rejected");

  if (hasRejectedTag) return false;
  if (hasApprovedTag && !hasPendingTag && !hasReturnMetadata && !hasPendingQuantity && !hasPendingStatus) {
    return false;
  }
  if (hasFinalStatus && !hasPendingTag && !hasReturnMetadata && !hasPendingQuantity && !hasPendingStatus) {
    return false;
  }

  return Boolean(
    hasPendingTag ||
      hasReturnMetadata ||
      hasPendingQuantity ||
      hasPendingStatus,
  );
}

function hasPendingReturnOrder(order = {}) {
  const status = String(order?.status || "").trim().toLowerCase();

  const tags = Array.isArray(order?.tags) ? order.tags : [];
  const hasPendingTag = tags.some(
    (tag) => String(tag || "").trim().toLowerCase() === "rental: return requested",
  );
  const hasApprovedTag = tags.some(
    (tag) => String(tag || "").trim().toLowerCase() === "rental: return",
  );
  const hasRejectedTag = tags.some(
    (tag) => String(tag || "").trim().toLowerCase() === "rental: rejected",
  );

  const hasReturnMetadata =
    String(order?.returnReason || "").trim() || String(order?.returnRequestedAt || "").trim();
  const hasPendingQuantity =
    Number(order?.returnQuantity) > 0 ||
    Number(order?.returnedQuantity) > 0 ||
    Number(order?.returnRequestedQuantity) > 0;
  const hasPendingStatus = status === "return requested";
  const hasFinalStatus = status === "return" || status === "rejected" || status === "closed";

  if (hasRejectedTag) {
    return false;
  }

  if (
    hasApprovedTag &&
    !hasPendingTag &&
    !hasReturnMetadata &&
    !hasPendingQuantity &&
    !hasPendingStatus
  ) {
    return false;
  }

  if (hasFinalStatus && !hasPendingTag && !hasReturnMetadata && !hasPendingQuantity && !hasPendingStatus) {
    return false;
  }

  return Boolean(
    hasPendingStatus || hasPendingTag || hasReturnMetadata || hasPendingQuantity,
  );
}

function hasShopifyReturnRequestTag(tags = []) {
  const normalizedTags = Array.isArray(tags)
    ? tags.map((tag) => String(tag || "").trim().toLowerCase()).filter(Boolean)
    : [];
  return normalizedTags.includes("rental: return requested");
}

async function backfillReturnRequestFromShopifyTags(preferredShop, orderDetailsById = {}, rows = []) {
  const cleanRows = Array.isArray(rows) ? rows : [];
  const updates = [];

  for (const row of cleanRows) {
    const orderId = String(row?.shopify_order_id || "").trim();
    if (!orderId) continue;

    const details = orderDetailsById[orderId] || {};
    if (!hasShopifyReturnRequestTag(details?.tags || [])) continue;

    const currentStatus = summarizeRentalStatuses([row?.status || ""]);
    if (currentStatus === "Return" || currentStatus === "Rejected") continue;

    const hasPendingMetadata =
      String(row?.return_reason || "").trim() ||
      String(row?.return_requested_at || "").trim() ||
      Number(row?.return_quantity) > 0;
    if (hasPendingMetadata) continue;

    const updateRes = await pool.query(
      `UPDATE rentals
       SET status = 'Return Requested',
           return_quantity = CASE
             WHEN COALESCE(return_quantity, 0) <= 0 THEN COALESCE(quantity, 1)
             ELSE return_quantity
           END,
           return_reason = COALESCE(NULLIF(TRIM(return_reason), ''), 'Return request received from Shopify'),
           return_requested_at = COALESCE(return_requested_at, NOW()),
           updated_at = NOW()
       WHERE shopify_order_id = $1
         AND lower(shop) = lower($2)
       RETURNING shopify_order_id, status`,
      [orderId, String(row?.shop || "").trim() || normalizeShopDomain(preferredShop || "")],
    );

    if (updateRes.rows?.length) {
      updates.push(updateRes.rows[0]);
    }
  }

  return updates;
}

async function backfillReturnQuantityFromReason(orderId, shop) {
  const cleanOrderId = String(orderId || "").trim();
  const cleanShop = normalizeShopDomain(shop || "");
  if (!cleanOrderId || !cleanShop) return;

  const { rows } = await pool.query(
    `SELECT shopify_order_id, variant_id, start_date, end_date, quantity, rate_type, rate_amount, return_quantity, return_reason
     FROM rentals
     WHERE shopify_order_id = $1
       AND lower(shop) = lower($2)
       AND COALESCE(return_quantity, 0) <= 0`,
    [cleanOrderId, cleanShop],
  );

  for (const row of rows || []) {
    const parsedQuantity = parseRequestedReturnQuantity(row?.return_reason || "");
    if (parsedQuantity <= 0) continue;
    await pool.query(
      `UPDATE rentals
       SET return_quantity = $1,
           updated_at = NOW()
       WHERE shopify_order_id = $2
         AND lower(shop) = lower($3)
         AND variant_id = $4
         AND start_date = $5
         AND end_date = $6
         AND quantity = $7
         AND rate_type = $8
         AND rate_amount = $9
         AND COALESCE(return_quantity, 0) <= 0`,
      [
        parsedQuantity,
        cleanOrderId,
        cleanShop,
        row?.variant_id,
        row?.start_date,
        row?.end_date,
        row?.quantity,
        row?.rate_type,
        row?.rate_amount,
      ],
    );
  }
}

function serializeRentalQuantityState(quantityState = {}) {
  const totalQuantity = Math.max(0, Number(quantityState?.totalQuantity) || 0);
  const returnedQuantity = Math.max(0, Number(quantityState?.returnedQuantity) || 0);
  const availableQuantity = Math.max(0, Number(quantityState?.availableQuantity) || 0);

  return {
    quantity: totalQuantity,
    totalQuantity,
    totalQty: totalQuantity,
    returnedQuantity,
    returnedQty: returnedQuantity,
    availableQuantity,
    availableQty: availableQuantity,
  };
}

function buildRentalLineKey(line = {}) {
  return [
    String(line?.variantId || "").trim(),
    String(line?.startDate || "").trim(),
    String(line?.endDate || "").trim(),
    String(line?.quantity || "").trim(),
    String(line?.rateType || "").trim().toLowerCase(),
    String(line?.rateAmount || "").trim(),
  ].join("|");
}

function preserveRentalReturnState(existingRows = [], incomingLine = {}) {
  const rows = Array.isArray(existingRows) ? existingRows : [];
  const incomingKey = buildRentalLineKey(incomingLine);
  const exactMatch = rows.find((row) => buildRentalLineKey({
    variantId: row?.variant_id,
    startDate: row?.start_date,
    endDate: row?.end_date,
    quantity: row?.quantity,
    rateType: row?.rate_type,
    rateAmount: row?.rate_amount,
  }) === incomingKey);
  const returnRequestedMatch = rows.find((row) => {
    const status = String(row?.status || "").trim().toLowerCase();
    const hasReturnMetadata =
      String(row?.return_reason || "").trim() ||
      String(row?.return_requested_at || "").trim();
    return status === "return requested" || Boolean(hasReturnMetadata);
  });
  const preferredRow =
    returnRequestedMatch ||
    exactMatch ||
    rows
      .slice()
      .sort((a, b) => {
        const statusDelta =
          rentalStatusRank(b?.status) - rentalStatusRank(a?.status);
        if (statusDelta) return statusDelta;
        const aCreated = new Date(a?.created_at || 0).getTime();
        const bCreated = new Date(b?.created_at || 0).getTime();
        return bCreated - aCreated;
      })[0] ||
    null;

  return {
    status: choosePreferredRentalStatus(preferredRow?.status, incomingLine?.status),
    returnQuantity: Number(preferredRow?.return_quantity) || 0,
    returnReason: String(preferredRow?.return_reason || "").trim(),
    returnRequestedAt: String(preferredRow?.return_requested_at || "").trim(),
  };
}

function extractRentalCustomerDetails(payload = {}) {
  return {
    customerName: String(
      payload?.shipping_address?.name ||
        payload?.billing_address?.name ||
        [payload?.customer?.first_name, payload?.customer?.last_name].filter(Boolean).join(" ") ||
        payload?.customer?.email ||
        "",
    ).trim(),
    customerEmail: String(
      payload?.email ||
        payload?.contact_email ||
        payload?.customer?.email ||
        "",
    ).trim(),
    customerPhone: String(
      payload?.phone ||
        payload?.shipping_address?.phone ||
        payload?.billing_address?.phone ||
        payload?.customer?.phone ||
        payload?.customer?.default_address?.phone ||
        "",
    ).trim(),
  };
}

async function upsertRentalRowsForOrder(orderId, shop, rentalLines, customerDetails, options = {}) {
  const { deductStock = false } = options;

  if (!orderId || !Array.isArray(rentalLines) || !rentalLines.length) {
    return { processed: 0 };
  }

  const existingStatusResult = await pool.query(
    `SELECT
        variant_id,
        start_date,
        end_date,
        quantity,
        rate_type,
        rate_amount,
        status,
        return_reason,
        return_requested_at,
        created_at
     FROM rentals
     WHERE shopify_order_id = $1
       AND lower(shop) = lower($2)`,
    [orderId, shop],
  );
  const existingRows = Array.isArray(existingStatusResult?.rows) ? existingStatusResult.rows : [];

  await pool.query(`DELETE FROM rentals WHERE shopify_order_id = $1`, [orderId]);

  for (const rentalLine of rentalLines) {
    if (deductStock) {
      await deductInventory(rentalLine.variantId, rentalLine.quantity);
    }

    const preservedState = preserveRentalReturnState(existingRows, rentalLine);
    const nextStatus = preservedState.status;

    await pool.query(
      `INSERT INTO rentals
       (shop, variant_id, start_date, end_date, quantity, rate_type, rate_amount, status, return_quantity, return_reason, return_requested_at, shopify_order_id, customer_name, customer_email, customer_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        shop,
        rentalLine.variantId,
        rentalLine.startDate,
        rentalLine.endDate,
        rentalLine.quantity,
        rentalLine.rateType,
        rentalLine.rateAmount,
        nextStatus,
        preservedState.returnQuantity || null,
        preservedState.returnReason || null,
        preservedState.returnRequestedAt || null,
        orderId,
        customerDetails.customerName,
        customerDetails.customerEmail,
        customerDetails.customerPhone,
      ],
    );
    await syncInventoryCounters(rentalLine.variantId);
  }

  return { processed: rentalLines.length };
}

const ADMIN_RENTAL_ORDER_STATUS_TAGS = [
  "Rental: Reserved",
  "Rental: On Rent",
  "Rental: Return Requested",
  "Rental: Return",
  "Rental: Rejected",
];

function toOrderGid(rawId) {
  const value = String(rawId || "").trim();
  if (!value) return "";
  if (value.startsWith("gid://")) return value;
  return `gid://shopify/Order/${value}`;
}

async function getGraphqlClientForShop(preferredShop = "") {
  const shopSession = await getStoredShopSession(preferredShop);
  if (!shopSession) {
    throw new Error("No Shopify offline token found. Re-auth required");
  }

  return new shopify.clients.Graphql({
    session: {
      id: `offline_${shopSession.shop}`,
      shop: shopSession.shop,
      accessToken: shopSession.access_token,
      isOnline: false,
    },
  });
}

async function fetchShopifyVariantInventoryQuantity(preferredShop, variantId) {
  const normalizedVariantId = normalizeVariantId(variantId);
  if (!normalizedVariantId) return null;

  const graphqlClient = await getGraphqlClientForShop(preferredShop);
  const response = await graphqlClient.query({
    data: {
      query: `
        query VariantInventoryQuantity($id: ID!) {
          productVariant(id: $id) {
            id
            inventoryQuantity
          }
        }
      `,
      variables: {
        id: toVariantGid(normalizedVariantId),
      },
    },
  });

  const quantity = response?.body?.data?.productVariant?.inventoryQuantity;
  if (quantity == null) return null;

  const numeric = Number(quantity);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : null;
}

async function fetchShopifyVariantImageUrl(preferredShop, variantId) {
  const normalizedVariantId = normalizeVariantId(variantId);
  if (!normalizedVariantId) return "";

  try {
    const graphqlClient = await getGraphqlClientForShop(preferredShop);
    const response = await graphqlClient.query({
      data: {
        query: `
          query VariantImageUrl($id: ID!) {
            productVariant(id: $id) {
              id
              image {
                url
              }
              product {
                featuredImage {
                  url
                }
                images(first: 1) {
                  nodes {
                    url
                  }
                }
              }
            }
          }
        `,
        variables: {
          id: toVariantGid(normalizedVariantId),
        },
      },
    });

    const variant = response?.body?.data?.productVariant;
    return String(
      variant?.image?.url ||
        variant?.product?.featuredImage?.url ||
        variant?.product?.images?.nodes?.[0]?.url ||
        "",
    ).trim();
  } catch (error) {
    console.warn("Unable to resolve Shopify variant image:", error.message);
    return "";
  }
}

async function updateAdminOrderStatusTag(preferredShop, orderIdOrGid, statusLabel) {
  const orderGid = toOrderGid(orderIdOrGid);
  const cleanStatus = String(statusLabel || "").trim();
  if (!orderGid || !cleanStatus) return;

  const graphqlClient = await getGraphqlClientForShop(preferredShop);
  const currentResponse = await graphqlClient.query({
    data: {
      query: `
        query OrderStatusTags($id: ID!) {
          order(id: $id) {
            id
            tags
            note
          }
        }
      `,
      variables: { id: orderGid },
    },
  });

  const currentOrder = currentResponse?.body?.data?.order;
  if (!currentOrder?.id) return;

  const filteredTags = (Array.isArray(currentOrder.tags) ? currentOrder.tags : []).filter(
    (tag) => !ADMIN_RENTAL_ORDER_STATUS_TAGS.includes(String(tag || "").trim()),
  );
  const nextTags = filteredTags.concat([`Rental: ${cleanStatus}`]);
  const currentNote = String(currentOrder.note || "");
  const rentalStatusLine = `Rental Status: ${cleanStatus}`;
  const noteLines = currentNote
    .split(/\r?\n/)
    .filter((line) => !/^Rental Status:/i.test(String(line || "").trim()));
  noteLines.push(rentalStatusLine);
  const nextNote = noteLines.join("\n").trim();

  const updateResponse = await graphqlClient.query({
    data: {
      query: `
        mutation UpdateOrderStatusTag($input: OrderInput!) {
          orderUpdate(input: $input) {
            order {
              id
              tags
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
      variables: {
        input: {
          id: currentOrder.id,
          tags: nextTags,
          note: nextNote,
        },
      },
    },
  });

  const userErrors = updateResponse?.body?.data?.orderUpdate?.userErrors || [];
  if (userErrors.length) {
    throw new Error(userErrors.map((item) => item.message).join("; "));
  }
}

async function resolveOrderFromFulfillmentOrder(preferredShop, fulfillmentOrderIdOrGid) {
  const fulfillmentOrderGid = String(fulfillmentOrderIdOrGid || "").trim();
  if (!fulfillmentOrderGid) return null;

  const graphqlClient = await getGraphqlClientForShop(preferredShop);
  const response = await graphqlClient.query({
    data: {
      query: `
        query FulfillmentOrderOwner($id: ID!) {
          node(id: $id) {
            ... on FulfillmentOrder {
              id
              order {
                id
              }
            }
          }
        }
      `,
      variables: { id: fulfillmentOrderGid },
    },
  });

  return response?.body?.data?.node?.order?.id || "";
}

async function syncAdminOrderStatusFromRentals(preferredShop, orderId) {
  await ensureRentalOrderColumns();

  const rows = await pool.query(
    `SELECT status
     FROM rentals
     WHERE shopify_order_id = $1`,
    [String(orderId || "").trim()],
  );

  const statuses = (rows.rows || [])
    .map((row) => String(row?.status || "").trim().toLowerCase())
    .filter(Boolean);

  if (!statuses.length) return;

  let nextStatus = "Reserved";
  if (statuses.some((status) => status === "rejected")) {
    nextStatus = "Rejected";
  } else if (statuses.some((status) => status === "return requested")) {
    nextStatus = "Return Requested";
  } else if (statuses.some((status) => status === "on rent" || status === "rented")) {
    nextStatus = "On Rent";
  } else if (statuses.every((status) => status === "return")) {
    nextStatus = "Return";
  } else if (statuses.some((status) => status === "reserved")) {
    nextStatus = "Reserved";
  }

  await updateAdminOrderStatusTag(preferredShop, orderId, nextStatus);
}

async function updateRentalRowsStatusByOrder(orderId, nextStatus) {
  const cleanOrderId = String(orderId || "").trim();
  const cleanStatus = String(nextStatus || "").trim();
  if (!cleanOrderId || !cleanStatus) return;

  await ensureRentalOrderColumns();
  const result = await pool.query(
    `UPDATE rentals
     SET status = $2,
         updated_at = NOW()
     WHERE shopify_order_id = $1`,
    [cleanOrderId, cleanStatus],
  );

  return result.rowCount || 0;
}

function summarizeRentalStatuses(values = []) {
  const statuses = (Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);

  if (!statuses.length) return "Reserved";
  if (statuses.some((status) => status === "rejected")) {
    return "Rejected";
  }
  if (statuses.some((status) => status === "return")) {
    return "Return";
  }
  if (statuses.some((status) => status === "return requested")) {
    return "Return Requested";
  }
  if (statuses.some((status) => status === "on rent" || status === "rented")) {
    return "On Rent";
  }
  return "Reserved";
}

function resolveRentalDisplayStatus({
  status = "",
  returnQuantity = 0,
  returnReason = "",
  returnRequestedAt = "",
  tags = [],
  fallback = "Reserved",
} = {}) {
  const normalizedStatus = summarizeRentalStatuses([status]);
  const normalizedTags = Array.isArray(tags)
    ? tags.map((tag) => String(tag || "").trim().toLowerCase()).filter(Boolean)
    : [];
  const hasRejectedTag = normalizedTags.includes("rental: rejected");
  const hasApprovedTag = normalizedTags.includes("rental: return");
  const hasPendingTag = normalizedTags.includes("rental: return requested");
  const hasReturnMetadata =
    String(returnReason || "").trim() || String(returnRequestedAt || "").trim();

  if (normalizedStatus === "rejected" || hasRejectedTag) return "Rejected";
  if (normalizedStatus === "return" || hasApprovedTag) return "Return";
  if (normalizedStatus === "return requested" || hasPendingTag || hasReturnMetadata) {
    return "Return Requested";
  }
  if (normalizedStatus && normalizedStatus !== "processing") return normalizedStatus;
  return fallback || "Reserved";
}

async function fetchOrderNames(preferredShop, orderIds = []) {
  const cleanIds = Array.from(
    new Set(
      (Array.isArray(orderIds) ? orderIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    ),
  );

  if (!cleanIds.length) return {};

  try {
    const graphqlClient = await getGraphqlClientForShop(preferredShop);
    const response = await graphqlClient.query({
      data: {
        query: `
          query RentalAdminOrders($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Order {
                id
                name
              }
            }
          }
        `,
        variables: {
          ids: cleanIds.map((id) => toOrderGid(id)),
        },
      },
    });

    const nodes = response?.body?.data?.nodes || [];
    return nodes.reduce((acc, node) => {
      const key = String(node?.id || "")
        .trim()
        .replace(/^gid:\/\/shopify\/Order\//, "");
      if (key) {
        acc[key] = String(node?.name || "").trim() || `#${key}`;
      }
      return acc;
    }, {});
  } catch (error) {
    console.warn("Unable to resolve Shopify order names for rental admin grid:", error.message);
    return {};
  }
}

function formatAdminCustomerName(customer = {}) {
  const parts = [
    String(customer?.displayName || "").trim(),
    [customer?.firstName || customer?.first_name, customer?.lastName || customer?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim(),
    String(customer?.email || "").trim(),
  ].filter(Boolean);
  return parts[0] || "Guest";
}

function normalizeAddressLines(address) {
  if (!address) return [];
  return [
    String(address.name || "").trim(),
    String(address.address1 || address.address_1 || "").trim(),
    String(address.address2 || address.address_2 || "").trim(),
    [address.city, address.zip].filter(Boolean).join(" ").trim(),
    String(
      address.provinceCode ||
        address.province_code ||
        address.province ||
        address.countryCode ||
        address.country_code ||
        address.country ||
        "",
    ).trim(),
  ].filter(Boolean);
}

function extractRentalAdminLineItems(lineItems = []) {
  const RENTAL_ENABLED_KEYS = [
    "Rental Enabled",
    "_Rental Enabled",
    "_RentalEnabled",
    "_rental_enabled",
  ];
  const START_DATE_KEYS = [
    "Start Date",
    "_Start Date",
    "_Rental Start Date",
    "_RentalStartDate",
    "_Rental Start",
    "_start_date",
  ];
  const END_DATE_KEYS = [
    "End Date",
    "_End Date",
    "_Rental End Date",
    "_RentalEndDate",
    "_Rental End",
    "_end_date",
  ];
  const RATE_TYPE_KEYS = [
    "Rental Type",
    "_Rental Type",
    "_RentalType",
    "_rental_type",
    "Rental Frequency",
    "_Rental Frequency",
  ];
  const DURATION_KEYS = [
    "Rental Duration",
    "_Rental Duration",
    "_RentalDuration",
    "_rental_duration",
  ];
  const SELECTED_ITEM_KEYS = [
    "Selected Product Item",
    "_Selected Product Item",
    "_SelectedProductItem",
    "_selected_product_item",
    "S.Number",
    "L.Number",
    "S Number",
    "L Number",
  ];
  const SERIAL_NUMBER_KEYS = [
    "Serial Number",
    "_Serial Number",
    "_SerialNumber",
    "_serial_number",
  ];
  const PRICE_KEYS = [
    "Rental Line Price",
    "_Rental Line Price",
    "_RentalLinePrice",
    "_rental_line_price",
    "Rental Price",
    "_Rental Price",
    "_RentalPrice",
    "_rental_price",
  ];
  const STATUS_KEYS = [
    "Rental Status",
    "_Rental Status",
    "_RentalStatus",
    "_rental_status",
    "Return Status",
  ];

  return (Array.isArray(lineItems) ? lineItems : [])
    .map((line) => {
      const properties = normalizeAttributeMap(line?.customAttributes || []);
      const startDate = normalizeDateOnly(getPropertyValue(properties, START_DATE_KEYS));
      const endDate = normalizeDateOnly(getPropertyValue(properties, END_DATE_KEYS));
      const rateType = getPropertyValue(properties, RATE_TYPE_KEYS);
      const duration = getPropertyValue(properties, DURATION_KEYS);
      const selectedItem =
        getPropertyValue(properties, SERIAL_NUMBER_KEYS) ||
        getPropertyValue(properties, SELECTED_ITEM_KEYS);
      const priceText = getPropertyValue(properties, PRICE_KEYS);
      const enabled = getBooleanProperty(properties, RENTAL_ENABLED_KEYS);
      const rentalStatus = normalizeRentalStatus(
        getPropertyValue(properties, STATUS_KEYS),
        startDate,
        endDate,
      );

      if (!(enabled || startDate || endDate || rateType || duration || selectedItem || priceText)) {
        return null;
      }

      return {
        title: String(line?.title || "Rental item").trim() || "Rental item",
        quantity: Math.max(1, Number(line?.quantity) || 1),
        imageUrl: String(
          line?.image?.url ||
            line?.imageUrl ||
            line?.image_url ||
            line?.variant?.image?.url ||
            line?.variant?.product?.featuredImage?.url ||
            line?.variant?.product?.image?.url ||
            "",
        ).trim(),
        startDate,
        endDate,
        rateType,
        duration,
        selectedItem,
        itemNumber: String(selectedItem || "").trim(),
        priceText,
        status: statusLabel(rentalStatus),
      };
    })
    .filter(Boolean);
}

function buildAdminOrderDetails(orderId, source = {}) {
  const allLineItems = Array.isArray(source?.lineItems) ? source.lineItems : [];
  const rentalLines = extractRentalAdminLineItems(allLineItems);
  const fallbackProductNames = Array.from(
    new Set(
      allLineItems
        .map((line) => String(line?.title || "").trim())
        .filter(Boolean),
    ),
  );
  const productNames = Array.from(
    new Set(
      (rentalLines.length ? rentalLines : fallbackProductNames.map((title) => ({ title })))
        .map((line) => String(line?.title || "").trim())
        .filter(Boolean),
    ),
  );
  const customerName =
    String(source?.shippingAddress?.name || "").trim() ||
    String(source?.billingAddress?.name || "").trim() ||
    formatAdminCustomerName(source?.customer) ||
    "Guest";
  const customerId = normalizeCustomerId(
    source?.customerId ||
      source?.customer?.id ||
      "",
  );
  const customerEmail = String(
    source?.customerEmail ||
      source?.customerContactEmail ||
      source?.orderEmail ||
      source?.customer?.email ||
      source?.customer?.default_address?.email ||
      "",
  ).trim();
  const customerPhone = String(
    source?.customerPhone ||
      source?.orderPhone ||
      source?.customer?.phone ||
      source?.customer?.default_address?.phone ||
      source?.shippingAddress?.phone ||
      source?.billingAddress?.phone ||
      "",
  ).trim();
  const fulfillmentStatus = normalizeFulfillmentStatus(
    source?.displayFulfillmentStatus ||
      source?.fulfillmentStatus ||
      source?.fulfillment_status ||
      "",
  );

  return {
    orderLabel: String(source?.orderLabel || "").trim() || `#${orderId}`,
    customerId,
    customerName,
    customerEmail,
    customerPhone,
    fulfillmentStatus,
    tags: Array.isArray(source?.tags) ? source.tags.map((tag) => String(tag || "").trim()).filter(Boolean) : [],
    productName: productNames.join(", "),
    productNames,
    shippingAddressLines: normalizeAddressLines(source?.shippingAddress),
    billingAddressLines: normalizeAddressLines(source?.billingAddress),
    rentalLines: rentalLines.length
      ? rentalLines
      : fallbackProductNames.map((title) => ({
          title,
          quantity: 0,
          startDate: "",
          endDate: "",
          rateType: "",
          duration: "",
          selectedItem: "",
          priceText: "",
          status: "Reserved",
        })),
  };
}

async function fetchAdminOrdersMap(preferredShop, orderIds = []) {
  const cleanIds = Array.from(
    new Set(
      (Array.isArray(orderIds) ? orderIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    ),
  );

  if (!cleanIds.length) return {};

  try {
    const graphqlClient = await getGraphqlClientForShop(preferredShop);
    const response = await graphqlClient.query({
      data: {
        query: `
          query RentalAdminOrders($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Order {
                id
                name
                email
                phone
                displayFulfillmentStatus
                tags
                customer {
                  id
                  displayName
                  firstName
                  lastName
                  email
                  phone
                }
                shippingAddress {
                  name
                  address1
                  address2
                  city
                  zip
                  phone
                  provinceCode
                  countryCode
                }
                billingAddress {
                  name
                  address1
                  address2
                  city
                  zip
                  phone
                  provinceCode
                  countryCode
                }
                lineItems(first: 100) {
                  nodes {
                    title
                    quantity
                    image {
                      url
                    }
                    variant {
                      image {
                        url
                      }
                      product {
                        featuredImage {
                          url
                        }
                        image {
                          url
                        }
                      }
                    }
                    customAttributes {
                      key
                      value
                    }
                  }
                }
              }
            }
          }
        `,
        variables: {
          ids: cleanIds.map((id) => toOrderGid(id)),
        },
      },
    });

    const nodes = response?.body?.data?.nodes || [];
    return nodes.reduce((acc, node) => {
      const orderId = String(node?.id || "")
        .trim()
        .replace(/^gid:\/\/shopify\/Order\//, "");
      if (!orderId) return acc;

      acc[orderId] = buildAdminOrderDetails(orderId, {
        orderLabel: String(node?.name || "").trim(),
        orderEmail: String(node?.email || "").trim(),
        orderPhone: String(node?.phone || "").trim(),
        displayFulfillmentStatus: String(node?.displayFulfillmentStatus || "").trim(),
        tags: Array.isArray(node?.tags) ? node.tags : [],
        customer: node?.customer,
        shippingAddress: node?.shippingAddress,
        billingAddress: node?.billingAddress,
              lineItems: Array.isArray(node?.lineItems?.nodes) ? node.lineItems.nodes : [],
            });
      return acc;
    }, {});
  } catch (error) {
    console.warn("Unable to resolve Shopify order details for rental admin grid:", error.message);
    return {};
  }
}

async function fetchAdminOrdersMapViaRest(preferredShop, orderIds = []) {
  const cleanIds = Array.from(
    new Set(
      (Array.isArray(orderIds) ? orderIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    ),
  );

  if (!cleanIds.length) return {};

  try {
    const shopSession = await getStoredShopSession(preferredShop);
    if (!shopSession?.shop || !shopSession?.access_token) return {};

    const responses = await Promise.all(
      cleanIds.map(async (orderId) => {
        try {
          const response = await axios.get(
            `https://${shopSession.shop}/admin/api/2025-01/orders/${encodeURIComponent(orderId)}.json`,
            {
              headers: {
                "X-Shopify-Access-Token": shopSession.access_token,
              },
              params: {
              status: "any",
                fields: "id,name,email,contact_email,phone,customer,shipping_address,billing_address,line_items,tags,fulfillment_status,display_fulfillment_status",
              },
            },
          );

          const order = response?.data?.order;
          if (!order?.id) return [orderId, null];

          const normalizedLineItems = Array.isArray(order?.line_items)
            ? order.line_items.map((line) => ({
                title: line?.title,
                quantity: line?.quantity,
                imageUrl: String(line?.image_url || line?.image?.src || "").trim(),
                customAttributes: Array.isArray(line?.properties)
                  ? line.properties.map((property) => ({
                      key: property?.name,
                      value: property?.value,
                    }))
                  : [],
              }))
            : [];

          return [
            orderId,
            buildAdminOrderDetails(orderId, {
              orderLabel: String(order?.name || "").trim(),
              customer: order?.customer,
              customerContactEmail: String(order?.contact_email || "").trim(),
              orderEmail: String(order?.email || "").trim(),
              orderPhone: String(order?.phone || "").trim(),
              displayFulfillmentStatus: String(order?.display_fulfillment_status || order?.fulfillment_status || "").trim(),
              tags: Array.isArray(order?.tags) ? order.tags : [],
              shippingAddress: order?.shipping_address,
              billingAddress: order?.billing_address,
              lineItems: normalizedLineItems,
            }),
          ];
        } catch (innerError) {
          console.warn(`Unable to load Shopify REST order ${orderId}:`, innerError.message);
          return [orderId, null];
        }
      }),
    );

    return responses.reduce((acc, [orderId, details]) => {
      if (orderId && details) acc[orderId] = details;
      return acc;
    }, {});
  } catch (error) {
    console.warn("Unable to resolve Shopify REST order details for rental admin grid:", error.message);
    return {};
  }
}

async function fetchShopifyOrderPayloadViaRest(preferredShop, orderId) {
  const cleanOrderId = String(orderId || "").trim();
  if (!cleanOrderId) return null;

  try {
    const shopSession = await getStoredShopSession(preferredShop);
    if (!shopSession?.shop || !shopSession?.access_token) return null;

    const response = await axios.get(
      `https://${shopSession.shop}/admin/api/2025-01/orders/${encodeURIComponent(cleanOrderId)}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": shopSession.access_token,
        },
        params: {
          status: "any",
          fields: "id,name,email,contact_email,phone,customer,shipping_address,billing_address,line_items,tags,created_at,fulfillment_status,display_fulfillment_status",
        },
      },
    );

    return response?.data?.order || null;
  } catch (error) {
    console.warn(`Unable to load Shopify REST order ${cleanOrderId}:`, error?.message || error);
    return null;
  }
}

async function fetchResolvedAdminOrdersMap(preferredShop, orderIds = []) {
  const graphqlDetails = await fetchAdminOrdersMap(preferredShop, orderIds);
  const missingIds = (Array.isArray(orderIds) ? orderIds : [])
    .map((id) => String(id || "").trim())
    .filter((id) => {
      if (!id) return false;
      const details = graphqlDetails[id];
      if (!details) return true;
      const rentalLines = Array.isArray(details.rentalLines) ? details.rentalLines : [];
      const needsRentalFallback =
        !rentalLines.length ||
        rentalLines.some(
          (line) =>
            !String(line?.itemNumber || line?.selectedItem || line?.serialNumber || "").trim() ||
            !String(line?.imageUrl || line?.productImageUrl || "").trim(),
        );
      return (
        !String(details.customerEmail || "").trim() ||
        !String(details.customerPhone || "").trim() ||
        needsRentalFallback
      );
    });

  if (!missingIds.length) return graphqlDetails;

  const restDetails = await fetchAdminOrdersMapViaRest(preferredShop, missingIds);
  const mergedDetails = { ...graphqlDetails };

  missingIds.forEach((id) => {
    const base = graphqlDetails[id] || {};
    const fallback = restDetails[id] || {};
    const baseRentalLines = Array.isArray(base.rentalLines) ? base.rentalLines : [];
    const fallbackRentalLines = Array.isArray(fallback.rentalLines) ? fallback.rentalLines : [];
    const mergedRentalLines = (fallbackRentalLines.length ? fallbackRentalLines : baseRentalLines).map(
      (fallbackLine, index) => {
        const baseLine = baseRentalLines[index] || {};
        const nextLine = {
          ...fallbackLine,
          ...baseLine,
          title: String(baseLine.title || fallbackLine.title || "Rental item").trim() || "Rental item",
          selectedItem: String(baseLine.selectedItem || fallbackLine.selectedItem || "").trim(),
          itemNumber: String(
            baseLine.itemNumber ||
              fallbackLine.itemNumber ||
              baseLine.selectedItem ||
              fallbackLine.selectedItem ||
              baseLine.serialNumber ||
              fallbackLine.serialNumber ||
              "",
          ).trim(),
          imageUrl: String(baseLine.imageUrl || fallbackLine.imageUrl || "").trim(),
          serialNumber: String(baseLine.serialNumber || fallbackLine.serialNumber || "").trim(),
        };
        return nextLine;
      },
    );

    mergedDetails[id] = {
      ...base,
      ...fallback,
      orderLabel: String(fallback.orderLabel || base.orderLabel || `#${id}`).trim() || `#${id}`,
      customerId: normalizeCustomerId(fallback.customerId || base.customerId || ""),
      customerName: String(fallback.customerName || base.customerName || "Guest").trim() || "Guest",
      customerEmail: String(fallback.customerEmail || base.customerEmail || "").trim(),
      customerPhone: String(fallback.customerPhone || base.customerPhone || "").trim(),
      fulfillmentStatus: normalizeFulfillmentStatus(fallback.fulfillmentStatus || base.fulfillmentStatus || ""),
      productName: String(fallback.productName || base.productName || "").trim(),
      productNames:
        Array.isArray(fallback.productNames) && fallback.productNames.length
          ? fallback.productNames
          : (Array.isArray(base.productNames) ? base.productNames : []),
      shippingAddressLines:
        Array.isArray(fallback.shippingAddressLines) && fallback.shippingAddressLines.length
          ? fallback.shippingAddressLines
          : (Array.isArray(base.shippingAddressLines) ? base.shippingAddressLines : []),
      billingAddressLines:
        Array.isArray(fallback.billingAddressLines) && fallback.billingAddressLines.length
          ? fallback.billingAddressLines
          : (Array.isArray(base.billingAddressLines) ? base.billingAddressLines : []),
      rentalLines: mergedRentalLines.length
        ? mergedRentalLines
        : (Array.isArray(fallback.rentalLines) && fallback.rentalLines.length
            ? fallback.rentalLines
            : (Array.isArray(base.rentalLines) ? base.rentalLines : [])),
    };
  });

  return {
    ...graphqlDetails,
    ...mergedDetails,
  };
}

function parseLinkHeader(headerValue = "") {
  const links = {};
  String(headerValue || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/i);
      if (!match) return;
      const [, url, rel] = match;
      links[rel] = url;
    });
  return links;
}

async function syncHistoricRentalOrders(preferredShop, options = {}) {
  await ensureRentalOrderColumns();

  const maxPages = Math.max(1, Math.min(10, Number(options?.maxPages) || 4));
  const shopSession = await getStoredShopSession(preferredShop);
  if (!shopSession) {
    throw new Error("No Shopify offline token found. Re-auth required");
  }

  let nextUrl = `https://${shopSession.shop}/admin/api/2025-01/orders.json`;
  let page = 0;
  let scanned = 0;
  let synced = 0;

  while (nextUrl && page < maxPages) {
    const requestConfig = {
      headers: {
        "X-Shopify-Access-Token": shopSession.access_token,
      },
    };

    if (page === 0) {
      requestConfig.params = {
        status: "any",
        limit: 250,
        order: "created_at desc",
        fields: "id,name,email,contact_email,phone,customer,shipping_address,billing_address,line_items,created_at,tags",
      };
    }

    const response = await axios.get(nextUrl, requestConfig);
    const orders = Array.isArray(response?.data?.orders) ? response.data.orders : [];
    scanned += orders.length;

    for (const order of orders) {
      const orderId = String(order?.id || "").trim();
      const rentalLines = forceRentalLinesStatus(
        await extractRentalLinesFromOrderPayload(order, shopSession.shop),
        "Reserved",
      );
      if (!orderId || !rentalLines.length) continue;

      const customerDetails = extractRentalCustomerDetails(order);
      await upsertRentalRowsForOrder(orderId, shopSession.shop, rentalLines, customerDetails);
      synced += 1;
    }

    const links = parseLinkHeader(response?.headers?.link || response?.headers?.Link || "");
    nextUrl = links.next || "";
    page += 1;
  }

  return {
    synced,
    scanned,
    pages: page,
    shop: shopSession.shop,
  };
}

router.get("/api/admin/rental-orders", requireAuth, async (ctx) => {
  await ensureRentalOrderColumns();
  await safeRunStatusAutomation("admin rental orders list");

  const preferredShop =
    extractPreferredShop(ctx, ctx.state?.shop || "") ||
    normalizeShopDomain(ctx.state?.shop || "");

  const shouldSync = String(ctx.query?.sync || "").trim().toLowerCase();
  const pendingOnly = String(ctx.query?.pendingOnly || "").trim().toLowerCase() === "1";

  if (!pendingOnly && (shouldSync === "1" || shouldSync === "true" || shouldSync === "latest")) {
    try {
      await syncHistoricRentalOrders(preferredShop, { maxPages: 6 });
    } catch (error) {
      console.warn("Unable to sync latest rental orders:", error?.message || error);
    }
  }

  const result = await pool.query(
    `SELECT
        shopify_order_id,
        shop,
        MIN(start_date) AS start_date,
        MAX(end_date) AS end_date,
        COALESCE(SUM(quantity), 0)::int AS total_quantity,
        COALESCE(SUM(COALESCE(return_quantity, 0)), 0)::int AS return_quantity,
        COALESCE(SUM(COALESCE(rate_amount, 0) * quantity), 0)::numeric AS rental_total,
        MAX(NULLIF(TRIM(customer_name), '')) AS customer_name,
        MAX(NULLIF(TRIM(customer_email), '')) AS customer_email,
        MAX(NULLIF(TRIM(customer_phone), '')) AS customer_phone,
        ARRAY_AGG(status ORDER BY created_at ASC) AS statuses,
        MAX(NULLIF(TRIM(return_reason), '')) AS return_reason,
        MAX(return_requested_at) AS return_requested_at
     FROM rentals
     WHERE shopify_order_id IS NOT NULL
       AND TRIM(shopify_order_id) <> ''
     GROUP BY shopify_order_id, shop
     ORDER BY MAX(created_at) DESC`,
  );

  const rows = result.rows || [];
  const orderDetails = await fetchResolvedAdminOrdersMap(
    preferredShop,
    rows.map((row) => row.shopify_order_id),
  );
  await backfillReturnRequestFromShopifyTags(preferredShop, orderDetails, rows);

  const mappedOrders = rows
    .filter((row) => {
      const orderId = String(row?.shopify_order_id || "").trim();
      const details = orderDetails[orderId] || {};
      return isFulfilledShopifyOrder(details?.fulfillmentStatus);
    })
    .map((row) => {
      const orderId = String(row?.shopify_order_id || "").trim();
      const statuses = Array.isArray(row?.statuses) ? row.statuses : [];
      const details = orderDetails[orderId] || {};
      const tagList = Array.isArray(details?.tags) ? details.tags : [];
      const pendingApproval = hasPendingReturnRequest(row, statuses, tagList);
      const currentStatus = resolveRentalDisplayStatus({
        status: summarizeRentalStatuses(statuses),
        returnQuantity: row?.return_quantity,
        returnReason: row?.return_reason,
        returnRequestedAt: row?.return_requested_at,
        tags: tagList,
        fallback: summarizeRentalStatuses(statuses),
      });
      const quantityState = buildRentalQuantityState(row, row?.total_quantity);
      const quantityPayload = serializeRentalQuantityState(quantityState);

      return {
        orderId,
        orderLabel: details.orderLabel || `#${orderId}`,
        productName: details.productName || "-",
        customerName: details.customerName || String(row?.customer_name || "").trim() || "Guest",
        shop: String(row?.shop || "").trim(),
        startDate: String(row?.start_date || "").trim(),
        endDate: String(row?.end_date || "").trim(),
        ...quantityPayload,
        rentalTotal: toMoneyString(row?.rental_total),
        status: currentStatus,
        pendingApproval,
        tags: tagList,
        returnReason: String(row?.return_reason || "").trim(),
        returnRequestedAt: String(row?.return_requested_at || "").trim(),
      };
    });

  ctx.body = pendingOnly
    ? mappedOrders.filter((order) => hasPendingReturnOrder(order))
    : mappedOrders;
});

router.post("/api/admin/rental-orders/sync", requireAuth, async (ctx) => {
  const preferredShop =
    extractPreferredShop(ctx, ctx.state?.shop || "") ||
    normalizeShopDomain(ctx.state?.shop || "");

  const summary = await syncHistoricRentalOrders(preferredShop, { maxPages: 6 });
  ctx.body = {
    success: true,
    ...summary,
  };
});

router.get("/api/admin/rental-orders/:orderId", requireAuth, async (ctx) => {
  await ensureRentalOrderColumns();
  await safeRunStatusAutomation("admin rental order detail");

  const orderId = String(ctx.params?.orderId || "").trim();
  if (!orderId) ctx.throw(400, "Order ID is required");

  const preferredShop =
    extractPreferredShop(ctx, ctx.state?.shop || "") ||
    normalizeShopDomain(ctx.state?.shop || "");

  const result = await pool.query(
    `SELECT
        shopify_order_id,
        shop,
        variant_id,
        start_date,
        end_date,
      quantity,
      rate_type,
      rate_amount,
      customer_name,
      customer_email,
      customer_phone,
      return_reason,
      return_requested_at,
      status,
      created_at
   FROM rentals
     WHERE shopify_order_id = $1
     ORDER BY created_at ASC`,
    [orderId],
  );

  if (!result.rows.length) {
    ctx.throw(404, "Rental order not found");
  }

  const orderDetailsMap = await fetchResolvedAdminOrdersMap(preferredShop, [orderId]);
  await backfillReturnRequestFromShopifyTags(preferredShop, orderDetailsMap, result.rows);
  const orderDetails = orderDetailsMap[orderId] || {};
  const currentVariantId = normalizeVariantId(result.rows[0]?.variant_id || "");
  const currentRentalRows = currentVariantId ? await fetchRentalRowsByVariant(currentVariantId) : [];
  const currentVariantImageUrl = currentVariantId
    ? await fetchShopifyVariantImageUrl(preferredShop, currentVariantId)
    : "";
  const currentItemType = String(
    currentRentalRows[0]?.item_type ||
      orderDetails?.rentalLines?.[0]?.itemType ||
      result.rows[0]?.item_type ||
      "",
  ).toLowerCase();
  const currentSubItems = buildSubItems(
    currentRentalRows.filter(hasItemSummaryIdentity),
    currentItemType,
  );
  const tagList = Array.isArray(orderDetails?.tags) ? orderDetails.tags : [];
  const statuses = result.rows.map((row) => row.status);
  const hasReturnRequest =
    result.rows.some((row) => hasPendingReturnRequest(row, statuses)) ||
    tagList.includes("Rental: Return Requested");
  const quantityRows = result.rows
    .slice()
    .sort((a, b) => {
      const returnDelta = Number(b?.return_quantity || 0) - Number(a?.return_quantity || 0);
      if (returnDelta) return returnDelta;
      const aReason = String(a?.return_reason || "").trim();
      const bReason = String(b?.return_reason || "").trim();
      if (aReason !== bReason) return bReason ? 1 : -1;
      const aCreated = new Date(a?.created_at || 0).getTime();
      const bCreated = new Date(b?.created_at || 0).getTime();
      return bCreated - aCreated;
    });
  const quantityRowFallback = quantityRows[0] || result.rows[0];
  const status = resolveRentalDisplayStatus({
    status: summarizeRentalStatuses(statuses),
    returnQuantity: result.rows.reduce((sum, row) => sum + (Number(row?.return_quantity) || 0), 0),
    returnReason:
      String(result.rows.find((row) => String(row?.return_reason || "").trim())?.return_reason || "").trim(),
    returnRequestedAt:
      String(result.rows.find((row) => row?.return_requested_at)?.return_requested_at || "").trim(),
    tags: tagList,
    fallback: summarizeRentalStatuses(statuses),
  });
  const summaryQuantityState = buildRentalQuantityState(
    {
      quantity: result.rows.reduce((sum, row) => sum + (Number(row?.quantity) || 0), 0),
      return_quantity: result.rows.reduce((sum, row) => sum + (Number(row?.return_quantity) || 0), 0),
    },
    0,
  );
  const quantityPayload = serializeRentalQuantityState(summaryQuantityState);

  ctx.body = {
    orderId,
    orderLabel: orderDetails.orderLabel || `#${orderId}`,
    productName: orderDetails.productName || "-",
    productNames: orderDetails.productNames || [],
    customerName:
      orderDetails.customerName ||
      String(result.rows[0]?.customer_name || "").trim() ||
      "Guest",
    customerEmail:
      orderDetails.customerEmail ||
      String(result.rows[0]?.customer_email || "").trim() ||
      "",
    customerPhone:
      orderDetails.customerPhone ||
      String(result.rows[0]?.customer_phone || "").trim() ||
      "",
    shop: String(result.rows[0]?.shop || "").trim(),
    ...quantityPayload,
    rentalTotal: toMoneyString(
      result.rows.reduce(
        (sum, row) => sum + ((Number(row?.rate_amount) || 0) * (Number(row?.quantity) || 0)),
        0,
      ),
    ),
    status,
    tags: tagList,
      shippingAddressLines: orderDetails.shippingAddressLines || [],
      billingAddressLines: orderDetails.billingAddressLines || [],
      returnReason:
        String(result.rows.find((row) => String(row?.return_reason || "").trim())?.return_reason || "").trim(),
      returnRequestedAt:
        String(result.rows.find((row) => row?.return_requested_at)?.return_requested_at || "").trim(),
      rentalLines:
      orderDetails.rentalLines && orderDetails.rentalLines.length
        ? orderDetails.rentalLines.map((line, index) => {
            const quantityRow = quantityRows[index] || quantityRowFallback;
            const quantityState = buildRentalQuantityState(quantityRow, line?.quantity);
            const nextStatus = resolveRentalDisplayStatus({
              status: quantityRow?.status || line?.status || status,
              returnQuantity: quantityRow?.return_quantity,
              returnReason: quantityRow?.return_reason,
              returnRequestedAt: quantityRow?.return_requested_at,
              tags: tagList,
              fallback: status,
            });
            return {
              title: String(line?.title || "Rental item").trim() || "Rental item",
              quantity: quantityState.totalQuantity,
              returnQuantity: quantityState.returnedQuantity,
              returnedQuantity: quantityState.returnedQuantity,
              availableQuantity: quantityState.availableQuantity,
              startDate: normalizeDateOnly(line?.startDate || quantityRow?.start_date || ""),
              endDate: normalizeDateOnly(line?.endDate || quantityRow?.end_date || ""),
              rateType: String(line?.rateType || "").trim(),
              duration: String(line?.duration || "").trim(),
              selectedItem: String(line?.selectedItem || "").trim(),
              itemNumber: resolveItemNumberDisplay(line, currentSubItems),
              imageUrl: String(line?.imageUrl || line?.productImageUrl || currentVariantImageUrl || "").trim(),
              serialNumber: resolveItemNumberDisplay(line, currentSubItems),
              itemType: String(line?.itemType || "").trim(),
              priceText: String(line?.priceText || "").trim(),
              unitPriceText: toMoneyString(Number(line?.rateAmount || quantityRow?.rate_amount) || 0),
              totalPriceText: String(line?.priceText || "").trim() || toMoneyString(
                (Number(line?.rateAmount || quantityRow?.rate_amount) || 0) *
                  (Number(line?.quantity || quantityRow?.quantity) || 0),
              ),
              returnReason: String(quantityRow?.return_reason || "").trim(),
              returnRequestedAt: String(quantityRow?.return_requested_at || "").trim(),
              status: nextStatus,
            };
          })
        : result.rows.map((row) => {
            const quantityState = buildRentalQuantityState(row, row?.quantity);
            const nextStatus = resolveRentalDisplayStatus({
              status: row?.status || status,
              returnQuantity: row?.return_quantity,
              returnReason: row?.return_reason,
              returnRequestedAt: row?.return_requested_at,
              tags: tagList,
              fallback: status,
            });
            return {
              title: "Rental item",
              quantity: quantityState.totalQuantity,
              returnQuantity: quantityState.returnedQuantity,
              returnedQuantity: quantityState.returnedQuantity,
              availableQuantity: quantityState.availableQuantity,
              startDate: String(row?.start_date || "").trim(),
              endDate: String(row?.end_date || "").trim(),
              rateType: String(row?.rate_type || "").trim(),
              duration: "",
              selectedItem: "",
              itemNumber: resolveItemNumberDisplay(
                {
                  selectedItem: currentSubItems[0]?.display_name || "",
                  serialNumber: currentSubItems[0]?.serial_number || "",
                },
                currentSubItems,
              ),
              imageUrl: currentVariantImageUrl || "",
              itemType: "",
              priceText: toMoneyString(row?.rental_total),
              unitPriceText: toMoneyString(row?.rate_amount),
              totalPriceText: toMoneyString(row?.rental_total || (Number(row?.rate_amount) || 0) * (Number(row?.quantity) || 0)),
              returnReason: String(row?.return_reason || "").trim(),
              returnRequestedAt: String(row?.return_requested_at || "").trim(),
              status: nextStatus,
            };
          }),
  };
});

router.put("/api/admin/rental-orders/:orderId/status", requireAuth, async (ctx) => {
  await ensureRentalOrderColumns();

  const orderId = String(ctx.params?.orderId || "").trim();
  const requestedStatus = String(ctx.request?.body?.status || "").trim();
  const allowedStatuses = new Set(["Reserved", "On Rent", "Return Requested", "Return", "Rejected"]);

  if (!orderId) ctx.throw(400, "Order ID is required");
  if (!allowedStatuses.has(requestedStatus)) {
    ctx.throw(400, "Invalid rental status");
  }

  const updateRes = await pool.query(
      `UPDATE rentals
       SET status = $2,
           return_requested_at = CASE
             WHEN $2 = 'Return Requested' THEN COALESCE(return_requested_at, NOW())
             WHEN $2 = 'Return' THEN NULL
             ELSE NULL
           END,
           return_reason = CASE
             WHEN $2 = 'Return Requested' THEN COALESCE(NULLIF(TRIM(return_reason), ''), '')
             WHEN $2 = 'Return' THEN NULL
             ELSE NULL
           END,
           updated_at = NOW()
       WHERE shopify_order_id = $1
       RETURNING shop`,
    [orderId, requestedStatus],
  );

  if (!updateRes.rows.length) {
    ctx.throw(404, "Rental order not found");
  }

  const preferredShop =
    extractPreferredShop(ctx, updateRes.rows[0]?.shop || "") ||
    normalizeShopDomain(updateRes.rows[0]?.shop || "");

  if (requestedStatus === "Return" || requestedStatus === "Return Requested") {
    await backfillReturnQuantityFromReason(orderId, preferredShop);
  }

  await updateAdminOrderStatusTag(preferredShop, orderId, requestedStatus);

  ctx.body = {
    success: true,
    orderId,
    status: requestedStatus,
  };
});

router.get("/api/admin-extension/rental-order", async (ctx) => {
  const { shop } = await decodeAdminExtensionIdToken(ctx);
  await ensureRentalOrderColumns();
  await safeRunStatusAutomation("admin extension rental order");

  const orderId = String(ctx.query?.orderId || "").trim().replace(/^gid:\/\/shopify\/Order\//, "");
  if (!orderId) ctx.throw(400, "Order ID is required");

  const result = await pool.query(
    `SELECT
        shopify_order_id,
        MIN(start_date) AS start_date,
        MAX(end_date) AS end_date,
        COALESCE(SUM(quantity), 0)::int AS total_quantity,
        COALESCE(SUM(COALESCE(return_quantity, 0)), 0)::int AS return_quantity,
        COALESCE(SUM(COALESCE(rate_amount, 0) * quantity), 0)::numeric AS rental_total,
        ARRAY_AGG(status ORDER BY created_at ASC) AS statuses,
        MAX(NULLIF(TRIM(return_reason), '')) AS return_reason,
        MAX(return_requested_at) AS return_requested_at
     FROM rentals
     WHERE shopify_order_id = $1
       AND lower(shop) = lower($2)
     GROUP BY shopify_order_id`,
    [orderId, shop],
  );

  const row = result.rows?.[0];
  if (!row) {
    ctx.status = 404;
    ctx.body = { error: true, message: "No rental details found for this order" };
    return;
  }

  const orderNames = await fetchOrderNames(shop, [orderId]);
  const orderDetailsMap = await fetchResolvedAdminOrdersMap(shop, [orderId]);
  await backfillReturnRequestFromShopifyTags(shop, orderDetailsMap, [row]);
  const status = resolveRentalDisplayStatus({
    status: summarizeRentalStatuses(row?.statuses || []),
    returnQuantity: row?.return_quantity,
    returnReason: row?.return_reason,
    returnRequestedAt: row?.return_requested_at,
    tags: [],
    fallback: summarizeRentalStatuses(row?.statuses || []),
  });
  const quantityState = buildRentalQuantityState(row, row?.total_quantity);
  const quantityPayload = serializeRentalQuantityState(quantityState);

  ctx.body = {
    orderId,
    orderLabel: orderNames[orderId] || `#${orderId}`,
    startDate: String(row?.start_date || "").trim(),
    endDate: String(row?.end_date || "").trim(),
    ...quantityPayload,
    rentalTotal: toMoneyString(row?.rental_total),
    status,
    tags: [],
  };
});

router.put("/api/admin-extension/rental-order/:orderId/status", async (ctx) => {
  const { shop } = await decodeAdminExtensionIdToken(ctx);
  await ensureRentalOrderColumns();

  const orderId = String(ctx.params?.orderId || "").trim().replace(/^gid:\/\/shopify\/Order\//, "");
  const requestedStatus = String(ctx.request?.body?.status || "").trim();
  const allowedStatuses = new Set(["Reserved", "On Rent", "Return Requested", "Return", "Rejected"]);

  if (!orderId) ctx.throw(400, "Order ID is required");
  if (!allowedStatuses.has(requestedStatus)) {
    ctx.throw(400, "Invalid rental status");
  }

  const updateRes = await pool.query(
      `UPDATE rentals
       SET status = $3,
           return_requested_at = CASE
             WHEN $3 = 'Return Requested' THEN COALESCE(return_requested_at, NOW())
             WHEN $3 = 'Return' THEN NULL
             ELSE NULL
           END,
           return_reason = CASE
             WHEN $3 = 'Return Requested' THEN COALESCE(NULLIF(TRIM(return_reason), ''), '')
             WHEN $3 = 'Return' THEN NULL
             ELSE NULL
           END,
           updated_at = NOW()
       WHERE shopify_order_id = $1
         AND lower(shop) = lower($2)
     RETURNING shopify_order_id`,
    [orderId, shop, requestedStatus],
  );

  if (!updateRes.rows.length) {
    ctx.throw(404, "Rental order not found");
  }

  await updateAdminOrderStatusTag(shop, orderId, requestedStatus);

  ctx.body = {
    success: true,
    orderId,
    status: requestedStatus,
  };
});

function normalizeShippingAddress(address) {
  if (!address) return [];
  return [
    String(address.name || "").trim(),
    String(address.address1 || "").trim(),
    String(address.address2 || "").trim(),
    [address.city, address.zip].filter(Boolean).join(" ").trim(),
    String(address.provinceCode || address.countryCode || "").trim(),
  ].filter(Boolean);
}

function normalizeAddressName(address) {
  if (!address) return "";
  return String(address.name || "").trim();
}

function toCustomerGid(rawCustomerId) {
  const value = normalizeCustomerId(rawCustomerId);
  if (!value) return "";
  if (value.startsWith("gid://")) return value;
  return `gid://shopify/Customer/${value}`;
}

async function decodeCustomerAccountSessionToken(ctx) {
  const header = String(ctx.get("authorization") || "").trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  const fallbackToken = String(
    ctx.request?.body?.sessionToken ||
      ctx.request?.body?.session_token ||
      ctx.query?.sessionToken ||
      ctx.query?.session_token ||
      "",
  ).trim();
  const token = String(match?.[1] || fallbackToken || "").trim();

  if (!token) {
    ctx.throw(401, "Missing session token");
  }

  try {
    return await shopify.session.decodeSessionToken(token);
  } catch (error) {
    console.error("Invalid customer account session token:", error);
    ctx.throw(401, "Invalid session token");
  }
}

async function tryDecodeCustomerAccountSessionToken(ctx) {
  try {
    return await decodeCustomerAccountSessionToken(ctx);
  } catch (error) {
    return null;
  }
}

function normalizeOrderId(rawOrderId = "") {
  const value = String(rawOrderId || "").trim();
  if (!value) return "";
  const match = value.match(/\/(\d+)$/);
  return match ? match[1] : value;
}

async function fetchOrderIdsForCustomer(shopSession, customerId) {
  const normalizedCustomerId = normalizeCustomerId(customerId);
  if (!shopSession?.shop || !shopSession?.access_token || !normalizedCustomerId) {
    return new Set();
  }

  const session = {
    id: `offline_${shopSession.shop}`,
    shop: shopSession.shop,
    accessToken: shopSession.access_token,
    isOnline: false,
  };
  const graphqlClient = new shopify.clients.Graphql({ session });

  const query = `
    query CustomerOrderIds($searchQuery: String!) {
      orders(
        first: 100
        reverse: true
        sortKey: PROCESSED_AT
        query: $searchQuery
      ) {
        nodes {
          id
        }
      }
    }
  `;

  try {
    const response = await graphqlClient.query({
              data: {
                query,
                variables: {
                  searchQuery: `customer_id:${normalizedCustomerId}`,
                },
              },
            });

    const nodes = response?.body?.data?.orders?.nodes || [];
    const orderIds = nodes.map((order) => normalizeOrderId(order?.id)).filter(Boolean);

    return new Set(orderIds);
  } catch (error) {
    console.warn("Failed to fetch customer order IDs for rental matching:", error?.message || error);
    return new Set();
  }
}

async function decodeAdminExtensionIdToken(ctx) {
  const header = String(ctx.get("authorization") || "").trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = String(match?.[1] || "").trim();

  if (!token) {
    ctx.throw(401, "Missing admin extension token");
  }

  try {
    const payload = await shopify.session.decodeSessionToken(token);
    const destination = String(payload?.dest || "").trim();
    const shop = normalizeShopDomain(
      destination.replace(/^https?:\/\//i, "").replace(/\/$/, ""),
    );

    if (!shop) {
      ctx.throw(401, "Unable to resolve shop from admin extension token");
    }

    return { payload, shop };
  } catch (error) {
    console.error("Invalid admin extension token:", error);
    ctx.throw(401, "Invalid admin extension token");
  }
}

function normalizeAttributeMap(customAttributes = []) {
  const map = {};
  (Array.isArray(customAttributes) ? customAttributes : []).forEach((item) => {
    const key = String(item?.key || "").trim();
    const value = String(item?.value || "").trim();
    if (key) map[key] = value;
  });
  return map;
}

function normalizeCustomerRentalOrders(orderNodes = [], _customerEmail = "", rentalRowsByOrderId = new Map()) {
  const RENTAL_ENABLED_KEYS = [
    "Rental Enabled",
    "_Rental Enabled",
    "_RentalEnabled",
    "_rental_enabled",
  ];
  const START_DATE_KEYS = [
    "Start Date",
    "_Start Date",
    "_Rental Start Date",
    "_RentalStartDate",
    "_Rental Start",
    "_start_date",
  ];
  const END_DATE_KEYS = [
    "End Date",
    "_End Date",
    "_Rental End Date",
    "_RentalEndDate",
    "_Rental End",
    "_end_date",
  ];
  const RATE_TYPE_KEYS = [
    "Rental Type",
    "_Rental Type",
    "_RentalType",
    "_rental_type",
    "Rental Frequency",
    "_Rental Frequency",
  ];
  const DURATION_KEYS = [
    "Rental Duration",
    "_Rental Duration",
    "_RentalDuration",
    "_rental_duration",
  ];
  const SELECTED_ITEM_KEYS = [
    "Selected Product Item",
    "_Selected Product Item",
    "_SelectedProductItem",
    "_selected_product_item",
  ];
  const PRICE_KEYS = [
    "Rental Line Price",
    "_Rental Line Price",
    "_RentalLinePrice",
    "_rental_line_price",
    "Rental Price",
    "_Rental Price",
    "_RentalPrice",
    "_rental_price",
  ];
  const STATUS_KEYS = [
    "Rental Status",
    "_Rental Status",
    "_RentalStatus",
    "_rental_status",
    "Return Status",
  ];

  return (Array.isArray(orderNodes) ? orderNodes : [])
    .map((order) => {
      const rentalRow = (() => {
        if (!rentalRowsByOrderId || typeof rentalRowsByOrderId.get !== "function") return null;
        const keys = [
          normalizeOrderId(order?.id || ""),
          normalizeOrderId(order?.name || ""),
          normalizeOrderId(order?.orderNumber || ""),
        ].filter(Boolean);
        for (const key of keys) {
          const row = rentalRowsByOrderId.get(key);
          if (row) return row;
        }
        return null;
      })();
      const lines = (((order || {}).lineItems || {}).nodes || [])
        .map((line) => {
          const properties = normalizeAttributeMap(line?.customAttributes || []);
          const startDate = normalizeDateOnly(getPropertyValue(properties, START_DATE_KEYS));
          const endDate = normalizeDateOnly(getPropertyValue(properties, END_DATE_KEYS));
          const rentalStatus = normalizeRentalStatus(
            getPropertyValue(properties, STATUS_KEYS),
            startDate,
            endDate,
          );
          const enabled = getBooleanProperty(properties, RENTAL_ENABLED_KEYS);
      const rateType = getPropertyValue(properties, RATE_TYPE_KEYS);
      const duration = getPropertyValue(properties, DURATION_KEYS);
      const selectedItem =
        getPropertyValue(properties, SERIAL_NUMBER_KEYS) ||
        getPropertyValue(properties, SELECTED_ITEM_KEYS);
          const priceText = getPropertyValue(properties, PRICE_KEYS);
          const returnedQuantity = rentalRow
            ? Math.max(0, Number(rentalRow?.return_quantity) || 0)
            : 0;

          if (!(enabled || startDate || endDate || rateType || duration || selectedItem || priceText)) {
            return null;
          }

          return {
            title: String(line?.title || "Rental item").trim() || "Rental item",
            quantity: Math.max(1, Number(line?.quantity) || 1),
            returnQuantity: returnedQuantity,
            returnedQuantity,
            availableQuantity: rentalRow
              ? Math.max(0, Math.max(1, Number(line?.quantity) || 1) - returnedQuantity)
              : undefined,
            startDate,
            endDate,
            rateType,
            duration,
            selectedItem,
            priceText,
            status: rentalStatus,
            statusLabel: statusLabel(rentalStatus),
          };
        })
        .filter(Boolean);

      if (!lines.length) return null;

      const overallStatus = rentalRow
        ? summarizeRentalStatuses(rentalRow?.statuses || [])
        : lines.some((line) => line.status === "on-rent")
        ? "on-rent"
        : lines.some((line) => line.status === "reserved")
          ? "reserved"
          : lines.every((line) => line.status === "return")
            ? "return"
            : "processing";

      const dates = lines
        .flatMap((line) => [line.startDate, line.endDate])
        .filter(Boolean)
        .sort();

      return {
        id: String(order?.id || "").trim(),
        orderNumber: String(order?.name || order?.orderNumber || "").replace(/^#?/, ""),
        label: String(order?.name || "").trim() || `#${String(order?.orderNumber || "").trim()}`,
        processedAt: String(order?.processedAt || "").trim(),
        shippingAddressLines: normalizeShippingAddress(order?.shippingAddress),
        billingAddressName: normalizeAddressName(order?.billingAddress || order?.shippingAddress),
        billingAddressLines: normalizeShippingAddress(order?.billingAddress || order?.shippingAddress),
        customerName:
          normalizeAddressName(order?.billingAddress || order?.shippingAddress) || "Customer",
        status: overallStatus,
        statusLabel: statusLabel(overallStatus),
        startDate: dates[0] || "",
        endDate: dates[dates.length - 1] || "",
        lines,
      };
    })
    .filter(Boolean);
}

/**
 * Create Rental Reservation
 */
router.post("/api/rentals", requireAuth, async (ctx) => {
  const { variantId, startDate, endDate, quantity, rateType } = ctx.request.body;
  const normalizedVariantId = normalizeVariantId(variantId);

  /* ---------------- VALIDATION ---------------- */

  if (!variantId) ctx.throw(400, "Variant ID is required");
  if (!startDate || !endDate) ctx.throw(400, "Rental dates are required");
  if (!quantity || quantity <= 0) ctx.throw(400, "Invalid quantity");

  if (new Date(startDate) > new Date(endDate)) {
    ctx.throw(400, "End date must be after start date");
  }

  /* ---------------- AVAILABILITY ---------------- */

  const available = await checkAvailability(
    normalizedVariantId,
    startDate,
    endDate,
    quantity
  );

  if (!available) {
    ctx.throw(400, "Item not available for selected dates");
  }

  /* ---------------- FETCH ITEM ---------------- */

  const itemRows = await fetchRentalRowsByVariant(normalizedVariantId);

  if (!itemRows.length) {
    ctx.throw(404, "Rental item not found");
  }

  const item = itemRows[0];
  const itemType = item.item_type;

  /* ---------------- RATE RESOLUTION ---------------- */

  let rateAmount = null;

  if (rateType) {
    if (rateType === "daily") rateAmount = item.daily_rate;
    if (rateType === "weekly") rateAmount = item.weekly_rate;
    if (rateType === "monthly") rateAmount = item.monthly_rate;

    if (!rateAmount) {
      ctx.throw(400, "Invalid rate type selected");
    }
  }

  let allocation = null;

  await pool.query("BEGIN");

  try {
    /* ---------------- INVENTORY LOGIC ---------------- */

    if (itemType === "serial") {
      allocation = await allocateSerial(normalizedVariantId);
    }

    if (itemType === "lot") {
      allocation = await allocateLot(normalizedVariantId, quantity);
    }

    if (itemType === "inventory") {
      await deductInventory(normalizedVariantId, quantity);
    }

    /* ---------------- INSERT RENTAL ---------------- */

    const { rows } = await pool.query(
      `INSERT INTO rentals
       (shop, variant_id, start_date, end_date, quantity, rate_type, rate_amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Reserved')
       RETURNING *`,
      [
        ctx.state.shop,
        normalizedVariantId,
        startDate,
        endDate,
        quantity,
        rateType || null,
        rateAmount || null,
      ]
    );

    await pool.query("COMMIT");

    ctx.body = {
      success: true,
      rental: rows[0],
      allocation,
    };

  } catch (err) {
    await pool.query("ROLLBACK");

    console.error("Rental Error:", err);

    ctx.throw(400, err.message || "Rental creation failed");
  }
});


/**
 * Check Availability Public Endpoint
 */
// NOTE: Ideally verify request comes from Shopify Proxy (HMAC check)
async function checkAvailabilityHandler(ctx) {
  await safeRunStatusAutomation("availability check");

  const {
    variantId,
    startDate,
    endDate,
    rateType,
    duration: rawDuration,
    subItemId,
    quantity: rawQty,
  } = ctx.request.body;
  const normalizedVariantId = normalizeVariantId(variantId);
  const quantity = normalizePositiveInt(rawQty, 1);

  if (!normalizedVariantId || !startDate || !endDate || !rateType) {
    ctx.throw(400, "Missing required fields");
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    ctx.throw(400, "Invalid rental dates");
  }
  if (end < start) {
    ctx.throw(400, "End date must be after start date");
  }

  const itemRows = await fetchRentalRowsByVariant(normalizedVariantId);

  if (!itemRows.length) {
    ctx.throw(404, "Item not found");
  }

  const itemType = String(itemRows[0].item_type || "").toLowerCase();
  const configuredItem = itemRows[0];
  const rate = getRateByType(configuredItem, rateType);
  if (!rate || rate <= 0) {
    ctx.throw(400, "Selected rental rate is not configured");
  }

  const stockRows = getStockRows(itemRows, itemType);
  const detailRows = itemRows.filter(hasItemSummaryIdentity);
  const subItems = buildSubItems(detailRows, itemType);
  const databaseAvailableStock = getSummaryAvailableStock(configuredItem, stockRows, itemType);
  const shopifyStock = await (async () => {
    try {
      return await fetchShopifyVariantInventoryQuantity(
        extractPreferredShop(ctx),
        normalizedVariantId,
      );
    } catch (error) {
      console.warn("Unable to fetch Shopify inventory quantity for availability check:", error.message);
      return null;
    }
  })();
  const baseAvailableStock = databaseAvailableStock;
  const bookedQuantity = await fetchBookedQuantity(
    normalizedVariantId,
    startDate,
    endDate,
  );
  const availableStock =
    itemType === "non_inventory"
      ? baseAvailableStock
      : Math.max(0, baseAvailableStock - bookedQuantity);
  const responseAvailableStock = resolveDisplayedAvailableStock(
    itemType,
    availableStock,
    subItems,
    subItemId,
  );

  if (responseAvailableStock < quantity) {
    ctx.body = {
      available: false,
      availableStock: responseAvailableStock,
      message: responseAvailableStock <= 0 ? "Out of stock for selected dates" : "Selected quantity is not available",
    };
    return;
  }

  // 1. Check Availability
  const available = await checkAvailability(
    normalizedVariantId,
    startDate,
    endDate,
    quantity
  );

  if (!available) {
      ctx.body = {
        available: false,
        availableStock: responseAvailableStock,
        message: "Dates not available",
      };
      return;
  }

  if (subItemId && (itemType === "serial" || itemType === "lot" || itemType === "inventory")) {
    const selected = subItems.find((r) => String(r.id) === String(subItemId));
    if (!selected) {
      ctx.body = {
        available: false,
        availableStock: responseAvailableStock,
        message: "Selected item is not available",
      };
      return;
    }
    if ((itemType === "lot" || itemType === "inventory") && selected.stock < quantity) {
      ctx.body = {
        available: false,
        availableStock: responseAvailableStock,
        message: "Selected item has insufficient stock",
      };
      return;
    }
  }

  // 2. Calculate Price based on selected rental unit duration.
  const duration = normalizePositiveInt(
    rawDuration,
    computeDurationFromDates(startDate, endDate, rateType),
  );
  const totalPrice = rate * duration * quantity;

  ctx.body = {
    available: true,
    availableStock: responseAvailableStock,
    shopifyStock: Number.isFinite(Number(shopifyStock)) ? Math.max(0, Number(shopifyStock)) : 0,
    rateType,
    duration,
    price: totalPrice.toFixed(2),
    currency: "USD",
    itemType,
  };
}

router.post("/api/check", checkAvailabilityHandler);
router.post("/proxy/api/check", checkAvailabilityHandler);

/**
 * Get Rental Configuration for Widget
 */
async function rentalConfigHandler(ctx) {
  await safeRunStatusAutomation("rental config lookup");

  const { variantId: rawVariantId } = ctx.params;
  const normalizedVariantId = normalizeVariantId(rawVariantId);
  const rows = await fetchRentalRowsByVariant(normalizedVariantId);

  if (!rows.length) {
    ctx.body = { configured: false };
    return;
  }

  const item = rows[0];
  const itemType = String(item.item_type || "").toLowerCase();
  const options = [
    { value: "daily", label: "Daily", rate: Number(item.daily_rate) || 0 },
    { value: "weekly", label: "Weekly", rate: Number(item.weekly_rate) || 0 },
    { value: "monthly", label: "Monthly", rate: Number(item.monthly_rate) || 0 },
  ];
  const rentalEnabled = options.some((opt) => Number(opt.rate) > 0);

  const stockRows = getStockRows(rows, itemType);
  const detailRows = rows.filter(hasItemSummaryIdentity);
  const subItems = buildSubItems(detailRows, itemType);
  const shopifyStock = await (async () => {
    try {
      return await fetchShopifyVariantInventoryQuantity(
        extractPreferredShop(ctx),
        normalizedVariantId,
      );
    } catch (error) {
      console.warn("Unable to fetch Shopify inventory quantity for rental config:", error.message);
      return null;
    }
  })();
  let availableStock = getSummaryAvailableStock(item, stockRows, itemType);
  if (availableStock <= 0 && subItems.length) {
    availableStock = subItems.reduce((sum, item) => {
      return sum + Math.max(0, Number(item.stock) || 0);
    }, 0);
  }

  ctx.body = {
    configured: true,
    rentalEnabled,
    options: rentalEnabled ? options : [],
    itemType,
    availableStock,
    shopifyStock: Number.isFinite(Number(shopifyStock)) ? Math.max(0, Number(shopifyStock)) : 0,
    subItems,
  };
}

router.get("/api/rental-config/:variantId", rentalConfigHandler);
router.get("/proxy/api/rental-config/:variantId", rentalConfigHandler);

/**
 * Create Draft Order checkout from storefront cart with rental pricing.
 * This makes rental price the actual checkout price.
 */
async function draftCheckoutHandler(ctx) {
  const { cart, shop: bodyShop } = ctx.request.body || {};
  const cartItems = Array.isArray(cart?.items) ? cart.items : [];

  if (!cartItems.length) {
    ctx.throw(400, "Cart items are required");
  }

  const preferredShop = extractPreferredShop(ctx, bodyShop);
  const shopSession = await getStoredShopSession(preferredShop);
  if (!shopSession) {
    ctx.throw(400, "No Shopify offline token found. Re-auth required");
  }

  const lineItems = cartItems.map((item) => {
    const cartQty = Math.max(1, Number(item?.quantity) || 1);
    const properties = { ...(item?.properties || {}) };
    const isRental = isRentalLine(properties);
    const qty = cartQty;
    const defaultUnitPrice = (Number(item?.final_price || item?.price) || 0) / 100;
    const rentalUnitPrice = getRentalUnitPriceFromProperties(properties, defaultUnitPrice, qty);
    const unitPrice = isRental
      ? rentalUnitPrice
      : defaultUnitPrice;
    const productTitle = String(item?.product_title || item?.title || "Rental Product").trim();
    const variantTitle = String(item?.variant_title || "").trim();
    const title = variantTitle && variantTitle.toLowerCase() !== "default title"
      ? `${productTitle} - ${variantTitle}`
      : productTitle;
    const variantId = normalizeVariantId(item?.variant_id || item?.id || "");

    if (isRental && variantId && !String(properties["Rental Variant ID"] || "").trim()) {
      properties["Rental Variant ID"] = variantId;
    }

    if (isRental) {
      const rentalLineTotal = unitPrice * qty;
      normalizeRentalDraftProperties(properties, qty, unitPrice);
      return {
        ...(variantId
          ? {
              variantId: toVariantGid(variantId),
              priceOverride: {
                amount: toMoneyString(unitPrice),
                currencyCode: "USD",
              },
            }
          : {
              title,
              originalUnitPriceWithCurrency: {
                amount: toMoneyString(unitPrice),
                currencyCode: "USD",
              },
            }),
        quantity: qty,
        custom_attributes: toDraftAttributeArray(properties),
        taxable: false,
        requires_shipping: true,
        debug: {
          type: variantId ? "rental-variant-price-override" : "rental-custom-line",
          title,
          variantId: variantId || "",
          unitPrice: toMoneyString(unitPrice),
          lineTotal: toMoneyString(rentalLineTotal),
          quantity: qty,
        },
      };
    }

    return {
      ...(variantId ? { variantId: toVariantGid(variantId) } : { title }),
      quantity: qty,
      ...(variantId ? {} : { originalUnitPrice: toMoneyString(unitPrice) }),
      custom_attributes: toDraftAttributeArray(properties),
      taxable: false,
      requires_shipping: true,
      debug: {
        type: variantId ? "variant-line" : "custom-line",
        title,
        variantId: variantId || "",
        unitPrice: toMoneyString(unitPrice),
        quantity: qty,
      },
    };
  });

  const hasRental = lineItems.some((_li, i) => isRentalLine(cartItems[i]?.properties || {}));
  if (!hasRental) {
    ctx.throw(400, "No rental item found in cart");
  }

  const note = "Created by NetScore Rental Management (rental checkout)";
  const session = {
    id: `offline_${shopSession.shop}`,
    shop: shopSession.shop,
    accessToken: shopSession.access_token,
    isOnline: false,
  };
  const graphqlClient = new shopify.clients.Graphql({
    session,
  });

  const graphqlLineItems = lineItems.map((line) => ({
    ...(line.variantId ? { variantId: line.variantId } : { title: line.title }),
    quantity: line.quantity,
    ...(line.priceOverride
      ? { priceOverride: line.priceOverride }
      : line.originalUnitPriceWithCurrency
        ? { originalUnitPriceWithCurrency: line.originalUnitPriceWithCurrency }
        : line.originalUnitPrice
          ? { originalUnitPrice: line.originalUnitPrice }
          : {}),
    customAttributes: line.custom_attributes,
    taxable: line.taxable,
    requiresShipping: line.requires_shipping,
  }));

  const mutation = `
    mutation DraftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          invoiceUrl
          subtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
            presentmentMoney {
              amount
              currencyCode
            }
          }
          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
            presentmentMoney {
              amount
              currencyCode
            }
          }
          lineItems(first: 20) {
            nodes {
            title
            quantity
            custom
            originalUnitPriceSet {
              presentmentMoney {
                amount
                currencyCode
              }
            }
            priceOverride {
              amount
              currencyCode
            }
            customAttributes {
              key
              value
            }
              variant {
                id
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  let response;
  try {
    response = await graphqlClient.query({
      data: {
        query: mutation,
        variables: {
          input: {
            note,
            presentmentCurrencyCode: "USD",
            customAttributes: [
              { key: "ns_rental_checkout", value: "draft" },
              { key: "ns_rental_shop", value: shopSession.shop },
            ],
            lineItems: graphqlLineItems,
          },
        },
      },
    });
  } catch (err) {
    const msg = String(err?.message || "").toLowerCase();
    if (msg.includes("draftordercreate") || msg.includes("draft order")) {
      ctx.throw(
        403,
        "Shopify rejected draft order creation. Add write_draft_orders scope, then reinstall/re-auth app.",
      );
    }
    throw err;
  }

  const payload = response?.body?.data?.draftOrderCreate;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length) {
    ctx.status = 422;
    ctx.body = {
      success: false,
      shop: shopSession.shop,
      message: userErrors.map((err) => err.message).join("; "),
      errors: userErrors,
      debug: {
        sentLineItems: lineItems.map((line) => line.debug),
      },
    };
    return;
  }

  const draft = payload?.draftOrder;
  const checkoutUrl = draft?.invoiceUrl || "";

  if (!checkoutUrl) {
    ctx.throw(500, "Draft order created but checkout URL is missing");
  }

  ctx.body = {
    success: true,
    shop: shopSession.shop,
    draftOrderId: draft?.id || null,
    checkoutUrl,
    debug: {
      sentLineItems: lineItems.map((line) => line.debug),
      createdDraft: {
        subtotalPriceSet: draft?.subtotalPriceSet || null,
        totalPriceSet: draft?.totalPriceSet || null,
        lineItems:
          draft?.lineItems?.nodes?.map((line) => ({
            title: line?.title || "",
            quantity: line?.quantity || 0,
            custom: Boolean(line?.custom),
            originalUnitPriceSet: line?.originalUnitPriceSet || null,
            priceOverride: line?.priceOverride || null,
            variantId: line?.variant?.id || "",
            customAttributes: Array.isArray(line?.customAttributes) ? line.customAttributes : [],
          })) || [],
      },
    },
  };
}

router.post("/api/rental/draft-checkout", draftCheckoutHandler);
router.post("/proxy/api/rental/draft-checkout", draftCheckoutHandler);

async function ordersCreateWebhookHandler(ctx) {
  const payload = ctx.request.body || {};
  const orderId = String(payload?.id || "").trim();
  const shop = normalizeShopDomain(
    ctx.get("x-shopify-shop-domain") ||
      payload?.shop_domain ||
      "",
  );

  if (!orderId) {
    ctx.status = 200;
    ctx.body = { success: true, skipped: true };
    return;
  }

  await ensureRentalOrderColumns();

  const rentalLines = forceRentalLinesStatus(
    await extractRentalLinesFromOrderPayload(payload, shop),
    "Reserved",
  );
  if (!rentalLines.length) {
    ctx.status = 200;
    ctx.body = { success: true, skipped: true, processed: 0 };
    return;
  }

  const customerDetails = extractRentalCustomerDetails(payload);
  const result = await upsertRentalRowsForOrder(orderId, shop, rentalLines, customerDetails);

  await updateAdminOrderStatusTag(shop, orderId, "Reserved");

  ctx.status = 200;
  ctx.body = { success: true, processed: result.processed };
}

async function ordersPaidWebhookHandler(ctx) {
  const payload = ctx.request.body || {};
  const orderId = String(payload?.id || "").trim();
  const shop = normalizeShopDomain(
    ctx.get("x-shopify-shop-domain") ||
      payload?.shop_domain ||
      "",
  );

  if (!orderId) {
    ctx.status = 200;
    ctx.body = { success: true, skipped: true };
    return;
  }

  await ensureProcessedWebhookTable();
  await ensureRentalOrderColumns();

  const existing = await pool.query(
    `SELECT order_id FROM processed_shopify_orders WHERE order_id = $1 LIMIT 1`,
    [orderId],
  );
  if (existing.rows.length) {
    ctx.status = 200;
    ctx.body = { success: true, duplicate: true };
    return;
  }

  const rentalLines = forceRentalLinesStatus(
    await extractRentalLinesFromOrderPayload(payload, shop),
    "Reserved",
  );
  const customerDetails = extractRentalCustomerDetails(payload);
  if (rentalLines.length) {
    await upsertRentalRowsForOrder(orderId, shop, rentalLines, customerDetails, {
      deductStock: true,
    });
  }

  await updateAdminOrderStatusTag(shop, orderId, "Reserved");

  await pool.query(
    `INSERT INTO processed_shopify_orders (order_id, shop)
     VALUES ($1, $2)
     ON CONFLICT (order_id) DO NOTHING`,
    [orderId, shop],
  );

  ctx.status = 200;
  ctx.body = { success: true, processed: rentalLines.length };
}

async function fulfillmentPlacedOnHoldWebhookHandler(ctx) {
  const payload = ctx.request.body || {};
  const shop = normalizeShopDomain(
    ctx.get("x-shopify-shop-domain") ||
      payload?.shop_domain ||
      "",
  );
  const fulfillmentOrderId =
    String(payload?.admin_graphql_api_id || "").trim() ||
    String(payload?.id || "").trim();

  if (!shop || !fulfillmentOrderId) {
    ctx.status = 200;
    ctx.body = { success: true, skipped: true };
    return;
  }

  const orderGid = await resolveOrderFromFulfillmentOrder(shop, fulfillmentOrderId);
  if (orderGid) {
    const orderId = orderGid.replace(/^gid:\/\/shopify\/Order\//, "");
    await updateRentalRowsStatusByOrder(orderId, "Reserved");
    await updateAdminOrderStatusTag(shop, orderGid, "Reserved");
    await syncInventoryStateForOrder(orderId, "Reserved");
  }

  ctx.status = 200;
  ctx.body = { success: true };
}

async function fulfillmentHoldReleasedWebhookHandler(ctx) {
  const payload = ctx.request.body || {};
  const shop = normalizeShopDomain(
    ctx.get("x-shopify-shop-domain") ||
      payload?.shop_domain ||
      "",
  );
  const fulfillmentOrderId =
    String(payload?.admin_graphql_api_id || "").trim() ||
    String(payload?.id || "").trim();

  if (!shop || !fulfillmentOrderId) {
    ctx.status = 200;
    ctx.body = { success: true, skipped: true };
    return;
  }

  const orderGid = await resolveOrderFromFulfillmentOrder(shop, fulfillmentOrderId);
  if (orderGid) {
    const orderId = orderGid.replace(/^gid:\/\/shopify\/Order\//, "");
    await updateRentalRowsStatusByOrder(orderId, "On Rent");
    await updateAdminOrderStatusTag(shop, orderId, "On Rent");
    await syncInventoryStateForOrder(orderId, "On Rent");
  }

  ctx.status = 200;
  ctx.body = { success: true };
}

async function fulfillmentsCreateWebhookHandler(ctx) {
  const payload = ctx.request.body || {};
  const shop = normalizeShopDomain(
    ctx.get("x-shopify-shop-domain") ||
      payload?.shop_domain ||
      "",
  );
  const orderId = String(payload?.order_id || "").trim();
  const fulfillmentOrderId =
    String(payload?.fulfillment_order_id || "").trim() ||
    String(payload?.admin_graphql_api_id || "").trim() ||
    String(payload?.id || "").trim();

  let resolvedOrderId = orderId;

  if (!shop) {
    ctx.status = 200;
    ctx.body = { success: true, skipped: true };
    return;
  }

  await ensureRentalOrderColumns();

  if (!resolvedOrderId && fulfillmentOrderId) {
    const orderGid = await resolveOrderFromFulfillmentOrder(shop, fulfillmentOrderId);
    if (orderGid) {
      resolvedOrderId = orderGid.replace(/^gid:\/\/shopify\/Order\//, "");
    }
  }

  if (!resolvedOrderId) {
    ctx.status = 200;
    ctx.body = { success: true, skipped: true };
    return;
  }

  const orderPayload = await fetchShopifyOrderPayloadViaRest(shop, resolvedOrderId);
  if (orderPayload) {
    const rentalLines = forceRentalLinesStatus(
      await extractRentalLinesFromOrderPayload(orderPayload, shop),
      "On Rent",
    );
    if (rentalLines.length) {
      const customerDetails = extractRentalCustomerDetails(orderPayload);
      await upsertRentalRowsForOrder(resolvedOrderId, shop, rentalLines, customerDetails);
    }
  }

  await updateRentalRowsStatusByOrder(resolvedOrderId, "On Rent");
  await updateAdminOrderStatusTag(shop, resolvedOrderId, "On Rent");

  ctx.status = 200;
  ctx.body = { success: true };
}

function applyCustomerCors(ctx) {
  ctx.set("Access-Control-Allow-Origin", "*");
  ctx.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  ctx.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  ctx.set("Access-Control-Max-Age", "86400");
}

async function customerRentalsHandler(ctx) {
  applyCustomerCors(ctx);
  if (ctx.method === "OPTIONS") {
    ctx.status = 204;
    return;
  }

  await safeRunStatusAutomation("customer rentals lookup");

  const decodedToken = await tryDecodeCustomerAccountSessionToken(ctx);
  const loggedInCustomerId = normalizeCustomerId(
    extractCustomerIdFromBody(ctx) ||
      ctx.query.customerId ||
      ctx.query.customer_id ||
      decodedToken?.sub ||
      ctx.query.logged_in_customer_id ||
      ctx.get("x-logged-in-customer-id") ||
      "",
  );
  const tokenEmail = String(
    decodedToken?.email ||
      decodedToken?.contact_email ||
      decodedToken?.customer_email ||
      decodedToken?.email_address ||
      decodedToken?.emailAddress ||
      decodedToken?.mail ||
      decodedToken?.upn ||
      decodedToken?.preferred_username ||
      "",
  )
    .trim()
    .toLowerCase();
  const customerEmail = String(
    ctx.get("x-customer-email") ||
      ctx.query.customerEmail ||
      ctx.query.customer_email ||
      ctx.request?.body?.customerEmail ||
      ctx.request?.body?.customer_email ||
      "",
  )
    .trim()
    .toLowerCase();
  const resolvedCustomerEmail = customerEmail || tokenEmail;

  if (!loggedInCustomerId && !resolvedCustomerEmail) {
    ctx.status = 401;
    ctx.body = {
      success: false,
      message: "Customer login is required",
      orders: [],
    };
    return;
  }

  const preferredShop =
    normalizeShopDomain(decodedToken?.dest || "") ||
    extractPreferredShop(ctx) ||
    normalizeShopDomain(ctx.query.shop || "");
  const shopSession = await resolveCustomerShopSession(preferredShop, resolvedCustomerEmail);
  if (!shopSession) {
    ctx.throw(400, "No Shopify offline token found. Re-auth required");
  }

  const result = await pool.query(
    `SELECT
        shopify_order_id,
        shop,
        MIN(start_date) AS start_date,
        MAX(end_date) AS end_date,
        COALESCE(SUM(quantity), 0)::int AS total_quantity,
        COALESCE(SUM(COALESCE(return_quantity, 0)), 0)::int AS return_quantity,
        COALESCE(SUM(COALESCE(rate_amount, 0) * quantity), 0)::numeric AS rental_total,
        MAX(NULLIF(TRIM(return_reason), '')) AS return_reason,
        MAX(return_requested_at) AS return_requested_at,
        MAX(NULLIF(TRIM(customer_name), '')) AS customer_name,
        MAX(NULLIF(TRIM(customer_email), '')) AS customer_email,
        ARRAY_AGG(status ORDER BY created_at ASC) AS statuses
     FROM rentals
     WHERE shopify_order_id IS NOT NULL
       AND TRIM(shopify_order_id) <> ''
       AND lower(shop) = lower($1)
     GROUP BY shopify_order_id, shop
     ORDER BY MAX(created_at) DESC`,
    [shopSession.shop],
  );

  const rows = result.rows || [];
  const orderIds = rows
    .map((row) => String(row?.shopify_order_id || "").trim())
    .filter(Boolean);
  const orderDetails = orderIds.length
    ? await fetchResolvedAdminOrdersMap(shopSession.shop, orderIds)
    : {};
  const customerOrderIdSet = loggedInCustomerId
    ? await fetchOrderIdsForCustomer(shopSession, loggedInCustomerId)
    : new Set();

  const matchingRows = rows.filter((row) => {
    const orderId = String(row?.shopify_order_id || "").trim();
    const details = orderDetails[orderId] || {};
    const detailEmail = String(details?.customerEmail || "").trim().toLowerCase();
    const rowEmail = String(row?.customer_email || "").trim().toLowerCase();
    const detailEmailComparable = normalizeComparableEmail(detailEmail);
    const rowEmailComparable = normalizeComparableEmail(rowEmail);
    const resolvedEmailComparable = normalizeComparableEmail(resolvedCustomerEmail);
    const detailCustomerId = normalizeCustomerId(details?.customerId || "");

    if (
      resolvedCustomerEmail &&
      (
        detailEmail === resolvedCustomerEmail ||
        rowEmail === resolvedCustomerEmail ||
        (resolvedEmailComparable &&
          (detailEmailComparable === resolvedEmailComparable ||
            rowEmailComparable === resolvedEmailComparable))
      )
    ) {
      return true;
    }

    if (loggedInCustomerId && detailCustomerId === loggedInCustomerId) {
      return true;
    }

    if (loggedInCustomerId && customerOrderIdSet.has(orderId)) {
      return true;
    }

    return false;
  });

  const debugInfo = {
    preferredShop,
    resolvedShop: shopSession.shop,
    loggedInCustomerId,
    resolvedCustomerEmail,
    totalRows: rows.length,
    matchedRows: matchingRows.length,
    sampleRows: rows.slice(0, 5).map((row) => ({
      orderId: String(row?.shopify_order_id || "").trim(),
      rowEmail: String(row?.customer_email || "").trim(),
      rowShop: String(row?.shop || "").trim(),
      orderCustomerId: normalizeCustomerId(orderDetails[String(row?.shopify_order_id || "").trim()]?.customerId || ""),
    })),
  };

  const matchingOrderIds = Array.from(
    new Set(
      matchingRows
        .map((row) => String(row?.shopify_order_id || "").trim())
        .filter(Boolean),
    ),
  );
  const detailedRentalRows = matchingOrderIds.length
    ? await pool.query(
        `SELECT
            shopify_order_id,
            shop,
            variant_id,
            start_date,
            end_date,
            quantity,
            rate_type,
            rate_amount,
            status,
            return_quantity,
            return_reason,
            return_requested_at,
            created_at
         FROM rentals
         WHERE shopify_order_id = ANY($1::text[])
           AND lower(shop) = lower($2)
         ORDER BY created_at ASC`,
        [matchingOrderIds, shopSession.shop],
      )
    : { rows: [] };
  const detailRowsByOrderId = new Map();
  for (const detailRow of detailedRentalRows.rows || []) {
    const detailOrderId = String(detailRow?.shopify_order_id || "").trim();
    if (!detailOrderId) continue;
    const list = detailRowsByOrderId.get(detailOrderId) || [];
    list.push(detailRow);
    detailRowsByOrderId.set(detailOrderId, list);
  }

  const orders = matchingRows.map((row) => {
    const orderId = String(row?.shopify_order_id || "").trim();
    const details = orderDetails[orderId] || {};
    const statuses = Array.isArray(row?.statuses) ? row.statuses : [];
    const tagList = Array.isArray(details?.tags) ? details.tags : [];
    const overallStatus = resolveRentalDisplayStatus({
      status: summarizeRentalStatuses(statuses),
      returnQuantity: row?.return_quantity,
      returnReason: row?.return_reason,
      returnRequestedAt: row?.return_requested_at,
      tags: tagList,
      fallback: summarizeRentalStatuses(statuses),
    });
    const detailLines = Array.isArray(details?.rentalLines) ? details.rentalLines : [];
    const quantityRows = (detailRowsByOrderId.get(orderId) || [])
      .sort((a, b) => {
        const returnDelta = Number(b?.return_quantity || 0) - Number(a?.return_quantity || 0);
        if (returnDelta) return returnDelta;
        const aReason = String(a?.return_reason || "").trim();
        const bReason = String(b?.return_reason || "").trim();
        if (aReason !== bReason) return bReason ? 1 : -1;
        const aCreated = new Date(a?.created_at || 0).getTime();
        const bCreated = new Date(b?.created_at || 0).getTime();
        return bCreated - aCreated;
      });
    const quantityRowFallback = quantityRows[0] || row;

      return {
        id: orderId,
        orderId,
        shopify_order_id: orderId,
        orderNumber: String(details?.orderLabel || `#${orderId}`).replace(/^#/, ""),
        label: String(details?.orderLabel || `#${orderId}`).trim(),
        processedAt: String(
          details?.processedAt ||
            row?.processed_at ||
            row?.created_at ||
            row?.createdAt ||
            row?.order_created_at ||
            "",
        ).trim(),
        shippingAddressLines: Array.isArray(details?.shippingAddressLines)
          ? details.shippingAddressLines
          : [],
        billingEmail:
          String(
            details?.customerEmail ||
              row?.customer_email ||
              resolvedCustomerEmail ||
              "",
          ).trim(),
        returnReason: String(row?.return_reason || "").trim(),
        returnRequestedAt: String(row?.return_requested_at || "").trim(),
        paymentMethod: String(details?.paymentMethod || "Shopify Checkout").trim(),
        status: overallStatus,
        statusLabel: statusLabel(normalizeRentalStatus(overallStatus)),
        startDate: String(row?.start_date || "").trim(),
        endDate: String(row?.end_date || "").trim(),
        lines: detailLines.length
          ? detailLines.map((line, index) => {
              const quantityRow = quantityRows[index] || quantityRowFallback;
              const quantityState = buildRentalQuantityState(quantityRow, line?.quantity || row?.total_quantity);
              const nextStatus = resolveRentalDisplayStatus({
                status: quantityRow?.status || line?.status || overallStatus,
                returnQuantity: quantityRow?.return_quantity,
                returnReason: quantityRow?.return_reason,
                returnRequestedAt: quantityRow?.return_requested_at,
                tags: tagList,
                fallback: overallStatus,
              });
              return {
                title: String(line?.title || "Rental item").trim() || "Rental item",
                quantity: quantityState.totalQuantity,
                returnQuantity: quantityState.returnedQuantity,
                returnedQuantity: quantityState.returnedQuantity,
                availableQuantity: quantityState.availableQuantity,
                startDate: normalizeDateOnly(line?.startDate || quantityRow?.start_date || ""),
                endDate: normalizeDateOnly(line?.endDate || quantityRow?.end_date || ""),
                rateType: String(line?.rateType || "").trim(),
                duration: String(line?.duration || "").trim(),
                selectedItem: String(line?.selectedItem || "").trim(),
                itemType: String(line?.itemType || "").trim(),
                priceText: String(line?.priceText || "").trim(),
                unitPriceText: toMoneyString(Number(line?.rateAmount || quantityRow?.rate_amount) || 0),
                returnReason: String(quantityRow?.return_reason || "").trim(),
                returnRequestedAt: String(quantityRow?.return_requested_at || "").trim(),
                status: nextStatus,
                statusLabel: statusLabel(nextStatus),
              };
            })
          : quantityRows.length
          ? quantityRows.map((quantityRow) => {
              const quantityState = buildRentalQuantityState(quantityRow, quantityRow?.total_quantity);
              const nextStatus = resolveRentalDisplayStatus({
                status: quantityRow?.status || overallStatus,
                returnQuantity: quantityRow?.return_quantity,
                returnReason: quantityRow?.return_reason,
                returnRequestedAt: quantityRow?.return_requested_at,
                tags: tagList,
                fallback: overallStatus,
              });
              return {
                title: String(details?.productName || "Rental item").trim() || "Rental item",
                quantity: quantityState.totalQuantity,
                returnQuantity: quantityState.returnedQuantity,
                returnedQuantity: quantityState.returnedQuantity,
                availableQuantity: quantityState.availableQuantity,
                startDate: String(quantityRow?.start_date || "").trim(),
                endDate: String(quantityRow?.end_date || "").trim(),
                rateType: "",
                duration: "",
                selectedItem: "",
                itemType: "",
                priceText: toMoneyString(quantityRow?.rental_total),
                returnReason: String(quantityRow?.return_reason || "").trim(),
                returnRequestedAt: String(quantityRow?.return_requested_at || "").trim(),
                status: nextStatus,
                statusLabel: statusLabel(nextStatus),
              };
            })
          : [{
              title: String(details?.productName || "Rental item").trim() || "Rental item",
              quantity: Number(row?.total_quantity) || 0,
              returnQuantity: buildRentalQuantityState(row, row?.total_quantity).returnedQuantity,
              returnedQuantity: buildRentalQuantityState(row, row?.total_quantity).returnedQuantity,
              availableQuantity: buildRentalQuantityState(row, row?.total_quantity).availableQuantity,
              startDate: String(row?.start_date || "").trim(),
              endDate: String(row?.end_date || "").trim(),
              rateType: "",
              duration: "",
              selectedItem: "",
              itemType: "",
              priceText: toMoneyString(row?.rental_total),
              unitPriceText: toMoneyString(row?.rate_amount),
              returnReason: String(row?.return_reason || "").trim(),
              returnRequestedAt: String(row?.return_requested_at || "").trim(),
              status: resolveRentalDisplayStatus({
                status: overallStatus,
                returnQuantity: row?.return_quantity,
                returnReason: row?.return_reason,
                returnRequestedAt: row?.return_requested_at,
                tags: tagList,
                fallback: overallStatus,
              }),
              statusLabel: statusLabel(
                resolveRentalDisplayStatus({
                  status: overallStatus,
                  returnQuantity: row?.return_quantity,
                  returnReason: row?.return_reason,
                  returnRequestedAt: row?.return_requested_at,
                  tags: tagList,
                  fallback: overallStatus,
                }),
              ),
            }],
    };
  });

  ctx.body = {
    success: true,
    shop: shopSession.shop,
    customerId: loggedInCustomerId,
    customerEmail: resolvedCustomerEmail,
    orders,
    source: "database",
    debug: debugInfo,
  };
  return;

  const session = {
    id: `offline_${shopSession.shop}`,
    shop: shopSession.shop,
    accessToken: shopSession.access_token,
    isOnline: false,
  };

  const graphqlClient = new shopify.clients.Graphql({ session });
  const customerGid = toCustomerGid(loggedInCustomerId);

  const query = `
    query CustomerRentalOrders($searchQuery: String!) {
      orders(
        first: 100
        reverse: true
        sortKey: PROCESSED_AT
        query: $searchQuery
      ) {
        nodes {
          id
          name
          orderNumber
          processedAt
          shippingAddress {
            name
            address1
            address2
            city
            zip
            provinceCode
            countryCode
          }
          billingAddress {
            name
            address1
            address2
            city
            zip
            provinceCode
            countryCode
          }
          lineItems(first: 100) {
            nodes {
              title
              quantity
              customAttributes {
                key
                value
              }
            }
          }
        }
      }
    }
  `;

  const searchQuery = `customer_id:${loggedInCustomerId}`;

  let response;
  try {
    response = await graphqlClient.query({
      data: {
        query,
        variables: {
          searchQuery,
        },
      },
    });
  } catch (error) {
    console.error("Failed to load customer rental orders:", error);
    ctx.throw(500, "Unable to load customer rental orders");
  }

  const payload = response?.body?.data?.orders?.nodes || [];
  const rentalRowsByOrderId = new Map(
    rows.map((row) => [normalizeOrderId(row?.shopify_order_id || ""), row]),
  );
  const fallbackOrders = normalizeCustomerRentalOrders(payload, "", rentalRowsByOrderId);

  ctx.body = {
    success: true,
    source: "database",
    shop: shopSession.shop,
    customerId: loggedInCustomerId,
    orders: fallbackOrders,
  };
}

async function customerReturnRequestHandler(ctx) {
  applyCustomerCors(ctx);
  if (ctx.method === "OPTIONS") {
    ctx.status = 204;
    return;
  }

  await ensureRentalOrderColumns();

  const decodedToken = await tryDecodeCustomerAccountSessionToken(ctx);
  const preferredShop =
    normalizeShopDomain(decodedToken?.dest || "") ||
    extractPreferredShop(ctx) ||
    normalizeShopDomain(ctx.query.shop || "");
  const shopSession = await getStoredShopSession(preferredShop);

  const orderId = String(
    ctx.request?.body?.orderId ||
      ctx.request?.body?.order_id ||
      ctx.query.orderId ||
      ctx.query.order_id ||
      "",
  )
    .trim()
    .replace(/^#/, "");
  const normalizedOrderId = normalizeOrderId(orderId);
  const reason = String(
    ctx.request?.body?.reason ||
      ctx.request?.body?.returnReason ||
      ctx.query.reason ||
      ctx.query.returnReason ||
      "",
  ).trim();
  const requestedQuantity = Math.max(
    0,
    Number(ctx.request?.body?.returnQuantity) ||
      Number(ctx.request?.body?.quantity) ||
      Number(ctx.query?.returnQuantity) ||
      Number(ctx.query?.quantity) ||
      parseRequestedReturnQuantity(reason),
  );

  if (!normalizedOrderId) ctx.throw(400, "Order ID is required");
  if (reason.length < 5) ctx.throw(400, "Please enter a return reason");

  let resolvedShop = shopSession?.shop || "";
  if (!resolvedShop) {
    const fallbackShopRows = await pool.query(
      `SELECT DISTINCT shop
       FROM rentals
       WHERE shopify_order_id = $1
         AND TRIM(COALESCE(shop, '')) <> ''`,
      [normalizedOrderId],
    );
    const fallbackShops = (fallbackShopRows.rows || [])
      .map((row) => normalizeShopDomain(row?.shop || ""))
      .filter(Boolean);
    if (fallbackShops.length === 1) {
      resolvedShop = fallbackShops[0];
    } else if (fallbackShops.length > 1 && preferredShop) {
      resolvedShop = fallbackShops.find((shop) => shop === preferredShop) || fallbackShops[0];
    }
  }

  if (!resolvedShop) {
    ctx.throw(400, "No Shopify shop context found for this return request");
  }

  const orderPayload = await fetchShopifyOrderPayloadViaRest(resolvedShop, normalizedOrderId);
  if (
    orderPayload &&
    !isFulfilledShopifyOrder(
      orderPayload?.display_fulfillment_status ||
        orderPayload?.fulfillment_status ||
        orderPayload?.fulfillmentStatus ||
        "",
    )
  ) {
    ctx.throw(409, "This rental can be returned only after the order is fulfilled");
  }

  const updated = await pool.query(
    `UPDATE rentals
     SET status = 'Return Requested',
         return_quantity = CASE
           WHEN $3 > 0 THEN $3
           ELSE COALESCE(return_quantity, 0)
         END,
         return_reason = $2,
         return_requested_at = NOW(),
         updated_at = NOW()
     WHERE shopify_order_id = $1
       AND lower(shop) = lower($4)
     RETURNING shopify_order_id`,
    [normalizedOrderId, reason, requestedQuantity, resolvedShop],
  );

  if (!updated.rows.length) {
    if (!orderPayload) {
      ctx.throw(404, "Rental order not found");
    }

    const rentalLines = forceRentalLinesStatus(
      await extractRentalLinesFromOrderPayload(orderPayload, resolvedShop),
      "Return Requested",
    );

    if (!rentalLines.length) {
      ctx.throw(404, "Rental order not found");
    }

    await upsertRentalRowsForOrder(
      normalizedOrderId,
      resolvedShop,
      rentalLines,
      extractRentalCustomerDetails(orderPayload),
    );

    const retryUpdate = await pool.query(
      `UPDATE rentals
       SET status = 'Return Requested',
           return_quantity = CASE
             WHEN $3 > 0 THEN $3
             ELSE COALESCE(return_quantity, 0)
           END,
           return_reason = $2,
           return_requested_at = NOW(),
           updated_at = NOW()
       WHERE shopify_order_id = $1
         AND lower(shop) = lower($4)
       RETURNING shopify_order_id`,
      [normalizedOrderId, reason, requestedQuantity, resolvedShop],
    );

    if (!retryUpdate.rows.length) {
      ctx.throw(404, "Rental order not found");
    }
  }

  await backfillReturnQuantityFromReason(normalizedOrderId, resolvedShop);
  await updateAdminOrderStatusTag(resolvedShop, normalizedOrderId, "Return Requested");

  const wantsHtml =
    String(ctx.query.mode || "").trim().toLowerCase() === "page" ||
    String(ctx.get("accept") || "").toLowerCase().includes("text/html");

  if (wantsHtml) {
    ctx.type = "html";
    ctx.body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Return request submitted</title>
    <style>
      body {
        margin: 0;
        font-family: Arial, sans-serif;
        background: #f6f6f7;
        color: #1f1f1f;
      }
      .shell {
        max-width: 720px;
        margin: 64px auto;
        background: #ffffff;
        border: 1px solid #e1e3e5;
        border-radius: 20px;
        padding: 40px;
        box-shadow: 0 12px 36px rgba(15, 23, 42, 0.08);
      }
      .eyebrow {
        color: #2563eb;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      h1 {
        margin: 12px 0 10px;
        font-size: 30px;
        line-height: 1.2;
      }
      p {
        margin: 0 0 16px;
        font-size: 16px;
        line-height: 1.6;
        color: #4b5563;
      }
      .card {
        margin-top: 28px;
        padding: 20px 22px;
        border-radius: 16px;
        background: #f9fafb;
        border: 1px solid #e5e7eb;
      }
      .label {
        display: block;
        margin-bottom: 8px;
        font-size: 13px;
        color: #6b7280;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .value {
        font-size: 17px;
        font-weight: 600;
        color: #111827;
      }
      .back {
        display: inline-block;
        margin-top: 28px;
        padding: 12px 18px;
        border-radius: 999px;
        background: #111827;
        color: #ffffff;
        text-decoration: none;
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="eyebrow">Return Request</div>
      <h1>Request submitted successfully</h1>
      <p>Your return request for order #${String(orderId)} has been sent to the admin team for approval.</p>
      <div class="card">
        <span class="label">Return reason</span>
        <div class="value">${String(reason)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</div>
      </div>
      <a class="back" href="/account">Back to account</a>
    </div>
  </body>
</html>`;
    return;
  }

    ctx.body = {
    success: true,
    orderId: normalizedOrderId,
    status: "Return Requested",
    reason,
  };
}

router.get("/proxy/api/customer-rentals", customerRentalsHandler);
router.post("/proxy/api/customer-rentals", customerRentalsHandler);
router.get("/proxy/api/customer-account/rentals", customerRentalsHandler);
router.post("/proxy/api/customer-account/rentals", customerRentalsHandler);
router.get("/api/customer-account/rentals", customerRentalsHandler);
router.post("/api/customer-account/rentals", customerRentalsHandler);
async function cartSyncSettingsHandler(ctx) {
  try {
    const preferredShop =
      extractPreferredShop(ctx, ctx.query?.shop || "") ||
      normalizeShopDomain(ctx.query?.shop || "");
    const settings = await getShopCartSyncSettings(preferredShop);
    ctx.body = {
      success: true,
      ...settings,
    };
  } catch (error) {
    console.error("Cart sync settings proxy error:", error?.message || error);
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: "Failed to load cart sync settings",
    };
  }
}
async function bookingSettingsHandler(ctx) {
  try {
    const preferredShop =
      extractPreferredShop(ctx, ctx.query?.shop || "") ||
      normalizeShopDomain(ctx.query?.shop || "");
    const settings = await getShopBookingBlockSettings(preferredShop);
    ctx.body = {
      success: true,
      ...settings,
    };
  } catch (error) {
    console.error("Booking settings proxy error:", error?.message || error);
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: "Failed to load booking settings",
    };
  }
}
router.get("/proxy/api/cart-sync-settings", cartSyncSettingsHandler);
router.get("/api/cart-sync-settings", cartSyncSettingsHandler);
router.get("/proxy/api/booking-settings", bookingSettingsHandler);
router.get("/api/booking-settings", bookingSettingsHandler);
router.get("/proxy/api/customer-return-request", customerReturnRequestHandler);
router.post("/proxy/api/customer-return-request", customerReturnRequestHandler);
router.get("/proxy/api/customer-account/return-request", customerReturnRequestHandler);
router.post("/proxy/api/customer-account/return-request", customerReturnRequestHandler);
router.get("/api/customer-account/return-request", customerReturnRequestHandler);
router.post("/api/customer-account/return-request", customerReturnRequestHandler);

router.options("/proxy/api/customer-rentals", customerRentalsHandler);
router.options("/proxy/api/customer-account/rentals", customerRentalsHandler);
router.options("/api/customer-account/rentals", customerRentalsHandler);
router.options("/proxy/api/cart-sync-settings", cartSyncSettingsHandler);
router.options("/api/cart-sync-settings", cartSyncSettingsHandler);
router.options("/proxy/api/booking-settings", bookingSettingsHandler);
router.options("/api/booking-settings", bookingSettingsHandler);
router.options("/proxy/api/customer-return-request", customerReturnRequestHandler);
router.options("/proxy/api/customer-account/return-request", customerReturnRequestHandler);
router.options("/api/customer-account/return-request", customerReturnRequestHandler);
router.get("/proxy/api/print/rental-order", rentalOrderPrintHandler);
router.get("/api/customer-account/print-rental-order", rentalOrderPrintHandler);
router.post("/webhooks/orders/create", ordersCreateWebhookHandler);
router.post("/webhooks/orders/paid", ordersPaidWebhookHandler);
router.post("/webhooks/fulfillment_orders/placed_on_hold", fulfillmentPlacedOnHoldWebhookHandler);
router.post("/webhooks/fulfillment_orders/hold_released", fulfillmentHoldReleasedWebhookHandler);
router.post("/webhooks/fulfillments/create", fulfillmentsCreateWebhookHandler);

module.exports = router;
