const cron = require("node-cron");
const mongoose = require("mongoose");
const Organization = require("../db/OrganizationSchema"); // Adjust path as needed
const { getSubscriptionModel } = require("../db/subscriptionSchema");
const { getNotificationModel } = require("../db/notificationSchema");
const {
  processRelapseRisksForCompletedPlans,
} = require("../controllers/aiController");

/**
 * Check subscription expiry for a single organization
 * @param {Object} organization - Organization data
 */
const checkOrganizationSubscriptionExpiry = async (organization) => {
  try {
    const { tenant_id, organization_name } = organization;

    // Connect to organization-specific database
    const dbName = `org_${tenant_id.replace(/-/g, "")}`;
    const orgDb = mongoose.connection.useDb(dbName);

    // Get models for this organization
    const Subscription = getSubscriptionModel(orgDb);
    const Notification = getNotificationModel(orgDb);

    // Find active subscriptions for this organization
    const subscriptions = await Subscription.find({
      tenant_id,
      status: "active",
    });

    if (!subscriptions || subscriptions.length === 0) {
      console.log(
        `No active subscriptions found for organization: ${organization_name}`,
      );
      return;
    }

    const currentDate = new Date();

    for (const subscription of subscriptions) {
      // Calculate days remaining until expiration
      const timeDiff = subscription.end_date.getTime() - currentDate.getTime();
      const daysRemaining = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));

      console.log(
        `Organization: ${organization_name}, Plan: ${subscription.plan}, Days remaining: ${daysRemaining}`,
      );

      // Check if subscription has expired
      if (daysRemaining <= 0) {
        // Update subscription status to expired
        await Subscription.updateOne(
          { _id: subscription._id },
          {
            $set: {
              status: "expired",
              updated_at: new Date(),
            },
          },
        );

        // Create expired notification
        const expiredNotification = Notification.createExpiryNotification(
          tenant_id,
          subscription.organization_id,
          subscription,
          daysRemaining,
        );

        // Check if similar notification already exists in the last 24 hours
        const existingNotification = await Notification.findOne({
          tenant_id,
          type: "subscription_expired",
          "metadata.subscription_plan": subscription.plan,
          created_at: {
            $gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
          },
        });

        if (!existingNotification) {
          await expiredNotification.save();
          console.log(`Created expired notification for ${organization_name}`);
        }

        continue;
      }

      // Check if subscription expires in 3 days or less
      if (daysRemaining <= 5) {
        // Create expiry warning notification
        const warningNotification = Notification.createExpiryNotification(
          tenant_id,
          subscription.organization_id,
          subscription,
          daysRemaining,
        );

        // Check if similar notification already exists for this day
        const existingWarning = await Notification.findOne({
          tenant_id,
          type: "subscription_expiry_warning",
          "metadata.subscription_plan": subscription.plan,
          "metadata.days_remaining": daysRemaining,
          created_at: {
            $gte: new Date(
              currentDate.getFullYear(),
              currentDate.getMonth(),
              currentDate.getDate(),
            ),
            $lt: new Date(
              currentDate.getFullYear(),
              currentDate.getMonth(),
              currentDate.getDate() + 1,
            ),
          },
        });

        if (!existingWarning) {
          await warningNotification.save();
          console.log(
            `Created expiry warning notification for ${organization_name} (${daysRemaining} days remaining)`,
          );
        }
      }
    }
  } catch (error) {
    console.error(
      `Error checking subscription expiry for organization ${organization.organization_name}:`,
      error,
    );
  }
};

/**
 * Check subscription expiry for all organizations
 */
const checkAllOrganizationsSubscriptionExpiry = async () => {
  try {
    console.log(
      "Starting daily subscription expiry check at",
      new Date().toISOString(),
    );

    // Get all organizations
    const organizations = await Organization.find(
      {},
      {
        tenant_id: 1,
        organization_name: 1,
        organization_email: 1,
      },
    );

    if (!organizations || organizations.length === 0) {
      console.log("No organizations found");
      return;
    }

    console.log(`Found ${organizations.length} organizations to check`);

    // Process each organization
    for (const organization of organizations) {
      await checkOrganizationSubscriptionExpiry(organization);
    }

    console.log(
      "Completed daily subscription expiry check at",
      new Date().toISOString(),
    );
  } catch (error) {
    console.error("Error in daily subscription expiry check:", error);
  }
};

