// server.js — Shopify Truckload Splitter (ES Module)

import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHOP = process.env.SHOP;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = process.env.API_VERSION || "2023-10";

if (!SHOP || !ACCESS_TOKEN) {
  console.error("❌ Missing required env vars: SHOP or SHOPIFY_ACCESS_TOKEN");
}

const shopBaseUrl = `https://${SHOP}`;

// 🔧 Normalize date to YYYY-MM-DD
function normalizeDate(input) {
  if (!input || typeof input !== "string") return null;
  const parsed = new Date(input);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

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

    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    if (lineItems.length === 0) {
      console.log("⚠️ No line items found on order");
      return res.status(200).send("No line items");
    }

    for (const item of lineItems) {
      if (!item?.product_id || !item?.variant_id) {
        console.log("⚠️ Invalid line item:", item);
        continue;
      }

      // Fetch product metafields for truckload capacity
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

      let metaData;
      try {
        metaData = await metaResp.json();
      } catch (err) {
        console.error("❌ Failed to parse metafield JSON:", err);
        continue;
      }

      const metafields = Array.isArray(metaData?.metafields) ? metaData.metafields : [];
      const truckloadMeta = metafields.find(
        (m) =>
          m.key === "truckload_capacity" &&
          (m.namespace === "custom" || m.namespace === "logistics")
      );

      const truckloadCapacity = parseInt(truckloadMeta?.value ?? "0", 10);
      console.log("📦 Truckload capacity:", truckloadCapacity);
      console.log("📦 Item quantity:", item.quantity);

      if (!Number.isFinite(truckloadCapacity) || truckloadCapacity <= 0) {
        console.log("⚠️ No valid truckload capacity found for product", item.product_id);
        continue;
      }

      if (item.quantity <= truckloadCapacity) {
        console.log("🚫 No split needed for this line item");
        continue;
      }

      // Determine split quantities
      const fullLoads = Math.floor(item.quantity / truckloadCapacity);
      const remainder = item.quantity % truckloadCapacity;
      const splitQuantities = Array(fullLoads).fill(truckloadCapacity);
      if (remainder > 0) splitQuantities.push(remainder);

      console.log("🔀 Split quantities:", splitQuantities);

      for (let i = 0; i < splitQuantities.length; i++) {
        const qty = splitQuantities[i];

        // Line item properties source
        const projectName = Array.isArray(item.properties)
          ? item.properties.find(p => p.name === "Project Name")?.value || null
          : null;

        const pickupDateRaw = Array.isArray(item.properties)
          ? item.properties.find(p => p.name === "Pickup Date")?.value || null
          : null;

        const newOrderPayload = {
          order: {
            line_items: [
              {
                variant_id: item.variant_id,
                quantity: qty,
              },
            ],
            customer: order.customer && typeof order.customer === "object"
              ? {
                  id: order.customer.id,
                  email: order.customer.email,
                  first_name: order.customer.first_name,
                  last_name: order.customer.last_name,
                  phone: order.customer.phone,
                }
              : undefined,
            shipping_address: order.shipping_address && typeof order.shipping_address === "object"
              ? order.shipping_address
              : undefined,
            billing_address: order.billing_address && typeof order.billing_address === "object"
              ? order.billing_address
              : undefined,
            email: typeof order.email === "string" ? order.email : undefined,
            note: `Split from original order #${order.name} (ID: ${order.id})`,
            tags: [`Split-Child`, `Truckload ${i + 1}`, `Parent-${order.name}`],

            // Native PO field for quick visibility
            purchase_order_number: projectName,

            // Metafields inline on create: Pickup Date
            metafields: [
              {
                namespace: "custom",
                key: "pickup_date",
                type: "date",
                value: normalizeDate(pickupDateRaw)
              }
            ]
          }
        };

        try {
          const createResp = await fetch(
            `${shopBaseUrl}/admin/api/${API_VERSION}/orders.json`,
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
          if (!createResp.ok) {
            console.error(
              `❌ Failed to create split order ${i + 1}:`,
              createResp.status,
              JSON.stringify(createdOrder, null, 2)
            );
            continue;
          }

          console.log(`✅ Created split order ${i + 1}:`, JSON.stringify(createdOrder, null, 2));

          // Add custom.project_name metafield using global endpoint with ownership context
          if (projectName) {
            try {
              const mfResp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/metafields.json`, {
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
                    owner_id: createdOrder.order.id,
                    owner_resource: "order",
                  }
                })
              });
              const mfData = await mfResp.json();
              console.log("📌 custom.project_name metafield response (child):", JSON.stringify(mfData, null, 2));
            } catch (err) {
              console.error("❌ Failed to add custom.project_name metafield:", err);
            }
          }

        } catch (err) {
          console.error(`❌ Error creating split order ${i + 1}:`, err);
          continue;
        }
      }
    }

    // Tag original order as processed and write parent metafield
    try {
      const existingTags = (order.tags || "").trim();
      const newTags = existingTags ? `${existingTags}, Split-Processed` : "Split-Processed";

      const tagResp = await fetch(
        `${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}.json`,
        {
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
        }
      );

      const tagData = await tagResp.json();
      if (!tagResp.ok) {
        console.error("❌ Failed to tag original order:", tagResp.status, JSON.stringify(tagData, null, 2));
      } else {
        console.log("🔵 Original order tagged as Split-Processed");

        // Parent order Project Name from note_attributes or fallback to line item properties
        const projectNameFromNotes = Array.isArray(order.note_attributes)
          ? order.note_attributes.find(attr => attr.name === "Project Name")?.value || null
          : null;

        const projectNameFallback =
          Array.isArray(order.line_items) && Array.isArray(order.line_items[0]?.properties)
            ? order.line_items[0].properties.find(p => p.name === "Project Name")?.value || null
            : null;

        const parentProjectName = projectNameFromNotes || projectNameFallback;

        if (parentProjectName) {
          try {
            const mfResp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/metafields.json`, {
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
                  value: parentProjectName,
                  owner_id: order.id,
                  owner_resource: "order",
                },
              }),
            });
            const mfData = await mfResp.json();
            console.log("📌 custom.project_name metafield response (parent):", JSON.stringify(mfData, null, 2));
          } catch (err) {
            console.error("❌ Failed to add custom.project_name metafield to parent:", err);
          }
        }
      }
    } catch (err) {
      console.error("❌ Error tagging original order:", err);
    }

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
