const { getSubscriptionModel } = require("../db/subscriptionSchema"); // Import the subscription model factory

/**
 * Validates if an organization has an active and non-expired subscription
 * @param {Object} orgDb - Organization database connection
 * @param {String} tenant_id - Organization tenant ID
 * @returns {Object} - Subscription status object
 */
const validateSubscription = async (orgDb, tenant_id) => {
  try {
    // Get the Subscription model for this organization
    const Subscription = getSubscriptionModel(orgDb);

    // Find the active subscription for this tenant
    const subscription = await Subscription.findOne({
      tenant_id,
      status: "active",
    });

    if (!subscription) {
      return {
        valid: false,
        error: "No active subscription found for this organization",
      };
    }
    // Check if subscription has expired
    const currentDate = new Date();
    if (currentDate > subscription.end_date) {
      // Update subscription status to expired
      await Subscription.updateOne(
        { _id: subscription._id },
        {
          $set: {
            status: "expired",
            updated_at: new Date(),
          },
        }
      );

      return {
        valid: false,
        error: "Your subscription has expired",
      };
    }

    // Calculate days remaining until expiration
    const daysRemaining = Math.ceil(
      (subscription.end_date - currentDate) / (1000 * 60 * 60 * 24)
    );

    // Subscription is valid
    return {
      valid: true,
      plan: subscription.plan,
      is_trial: subscription.is_trial,
      end_date: subscription.end_date,
      auto_renew: subscription.auto_renew,
      expiring_soon: daysRemaining <= 7,
      days_remaining: daysRemaining,
    };
  } catch (error) {
    console.error("Error validating subscription:", error);
    return {
      valid: false,
      error: "Error checking subscription status",
      details: error.message,
    };
  }
};

module.exports = { validateSubscription };
