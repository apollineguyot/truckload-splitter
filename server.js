// server.js

const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");

const app = express();
app.use(bodyParser.json());

const shopBaseUrl = `https://${process.env.SHOPIFY_SHOP_DOMAIN}`;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = "2025-01"; // adjust to your current API version

// Webhook endpoint
app.post("/webhook/orders/create", async (req, res) => {
  try {
    const order = req.body;

    // ✅ Capture pickup date attribute
    const pickupDateAttr = order.attributes?.pickup_date || null;

    // Example: unsplit order tagging
    if (!order.split_required) {
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

      // ✅ Add pickup date metafield to parent
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

    // Example: split order logic
    for (const split of order.splits) {
      const newOrderPayload = {
        order: {
          line_items: split.line_items,
          customer: order.customer,
          shipping_address: order.shipping_address,
          billing_address: order.billing_address,
          tags: "split-child",
          // ✅ Add pickup date into note
          note:
            `Split from original order #${order.name} (ID: ${order.id})` +
            (pickupDateAttr ? ` | Pickup Date: ${pickupDateAttr}` : ""),
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

    // ✅ Add pickup date metafield to parent as well
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

    res.status(200).send("Split orders created, parent tagged, pickup date propagated.");
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).send("Error processing webhook");
  }
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