/**
 * Clean up old notifications (optional utility)
 */
const cleanupOldNotifications = async () => {
  try {
    console.log("Starting notification cleanup at", new Date().toISOString());

    const organizations = await Organization.find({}, { tenant_id: 1 });

    for (const organization of organizations) {
      const dbName = `org_${organization.tenant_id.replace(/-/g, "")}`;
      const orgDb = mongoose.connection.useDb(dbName);
      const Notification = getNotificationModel(orgDb);

      // Archive notifications older than 30 days that are already read
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      await Notification.updateMany(
        {
          status: "read",
          created_at: { $lt: thirtyDaysAgo },
        },
        {
          $set: {
            status: "archived",
            archived_at: new Date(),
            updated_at: new Date(),
          },
        },
      );

      // Delete notifications that have expired
      await Notification.deleteMany({
        expires_at: { $lt: new Date() },
      });
    }

    console.log("Completed notification cleanup at", new Date().toISOString());
  } catch (error) {
    console.error("Error in notification cleanup:", error);
  }
};
const { getPatientModel } = require("../db/patientSchema");
const { getTherapyPlanModel } = require("../db/therepy");
const moment = require("moment-timezone");
const pushPastFollowUpsToNextSunday = async () => {
  try {
    console.log(
      "Starting weekly follow-up rollover job at",
      new Date().toISOString(),
    );

    // Define the time window for "last week" (7 days ago up to yesterday)
    const today = moment().tz("Asia/Kolkata").startOf("day");
    const lastWeekStart = moment(today).subtract(7, "days").toDate();
    const yesterdayEnd = moment(today).subtract(1, "milliseconds").toDate();

    // Calculate next week's Sunday
    const nextSunday = moment()
      .tz("Asia/Kolkata")
      .add(1, "weeks")
      .day(0)
      .startOf("day")
      .toDate();

    // Fetch all organizations[cite: 1]
    const organizations = await Organization.find({}, { tenant_id: 1 });

    if (!organizations || organizations.length === 0) {
      console.log("No organizations found for follow-up rollover.");
      return;
    }

    for (const org of organizations) {
      // Connect to the specific organization's database[cite: 1]
      const dbName = `org_${org.tenant_id.replace(/-/g, "")}`;
      const orgDb = mongoose.connection.useDb(dbName);

      const Patient = getPatientModel(orgDb);
      const TherapyPlan = getTherapyPlanModel(orgDb);

      // Fetch patients with follow-ups in the last week and populate their therapy plans[cite: 3]
      const patients = await Patient.find({
        follow_Up_Date: {
          $gte: lastWeekStart,
          $lte: yesterdayEnd,
        },
      })
        .select("follow_Up_Date therapy_plans")
        .populate({
          path: "therapy_plans",
          select: "closure_reason status",
          model: TherapyPlan,
        });

      let updatedCount = 0;

      for (const patient of patients) {
        if (!patient.therapy_plans || patient.therapy_plans.length === 0)
          continue;

        // Retrieve the most recent therapy plan
        const latestPlan =
          patient.therapy_plans[patient.therapy_plans.length - 1];

        // Normalize the closure reason for safe checking
        const closureReason = (latestPlan.closure_reason || "")
          .trim()
          .toLowerCase();

        // Ensure the closure reason includes "complete" but strictly excludes "incomplete"
        const isComplete =
          closureReason.includes("complete") &&
          !closureReason.includes("incomplete");

        if (isComplete) {
          // Update the patient's follow-up date to next week's Sunday[cite: 2]
          await Patient.findByIdAndUpdate(patient._id, {
            $set: { follow_Up_Date: nextSunday },
          });
          updatedCount++;
        }
      }

      console.log(
        `Rolled over ${updatedCount} follow-ups for database: ${dbName}`,
      );
    }

    console.log(
      "Completed weekly follow-up rollover job at",
      new Date().toISOString(),
    );
  } catch (error) {
    console.error("Error in weekly follow-up rollover job:", error);
  }
};
const generateWeeklyRelapseRisks = async () => {
  try {
    console.log(
      "Starting weekly relapse risk generation at",
      new Date().toISOString(),
    );

    // 1. Define the specific organizations you want to process
    const targetTenants = ["ad66a317-af68-4b3d-a294-5ed47182a591"]; // Replace with actual tenant IDs

    // 2. Filter the database query to only fetch those tenants
    const organizations = await Organization.find(
      { tenant_id: { $in: targetTenants } },
      { tenant_id: 1 },
    );

    if (!organizations || organizations.length === 0) {
      console.log(
        "No matching organizations found for relapse risk processing.",
      );
      return;
    }

    for (const organization of organizations) {
      const dbName = `org_${organization.tenant_id.replace(/-/g, "")}`;
      const orgDb = mongoose.connection.useDb(dbName);

      console.log(`Processing relapse risks for database: ${dbName}`);
      await processRelapseRisksForCompletedPlans(orgDb);
    }

    console.log(
      "Completed weekly relapse risk generation at",
      new Date().toISOString(),
    );
  } catch (error) {
    console.error("Error in weekly relapse risk generation:", error);
  }
};

