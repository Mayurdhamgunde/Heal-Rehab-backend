const { getSubscriptionModel } = require("../db/subscriptionSchema");
const mongoose = require("mongoose");

/**
 * Purchase a subscription for an organization, ensuring proper handling of existing subscriptions
 * @param {Object} orgDb - Database connection
 * @param {Object} subscriptionData - Subscription data
 * @returns {Object} Result object with success status and subscription or error details
 */
const purchaseSubscription = async (orgDb, subscriptionData) => {
  try {
    // Validate required fields
    const requiredFields = [
      "organization_id",
      "tenant_id",
      "plan",
      "billing_cycle",
      "payment_method",
    ];
    for (const field of requiredFields) {
      if (!subscriptionData[field]) {
        return {
          success: false,
          error: `Missing required field: ${field}`,
        };
      }
    }

    // Get the Subscription model for this organization
    const Subscription = getSubscriptionModel(orgDb);

    // Check for existing subscriptions for this organization
    const existingSubscription = await Subscription.findOne({
      organization_id: subscriptionData.organization_id,
      tenant_id: subscriptionData.tenant_id,
      status: { $in: ["active", "expired"] },
    }).sort({ end_date: -1 });

    const currentDate = new Date();
    let startDate = currentDate;
    let endDate;

    // If there's an existing subscription, set the start date after its end date
    if (existingSubscription) {
      const existingEndDate = new Date(existingSubscription.end_date);

      // If the existing subscription end date is in the future, use that as start date
      // Otherwise, use current date as start date
      startDate = existingEndDate > currentDate ? existingEndDate : currentDate;
    }

    // Calculate end date based on start date and billing cycle
    endDate = new Date(startDate);
    if (subscriptionData.billing_cycle === "monthly") {
      endDate.setMonth(endDate.getMonth() + 1);
    } else if (subscriptionData.billing_cycle === "yearly") {
      endDate.setFullYear(endDate.getFullYear() + 1);
    } else {
      return {
        success: false,
        error: "Invalid billing cycle. Must be 'monthly' or 'yearly'.",
      };
    }

    // Prepare subscription document
    const newSubscription = {
      organization_id: subscriptionData.organization_id,
      tenant_id: subscriptionData.tenant_id,
      plan: subscriptionData.plan,
      status: "active",
      start_date: startDate,
      end_date: endDate,
      is_trial: false,
      payment_method: subscriptionData.payment_method,
      transaction_id: subscriptionData.transaction_id || null,
      auto_renew: true, // Default to auto-renew
      billing_cycle: subscriptionData.billing_cycle,
      billing_information: subscriptionData.billing_information || null,
      price_paid: subscriptionData.price_paid || 0,
      next_billing_date: endDate,
      created_at: currentDate,
      updated_at: currentDate,
    };

    // Create the new subscription document
    const subscription = new Subscription(newSubscription);
    await subscription.save();

    return {
      success: true,
      message: "Subscription purchased successfully",
      subscription: subscription,
    };
  } catch (error) {
    console.error("Error purchasing subscription:", error);
    return {
      success: false,
      error: "Error purchasing subscription",
      details: error.message,
    };
  }
};

/**
 * Controller to handle subscription purchases
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const buySubscription = async (req, res) => {
  try {
    // Extract subscription data from request body
    const {
      plan,
      billing_cycle,
      payment_method,
      transaction_id,
      price_paid,
      billing_information,
    } = req.body;

    // Validate required fields
    if (!plan || !billing_cycle || !payment_method) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required fields. Required: plan, billing_cycle, payment_method",
      });
    }

    // Validate billing cycle
    if (billing_cycle !== "monthly" && billing_cycle !== "yearly") {
      return res.status(400).json({
        success: false,
        message: "Invalid billing cycle. Must be 'monthly' or 'yearly'.",
      });
    }

    // Validate plan
    const validPlans = ["basic", "professional", "enterprise"];
    if (!validPlans.includes(plan)) {
      return res.status(400).json({
        success: false,
        message: `Invalid plan. Must be one of: ${validPlans.join(", ")}`,
      });
    }

    // Prepare subscription data
    const subscriptionData = {
      organization_id: req.user.organization_id || req.doctor_id, // Use the appropriate ID
      tenant_id: req.user.tenant_id,
      plan,
      billing_cycle,
      payment_method,
      transaction_id,
      price_paid,
      billing_information,
    };

    // Purchase the subscription
    const result = await purchaseSubscription(req.orgDb, subscriptionData);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.error,
        details: result.details,
      });
    }

    // Return success response
    res.status(201).json({
      success: true,
      message: "Subscription purchased successfully",
      subscription: {
        plan: result.subscription.plan,
        status: result.subscription.status,
        start_date: result.subscription.start_date,
        end_date: result.subscription.end_date,
        billing_cycle: result.subscription.billing_cycle,
        auto_renew: result.subscription.auto_renew,
      },
    });
  } catch (error) {
    console.error("Error in buySubscription controller:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

module.exports = {
  buySubscription,
  purchaseSubscription, // Export this function if needed elsewhere
};
