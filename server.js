// server.js

const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");

const app = express();
app.use(bodyParser.json());

const shopBaseUrl = `https://${process.env.SHOPIFY_SHOP_DOMAIN}`;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = "2025-01";

// Helper: fetch order metafield
async function getOrderMetafield(orderId, namespace, key) {
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

// Helper: fetch product metafield
async function getProductCapacity(productId) {
  const response = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/products/${productId}/metafields.json`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
  });
  const data = await response.json();
  const mf = data.metafields.find(m => m.namespace === "custom" && m.key === "truckload_capacity");
  return mf ? parseInt(mf.value) : null;
}

// Webhook endpoint
app.post("/webhooks/orders/create", async (req, res) => {
  try {
    const order = req.body;
    console.log("🟠 Received order:", { id: order.id, name: order.name });

    // ✅ Read pickup date from order metafields
    const pickupDateAttr = await getOrderMetafield(order.id, "custom", "pickup_date");

    // ✅ Determine truckload capacity from products
    let capacity = null;
    for (const item of order.line_items) {
      const productCapacity = await getProductCapacity(item.product_id);
      if (productCapacity) {
        capacity = productCapacity; // assume all items share same capacity
        break;
      }
    }
    console.log("📦 Truckload capacity (from product):", capacity);

    const totalItems = order.line_items.length;

    // ✅ Split if capacity is defined and exceeded
    if (capacity && totalItems > capacity) {
      // naive split: chunk line_items into groups of `capacity`
      const splits = [];
      for (let i = 0; i < totalItems; i += capacity) {
        splits.push({
          line_items: order.line_items.slice(i, i + capacity),
        });
      }

      for (const split of splits) {
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
              ` | Truckload Capacity: ${capacity}`,
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

