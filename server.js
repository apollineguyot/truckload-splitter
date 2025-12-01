// server.js

const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");

const app = express();
app.use(bodyParser.json());

const shopBaseUrl = `https://${process.env.SHOPIFY_SHOP_DOMAIN}`;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = "2025-01";

// Helper: fetch metafield value by namespace + key
async function getMetafield(orderId, namespace, key) {
  const response = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${orderId}/metafields.json`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
  });
  const data = await response.json();
  const mf = data.metafields.find(m => m.namespace === namespace && m.key === key);
  return mf ? mf.value : null;
}

// Webhook endpoint
app.post("/webhooks/orders/create", async (req, res) => {
  try {
    const order = req.body;
    console.log("🟠 Received order:", { id: order.id, name: order.name });

    // ✅ Read pickup date and truckload capacity from metafields
    const pickupDateAttr = await getMetafield(order.id, "custom", "pickup_date");
    const truckloadCapacity = await getMetafield(order.id, "custom", "truckload_capacity");
    console.log("📦 Truckload capacity:", truckloadCapacity);

    const totalItems = order.line_items.length;
    const capacity = truckloadCapacity ? parseInt(truckloadCapacity) : null;

    // ✅ Split if capacity is defined and exceeded
    if (capacity && totalItems > capacity && order.splits?.length > 0) {
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
              ` | Truckload Capacity: ${truckloadCapacity}`,
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

        // ✅ Add pickup date to child order
        if (pickupDateAttr) {
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
          console.log("📌 pickup_date added to child order");
        }
      }

      // ✅ Tag parent as Skip-WMS
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

      // ✅ Add pickup date to parent
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

      return res.status(200).send("Split orders created, parent tagged, pickup date propagated.");
    }

    // ✅ Otherwise: tag as Truckload-Ready
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

    // ✅ Add pickup date to unsplit order
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

    res.status(200).send("Order processed: split or tagged based on truckload capacity.");
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).send("Error processing webhook");
  }
});

// ✅ Render-compatible port binding
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
