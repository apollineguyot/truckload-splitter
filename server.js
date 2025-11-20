const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.post("/webhooks/orders/create", async (req, res) => {
  try {
    const order = req.body;
    console.log("🚚 Received order:", JSON.stringify(order, null, 2));

    // Prevent reprocessing
    if ((order.tags || "").includes("Split-Processed")) {
      return res.status(200).send("Already processed");
    }

    const lineItem = order.line_items[0];
    console.log("🧩 Line item:", JSON.stringify(lineItem, null, 2));

    // Fetch product metafields
    const response = await fetch(`https://${process.env.SHOP}/admin/api/2023-10/products/${lineItem.product_id}/metafields.json`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
      },
    });

    const data = await response.json();
    console.log("📑 Product metafields:", JSON.stringify(data, null, 2));

    const truckloadMeta = data.metafields.find(
      (m) => m.namespace === "custom" && m.key === "truckload_capacity"
    );

    const truckloadCapacity = parseInt(truckloadMeta?.value || "0", 10);
    console.log("📦 Truckload capacity:", truckloadCapacity);

    if (!truckloadCapacity || truckloadCapacity <= 0) {
      console.log("⚠️ Invalid or missing truckload capacity");
      return res.status(200).send("No truckload capacity found");
    }

    // Calculate split quantities
    let remaining = lineItem.quantity;
    const splitQuantities = [];
    while (remaining > 0) {
      const split = Math.min(truckloadCapacity, remaining);
      splitQuantities.push(split);
      remaining -= split;
    }
    console.log("🔀 Split quantities:", splitQuantities);

    // Create new orders
    for (let i = 0; i < splitQuantities.length; i++) {
      const quantity = splitQuantities[i];
      const newOrderPayload = {
        order: {
          line_items: [
            {
              variant_id: lineItem.variant_id,
              quantity: quantity,
            },
          ],
          tags: [`Truckload ${i + 1}`],
        },
      };

      const createResponse = await fetch(`https://${process.env.SHOP}/admin/api/2023-10/orders.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
        },
        body: JSON.stringify(newOrderPayload),
      });

      const createdOrder = await createResponse.json();
      console.log(`✅ Created split order ${i + 1}:`, JSON.stringify(createdOrder, null, 2));
    }

    // Tag the original order
    await fetch(`https://${process.env.SHOP}/admin/api/2023-10/orders/${order.id}.json`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
      },
      body: JSON.stringify({
        order: {
          id: order.id,
          tags: `${order.tags}, Split-Processed`,
        },
      }),
    });

    console.log("🔵 Original order tagged as Split-Processed");
    res.status(200).send("Split processed");
  } catch (err) {
    console.error("❌ Error processing split:", err);
    res.status(500).send("Error");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
