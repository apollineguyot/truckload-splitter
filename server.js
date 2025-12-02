import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

function normalizeDate(input) {
  if (!input) return null;
  const date = new Date(input);
  if (isNaN(date)) return null;
  return date.toISOString().split("T")[0]; // YYYY-MM-DD
}

app.post("/webhook", async (req, res) => {
  const order = req.body;
  console.log("🚚 Received order:", order);

  const truckloadLineItems = order.line_items.filter(item =>
    item.properties?.some(prop => prop.name === "truckload")
  );

  for (const item of truckloadLineItems) {
    const truckloadProp = item.properties.find(prop => prop.name === "truckload");
    const truckload = truckloadProp?.value || "Unassigned";

    const projectNameProp = item.properties.find(prop => prop.name === "project_name");
    const projectName = projectNameProp?.value || "Unassigned";

    const pickupDateProp = item.properties.find(prop => prop.name === "pickup_date");
    const pickupDateRawFromLineItem = pickupDateProp?.value;

    const pickupDateRawFromCart = Array.isArray(order.note_attributes)
      ? order.note_attributes.find(attr => attr.name === "pickup_date")?.value
      : null;

    console.log("📦 Raw pickup date from line item:", pickupDateRawFromLineItem);
    console.log("📦 Raw pickup date from cart attribute:", pickupDateRawFromCart);

    const pickupDateRaw = pickupDateRawFromLineItem || pickupDateRawFromCart;
    const normalizedPickupDate = normalizeDate(pickupDateRaw);
    console.log("📅 Normalized pickup date:", normalizedPickupDate);

    const childOrder = {
      line_items: [item],
      metafields: [
        {
          namespace: "custom",
          key: "truckload",
          value: truckload,
          type: "single_line_text_field"
        },
        {
          namespace: "custom",
          key: "project_name",
          value: projectName,
          type: "single_line_text_field"
        },
        {
          namespace: "custom",
          key: "pickup_date",
          value: normalizedPickupDate,
          type: "date"
        }
      ]
    };

    try {
      const response = await axios.post(
        `https://${process.env.SHOPIFY_STORE}/admin/api/2023-10/orders.json`,
        { order: childOrder },
        {
          headers: {
            "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
            "Content-Type": "application/json"
          }
        }
      );
      console.log(`✅ Created child order for truckload ${truckload}:`, response.data);
    } catch (error) {
      console.error(`❌ Failed to create child order for truckload ${truckload}:`, error.response?.data || error.message);
    }
  }

  res.status(200).send("Webhook processed");
});

app.listen(3000, () => {
  console.log("🚀 Server listening on port 3000");
});
