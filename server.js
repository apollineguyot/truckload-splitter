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

app.post("/webhook", async (req, res) => {
  try {
    const order = req.body;

    // 🚫 Guard: Skip if parent already processed
    if ((order.tags || "").includes("Split-Processed")) {
      console.log("↩️ Parent already marked as processed. Skipping split.");
      return res.status(200).send("Already processed");
    }

    console.log(`🔔 Webhook fired for order ${order.id} at ${new Date().toISOString()}`);

    // 🚫 Skip child orders immediately
    if ((order.tags || "").includes("Split-Child")) {
      console.log("↩️ Child order detected. Skipping split.");
      return res.status(200).send("Child order skipped");
    }

    // ✅ Double‑check parent order tags from Shopify before splitting
    const latestParent = await getParentOrder(order.id);
    if ((latestParent.tags || "").includes("Split-Processed") || (latestParent.tags || "").includes("Truckload-Ready")) {
      console.log("↩️ Parent already marked as processed. Skipping split.");
      return res.status(200).send("Already processed");
    }

    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    if (lineItems.length === 0) {
      console.log("⚠️ No line items found on order");
      return res.status(200).send("No line items");
    }

    // ✅ Fetch parent pickup context
    const parentLocationId = await getParentPickupLocation(order.id);
    const parentPickupDate = getParentPickupDate(order);

    let childOrdersCreated = false;
// =========================
// Section 3: Split Logic Loop
// =========================

    // ✅ Outer loop over line items
    for (const item of lineItems) {
      if (!item?.product_id || !item?.variant_id) continue;

      // 🔎 Fetch truckload capacity metafield for this product
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

      // 🔎 Split quantities based on truckload capacity
      const splits = [];
      let remaining = item.quantity;
      while (remaining > 0) {
        const qty = Math.min(truckloadCapacity, remaining);
        splits.push(qty);
        remaining -= qty;
      }
      console.log(`Split quantities for ${item.product_id} – ${item.title}:`, splits);

      // ✅ Create child orders for each split
      for (let i = 0; i < splits.length; i++) {
        const payload = {
          order: {
            line_items: [
              {
                variant_id: item.variant_id,
                quantity: splits[i],
                location_id: parentLocationId,
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
              // ✅ Attach pickup date and project name if available
              ...(parentPickupDate ? [{
                namespace: "custom",
                key: "pickup_date",
                type: "single_line_text_field",
                value: parentPickupDate,
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

    return res.status(200).send("Split complete");
  } catch (err) {
    console.error("❌ Error in webhook handler:", err);
    return res.status(500).send("Internal error");
  }
});
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
