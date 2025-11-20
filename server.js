// server.js
// Fully self-contained Express server for Shopify order splitting with debug logs

const express = require("express");

// Node 18+ provides global fetch, so no need for node-fetch
const app = express();

// Parse JSON bodies (Shopify webhooks send JSON)
app.use(express.json());

// Config
const PORT = process.env.PORT || 3000;
const SHOP = process.env.SHOP; // e.g., sl5-ait-worldwide.myshopify.com
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2023-10";

// Basic sanity checks
if (!SHOP || !ACCESS_TOKEN) {
  console.warn("⚠️ Missing SHOP or SHOPIFY_ACCESS_TOKEN environment variables. Requests will fail.");
}

// Health check
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

// Helper: Fetch product metafields
async function getProductMetafields(productId) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/products/${productId}/metafields.json`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to fetch metafields (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return data.metafields || [];
}

// Helper: Create one split order
async function createSplitOrder({ variantId, quantity, truckloadIndex }) {
  const payload = {
    order: {
      line_items: [
        {
          variant_id: variantId,
          quantity: quantity,
        },
      ],
      tags: [`Truckload ${truckloadIndex}`],
    },
  };

  const url = `https://${SHOP}/admin/api/${API_VERSION}/orders.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
    body: JSON.stringify(payload),
  });

  const body = await resp.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    json = { raw: body };
  }

  if (!resp.ok) {
    throw new Error(`Create order failed (${resp.status}): ${body}`);
  }

  console.log(`🟢 Created split order ${truckloadIndex}:`, JSON.stringify(json, null, 2));
  return json;
}

// Webhook: orders/create
app.post("/webhooks/orders/create", async (req, res) => {
  try {
    const order = req.body;
    console.log("🚚 Received order:", JSON.stringify(order, null, 2));

    // Prevent reprocessing if already tagged
    if ((order.tags || "").includes("Split-Processed")) {
      console.log("↩️ Order already processed. Skipping split.");
      return res.status(200).send("Already processed");
    }

    // Basic guards
    if (!order || !Array.isArray(order.line_items) || order.line_items.length === 0) {
      console.log("⚠️ No line items found in order payload.");
      return res.status(200).send("No line items");
    }

    // For now, handle the first line item (expand later as needed)
    const item = order.line_items[0];
    console.log("🧩 Line item:", JSON.stringify(item, null, 2));

    if (!item.product_id || !item.variant_id) {
      console.log("⚠️ Missing product_id or variant_id on line item.");
      return res.status(200).send("Invalid line item");
    }

    // Fetch product metafields and find truckload capacity
    const metafields = await getProductMetafields(item.product_id);
    console.log("📑 Product metafields:", JSON.stringify(metafields, null, 2));

    // Accept either 'custom' or 'logistics' namespace to match your earlier setup
    const capacityMf =
      metafields.find((mf) => mf.key === "truckload_capacity" && mf.namespace === "logistics") ||
      metafields.find((mf) => mf.key === "truckload_capacity" && mf.namespace === "custom");

    if (!capacityMf) {
      console.log("⚠️ No truckload_capacity metafield found.");
      return res.status(200).send("No truckload capacity found");
    }

    const capacity = parseInt(capacityMf.value, 10);
    console.log("📦 Truckload capacity:", capacity);

    if (!capacity || capacity <= 0) {
      console.log("⚠️ Invalid truckload capacity value.");
      return res.status(200).send("Invalid truckload capacity");
    }

    // Compute split quantities
    let remaining = item.quantity;
    const splitQuantities = [];
    while (remaining > 0) {
      const split = Math.min(capacity, remaining);
      splitQuantities.push(split);
      remaining -= split;
    }
    console.log("🔀 Split quantities:", splitQuantities);

    // Create split orders
    for (let i = 0; i < splitQuantities.length; i++) {
      const qty = splitQuantities[i];
      await createSplitOrder({
        variantId: item.variant_id,
        quantity: qty,
        truckloadIndex: i + 1,
      });
    }

    // Tag original order as processed
    const tagUrl = `https://${SHOP}/admin/api/${API_VERSION}/orders/${order.id}.json`;
    const newTags = (order.tags ? `${order.tags}, ` : "") + "Split-Processed";

    const tagResp = await fetch(tagUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ACCESS_TOKEN,
      },
      body: JSON.stringify({
        order: {
          id: order.id,
          tags: newTags,
        },
      }),
    });

    const tagBody = await tagResp.text();
    if (!tagResp.ok) {
      console.error("❌ Failed to tag original order:", tagBody);
      // Still respond 200 to avoid webhook retries storm; log for manual follow-up
    } else {
      console.log("🔵 Original order tagged as Split-Processed:", tagBody);
    }

    return res.status(200).send("Split processed");
  } catch (err) {
    console.error("❌ Error processing split:", err);
    return res.status(500).send("Error");
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
