const { MongoClient } = require("mongodb");
const mongoose = require("mongoose");
const Organization = require("../db/OrganizationSchema"); // Adjust path as needed

/**
 * Initialize subscription plans in the main database
 * @param {string} mongoUrl - MongoDB connection URL
 */
async function initializeSubscriptionPlans(mongoUrl) {
  const client = await MongoClient.connect(mongoUrl);
  try {
    const mainDb = client.db("your_main_db_name"); // Replace with your main DB name
    const plansCollection = mainDb.collection("subscription_plans");

    // Check if plans already exist
    const plansCount = await plansCollection.countDocuments();
    if (plansCount > 0) {
      console.log("Subscription plans already exist");
      return;
    }

    // Define the plans
    const plans = [
      {
        plan_id: "basic",
        name: "Basic",
        price: 799,
        billing_cycle: "monthly",
        features: {
          cloud_storage: "5GB",
          database_backup: "Weekly",
          analytics: "Basic Analytics",
          support: "Email Support",
          health_data: "Health Data Export",
          devices: "Limited Devices",
          api_access: false,
          custom_branding: false,
        },
        is_active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        plan_id: "professional",
        name: "Professional",
        price: 1999,
        billing_cycle: "monthly",
        features: {
          cloud_storage: "Unlimited",
          database_backup: "Daily",
          analytics: "Advanced Analytics",
          support: "Priority Email Support",
          health_data: "Health Data Export",
          devices: "Unlimited Devices",
          api_access: true,
          custom_branding: false,
        },
        is_active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        plan_id: "enterprise",
        name: "Enterprise",
        price: 3999,
        billing_cycle: "monthly",
        features: {
          cloud_storage: "Unlimited",
          database_backup: "Real-time",
          analytics: "Enterprise Analytics",
          support: "24/7 Priority Support",
          health_data: "Health Data Export & Import",
          devices: "Unlimited Devices",
          api_access: true,
          custom_branding: true,
        },
        is_active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        plan_id: "free_trial",
        name: "Free Trial",
        price: 0,
        billing_cycle: "trial",
        features: {
          cloud_storage: "5GB",
          database_backup: "Weekly",
          analytics: "Basic Analytics",
          support: "Email Support",
          health_data: "Health Data Export",
          devices: "Limited Devices",
          api_access: false,
          custom_branding: false,
        },
        is_active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    // Insert the plans
    await plansCollection.insertMany(plans);
    console.log("Subscription plans initialized successfully");
  } catch (error) {
    console.error("Error initializing subscription plans:", error);
  }
}

/**
 * Add subscription collection to a single organization
 * @param {string} mongoUrl - MongoDB connection URL
 * @param {string} tenantId - Organization tenant ID
 * @param {string} plan - Subscription plan (default: free_trial)
 * @param {number} trialDays - Number of days for trial (default: 30)
 */
async function addSubscriptionToOrg(
  mongoUrl,
  tenantId,
  plan = "free_trial",
  trialDays = 30
) {
  let client;
  try {
    // Connect to MongoDB
    client = await MongoClient.connect(mongoUrl);
    console.log(`Connected to MongoDB for tenant: ${tenantId}`);

    // Fetch organization details from the main database
    const orgData = await Organization.findOne({ tenant_id: tenantId });
    if (!orgData) {
      console.error(`Organization with tenant ID ${tenantId} not found`);
      return false;
    }

    // Get the organization's database
    const dbName = orgData.database_name || `org_${tenantId.replace(/-/g, "")}`;
    const orgDb = client.db(dbName);

    // Check if subscription collection exists
    const collections = await orgDb
      .listCollections({ name: "subscription" })
      .toArray();
    if (collections.length === 0) {
      // Create subscription collection if it doesn't exist
      await orgDb.createCollection("subscription");
      console.log(`Created subscription collection for tenant: ${tenantId}`);
    }

    // Check if there are any existing subscriptions
    const existingSubscription = await orgDb
      .collection("subscription")
      .findOne({});
    if (existingSubscription) {
      console.log(`Tenant ${tenantId} already has a subscription`);
      return false;
    }

    // Create a new subscription
    const currentDate = new Date();
    const endDate = new Date(currentDate);

    if (plan === "free_trial") {
      // For free trial, set end date to X days from now
      endDate.setDate(currentDate.getDate() + trialDays);
    } else {
      // For paid plans, set end date to 1 month from now
      endDate.setMonth(currentDate.getMonth() + 1);
    }

    const subscriptionData = {
      organization_id: orgData._id.toString(),
      tenant_id: tenantId,
      plan: plan,
      status: "active",
      start_date: currentDate,
      end_date: endDate,
      is_trial: plan === "free_trial",
      auto_renew: plan !== "free_trial",
      billing_cycle: plan === "free_trial" ? "trial" : "monthly",
      price_paid:
        plan === "basic"
          ? 799
          : plan === "professional"
          ? 1999
          : plan === "enterprise"
          ? 3999
          : 0,
      next_billing_date: plan === "free_trial" ? null : endDate,
      created_at: currentDate,
      updated_at: currentDate,
    };

    await orgDb.collection("subscription").insertOne(subscriptionData);
    console.log(`Subscription added successfully for tenant: ${tenantId}`);
    return true;
  } catch (error) {
    console.error(`Error adding subscription for tenant ${tenantId}:`, error);
    return false;
  } finally {
    if (client) {
      await client.close();
      console.log(`MongoDB connection closed for tenant: ${tenantId}`);
    }
  }
}

/**
 * Add subscription collection to all organizations
 * @param {string} mongoUrl - MongoDB connection URL
 * @param {string} plan - Default subscription plan (default: free_trial)
 * @param {number} trialDays - Number of days for trial (default: 30)
 */
async function addSubscriptionToAllOrgs(
  mongoUrl,
  plan = "free_trial",
  trialDays = 30
) {
  let client;
  try {
    // Initialize subscription plans first
    await initializeSubscriptionPlans(mongoUrl);

    // Connect to MongoDB
    client = await MongoClient.connect(mongoUrl);
    console.log("Connected to MongoDB");

    // Get all organizations
    const organizations = await Organization.find({});
    console.log(`Found ${organizations.length} organizations`);

    // Process each organization sequentially
    let successCount = 0;
    let failCount = 0;

    for (const org of organizations) {
      const result = await addSubscriptionToOrg(
        mongoUrl,
        org.tenant_id,
        plan,
        trialDays
      );
      if (result) {
        successCount++;
      } else {
        failCount++;
      }
      // Add a small delay to prevent overloading the database
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.log(`Completed adding subscriptions to organizations.`);
    console.log(`Success: ${successCount}, Failed: ${failCount}`);

    return { success: successCount, failed: failCount };
  } catch (error) {
    console.error("Error in batch subscription adding:", error);
    return { success: 0, failed: 0, error: error.message };
  } finally {
    if (client) {
      await client.close();
      console.log("MongoDB connection closed");
    }
  }
}

const addsubscription = async (req, res) => {
  try {
    const {
      mongoUrl,
      tenantId,
      plan = "free_trial",
      trialDays = 30,
    } = req.body;

    if (!mongoUrl || !tenantId) {
      return res.status(400).json({
        success: false,
        message:
          "Missing required parameters: mongoUrl and tenantId are required",
      });
    }

    // Call the helper function, not itself!
    const added = await addSubscriptionToOrg(
      mongoUrl,
      tenantId,
      plan,
      trialDays
    );

    if (added) {
      return res.status(200).json({
        success: true,
        message: `Subscription added successfully for tenant: ${tenantId}`,
      });
    } else {
      return res.status(400).json({
        success: false,
        message: `Failed to add subscription for tenant: ${tenantId}. The organization might not exist or already has a subscription.`,
      });
    }
  } catch (error) {
    console.error("Error in addSubscription controller:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Example usage
module.exports = {
  addSubscriptionToOrg,
  addSubscriptionToAllOrgs,
  initializeSubscriptionPlans,
  addsubscription,
};

/*
// How to use these functions:

// 1. Initialize subscription plans in the main database
await initializeSubscriptionPlans('mongodb://localhost:27017');

// 2. Add subscription to a single organization
await addSubscriptionToOrg('mongodb://localhost:27017', 'tenant-uuid-here', 'free_trial', 30);

// 3. Add subscription to all organizations
await addSubscriptionToAllOrgs('mongodb://localhost:27017', 'free_trial', 30);
*/
