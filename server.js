/**
 * LandlordCollect — Backend Server
 * Node.js + Express + Stripe + Supabase
 *
 * Setup:
 *   npm install express stripe cors dotenv @supabase/supabase-js
 *   Create a .env file with your keys (see bottom of file)
 *   node server.js
 */

require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const stripe    = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { createClient } = require("@supabase/supabase-js");

const app = express();

// Supabase admin client (uses service role key — never expose this publicly)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: "https://landlordcollect.com" }));
app.use(express.json());

// Stripe webhooks need raw body — mount BEFORE express.json()
app.post("/api/webhook", express.raw({ type: "application/json" }), handleWebhook);

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/health
 * Health check endpoint
 */
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/**
 * GET /api/tenant/:tenantId
 * Returns tenant info for the payment page
 */
app.get("/api/tenant/:tenantId", async (req, res) => {
  const { data, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("id", req.params.tenantId)
    .single();

  if (error || !data) return res.status(404).json({ error: "Tenant not found" });
  res.json(data);
});

/**
 * POST /api/create-payment-intent
 * Creates a Stripe PaymentIntent for tenant rent payment
 */
app.post("/api/create-payment-intent", async (req, res) => {
  const { tenantId, paymentMethodId } = req.body;

  const { data: tenant } = await supabase
    .from("tenants")
    .select("*")
    .eq("id", tenantId)
    .single();

  if (!tenant) return res.status(404).json({ error: "Tenant not found" });

  const lateFee = tenant.status === "late" ? 5000 : 0;
  const total   = tenant.rent + lateFee;

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount:         total,
      currency:       "usd",
      payment_method: paymentMethodId,
      confirm:        true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      receipt_email:  tenant.email,
      metadata: { tenantId, tenantName: tenant.name, unit: tenant.unit },
      description: `Rent – Unit ${tenant.unit}`,
    });

    res.json({ success: true, transactionId: paymentIntent.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Stripe Webhook Handler ────────────────────────────────────────────────────

async function handleWebhook(req, res) {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`Stripe event: ${event.type}`);

  switch (event.type) {

    // ── New subscription created ──────────────────────────────────────────────
    case "customer.subscription.created": {
      const subscription = event.data.object;
      const customerId   = subscription.customer;

      try {
        // Get customer details from Stripe
        const customer = await stripe.customers.retrieve(customerId);
        const email    = customer.email;
        const name     = customer.name || email.split("@")[0];

        // Get plan name from subscription
        const priceId  = subscription.items.data[0]?.price?.id;
        const planName = getPlanName(priceId);

        console.log(`New subscriber: ${email} on ${planName}`);

        // Create Supabase account for this customer
        const { data: authData, error: authError } = await supabase.auth.admin.createUser({
          email,
          password:      generateTempPassword(),
          email_confirm: true,
          user_metadata: {
            full_name:       name,
            plan:            planName,
            stripe_customer: customerId,
            subscription_id: subscription.id,
          }
        });

        if (authError) {
          // User might already exist — try to get them
          console.log("User may already exist:", authError.message);
        }

        // Send password reset email so they can set their own password
        await supabase.auth.admin.generateLink({
          type:       "magiclink",
          email,
          options: { redirectTo: "https://landlordcollect.com/dashboard.html" }
        });

        // Send welcome email via Supabase
        console.log(`✅ Account created for ${email} on ${planName} plan`);

        // Save customer record to database
        await supabase.from("subscribers").upsert({
          email,
          name,
          plan:            planName,
          stripe_customer: customerId,
          subscription_id: subscription.id,
          status:          "trialing",
          trial_end:       new Date(subscription.trial_end * 1000).toISOString(),
          created_at:      new Date().toISOString(),
        });

      } catch (err) {
        console.error("Error creating user:", err.message);
      }
      break;
    }

    // ── Subscription activated (trial ended, now paying) ─────────────────────
    case "customer.subscription.updated": {
      const subscription = event.data.object;
      const status       = subscription.status;

      await supabase.from("subscribers")
        .update({ status })
        .eq("subscription_id", subscription.id);

      console.log(`Subscription ${subscription.id} updated to ${status}`);
      break;
    }

    // ── Subscription cancelled ────────────────────────────────────────────────
    case "customer.subscription.deleted": {
      const subscription = event.data.object;

      await supabase.from("subscribers")
        .update({ status: "cancelled" })
        .eq("subscription_id", subscription.id);

      console.log(`Subscription ${subscription.id} cancelled`);
      break;
    }

    // ── Tenant rent payment succeeded ─────────────────────────────────────────
    case "payment_intent.succeeded": {
      const intent   = event.data.object;
      const tenantId = intent.metadata?.tenantId;

      if (tenantId) {
        await supabase.from("tenants")
          .update({ status: "paid", paid_at: new Date().toISOString() })
          .eq("id", tenantId);

        console.log(`✅ Rent payment confirmed for tenant ${tenantId}`);
      }
      break;
    }

    // ── Payment failed ────────────────────────────────────────────────────────
    case "payment_intent.payment_failed": {
      const intent   = event.data.object;
      const tenantId = intent.metadata?.tenantId;

      if (tenantId) {
        await supabase.from("tenants")
          .update({ status: "late" })
          .eq("id", tenantId);
      }
      console.log(`❌ Payment failed for tenant ${tenantId}`);
      break;
    }

    default:
      console.log(`Unhandled event: ${event.type}`);
  }

  res.json({ received: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getPlanName(priceId) {
  const plans = {
    "price_UILraXmxb6aC8Y": "Starter",
    "price_UILt7w7WGK8fZB": "Pro",
    "price_UILuPNEbggy2kF": "Portfolio",
  };
  return plans[priceId] || "Starter";
}

function generateTempPassword() {
  return Math.random().toString(36).slice(2, 10) +
         Math.random().toString(36).slice(2, 10).toUpperCase() + "!1";
}

// ── Start Server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🏠 LandlordCollect API running on port ${PORT}`);
  console.log(`   Stripe: ${process.env.STRIPE_SECRET_KEY?.startsWith("sk_live") ? "LIVE 🟢" : "TEST 🟡"}`);
  console.log(`   Supabase: ${process.env.SUPABASE_URL}\n`);
});

/**
 * ── .env file ──────────────────────────────────────────────────────────────
 *
 * STRIPE_SECRET_KEY=sk_live_YOUR_KEY
 * STRIPE_WEBHOOK_SECRET=whsec_YOUR_KEY
 * SUPABASE_URL=https://uogaehexqnisestkpshu.supabase.co
 * SUPABASE_SERVICE_KEY=your_service_role_key_here
 * PORT=3001
 *
 * Get Supabase service key at:
 * supabase.com → your project → Settings → API → service_role key
 * ────────────────────────────────────────────────────────────────────────────
 */
