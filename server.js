// server.js — updated with Diff Entry #3

import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(bodyParser.json());

const normalizeDate = (raw) => {
  if (!raw) return null;
  const date = new Date(raw);
  return isNaN(date.getTime()) ? null : date.toISOString().split("T")[0];
};

app.post("/webhook", async (req, res) => {
  const order = req.body;
  console.log("🚚 Received order:", order);

  // ✅ Diff Entry #3: Global pickup date fallback from cart attributes
  const pickupDateRaw = Array.isArray(order.note_attributes)
    ? order.note_attributes.find(attr => attr.name === "pickup_date")?.value
    : null;

  const normalizedPickupDate = normalizeDate(pickupDateRaw);
  console.log("📅 Normalized pickup date:", normalizedPickupDate);

  const projectName = order.note_attributes?.find(attr => attr.name === "project_name")?.value || null;

  const truckloads = {};
  for (const item of order.line_items) {
    const truckload = item.properties?.find(p => p.name === "Truckload")?.value || "Unassigned";
    if (!truckloads[truckload]) truckloads[truckload] = [];
    truckloads[truckload].push(item);
  }

  for (const [truckload, items] of Object.entries(truckloads)) {
    const childOrderPayload = {
      order: {
        line_items: items.map((item) => ({
          variant_id: item.variant_id,
          quantity: item.quantity,
          properties: item.properties,
        })),
        tags: [`Split:${truckload}`],
        metafields: [
          {
            namespace: "custom",
            key: "pickup_date",
            type: "date",
            value: normalizedPickupDate,
          },
          ...(projectName
            ? [
                {
                  namespace: "custom",
                  key: "project_name",
                  type: "single_line_text_field",
                  value: projectName,
                },
              ]
            : []),
        ],
      },
    };

    try {
      const response = await axios.post(
        `https://${process.env.SHOPIFY_STORE}/admin/api/2023-10/orders.json`,
        childOrderPayload,
        {
          headers: {
            "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
            "Content-Type": "application/json",
          },
        }
      );
      console.log(`✅ Created child order for truckload ${truckload}:`, response.data.order.id);
    } catch (error) {
      console.error(`❌ Failed to create child order for truckload ${truckload}:`, error.response?.data || error.message);
    }
  }

  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server listening");
});
