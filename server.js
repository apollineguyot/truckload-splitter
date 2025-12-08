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

// ✅ Hardened date normalization
function normalizeDate(input) {
  if (!input || typeof input !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

// 📅 Helper to reschedule fulfillAt
async function rescheduleFulfillment(orderId, pickupDate) {
  try {
    const graphqlEndpoint = `${shopBaseUrl}/admin/api/${API_VERSION}/graphql.json`;

    // Step 1: Get fulfillment order ID
    const query = `
      query {
        order(id: "gid://shopify/Order/${orderId}") {
          fulfillmentOrders(first: 1) {
            edges {
              node { id }
            }
          }
        }
      }
    `;

    const resp = await fetch(graphqlEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ACCESS_TOKEN,
      },
      body: JSON.stringify({ query }),
    });

    const data = await resp.json();
    const fulfillmentOrderId = data?.data?.order?.fulfillmentOrders?.edges?.[0]?.node?.id;
    if (!fulfillmentOrderId) {
      console.error("❌ No fulfillment order found for order", orderId);
      return;
    }

    // Step 2: Reschedule fulfillAt
    const mutation = `
      mutation {
        fulfillmentOrderReschedule(
          id: "${fulfillmentOrderId}",
          fulfillAt: "${pickupDate}T00:00:00Z"
        ) {
          fulfillmentOrder { id fulfillAt }
          userErrors { field message }
        }
      }
    `;

    const rescheduleResp = await fetch(graphqlEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ACCESS_TOKEN,
      },
      body: JSON.stringify({ query: mutation }),
    });

    const rescheduleData = await rescheduleResp.json();
    console.log("📅 Reschedule result:", JSON.stringify(rescheduleData, null, 2));
  } catch (err) {
    console.error("❌ Error rescheduling fulfillAt:", err);
  }
}

app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

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
      if (!item?.product_id || !item?.variant_id) continue;

      const metaResp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/products/${item.product_id}/metafields.json`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ACCESS_TOKEN,
        },
      });

      const metaData = await metaResp.json();
      const truckloadMeta = Array.isArray(metaData?.metafields)
        ? metaData.metafields.find(m => m.key === "truckload_capacity" && ["custom", "logistics"].includes(m.namespace))
        : null;

      const truckloadCapacity = parseInt(truckloadMeta?.value ?? "0", 10);
      if (!Number.isFinite(truckloadCapacity) || truckloadCapacity <= 0 || item.quantity <= truckloadCapacity) continue;

      const fullLoads = Math.floor(item.quantity / truckloadCapacity);
      const remainder = item.quantity % truckloadCapacity;
      const splitQuantities = Array(fullLoads).fill(truckloadCapacity);
      if (remainder > 0) splitQuantities.push(remainder);

      for (let i = 0; i < splitQuantities.length; i++) {
        const qty = splitQuantities[i];
        const projectName = Array.isArray(item.properties)
          ? item.properties.find(p => p.name === "Project Name")?.value || null
          : null;
        const pickupDateRaw = Array.isArray(item.properties)
          ? item.properties.find(p => p.name === "Pickup Date")?.value || null
          : null;
        const pickupDateNormalized = normalizeDate(pickupDateRaw);
        
 // ✅ Debug logging
        console.log(
          `🔎 Child order ${i + 1} — Project Name: ${projectName || "null"}, Pickup Date raw: ${pickupDateRaw || "null"}, normalized: ${pickupDateNormalized || "null"}`
        );
        
        const newOrderPayload = {
          order: {
            line_items: [{ variant_id: item.variant_id, quantity: qty }],
            customer: order.customer ?? undefined,
            shipping_address: order.shipping_address ?? undefined,
            billing_address: order.billing_address ?? undefined,
            email: order.email ?? undefined,
            note: `Split from original order #${order.name} (ID: ${order.id})`,
            tags: [`Split-Child`, `Truckload ${i + 1}`, `Parent-${order.name}`],
            purchase_order_number: projectName,
            metafields: [], // ✅ metafields attached post-creation
          },
        };

        const createResp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ACCESS_TOKEN,
          },
          body: JSON.stringify(newOrderPayload),
        });

        const createdOrder = await createResp.json();
        if (!createResp.ok || !createdOrder.order?.id) continue;

        if (projectName) {
          await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/metafields.json`, {
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
              },
            }),
          });
        }

        if (pickupDateNormalized) {
          await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/metafields.json`, {
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
                value: pickupDateNormalized,
                owner_id: createdOrder.order.id,
                owner_resource: "order",
              },
            }),
          });
          // 📅 Reschedule fulfillAt for child order
await rescheduleFulfillment(createdOrder.order.id, pickupDateNormalized);

        }
      }
    }

    const newTags = order.tags ? `${order.tags}, Split-Processed` : "Split-Processed";
    await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}.json`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ACCESS_TOKEN,
      },
      body: JSON.stringify({ order: { id: order.id, tags: newTags } }),
    });

    const projectNameFromNotes = Array.isArray(order.note_attributes)
      ? order.note_attributes.find(attr => attr.name === "Project Name")?.value || null
      : null;
    const projectNameFallback = Array.isArray(order.line_items) && Array.isArray(order.line_items[0]?.properties)
      ? order.line_items[0].properties.find(p => p.name === "Project Name")?.value || null
      : null;
    const parentProjectName = projectNameFromNotes || projectNameFallback;

    if (parentProjectName) {
      await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/metafields.json`, {
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
    }

    // ✅ Parent pickup date metafield
    const pickupDateFromNotes = Array.isArray(order.note_attributes)
      ? order.note_attributes.find(attr => attr.name === "Pickup Date")?.value || null
      : null;
    const pickupDateFallback = Array.isArray(order.line_items) && Array.isArray(order.line_items[0]?.properties)
      ? order.line_items[0].properties.find(p => p.name === "Pickup Date")?.value || null
      : null;
    const parentPickupDate = normalizeDate(pickupDateFromNotes || pickupDateFallback);

    if (parentPickupDate) {
      await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/metafields.json`, {
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
            value: parentPickupDate,
            owner_id: order.id,
            owner_resource: "order",
          },
        }),
      });
    }
    // 📅 Reschedule fulfillAt for parent order
await rescheduleFulfillment(order.id, parentPickupDate);


    res.status(200).send("Split processed");
  } catch (err) {
    console.error("❌ Error processing split:", err);
    res.status(500).send("Error");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
