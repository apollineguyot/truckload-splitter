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

app.get("/", (_req, res) => {
  res.status(200).send("OK");
});
// Helper: fetch parent pickup location
async function getParentPickupLocation(orderId) {
  const resp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${orderId}/fulfillment_orders.json`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
  });

  const data = await resp.json();
  const assignedLocationId = data?.fulfillment_orders?.[0]?.assigned_location_id || null;
  console.log(`📍 Parent assigned location: ${assignedLocationId}`);
  return assignedLocationId;
}

// Helper: copy parent pickup date
function getParentPickupDate(order) {
  const pickupDateFromNotes = Array.isArray(order.note_attributes)
    ? order.note_attributes.find(attr => attr.name === "Pickup Date")?.value || null
    : null;
  const pickupDateFallback = Array.isArray(order.line_items) && Array.isArray(order.line_items[0]?.properties)
    ? order.line_items[0].properties.find(p => p.name === "Pickup Date")?.value || null
    : null;
  return normalizeDate(pickupDateFromNotes || pickupDateFallback);
}

app.post("/webhooks/orders/create", async (req, res) => {
  try {
    const order = req.body;
    console.log("🚚 Received order:", JSON.stringify(order, null, 2));

    if ((order.tags || "").includes("Split-Processed") || (order.tags || "").includes("Truckload-Ready")) {
      console.log("↩️ Order already processed. Skipping split.");
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

    let childOrdersCreated = false; // track whether any child orders were made

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

        console.log(`🔎 Child order ${i + 1} — Project Name: ${projectName || "null"}, Pickup Date raw: ${pickupDateRaw || "null"}, normalized: ${pickupDateNormalized || "null"}`);

      const newOrderPayload = {
  order: {
    line_items: [{
      variant_id: item.variant_id,
      quantity: qty,
      location_id: parentLocationId,
    }],
    customer: order.customer ?? undefined,
    shipping_address: order.shipping_address ?? undefined,
    billing_address: order.billing_address ?? undefined,
    email: order.email ?? undefined,
note: order.note || null,,
+   note: order.note || null,
    tags: [`Split-Child`, `Truckload ${i + 1}`, `Parent-${order.name}`],
    purchase_order_number: projectName,
    metafields: [],
    fulfillment_status: "unfulfilled",
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

        childOrdersCreated = true; // ✅ mark that at least one child was created

        // Attach project name metafield
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

        // Attach pickup date metafield (child inherits parent if none provided)
        const effectivePickupDate = pickupDateNormalized || parentPickupDate;
        if (effectivePickupDate) {
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
                value: effectivePickupDate,
                owner_id: createdOrder.order.id,
                owner_resource: "order",
              },
            }),
          });
        }
      }
    }

    // ✅ Tag parent order depending on split outcome
    let newTags;
    if (childOrdersCreated) {
      newTags = order.tags ? `${order.tags}, Split-Processed` : "Split-Processed";
    } else {
      newTags = order.tags ? `${order.tags}, Truckload-Ready` : "Truckload-Ready";
    }

    await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}.json`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ACCESS_TOKEN,
      },
      body: JSON.stringify({ order: { id: order.id, tags: newTags } }),
    });

    // ✅ Parent project name metafield
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

    res.status(200).send("Split processed");
  } catch (err) {
    console.error("❌ Error processing split:", err);
    res.status(500).send("Error");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

