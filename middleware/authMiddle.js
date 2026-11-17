const jwt = require("jsonwebtoken");
const User = require("../db/userSchema"); // Import the User model
const { getDoctorModel } = require("../db/doctorschema"); // Import the doctor model factory
const { validateSubscription } = require("./checksubscription"); // Import the subscription validation function
const { mongoose } = require("mongoose");
require("dotenv").config();

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).json({ error: "Invalid token format" });
    }

    // Verify the JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userEmail = decoded.email;

    // Find the user using Mongoose
    const user = await User.findOne({ email: userEmail });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Construct the organization-specific database name
    const dbName = `org_${user.tenant_id.replace(/-/g, "")}`;

    // Access the organization-specific database using the existing connection
    const orgDb = mongoose.connection.useDb(dbName);

    // Get the Doctor model for this organization
    const Doctor = getDoctorModel(orgDb);

    // Find the doctor using the Doctor model
    const doctor = await Doctor.findOne({ doctor_email: userEmail });

    if (!doctor) {
      return res.status(404).json({ error: "Doctor not found" });
    }
    if (doctor.status === "inactive" || doctor.status === "Inactive") {
      return res.status(403).json({ msg: "You are Inactive" });
    }

    // ── ACTIVE HOURS CHECK ──────────────────────────────────────────────────
    // Only enforced when active_hours.enabled === true AND type === "fixed"
    const activeHours = doctor.active_hours;
    if (activeHours?.enabled && activeHours?.type === "fixed") {
      // Use IST (Asia/Kolkata) to match the app's timezone convention
      const nowIST = new Date(
        new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
      );
      const currentMinutes = nowIST.getHours() * 60 + nowIST.getMinutes();

      const [startH, startM] = (activeHours.start || "09:00")
        .split(":")
        .map(Number);
      const [endH, endM] = (activeHours.end || "18:00").split(":").map(Number);

      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      if (currentMinutes < startMinutes || currentMinutes >= endMinutes) {
        return res.status(403).json({
          error: "Outside active hours",
          message: `Access is only allowed between ${activeHours.start} and ${activeHours.end} (IST). Please try again during your active hours.`,
          active_hours: {
            start: activeHours.start,
            end: activeHours.end,
          },
        });
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    // Validate subscription (add this section)
    const subscriptionStatus = await validateSubscription(
      orgDb,
      user.tenant_id,
    );

    // If subscription is not valid, return error (except for specific routes that don't require active subscription)
    if (!subscriptionStatus.valid) {
      return res.status(403).json({
        error: "Subscription Expired",
        message: subscriptionStatus.error,
      });
    }

    // Add user, doctor, and subscription information to the request object
    req.user = {
      email: userEmail,
      tenant_id: user.tenant_id,
      refreshToken: user.refresh_token,
      doctor_id: doctor._id,
      is_admin: doctor.is_admin,
      doctor_first_name: doctor.doctor_first_name,
      doctor_last_name: doctor.doctor_last_name,
      organization_name: doctor.organization_name,
      department_id: doctor.department_id,
      doctor_phone: doctor.doctor_phone,
      dbName: dbName,
    };

    // Add subscription info if valid
    if (subscriptionStatus.valid) {
      req.subscription = {
        plan: subscriptionStatus.plan,
        is_trial: subscriptionStatus.is_trial,
        end_date: subscriptionStatus.end_date,
        auto_renew: subscriptionStatus.auto_renew,
        expiring_soon: subscriptionStatus.expiring_soon,
        days_remaining: subscriptionStatus.days_remaining,
      };
    }

    req.doctor_id = doctor._id;
    req.orgDb = orgDb;
    // Update last_login timestamp
    await User.updateOne(
      { email: userEmail },
      { $set: { last_login: new Date() } },
    );

    next();
  } catch (error) {
    console.error("Error authenticating token:", error);

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token has expired" });
    }

    res.status(401).json({ error: "Invalid token" });
  }
};

module.exports = { authenticateToken };
