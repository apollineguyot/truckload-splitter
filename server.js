// server.js — Shopify Truckload Splitter (ES Module)

import express from "express";
import fetch from "node-fetch"; // If you're on Node 18+, you can remove this import.

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHOP = process.env.SHOP; // e.g., "sl5-ait-worldwide.myshopify.com" (NO protocol)
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = "2023-10";

// Basic env validation
if (!SHOP || !ACCESS_TOKEN) {
  console.error("❌ Missing required env vars: SHOP or SHOPIFY_ACCESS_TOKEN");
}

const shopBaseUrl = `https://${SHOP}`;

// Health check
app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

// Webhook: orders/create
app.post("/webhooks/orders/create", async (req, res) => {
  try {
    const order = req.body;
    console.log("🚚 Received order:", JSON.stringify(order, null, 2));

    // Skip if already processed
    if ((order.tags || "").includes("Split-Processed")) {
      console.log("↩️ Order already processed. Skipping split.");
      return res.status(200).send("Already processed");
    }

    // Validate line items exist
    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    if (lineItems.length === 0) {
      console.log("⚠️ No line items found on order");
      return res.status(200).send("No line items");
    }

    // Process each line item
    for (const item of lineItems) {
      if (!item?.product_id || !item?.variant_id) {
        console.log("⚠️ Invalid line item (missing product_id or variant_id)", item);
        continue;
      }

      // Fetch product metafields
      let metaResp;
      try {
        metaResp = await fetch(
          `${shopBaseUrl}/admin/api/${API_VERSION}/products/${item.product_id}/metafields.json`,
          {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": ACCESS_TOKEN,
            },
          }
        );
      } catch (err) {
        console.error("❌ Failed to fetch product metafields:", err);
        continue;
      }

      // Parse metafields JSON safely
      let metaData;
      try {
        metaData = await metaResp.json();
      } catch (err) {
        console.error("❌ Failed to parse metafield JSON:", err);
        continue;
      }

      const metafields = Array.isArray(metaData?.metafields) ? metaData.metafields : [];
      const truckloadMeta =
        metafields.find(
          (m) => m.key === "truckload_capacity" && (m.namespace === "custom" || m.namespace === "logistics")
        ) || null;

      const truckloadCapacity = parseInt(truckloadMeta?.value ?? "0", 10);

      // Debug logs
      console.log("📦 Parsed truckload capacity:", truckloadCapacity);
      console.log("📦 Item quantity:", item.quantity);

      // Skip if capacity invalid or split not needed
      if (!Number.isFinite(truckloadCapacity) || truckloadCapacity <= 0) {
        console.log("⚠️ No valid truckload capacity found for product", item.product_id);
        continue;
      }
      if (item.quantity <= truckloadCapacity) {
        console.log("🚫 No split needed for this line item");
        continue;
      }

      // Calculate split quantities
      const fullLoads = Math.floor(item.quantity / truckloadCapacity);
      const remainder = item.quantity % truckloadCapacity;
      const splitQuantities = Array(fullLoads).fill(truckloadCapacity);
      if (remainder > 0) splitQuantities.push(remainder);

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
            // You can copy address info from the original order if needed:
            // shipping_address: order.shipping_address,
            // billing_address: order.billing_address,
            tags: [`Split-Child`, `Truckload ${i + 1}`],
          },
        };

        try {
          const createResp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders.json`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": ACCESS_TOKEN,
            },
            body: JSON.stringify(newOrderPayload),
          });

          const createdOrder = await createResp.json();
          if (!createResp.ok) {
            console.error(
              `❌ Failed to create split order ${i + 1}:`,
              createResp.status,
              JSON.stringify(createdOrder, null, 2)
            );
            continue;
          }
          console.log(`✅ Created split order ${i + 1}:`, JSON.stringify(createdOrder, null, 2));
        } catch (err) {
          console.error(`❌ Error creating split order ${i + 1}:`, err);
          continue;
        }
      }
    }

    // Tag original order as processed (safe append)
    try {
      const existingTags = (order.tags || "").trim();
      const newTags = existingTags ? `${existingTags}, Split-Processed` : "Split-Processed";

      const tagResp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}.json`, {
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

      const tagData = await tagResp.json();
      if (!tagResp.ok) {
        console.error("❌ Failed to tag original order:", tagResp.status, JSON.stringify(tagData, null, 2));
      } else {
        console.log("🔵 Original order tagged as Split-Processed");
      }
    } catch (err) {
      console.error("
