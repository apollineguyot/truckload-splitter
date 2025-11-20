// server.js
// Express server for Shopify order splitting with debug logs

const express = require("express");
const fetch = require("node-fetch"); // required if Node < 18

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHOP = process.env.SHOP; // e.g. yourstore.myshopify.com
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = "2023-10";

// Health check
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

// Webhook: orders/create
app.post("/webhooks/orders/create", async (req, res) => {
  try {
    const order = req.body;
    console.log("🚚 Received order:", JSON.stringify(order, null, 2));

    // Prevent reprocessing
    if ((order.tags || "").includes("Split-Processed")) {
      console.log("↩️ Order already processed. Skipping split.");
      return res.status(200).send("Already processed");
    }

    if (!order.line_items || order.line_items.length === 0) {
      console.log("⚠️ No line items found.");
      return res.status(200).send("No line items");
    }

    const item = order.line_items[0];
    console.log("🧩 Line item:", JSON.stringify(item, null, 2));

    // Fetch product metafields
    const metaResp = await fetch(
      `https://${SHOP}/admin/api/${API_VERSION}/products/${item.product_id}/metafields.json`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ACCESS_TOKEN,
        },
      }
    );

    const metaData = await metaResp.json();
    console.log("📑 Product metafields:", JSON.stringify(metaData, null, 2));

    const truckloadMeta = (metaData.metafields || []).find(
      (m) => m.key === "truckload_capacity" && (m.namespace === "custom" || m.namespace === "logistics")
    );

    const truckloadCapacity = parseInt(truckloadMeta?.value || "0", 10);
    console.log("📦 Truckload capacity:", truckloadCapacity);

    if (!truckloadCapacity || truckloadCapacity <= 0) {
      console.log("⚠️ Invalid or missing truckload capacity");
      return res.status(200).send("No truckload capacity found");
    }

    // Calculate split quantities
    let remaining = item.quantity;
    const splitQuantities = [];
    while (remaining > 0) {
      const split = Math.min(truckloadCapacity, remaining);
      splitQuantities.push(split);
      remaining -= split;
    }
    console.log("🔀 Split quantities:", splitQuantities);

    // Create split orders
    for (let i = 0; i < splitQuantities.length; i++) {
      const qty = splitQuantities[i];
      const newOrderPayload = {
        order: {
          line_items: [
            {
              variant_id: item.variant_id,
              quantity: qty,
            },
          ],
          tags: [`Truckload ${i + 1}`],
        },
      };

      const createResp = await fetch(
        `https://${SHOP}/admin/api/${API_VERSION}/orders.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ACCESS_TOKEN,
          },
          body: JSON.stringify(newOrderPayload),
        }
      );

      const createdOrder = await createResp.json();
      console.log(`✅ Created split order ${i + 1}:`, JSON.stringify(createdOrder, null, 2));
    }

    // Tag original order
    await fetch(`https://${SHOP}/admin/api/${API_VERSION}/orders/${order.id}.json`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ACCESS_TOKEN,
      },
      body: JSON.stringify({
        order: {
          id: order.id,
          tags: `${order.tags}, Split-Processed`,
        },
      }),
    });

    console.log("🔵 Original order tagged as Split-Processed");
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
