/**
 * LandlordCollect — Backend Server
 * Node.js + Express + Stripe
 *
 * Setup:
 *   npm install express stripe cors dotenv
 *   Create a .env file with your Stripe keys (see below)
 *   node server.js
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const stripe  = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors({ origin: "https://landlordcollect.com" })); // Lock to your domain
app.use(express.json());

// Stripe webhooks need raw body — mount BEFORE express.json()
app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  handleWebhook
);

// ─── In-memory tenant DB (replace with a real DB like Postgres/MongoDB) ──────
const tenants = {
  "marcus_1a": { name: "Marcus Johnson",  unit: "1A", rent: 185000, status: "late",    email: "marcus@email.com" },
  "sofia_1b":  { name: "Sofia Reyes",     unit: "1B", rent: 210000, status: "late",    email: "sofia@email.com"  },
  "david_2a":  { name: "David Kim",       unit: "2A", rent: 165000, status: "paid",    email: "david@email.com"  },
  "priya_2b":  { name: "Priya Patel",     unit: "2B", rent: 195000, status: "pending", email: "priya@email.com"  },
  "james_3a":  { name: "James Wilson",    unit: "3A", rent: 225000, status: "late",    email: "james@email.com"  },
};

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /api/tenant/:tenantId
 * Returns tenant info for the payment page
 * Called when tenant opens their payment link
 */
app.get("/api/tenant/:tenantId", (req, res) => {
  const tenant = tenants[req.params.tenantId];
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  // Don't expose internal fields — return only what the page needs
  res.json({
    name:    tenant.name,
    unit:    tenant.unit,
    rent:    tenant.rent,       // in cents
    status:  tenant.status,
    email:   tenant.email,
    lateFee: tenant.status === "late" ? 5000 : 0, // $50 late fee in cents
  });
});

/**
 * POST /api/create-payment-intent
 * Creates a Stripe PaymentIntent and returns the client secret
 * Called when tenant clicks "Pay Now"
 */
app.post("/api/create-payment-intent", async (req, res) => {
  const { tenantId, paymentMethodId } = req.body;

  const tenant = tenants[tenantId];
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  if (tenant.status === "paid") {
    return res.status(400).json({ error: "This tenant has already paid." });
  }

  const lateFee = tenant.status === "late" ? 5000 : 0;
  const total   = tenant.rent + lateFee;

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount:               total,
      currency:             "usd",
      payment_method:       paymentMethodId,
      confirm:              true,            // Confirm immediately
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      receipt_email:        tenant.email,
      metadata: {
        tenantId,
        tenantName: tenant.name,
        unit:       tenant.unit,
        period:     "April 2026",
      },
      description: `Rent – Unit ${tenant.unit} – April 2026`,
    });

    res.json({
      success:      true,
      clientSecret: paymentIntent.client_secret,
      transactionId: paymentIntent.id,
    });

  } catch (err) {
    console.error("Stripe error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/send-reminder/:tenantId
 * Sends a payment reminder email via Stripe (or your email provider)
 * Called from the landlord dashboard "Remind" button
 */
app.post("/api/send-reminder/:tenantId", async (req, res) => {
  const tenant = tenants[req.params.tenantId];
  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  // In production: use SendGrid, Resend, or Postmark here
  // Example with a hypothetical emailService:
  //
  // await emailService.send({
  //   to:      tenant.email,
  //   subject: `Reminder: Rent Due – Unit ${tenant.unit}`,
  //   html:    `<p>Hi ${tenant.name}, your rent of $${tenant.rent / 100} is due...</p>
  //             <a href="https://landlordcollect.com/pay?tenant=${req.params.tenantId}">Pay Now</a>`
  // });

  console.log(`Reminder sent to ${tenant.email} for unit ${tenant.unit}`);
  res.json({ success: true, message: `Reminder sent to ${tenant.email}` });
});

/**
 * GET /api/dashboard
 * Returns aggregated stats for the landlord dashboard
 */
app.get("/api/dashboard", (req, res) => {
  const all = Object.entries(tenants).map(([id, t]) => ({ id, ...t }));

  const stats = {
    totalExpected:  all.reduce((s, t) => s + t.rent, 0),
    collected:      all.filter(t => t.status === "paid").reduce((s, t) => s + t.rent, 0),
    outstanding:    all.filter(t => t.status !== "paid").reduce((s, t) => s + t.rent, 0),
    paidCount:      all.filter(t => t.status === "paid").length,
    lateCount:      all.filter(t => t.status === "late").length,
    pendingCount:   all.filter(t => t.status === "pending").length,
    tenants:        all,
  };

  res.json(stats);
});

// ─── Stripe Webhook Handler ───────────────────────────────────────────────────

/**
 * POST /api/webhook
 * Stripe sends events here after payments complete
 * Marks tenants as paid automatically
 *
 * In Stripe Dashboard → Developers → Webhooks:
 *   Add endpoint: https://landlordcollect.com/api/webhook
 *   Listen for:   payment_intent.succeeded
 *                 payment_intent.payment_failed
 */
async function handleWebhook(req, res) {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "payment_intent.succeeded": {
      const intent   = event.data.object;
      const tenantId = intent.metadata.tenantId;

      if (tenants[tenantId]) {
        tenants[tenantId].status = "paid";
        console.log(`✅ Payment confirmed for ${tenants[tenantId].name} (${tenantId})`);
        // In production: update your database here
        // await db.tenants.update({ id: tenantId }, { status: 'paid', paidAt: new Date() });
      }
      break;
    }

    case "payment_intent.payment_failed": {
      const intent   = event.data.object;
      const tenantId = intent.metadata.tenantId;
      console.log(`❌ Payment failed for tenant ${tenantId}:`, intent.last_payment_error?.message);
      break;
    }

    default:
      console.log(`Unhandled event: ${event.type}`);
  }

  res.json({ received: true });
}

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🏠 LandlordCollect API running on port ${PORT}`);
  console.log(`   Stripe mode: ${process.env.STRIPE_SECRET_KEY?.startsWith("sk_live") ? "LIVE 🟢" : "TEST 🟡"}\n`);
});

/**
 * ─── .env file (create this in your project root) ──────────────────────────
 *
 * STRIPE_SECRET_KEY=sk_test_YOUR_SECRET_KEY_HERE
 * STRIPE_WEBHOOK_SECRET=whsec_YOUR_WEBHOOK_SECRET_HERE
 * PORT=3001
 *
 * Get your keys at: https://dashboard.stripe.com/apikeys
 * Get webhook secret at: https://dashboard.stripe.com/webhooks
 * ───────────────────────────────────────────────────────────────────────────
 */
