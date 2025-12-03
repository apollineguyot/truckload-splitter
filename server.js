import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

// Environment variables (clean + consistent)
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const apiUrl = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json`;

// Utility: normalize pickup date
function normalizeDate(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split("T")[0]; // YYYY-MM-DD
  } catch (err) {
    console.error("❌ Failed to normalize date:", dateStr, err);
    return null;
  }
}

// Health check route
app.get("/", (req, res) => {
  res.send("✅ Splitter service is running");
});

app.post("/webhook", async (req, res) => {
  const order = req.body;
  console.log("📦 Received order:", order.id);

  // Guard: skip child orders
  if (order.tags && order.tags.includes("child_order")) {
    console.log("⏭️ Skipping child order to avoid loop");
    return res.sendStatus(200);
  }

  // Extract pickup date (fallback: line item properties → cart attributes)
  let rawPickupDate =
    order.line_items?.[0]?.properties?.find(p => p.name === "pickup_date")?.value ||
    order.attributes?.find(a => a.name === "pickup_date")?.value;

  console.log("🧾 Raw pickup date from line item:", order.line_items?.[0]?.properties?.find(p => p.name === "pickup_date")?.value);
  console.log("🛒 Raw pickup date from cart attribute:", order.attributes?.find(a => a.name === "pickup_date")?.value);

  const normalizedPickupDate = normalizeDate(rawPickupDate);
  console.log("📅 Normalized pickup date:", normalizedPickupDate);

  // Group items by truckload
  const groups = {};
  for (const item of order.line_items) {
    const truckloadProp = item.properties.find(p => p.name === "truckload");
    const truckload = truckloadProp?.value || "Unassigned";
    if (!groups[truckload]) groups[truckload] = [];
    groups[truckload].push(item);
  }

  for (const [truckload, items] of Object.entries(groups)) {
    try {
      // Tagging strategy
      const existingTags = order.tags || "";
      const parentTag = `parent_#${order.id}`;
      const truckloadTag = `truckload-${truckload}`;
      const childTags = existingTags
        ? `${existingTags},split-child,${truckloadTag},child_order,${parentTag}`
        : `split-child,${truckloadTag},child_order,${parentTag}`;

      // Build child order payload (baseline style: billing only)
      const childOrder = {
        order: {
          line_items: items,
          tags: childTags,
          customer: order.customer,
          billing_address: order.billing_address,
          discount_applications: order.discount_applications,
          shipping_lines: order.shipping_lines
        }
      };

      console.log(`🚚 Creating child order for truckload: ${truckload}`);
      console.log("📂 Project name from parent:", order.project_name); // NEW DEBUG LINE

      const response = await axios.post(apiUrl, childOrder, {
        headers: {
          "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
          "Content-Type": "application/json"
        }
      });

      const orderId = response.data.order.id;
      console.log(`✅ Created child order ${orderId} for truckload ${truckload}`);

      // Attach metafields (only project_name + pickup_date now)
      const metafields = [
        { namespace: "custom", key: "project_name", value: order.project_name, type: "single_line_text_field" }
      ];
      if (normalizedPickupDate) {
        metafields.push({
          namespace: "custom",
          key: "pickup_date",
          value: normalizedPickupDate,
          type: "single_line_text_field"
        });
      }

      for (const mf of metafields) {
        await axios.post(
          `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders/${orderId}/metafields.json`,
          { metafield: mf },
          {
            headers: {
              "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
              "Content-Type": "application/json"
            }
          }
        );
        console.log(`🔖 Attached metafield ${mf.key}=${mf.value} to order ${orderId}`);
      }
    } catch (err) {
      console.error(
        `❌ Failed to create child order for truckload ${truckload}:`,
        err.response?.data || err.message
      );
    }
  }

  res.sendStatus(200);
});

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
