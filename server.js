// server.js
import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();

// Capture raw body for HMAC verification
app.use(bodyParser.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// Environment variables (set in Render dashboard)
const SHOP = process.env.SHOP; // e.g. s1-safe-worldwide.myshopify.com
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN; // Admin API token
const SECRET = process.env.SHOPIFY_API_SECRET; // App secret
const API_VERSION = process.env.API_VERSION || "2025-01";
const PORT = process.env.PORT || 3000;

function verifyShopifyWebhook(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-SHA256");
  const digest = crypto
    .createHmac("sha256", SECRET)
    .update(req.rawBody, "utf8")
    .digest("base64");
  if (!hmacHeader) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

async function getProductMetafields(productId) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/products/${productId}/metafields.json`;
  const res = await fetch(url, { headers: { "X-Shopify-Access-Token": TOKEN } });
  if (!res.ok) throw new Error(`Metafields fetch failed: ${res.status}`);
  const data = await res.json();
  return data.metafields || [];
}

async function createSplitOrder({ order, variantId, qty, truckloadIndex }) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/orders.json`;
  const payload = {
    order: {
      line_items: [{ variant_id: variantId, quantity: qty }],
      customer: order.customer ? { id: order.customer.id } : undefined,
      email: order.email,
      shipping_address: order.shipping_address,
      billing_address: order.billing_address,
      financial_status: "paid",
      send_receipt: false,
      send_fulfillment_receipt: false,
      tags: [`Truckload ${truckloadIndex}`, `SplitFrom:${order.name}`],
      note: `Split from ${order.name} (${order.id}) - Truckload ${truckloadIndex}`
    }
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Order create failed: ${res.status} ${errText}`);
  }
  return res.json();
}

async function tagOriginalOrder(orderId, noteAppend, extraTag = "Split-Processed") {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/orders/${orderId}.json`;
  const payload = { order: { id: orderId, note: noteAppend, tags: extraTag } };
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Original order tag failed: ${res.status}`);
}

app.post("/webhooks/orders/create", async (req, res) => {
  try {
    const order = req.body;
    console.log("🚚 Received order:", JSON.stringify(order, null, 2));

    // Grab the first line item (assuming one product per order for now)
    const lineItem = order.line_items[0];
    console.log("🧩 Line item:", JSON.stringify(lineItem, null, 2));

    // Fetch product metafields from Shopify Admin API
    const response = await fetch(`https://${process.env.SHOP}/admin/api/2023-10/products/${lineItem.product_id}/metafields.json`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
      },
    });

    const data = await response.json();
    console.log("📑 Product metafields:", JSON.stringify(data, null, 2));

    // Find the truckload_capacity metafield
    const truckloadMeta = data.metafields.find(
      (m) => m.namespace === "custom" && m.key === "truckload_capacity"
    );

    const truckloadCapacity = parseInt(truckloadMeta?.value || "0", 10);
    console.log("📦 Truckload capacity:", truckloadCapacity);

    // Calculate split quantities
    let remaining = lineItem.quantity;
    const splitQuantities = [];
    while (remaining > 0) {
      const split = Math.min(truckloadCapacity, remaining);
      splitQuantities.push(split);
      remaining -= split;
    }
    console.log("🔀 Split quantities:", splitQuantities);

    // Create new orders for each split
    for (let i = 0; i < splitQuantities.length; i++) {
      const quantity = splitQuantities[i];
      const newOrderPayload = {
        order: {
          line_items: [
            {
              variant_id: lineItem.variant_id,
              quantity: quantity,
            },
          ],
          tags: [`Truckload ${i + 1}`],
        },
      };

      const createResponse = await fetch(`https://${process.env.SHOP}/admin/api/2023-10/orders.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
        },
        body: JSON.stringify(newOrderPayload),
      });

      const createdOrder = await createResponse.json();
      console.log(`✅ Created split order ${i + 1}:`, JSON.stringify(createdOrder, null, 2));
    }

    // Tag the original order as processed
    await fetch(`https://${process.env.SHOP}/admin/api/2023-10/orders/${order.id}.json`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
      },
      body: JSON.stringify({
        order: {
          id: order.id,
          tags: `${order.tags}, Split-Processed`,
        },
      }),
    });

    console.log("🏷️ Original order tagged as Split-Processed");

    res.status(200).send("Split processed");
  } catch (err) {
    console.error("❌ Error processing split:", err);
    res.status(500).send("Error");
  }
});




    if ((order.tags || "").includes("Split-Processed")) {
      return res.status(200).send("Already processed");
    }

    for (const item of order.line_items || []) {
      if (!item.product_id || !item.variant_id) continue;

      const metafields = await getProductMetafields(item.product_id);
      const capacityMf = metafields.find(mf =>
        mf.key === "truckload_capacity" &&
        (mf.namespace === "custom" || mf.namespace === "logistics")
      );

      if (!capacityMf) continue;

      const capacity = parseInt(capacityMf.value, 10);
      if (!capacity || capacity <= 0) continue;

      const loads = Math.ceil(item.quantity / capacity);
      for (let i = 1; i <= loads; i++) {
        const remainder = item.quantity % capacity;
        const qty = (i < loads) ? capacity : (remainder || capacity);
        await createSplitOrder({ order, variantId: item.variant_id, qty, truckloadIndex: i });
      }
    }

    await tagOriginalOrder(order.id, "Order split into truckloads via custom app.", "Split-Processed");
    res.status(200).send("Split processed");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

app.get("/", (req, res) => res.send("Truckload Splitter is running"));

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
