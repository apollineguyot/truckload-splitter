import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// Standalone date normalizer
function normalizeDate(input) {
  if (!input || typeof input !== "string") return null;
  const s = input.trim();

  // Case 1: Already YYYY-MM-DD
  const yyyyMmDd = /^(\d{4})-(\d{2})-(\d{2})$/;
  if (s.match(yyyyMmDd)) return s;

  // Case 2: ISO timestamp -> take date part
  const isoDatePart = s.split("T")[0];
  if (isoDatePart.match(yyyyMmDd)) return isoDatePart;

  // Case 3: MM/DD/YYYY
  const mmDdYy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  const matchUs = s.match(mmDdYy);
  if (matchUs) {
    const mm = matchUs[1].padStart(2, "0");
    const dd = matchUs[2].padStart(2, "0");
    const yyyy = matchUs[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  // Case 4: YYYY/MM/DD
  const ySlash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
  const matchYSlash = s.match(ySlash);
  if (matchYSlash) {
    const yyyy = matchYSlash[1];
    const mm = matchYSlash[2].padStart(2, "0");
    const dd = matchYSlash[3].padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

app.post("/webhook", async (req, res) => {
  const order = req.body;
  console.log("📦 Received order:", order);

  const truckloadLineItems = order.line_items.filter(item =>
    item.properties?.some(prop => prop.name === "truckload")
  );

  for (const item of truckloadLineItems) {
    try {
      const truckloadProp = item.properties.find(prop => prop.name === "truckload");
      const truckload = truckloadProp?.value || "Unassigned";

      const projectNameProp = item.properties.find(prop => prop.name === "project_name");
      const projectName = projectNameProp?.value || "Unassigned";

      const pickupDateProp = item.properties.find(prop => prop.name === "pickup_date");
      const pickupDateRawFromLineItem = pickupDateProp?.value;

      const pickupDateRawFromCart = Array.isArray(order.note_attributes)
        ? order.note_attributes.find(attr => attr.name === "pickup_date")?.value
        : null;

      console.log("🧾 Raw pickup date from line item:", pickupDateRawFromLineItem);
      console.log("🛒 Raw pickup date from cart attribute:", pickupDateRawFromCart);

      const pickupDateRaw = pickupDateRawFromLineItem || pickupDateRawFromCart;
      const normalizedPickupDate = normalizeDate(pickupDateRaw);

      console.log("📅 Normalized pickup date:", normalizedPickupDate);

      // Build metafields with guardrails
      const metafields = [
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
        }
      ];

      if (normalizedPickupDate) {
        metafields.push({
          namespace: "custom",
          key: "pickup_date",
          value: normalizedPickupDate,
          type: "single_line_text_field"
        });
      } else {
        console.warn("⚠️ Skipping pickup_date metafield; no valid date available");
      }

      // Shopify requires payload wrapped in { order: { ... } }
      const childOrder = {
        order: {
          line_items: [item],
          metafields
        }
      };

      // Send to Shopify Admin API
      await axios.post(
        "https://sl5-ait-worldwide.myshopify.com/admin/api/2023-10/orders.json",
        childOrder,
        {
          headers: {
            "X-Shopify-Access-Token": process.env.SHOPIFY_API_KEY,
            "Content-Type": "application/json"
          }
        }
      );

      console.log(`✅ Created child order for truckload ${truckload}`);
    } catch (err) {
      console.error(
        `❌ Failed to create child order for truckload ${item.truckload}:`,
        err.response?.data || err.message
      );
    }
  }

  res.sendStatus(200);
});

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});

