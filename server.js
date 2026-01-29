import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHOP = process.env.SHOP;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = process.env.API_VERSION || "2023-10";


// ============================================================
// 🧠 Local In-Memory Lock (Prevents Race Conditions)
// ============================================================
const localLocks = new Map();


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

// ✅ Helper: fetch latest parent order
async function getParentOrder(orderId) {
  const resp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${orderId}.json`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
  });

  const data = await resp.json();
  return data.order;
}

// ============================================================
// 🔒 Metafield Lock Helpers (custom.processing_lock)
// ============================================================


// Fetch the current processing lock value for a parent order
async function getProcessingLock(orderId) {
  try {
    const resp = await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${orderId}/metafields.json`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ACCESS_TOKEN,
      },
    });

    const data = await resp.json();
    const lockField = Array.isArray(data?.metafields)
      ? data.metafields.find(m => m.namespace === "custom" && m.key === "processing_lock")
      : null;

    return lockField?.value || null;
  } catch (err) {
    console.error("❌ Error fetching processing lock:", err);
    return null;
  }
}

// Write or update the processing lock metafield
async function setProcessingLock(orderId, value) {
  try {
    await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/metafields.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ACCESS_TOKEN,
      },
      body: JSON.stringify({
        metafield: {
          namespace: "custom",
          key: "processing_lock",
          type: "single_line_text_field",
          value,
          owner_id: orderId,
          owner_resource: "order",
        },
      }),
    });

    console.log(`🔒 Lock for order ${orderId} set to: ${value}`);
  } catch (err) {
    console.error("❌ Error setting processing lock:", err);
  }
}

// Guard: prevent duplicate or concurrent splits
async function assertLockAvailable(orderId) {
  const lock = await getProcessingLock(orderId);

  if (lock === "in_progress") {
    console.log(`⛔ Split already in progress for ${orderId}. Skipping.`);
    return false;
  }

  if (lock === "done") {
    console.log(`⛔ Split already completed for ${orderId}. Skipping.`);
    return false;
  }

  return true;
}

