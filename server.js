const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");

const app = express();
app.use(bodyParser.json());

const shopBaseUrl = `https://${process.env.SHOPIFY_SHOP_DOMAIN}`;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = "2025-01";

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

app.post("/webhooks/orders/create", async (req, res) => {
  try {
    const order = req.body;
    console.log("📥 Received order:", { id: order.id, name: order.name });

    // Extract project name from note_attributes
    const projectName = order.note_attributes?.find(attr => attr.name === "Project Name")?.value;
    console.log("📝 Project Name from order:", projectName);

    let capacity = null;
    for (const item of order.line_items) {
      const productCapacity = await getProductCapacity(item.product_id);
      if (productCapacity) {
        capacity = productCapacity;
        break;
      }
    }

    const totalQuantity = order.line_items.reduce((sum, item) => sum + item.quantity, 0);
    console.log("📦 Truckload capacity (from product):", capacity);
    console.log("🔢 Total quantity:", totalQuantity);

    if (capacity && totalQuantity > capacity) {
      console.log("🍉 Capacity exceeded — splitting order");

      const flattenedItems = [];
      for (const item of order.line_items) {
        for (let i = 0; i < item.quantity; i++) {
          flattenedItems.push({ ...item, quantity: 1 });
        }
      }

      const splits = [];
      for (let i = 0; i < flattenedItems.length; i += capacity) {
        const chunk = flattenedItems.slice(i, i + capacity);
        const grouped = [];

        for (const unit of chunk) {
          const existing = grouped.find(g => g.variant_id === unit.variant_id);
          if (existing) {
            existing.quantity += 1;
          } else {
            grouped.push({ ...unit });
          }
        }

        splits.push({ line_items: grouped });
      }

      for (const split of splits) {
        console.log(`✂️ Creating child order with ${split.line_items.reduce((sum, li) => sum + li.quantity, 0)} items`);

        try {
          console.log("📫 Shipping address:", JSON.stringify(order.shipping_address, null, 2));

          const response = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders.json`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": ACCESS_TOKEN,
            },
            body: JSON.stringify({
              order: {
                line_items: split.line_items,
                email: order.email,
                customer: order.customer ? { id: order.customer.id } : undefined,
                shipping_address: order.shipping_address && typeof order.shipping_address === "object"
                  ? order.shipping_address
                  : undefined,
                billing_address: order.billing_address && typeof order.billing_address === "object"
                  ? order.billing_address
                  : undefined,
                tags: "split-child",
                note: `Split from original order #${order.name} (ID: ${order.id}) | Truckload Capacity: ${capacity}`,
                financial_status: "pending",
              },
            }),
          });

          const createdOrder = await response.json();

          if (!response.ok || !createdOrder.order?.id) {
            console.error("❌ Failed to create child order:", JSON.stringify(createdOrder, null, 2));
          } else {
            console.log("🟢 Child order created:", JSON.stringify(createdOrder, null, 2));

            // ✅ Add project name metafield to child order
            if (projectName) {
              await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${createdOrder.order.id}/metafields.json`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Shopify-Access-Token": ACCESS_TOKEN,
                },
                body: JSON.stringify({
                  metafield: {
                    namespace: "custom",
                    key: "project_name",
                    type: "single_line_text_field",
                    value: projectName,
                  },
                }),
              });
              console.log(`📝 Project name metafield set for child order ${createdOrder.order.id}: ${projectName}`);
            }
          }
        } catch (err) {
          console.error("❌ Error creating child order:", err.message);
        }
      }

      try {
        const parentResp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}.json`, {
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

        const parentData = await parentResp.json();

        if (!parentResp.ok) {
          console.error("❌ Failed to tag parent order:", JSON.stringify(parentData, null, 2));
        } else {
          console.log("🔵 Parent order tagged:", JSON.stringify(parentData, null, 2));

          // ✅ Add project name metafield to parent order
          if (projectName) {
            await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}/metafields.json`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": ACCESS_TOKEN,
              },
              body: JSON.stringify({
                metafield: {
                  namespace: "custom",
                  key: "project_name",
                  type: "single_line_text_field",
                  value: projectName,
                },
              }),
            });
            console.log(`📝 Project name metafield set for parent order ${order.id}: ${projectName}`);
          }
        }
      } catch (err) {
        console.error("❌ Error tagging parent order:", err.message);
      }

      return res.status(200).send("Split orders created, parent tagged, project name applied.");
    }

    console.log("🟣 Capacity not exceeded — tagging as TruckLoad-Ready");

    try {
      const parentResp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}.json`, {
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

      const parentData = await parentResp.json();

      if (!parentResp.ok) {
        console.error("❌ Failed to tag parent order:", JSON.stringify(parentData, null, 2));
      } else {
        console.log("🔵 Parent order tagged:", JSON.stringify(parentData, null, 2));

        // ✅ Add project name metafield to parent order (even if not split)
        if (projectName) {
          await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}/metafields.json`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": ACCESS_TOKEN,
            },
            body: JSON.stringify({
              metafield: {
                namespace: "custom",
                key: "project_name",
                type: "single_line_text_field",
                value: projectName,
              },
            }),
          });
          console.log(`📝 Project name metafield set for parent order ${order.id}: ${projectName}`);
        }
      }
    } catch (err) {
      console.error("❌ Error tagging parent order:", err.message);
    }

    res.status(200).send("Order processed: split/tagged and project name applied.");
  } catch (error) {
    console.error("❌ Webhook error:", error);
    res.status(500).send("Error processing webhook");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
