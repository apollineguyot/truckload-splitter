// =========================
// Section 1: Imports & Config
// =========================

import express from "express";

const app = express();
app.use(express.json());

// Environment variables
const PORT = process.env.PORT || 10000;
const SHOP = process.env.SHOP;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = process.env.API_VERSION || "2023-10";
const shopBaseUrl = `https://${SHOP}.myshopify.com`;

// =========================
// Utility Functions
// =========================

// Normalize date string (hardened)
function normalizeDate(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split("T")[0];
  } catch {
    return null;
  }
}

// Fetch parent order from Shopify
async function getParentOrder(orderId) {
  const resp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${orderId}.json`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
  });
  const data = await resp.json();
  return data.order || {};
}

// Tag parent order with Split-Processed
async function tagParentOrder(orderId, tag) {
  const resp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${orderId}.json`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
    body: JSON.stringify({
      order: {
        id: orderId,
        tags: tag,
      },
    }),
  });
  return await resp.json();
}

// Extract pickup date from note attributes
function getParentPickupDate(order) {
  if (order?.note_attributes) {
    const pickupAttr = order.note_attributes.find(attr => attr.name === "pickup_date");
    if (pickupAttr) return normalizeDate(pickupAttr.value);
  }
  return null;
}

// Stub for pickup location (extend if needed)
async function getParentPickupLocation(orderId) {
  return null;
}
// =========================
// Section 2: Webhook Handler Start
// =========================

// Unified webhook route
app.post("/webhook", async (req, res) => {
  try {
    const topic = req.get("X-Shopify-Topic"); // Shopify tells you which event fired
    const order = req.body; // Shopify sends the order payload

    console.log(`🔔 Webhook fired for topic: ${topic}, order ${order.id}`);

    if (topic === "orders/create") {
      await runSplitLogic(order);
    } else if (topic === "orders/paid") {
      await runSplitLogic(order);
    } else {
      console.log(`ℹ️ Ignored webhook topic: ${topic}`);
    }

    res.status(200).send("Webhook processed");
  } catch (err) {
    console.error("❌ Error in unified webhook handler:", err);
    res.status(500).send("Internal error");
  }
});

// =========================
// Split Logic Function
// =========================
async function runSplitLogic(order) {
  try {
    console.log(`📦 Running split logic for order ${order.id}`);

    // ✅ Guard clauses
    if (order.tags?.includes("Split-Processed")) {
      console.log(`↩️ Parent already marked as processed. Skipping split.`);
      return;
    }
    if (order.tags?.includes("Split-Child")) {
      console.log(`↩️ Child order detected. Skipping split.`);
      return;
    }

    let childOrdersCreated = false;

    // ✅ Outer loop over line items
    for (const item of order.line_items) {
      if (!item?.product_id || !item?.variant_id) continue;

      // 🔎 Fetch truckload capacity metafield
      const metaResp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/products/${item.product_id}/metafields.json`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ACCESS_TOKEN,
        },
      });
      const metaData = await metaResp.json();

      const truckloadMeta = Array.isArray(metaData?.metafields)
        ? metaData.metafields.find(m => m.namespace === "custom" && m.key === "truckload_capacity")
        : null;

      const truckloadCapacity = truckloadMeta ? parseInt(truckloadMeta.value, 10) : null;

      if (!truckloadCapacity || truckloadCapacity <= 0) {
        console.log(`⚠️ No valid truckload capacity for product ${item.product_id}`);
        continue;
      }

      // 🔎 Split quantities
      const splits = [];
      let remaining = item.quantity;
      while (remaining > 0) {
        const qty = Math.min(truckloadCapacity, remaining);
        splits.push(qty);
        remaining -= qty;
      }
      console.log(`Split quantities for ${item.product_id} – ${item.title}:`, splits);

      // ✅ Create child orders
      for (let i = 0; i < splits.length; i++) {
        const payload = {
          order: {
            line_items: [
              {
                variant_id: item.variant_id,
                quantity: splits[i],
                location_id: order.location_id,
              },
            ],
            customer: order.customer,
            billing_address: order.billing_address,
            email: order.email,
            note: order.note,
            tags: [
              "Split-Child",
              `Truckload ${i + 1}`,
              `Parent-#${order.order_number}`,
              `Product-${item.product_id}`,
              `LineItem-${item.id}`,
            ],
            purchase_order_number: order.purchase_order_number,
            metafields: [
              ...(order.pickup_date ? [{
                namespace: "custom",
                key: "pickup_date",
                type: "single_line_text_field",
                value: order.pickup_date,
              }] : []),
              ...(order.project_name ? [{
                namespace: "custom",
                key: "project_name",
                type: "single_line_text_field",
                value: order.project_name,
              }] : []),
            ],
            fulfillment_status: "unfulfilled",
          },
        };

        console.log(`🧾 Creating child order payload:`, JSON.stringify(payload, null, 2));

        const resp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ACCESS_TOKEN,
          },
          body: JSON.stringify(payload),
        });

        const childData = await resp.json();
        console.log(`✅ Created child order ${childData.order?.id} with tags: ${payload.order.tags.join(", ")}`);

        childOrdersCreated = true;
      }
    }

    // ✅ Tag parent after successful split
    if (childOrdersCreated) {
      await tagParentOrder(order.id, `${order.tags},Split-Processed`);
      console.log(`🏷️ Parent ${order.id} tagged as Split-Processed`);
    }
  } catch (err) {
    console.error("❌ Error in runSplitLogic:", err);
  }
}

// =========================
// Section 4: Health Check + Startup
// =========================

// ✅ Health check route
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// ✅ Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