app.post("/webhooks/orders/create", async (req, res) => {
  const order = req.body;   // ⭐ now visible to try/catch/finally

  try {
    console.log(`🔔 Webhook fired for order ${order.id} at ${new Date().toISOString()}`);

    // ============================================================
// 🧠 Local Lock Guard — prevents simultaneous webhook execution
// ============================================================
if (localLocks.get(order.id)) {
  console.log(`⛔ Local lock active for ${order.id}. Skipping.`);
  return res.status(200).send("Local lock skip");
}

// Activate local lock
localLocks.set(order.id, true);
console.log(`🔒 Local lock engaged for ${order.id}`);


    // ============================================================
// 🔒 Duplicate Webhook Guard + Initial Lock Write
// ============================================================

// 1. Check if lock is available
const lockAvailable = await assertLockAvailable(order.id);
if (!lockAvailable) {
  console.log(`⛔ Lock prevents processing for ${order.id}. Exiting early.`);
  return res.status(200).send("Split skipped due to lock");
}

// 2. Set lock to in_progress BEFORE any splitting logic
await setProcessingLock(order.id, "in_progress");
console.log(`🔒 Lock set to in_progress for parent ${order.id}`);

    // ============================================================
// 📦 Child Order Tracking (for verification later)
// ============================================================

// This array will store the expected details for each child order
let expectedChildren = [];

// Helper to record what we *intend* to create
function trackExpectedChild({
  childId,          // ⭐ NEW
  variantId,
  quantity,
  parentOrderName,
  productId,
  lineItemId,
  truckloadIndex,
  note,
  projectName,
  pickupDate
}) {
  expectedChildren.push({
    childId,        // ⭐ NEW
    variantId,
    quantity,
    parentOrderName,
    productId,
    lineItemId,
    truckloadIndex,
    note,
    projectName,
    pickupDate
  });
}



    // 🚫 Skip child orders immediately
    if ((order.tags || "").includes("Split-Child")) {
      console.log("↩️ Child order detected. Skipping split.");
      return res.status(200).send("Child order skipped");
    }

    // ✅ Double‑check parent order tags from Shopify before splitting
    const latestParent = await getParentOrder(order.id);
    if ((latestParent.tags || "").includes("Split-Processed") || (latestParent.tags || "").includes("Truckload-Ready")) {
      console.log("↩️ Parent already marked as processed. Skipping split.");
      return res.status(200).send("Already processed");
    }

    // 🏷️ Tag parent immediately to prevent duplicate splits
    const newTags = order.tags ? `${order.tags}, Split-Processed` : "Split-Processed";
    await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}.json`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": ACCESS_TOKEN,
      },
      body: JSON.stringify({ order: { id: order.id, tags: newTags } }),
    });
    console.log(`🏷️ Parent ${order.name} tagged as Split-Processed before child creation`);

    const lineItems = Array.isArray(order.line_items) ? order.line_items : [];
    if (lineItems.length === 0) {
      console.log("⚠️ No line items found on order");
      return res.status(200).send("No line items");
    }

    // ✅ Fetch parent pickup context
    const parentLocationId = await getParentPickupLocation(order.id);
    const parentPickupDate = getParentPickupDate(order);

    let childOrdersCreated = false;

        // ✅ Outer loop over line items
    const multipleProducts = lineItems.length > 1;

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
      let splitQuantities = [];

      console.log(`🔍 Checking item ${item.title} (qty ${item.quantity}) with truckloadCapacity=${truckloadCapacity}`);

      if (!Number.isFinite(truckloadCapacity) || truckloadCapacity <= 0) {
        console.log(`⚠️ Skipping ${item.title} — invalid truckloadCapacity`);
        continue;
      }

// Case: quantity less than capacity → still create one child order
if (item.quantity < truckloadCapacity) {
  console.log(`📦 Qty ${item.quantity} < capacity ${truckloadCapacity} — creating one child order`);
  splitQuantities = [item.quantity];
}


      // Case: quantity equals capacity
      if (item.quantity === truckloadCapacity) {
        if (multipleProducts) {
          console.log(`✅ Equal capacity for ${item.title}, creating one child order since parent has multiple products`);
          splitQuantities = [item.quantity];
        } else {
          console.log(`🏷️ Parent-only product ${item.title} at capacity, tagging parent as Truckload-Ready`);
          const newTags = order.tags ? `${order.tags}, Truckload-Ready` : "Truckload-Ready";
          await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}.json`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": ACCESS_TOKEN,
            },
            body: JSON.stringify({ order: { id: order.id, tags: newTags } }),
          });
          continue; // no child orders created
        }
      }

      // Case: quantity greater than capacity → normal split
      if (item.quantity > truckloadCapacity) {
        const fullLoads = Math.floor(item.quantity / truckloadCapacity);
        const remainder = item.quantity % truckloadCapacity;
        splitQuantities = Array(fullLoads).fill(truckloadCapacity);
        if (remainder > 0) splitQuantities.push(remainder);
      }

      console.log(`Split quantities for ${item.title}:`, splitQuantities);

      // ✅ Inner loop over split quantities
      for (let i = 0; i < splitQuantities.length; i++) {
        const qty = splitQuantities[i];

        const projectName = Array.isArray(item.properties)
          ? item.properties.find(p => p.name === "Project Name")?.value || null
          : null;
        const pickupDateRaw = Array.isArray(item.properties)
          ? item.properties.find(p => p.name === "Pickup Date")?.value || null
          : null;
        const pickupDateNormalized = normalizeDate(pickupDateRaw);
// Extract warehouse instructions cleanly from parent note
let warehouseInstructions = null;
if (order.note) {
  warehouseInstructions = order.note.replace(/Pickup Date:[^|]+(\|)?/, "").trim();
  if (warehouseInstructions === "") warehouseInstructions = null;

  // 🚩 Fix (Diff #22): remove duplicate "Warehouse Instructions:" if already present
  if (warehouseInstructions && warehouseInstructions.startsWith("Warehouse Instructions:")) {
    warehouseInstructions = warehouseInstructions.replace(/^Warehouse Instructions:\s*/, "");
  }
}

// Build childNote cleanly
let childNoteParts = [];
if (pickupDateNormalized) childNoteParts.push(`Pickup Date: ${pickupDateNormalized}`);
if (warehouseInstructions) childNoteParts.push(`Warehouse Instructions: ${warehouseInstructions}`);

const childNote = childNoteParts.join(" | ");
console.log(`🔎 Child order ${i + 1} — Note: ${childNote}`);


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
            note: childNote || null,
            tags: [
              `Split-Child`,
              `Truckload ${i + 1}`,
              `Parent-${order.name}`,
              `Product-${item.product_id}`,
              `LineItem-${item.id}`
            ],
            purchase_order_number: projectName,
            metafields: [],
            fulfillment_status: "unfulfilled",
          },
        };

        console.log("🧾 Creating child order payload:", JSON.stringify(newOrderPayload, null, 2));

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

        console.log(`✅ Created child order ${createdOrder.order.id} with tags: ${createdOrder.order.tags}`);
        childOrdersCreated = true;

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

        // Attach pickup date metafield
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

