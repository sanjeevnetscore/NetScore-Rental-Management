const Router = require("@koa/router");
const shopify = require("../shopify");
const pool = require("../db");

const router = new Router();

function sanitizeReturnTo(rawValue = "/") {
  const value = String(rawValue || "").trim();
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/";
  return value || "/";
}

function buildPostAuthRedirect(returnTo, shop, host) {
  const safeReturnTo = sanitizeReturnTo(returnTo);
  const url = new URL(safeReturnTo, "https://app.local");

  if (shop && !url.searchParams.get("shop")) {
    url.searchParams.set("shop", shop);
  }

  if (host && !url.searchParams.get("host")) {
    url.searchParams.set("host", host);
  }

  if (host && !url.searchParams.get("embedded")) {
    url.searchParams.set("embedded", "1");
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

router.get("/auth", async (ctx) => {
  const shop = ctx.query.shop;
  const returnTo = sanitizeReturnTo(ctx.query.returnTo || "/");

  if (!shop) {
    ctx.status = 400;
    ctx.body = "Missing shop parameter";
    return;
  }

  ctx.session.shopifyReturnTo = returnTo;

  await shopify.auth.begin({
    shop,
    callbackPath: "/auth/callback",
    isOnline: false,
    rawRequest: ctx.req,
    rawResponse: ctx.res,
  });
  // Shopify's Node adapter sends the redirect + OAuth cookie on rawResponse.
  ctx.respond = false;
  return;
});

router.get("/auth/callback", async (ctx) => {
  try {
    const callbackResult = await shopify.auth.callback({
      rawRequest: ctx.req,
      rawResponse: ctx.res,
    });
    const { session, headers } = callbackResult;

    if (headers && typeof headers === "object") {
      for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) {
          ctx.set(key, value);
        }
      }
    }

    await pool.query(
      "INSERT INTO shops (shop, access_token) VALUES ($1, $2) ON CONFLICT (shop) DO UPDATE SET access_token = EXCLUDED.access_token, updated_at = NOW()",
      [session.shop, session.accessToken],
    );

    const redirectTo = buildPostAuthRedirect(
      ctx.session.shopifyReturnTo || "/",
      session.shop,
      ctx.query.host,
    );

    ctx.session.shopifyReturnTo = null;
    ctx.redirect(redirectTo);
  } catch (err) {
    console.error("Shopify auth callback failed:", {
      message: err?.message,
      stack: err?.stack,
      query: ctx.query,
    });

    ctx.status = 400;
    ctx.body = `Auth failed: ${err?.message || "Unknown error"}`;
  }
});

module.exports = router;
