// server.js — Shopify Truckload Splitter (ES Module)

import express from "express";
import fetch from "node-fetch"; // required if Node < 18

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHOP = process.env.SHOP;
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

    if ((order.tags || "").includes("Split-Processed")) {
      console.log("↩️ Order already processed. Skipping split.");
      return res.status(200).send("Already processed");
    }

    const item = order.line_items?.[0];
    if (!item?.product_id || !item?.variant_id) {
      console.log("⚠️ Invalid line item");
      return res.status(200).send("Invalid line item");
    }
for (const item of order.line_items) {
  try {
    // 🔗 Fetch metafields for the product
    const metaResp = await fetch(
      `https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/products/${item.product_id}/metafields.json`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ACCESS_TOKEN,
        },
      }
    );

    const metaData = await metaResp.json();
    const metafield = metaData.metafields.find(
      (m) => m.namespace === "custom" && m.key === "truckload_capacity"
    );

    const truckloadCapacity = parseInt(metafield?.value, 10);

    // 🧪 Debug logs
    console.log("📦 Parsed truckload capacity:", truckloadCapacity);
    console.log("📦 Quantity:", item.quantity);

    // 🚫 Skip if no split needed
    if (!truckloadCapacity || item.quantity <= truckloadCapacity) {
      console.log("🚫 No split needed");
      continue;
    }

    // 🔀 Calculate split quantities
    const fullLoads = Math.floor(item.quantity / truckloadCapacity);
    const remainder = item.quantity % truckloadCapacity;
    const splitQuantities = Array(fullLoads).fill(truckloadCapacity);
    if (remainder > 0) splitQuantities.push(remainder);

    console.log("🔀 Split quantities:", splitQuantities);

    // ✅ Create split orders (you can loop through splitQuantities here)
    for (const qty of splitQuantities) {
      // Replace this with your order creation logic
      console.log(`✅ Creating split order with quantity: ${qty}`);
    }

    // 🏷️ Tag original order
    console.log("🔵 Original order tagged as Split-Processed");

  } catch (err) {
    console.error("❌ Error processing split:", err);
  }
}

  
    const metaData = await metaResp.json();
    console.log("📑 Product metafields:", JSON.stringify(metaData, null, 2));

    const truckloadMeta = (metaData.metafields || []).find(
      (m) => m.key === "truckload_capacity" && (m.namespace === "custom" || m.namespace === "logistics")
    );

    const truckloadCapacity = parseInt(truckloadMeta?.value || "0", 10);
    console.log("📦 Truckload capacity:", truckloadCapacity);

    if (!truckloadCapacity || truckloadCapacity <= 0) {
      console.log("⚠️ No valid truckload capacity found");
      return res.status(200).send("No truckload capacity found");
    }

    let remaining = item.quantity;
    const splitQuantities = [];
    while (remaining > 0) {
      const split = Math.min(truckloadCapacity, remaining);
      splitQuantities.push(split);
      remaining -= split;
    }
    console.log("🔀 Split quantities:", splitQuantities);

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