// Track expected child order for verification
trackExpectedChild({
  childId: createdOrder.order.id,   // ⭐ NEW
  variantId: item.variant_id,
  quantity: qty,
  parentOrderName: order.name,
  productId: item.product_id,
  lineItemId: item.id,
  truckloadIndex: i,
  note: childNote || null,
  projectName: projectName || null,
  pickupDate: pickupDateNormalized || parentPickupDate || null
});


        
      } // closes inner loop
    }   // closes outer loop

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

    // ============================================================
// 🔍 Verification Pass — Confirm All Child Orders Were Created Correctly
// ============================================================

async function verifyChildOrders(expectedChildren) {
  console.log("🔍 Starting verification pass for child orders…");

  let allVerified = true;

  for (const expected of expectedChildren) {
    const {
      childId,          // ⭐ REQUIRED
      variantId,
      quantity,
      parentOrderName,
      productId,
      lineItemId,
      truckloadIndex,
      note,
      projectName,
      pickupDate
    } = expected;

    // ⭐ Fetch child order directly by ID
    const childResp = await fetch(
      `${shopBaseUrl}/admin/api/${API_VERSION}/orders/${childId}.json`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ACCESS_TOKEN,
        },
      }
    );

    const childData = await childResp.json();
    const child = childData.order;

    if (!child) {
      console.error(`❌ Child order ${childId} not found`);
      allVerified = false;
      continue;
    }

    // ⭐ Verify quantity
    const actualQty = child.line_items?.[0]?.quantity;
    if (actualQty !== quantity) {
      console.error(`❌ Quantity mismatch for child ${childId}: expected ${quantity}, got ${actualQty}`);
      allVerified = false;
    }

    // ⭐ Verify note
    if (note && child.note !== note) {
      console.error(`❌ Note mismatch for child ${childId}: expected "${note}", got "${child.note}"`);
      allVerified = false;
    }

    // ⭐ Verify tags
    const requiredTags = [
      "Split-Child",
      `Parent-${parentOrderName}`,
      `Product-${productId}`,
      `LineItem-${lineItemId}`,
      `Truckload ${truckloadIndex + 1}`
    ];

    for (const tag of requiredTags) {
      if (!child.tags.includes(tag)) {
        console.error(`❌ Missing tag "${tag}" on child ${childId}`);
        allVerified = false;
      }
    }

    // ⭐ Verify metafields
    const metaResp = await fetch(
      `${shopBaseUrl}/admin/api/${API_VERSION}/orders/${childId}/metafields.json`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ACCESS_TOKEN,
        },
      }
    );

    const metaData = await metaResp.json();
    const metaList = Array.isArray(metaData?.metafields) ? metaData.metafields : [];

    const projectMeta = metaList.find(m => m.namespace === "custom" && m.key === "project_name");
    const pickupMeta = metaList.find(m => m.namespace === "custom" && m.key === "pickup_date");

    if (projectName && (!projectMeta || projectMeta.value !== projectName)) {
      console.error(`❌ Project name metafield mismatch on child ${childId}`);
      allVerified = false;
    }

    if (pickupDate && (!pickupMeta || pickupMeta.value !== pickupDate)) {
      console.error(`❌ Pickup date metafield mismatch on child ${childId}`);
      allVerified = false;
    }
  }

  console.log(allVerified ? "✅ Verification passed" : "❌ Verification failed");
  return allVerified;
}


    // Run verification pass
const verificationPassed = await verifyChildOrders(expectedChildren);

// ============================================================
// 🔒 Lock Completion — Only mark as done if verification passes
// ============================================================

if (verificationPassed) {
  console.log(`🔒 Verification succeeded — marking lock as done for ${order.id}`);
  await setProcessingLock(order.id, "done");
} else {
  console.error(`❌ Verification failed — leaving lock as in_progress for ${order.id}`);
}


    // ✅ Final parent tagging logic
    if (!childOrdersCreated) {
      // If no child orders were created, parent should be tagged Truckload-Ready
      const newTags = order.tags ? `${order.tags}, Truckload-Ready` : "Truckload-Ready";
      await fetch(`${shopBaseUrl}/admin/api/${API_VERSION}/orders/${order.id}.json`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ACCESS_TOKEN,
        },
        body: JSON.stringify({ order: { id: order.id, tags: newTags } }),
      });
      console.log(`🏷️ Parent ${order.name} tagged as Truckload-Ready (no child orders created)`);
    }

res.status(200).send("Split processed");

} catch (err) {
  console.error("❌ Error processing split:", err);
  res.status(500).send("Error");

} finally {
  // ============================================================
  // 🧠 ALWAYS Release Local Lock
  // ============================================================
  if (order?.id && localLocks.get(order.id)) {
    localLocks.delete(order.id);
    console.log(`🔓 Local lock released for ${order.id}`);
  }
}
});


app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

