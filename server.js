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

  // Extract project name from line item properties
  const projectName =
    order.line_items?.[0]?.properties?.find(p => p.name === "Project Name")?.value;
  console.log("📂 Project name from parent:", projectName);

  try {
    // Tagging strategy (no truckload tags anymore)
    const existingTags = order.tags || "";
    const parentTag = `parent_#${order.id}`;
    const childTags = existingTags
      ? `${existingTags},split-child,child_order,${parentTag}`
      : `split-child,child_order,${parentTag}`;

    // Build child order payload (baseline style: billing only)
    const childOrder = {
      order: {
        line_items: order.line_items,
        tags: childTags,
        customer: order.customer,
        billing_address: order.billing_address,
        discount_applications: order.discount_applications,
        shipping_lines: order.shipping_lines
      }
    };

    console.log("🚚 Creating child order (no truckload grouping)");

    const response = await axios.post(apiUrl, childOrder, {
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json"
      }
    });

    const orderId = response.data.order.id;
    console.log(`✅ Created child order ${orderId}`);

    // Attach metafields (only project_name + pickup_date now)
    const metafields = [];

    if (projectName) {
      metafields.push({
        namespace: "custom",
        key: "project_name",
        value: projectName,
        type: "single_line_text_field"
      });
    } else {
      console.log("⚠️ No project name found, skipping metafield");
    }

    if (normalizedPickupDate) {
      metafields.push({
        namespace: "custom",
        key: "pickup_date",
        value: normalizedPickupDate,
        type: "single_line_text_field"
      });
    } else {
      console.log("⚠️ No pickup date found, skipping metafield");
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
      "❌ Failed to create child order:",
      err.response?.data || err.message
    );
  }

  res.sendStatus(200);
});

app.listen(3000, () => {
  console.log("🚀 Server running on port 3000");
});
