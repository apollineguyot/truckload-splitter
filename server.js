// server.js

const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");

const app = express();
app.use(bodyParser.json());

const shopBaseUrl = `https://${process.env.SHOPIFY_SHOP_DOMAIN}`;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = "2025-01"; // adjust to your current API version

// Helper: fetch metafield value
async function getMetafield(orderId, key) {
  const response = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${orderId}/metafields.json`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
  });
  const data = await response.json();
  const mf = data.metafields.find(m => m.key === key);
  return mf ? mf.value : null;
}

// Webhook endpoint
app.post("/webhooks/orders/create", async (req, res) => {
  try {
    const order = req.body;
    console.log("🚚 Received order:", { id: order.id, name: order.name });

    // ✅ Capture pickup date metafield
    const pickupDateAttr = await getMetafield(order.id, "pickup_date");

    // ✅ Capture truckload capacity metafield
    const truckloadCapacity = await getMetafield(order.id, "truckload_capacity");
    console.log("📦 Truckload capacity:", truckloadCapacity);

    // Example: unsplit order tagging (capacity not exceeded)
    if (!truckloadCapacity || parseInt(truckloadCapacity) >= order.line_items.length) {
      await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}.json`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ACCESS_TOKEN,
        },
        body: JSON.stringify({
          order: {
            id: order.id,
            tags: `${order.tags}, Truckload-Ready`,
          },
        }),
      });

      // ✅ Ensure pickup date metafield exists
      if (pickupDateAttr) {
        await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}/metafields.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ACCESS_TOKEN,
          },
          body: JSON.stringify({
            metafield: {
              namespace: "custom",
              key: "pickup_date",
              type: "date",
              value: pickupDateAttr,
            },
          }),
        });
      }

      return res.status(200).send("Unsplit order tagged and pickup date saved.");
    }

    // Example: split order logic when capacity exceeded
    if (truckloadCapacity && parseInt(truckloadCapacity) < order.line_items.length) {
      for (const split of order.splits) {
        const newOrderPayload = {
          order: {
            line_items: split.line_items,
            customer: order.customer,
            shipping_address: order.shipping_address,
            billing_address: order.billing_address,
            tags: "split-child",
            note:
              `Split from original order #${order.name} (ID: ${order.id})` +
              (pickupDateAttr ? ` | Pickup Date: ${pickupDateAttr}` : "") +
              (truckloadCapacity ? ` | Truckload Capacity: ${truckloadCapacity}` : ""),
          },
        };

        const response = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ACCESS_TOKEN,
          },
          body: JSON.stringify(newOrderPayload),
        });

        const createdOrder = await response.json();

        // ✅ Add pickup date metafield to child order
        if (pickupDateAttr) {
          try {
            await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${createdOrder.order.id}/metafields.json`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": ACCESS_TOKEN,
              },
              body: JSON.stringify({
                metafield: {
                  namespace: "custom",
                  key: "pickup_date",
                  type: "date",
                  value: pickupDateAttr,
                },
              }),
            });
            console.log("📌 custom.pickup_date metafield added to child order");
          } catch (err) {
            console.error("❌ Failed to add custom.pickup_date metafield:", err);
          }
        }
      }

      // Tag parent as Skip-WMS
      await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}.json`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ACCESS_TOKEN,
        },
        body: JSON.stringify({
          order: {
            id: order.id,
            tags: `${order.tags}, Skip-WMS`,
          },
        }),
      });
    }

    res.status(200).send("Split orders created, parent tagged, pickup date and truckload capacity propagated.");
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).send("Error processing webhook");
  }
});

// ✅ FIXED: Render-compatible port binding
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
