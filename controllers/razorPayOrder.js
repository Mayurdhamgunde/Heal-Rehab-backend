const mongoose = require("mongoose");
const Razorpay = require("razorpay");
const { getSubscriptionModel } = require("../db/subscriptionSchema");
const { ObjectId } = mongoose.Types;

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

// Plan pricing configuration (moved to backend for security)
const PLAN_PRICING = {
  basic: {
    monthly: 999,    // Updated from frontend values
    yearly: 9990     // Added 16% discount for yearly billing
  },
  professional: {
    monthly: 1999,   // Updated from frontend values
    yearly: 19990    // Maintained existing yearly price
  },
  enterprise: {
    monthly: 4999,   // Updated from frontend values
    yearly: 49990    // Maintained existing yearly price
  }
};

const razorpayOrder = async (req, res) => {
  const { plan, billingCycle } = req.body;

  // Validate plan and billing cycle
  if (!PLAN_PRICING[plan]) {
    return res.status(400).json({ msg: "Invalid plan selected" });
  }

  if (!["monthly", "yearly"].includes(billingCycle)) {
    return res.status(400).json({ msg: "Invalid billing cycle" });
  }

  try {
    // Get the price from backend configuration
    const amount = PLAN_PRICING[plan][billingCycle];

    if (!amount) {
      return res.status(400).json({ msg: "Unable to determine plan price" });
    }

    // Create Razorpay order
    const order = await razorpay.orders.create({
      amount: amount * 100, // Razorpay expects amount in paise
      currency: "INR",
      payment_capture: 1,
    });

    res.json({
      order,
      planDetails: {
        plan,
        billingCycle,
        amount
      }
    });
  } catch (err) {
    console.error("Error creating Razorpay order:", err);
    res.status(500).json({ msg: "Failed to create order" });
  }
};

module.exports = { razorpayOrder };