/**
 * Initialize cron jobs
 */
const initializeSubscriptionCronJobs = () => {
  // Daily subscription expiry check at 9:00 AM
  cron.schedule("03 17 * * *", checkAllOrganizationsSubscriptionExpiry, {
    timezone: "Asia/Kolkata",
    scheduled: true,
  });

  // Weekly notification cleanup on Sundays at 2:00 AM
  cron.schedule("0 2 * * 0", cleanupOldNotifications, {
    timezone: "Asia/Kolkata",
    scheduled: true,
  });
  // cron.schedule("53 12 * * *", pushPastFollowUpsToNextSunday, {
  //   timezone: "Asia/Kolkata",
  //   scheduled: true,
  // });
  // console.log(
  //   "Initialized Follow-up Rollover Cron Job: Every night at 12:00 AM",
  // );
  // cron.schedule("13 17 * * 5", generateWeeklyRelapseRisks, {
  //   timezone: "Asia/Kolkata",
  //   scheduled: true,
  // });
  console.log("Subscription expiry cron jobs initialized:");
  console.log("- Daily expiry check: Every day at 9:00 AM");
  console.log("- Weekly cleanup: Every Sunday at 2:00 AM");
  console.log("- Weekly Relapse Risk AI batch: Every Sunday at 2:00 AM");
};

/**
 * Manual trigger for testing (can be called via API endpoint)
 */
const triggerManualExpiryCheck = async (tenant_id = null) => {
  try {
    if (tenant_id) {
      // Check specific organization
      const organization = await Organization.findOne({ tenant_id });
      if (organization) {
        await checkOrganizationSubscriptionExpiry(organization);
        return {
          success: true,
          message: `Expiry check completed for ${organization.organization_name}`,
        };
      } else {
        return { success: false, message: "Organization not found" };
      }
    } else {
      // Check all organizations
      await checkAllOrganizationsSubscriptionExpiry();
      return {
        success: true,
        message: "Expiry check completed for all organizations",
      };
    }
  } catch (error) {
    console.error("Error in manual expiry check:", error);
    return {
      success: false,
      message: "Error during expiry check",
      error: error.message,
    };
  }
};

module.exports = {
  initializeSubscriptionCronJobs,
  checkAllOrganizationsSubscriptionExpiry,
  checkOrganizationSubscriptionExpiry,
  triggerManualExpiryCheck,
  cleanupOldNotifications,
};
