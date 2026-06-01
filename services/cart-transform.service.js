const pool = require("../db");
const shopify = require("../shopify");

const RENTAL_CART_TRANSFORM_HANDLE = "rental-cart-transform-rust";

function normalizeShopDomain(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  return value.endsWith(".myshopify.com") ? value : `${value}.myshopify.com`;
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

function createOfflineSession(shopSession) {
  return {
    id: `offline_${shopSession.shop}`,
    shop: shopSession.shop,
    accessToken: shopSession.access_token,
    isOnline: false,
  };
}

async function graphqlRequest(client, query, variables = {}) {
  const response = await client.request(query, { variables });
  return { body: { data: response?.data || {} } };
}

async function listRentalCartTransforms(client) {
  const response = await graphqlRequest(
    client,
    `
        query ListCartTransforms {
          cartTransforms(first: 25) {
            nodes {
              id
              functionId
            }
          }
        }
      `,
  );

  const body = response?.body?.data || {};
  return Array.isArray(body?.cartTransforms?.nodes) ? body.cartTransforms.nodes : [];
}

async function deleteCartTransform(client, id) {
  const response = await graphqlRequest(
    client,
    `
        mutation DeleteCartTransform($id: ID!) {
          cartTransformDelete(id: $id) {
            deletedId
            userErrors {
              field
              message
            }
          }
        }
      `,
    { id },
  );

  const payload = response?.body?.data?.cartTransformDelete;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length) {
    throw new Error(userErrors.map((err) => err.message).join("; "));
  }
}

async function activateRentalCartTransform(session) {
  const client = new shopify.clients.Graphql({ session });
  const transforms = await listRentalCartTransforms(client);

  for (const transform of transforms) {
    if (!transform?.id) continue;
    await deleteCartTransform(client, transform.id);
  }

  const response = await graphqlRequest(
    client,
    `
        mutation ActivateRentalCartTransform($functionHandle: String!, $blockOnFailure: Boolean!) {
          cartTransformCreate(functionHandle: $functionHandle, blockOnFailure: $blockOnFailure) {
            cartTransform {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
    {
      functionHandle: RENTAL_CART_TRANSFORM_HANDLE,
      blockOnFailure: false,
    },
  );

  const payload = response?.body?.data?.cartTransformCreate;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length) {
    throw new Error(userErrors.map((err) => err.message).join("; "));
  }

  return payload?.cartTransform || null;
}

async function activateRentalCartTransformForShop(preferredShop = "") {
  const shopSession = await getStoredShopSession(preferredShop);
  if (!shopSession) {
    throw new Error("No Shopify offline token found for this store.");
  }

  return activateRentalCartTransform(createOfflineSession(shopSession));
}

async function deactivateRentalCartTransformForShop(preferredShop = "") {
  const shopSession = await getStoredShopSession(preferredShop);
  if (!shopSession) {
    throw new Error("No Shopify offline token found for this store.");
  }

  const client = new shopify.clients.Graphql({
    session: createOfflineSession(shopSession),
  });
  const transforms = await listRentalCartTransforms(client);

  for (const transform of transforms) {
    if (!transform?.id) continue;
    await deleteCartTransform(client, transform.id);
  }

  return { deleted: transforms.length };
}

module.exports = {
  activateRentalCartTransform,
  activateRentalCartTransformForShop,
  deactivateRentalCartTransformForShop,
  getStoredShopSession,
  normalizeShopDomain,
};
