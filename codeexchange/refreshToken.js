// refreshToken.js
const { OAuth2Client } = require("google-auth-library");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
require("dotenv").config();

// Organization settings schema
const organizationSettingsSchema = new mongoose.Schema({
  tenant_id: {
    type: String,
    required: true,
    unique: true,
  },
  access_token: {
    type: String,
    required: true,
  },
  google_calendar_refresh_token: {
    type: String,
    required: true,
  },
  last_updated: {
    type: Date,
    default: Date.now,
  },
  updated_by: {
    type: String,
    required: true,
  },
});

// Helper function to get organization settings model
const getOrgSettingsModel = (db) => {
  return db.model(
    "OrganizationSettings",
    organizationSettingsSchema,
    "organization_settings"
  );
};

// User schema (simplified - adjust as needed for your actual User model)
const User = require("../db/userSchema");

const webClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_SECRET,
  "postmessage"
);

const mobileClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_SECRET,
  "https://dev-e2ng22nf1lkiirzs.us.auth0.com/login/callback"
);

const exchange = async (req, res) => {
  const { serverAuthCode, clientType } = req.body;
  const { user, orgDb } = req;
  try {
    if (!user.is_admin) {
      return res.status(403).json({
        error:
          "Unauthorized: Only administrators can manage calendar integration",
      });
    }
    const client = clientType === "web" ? webClient : mobileClient;
    const { tokens } = await client.getToken(serverAuthCode);
    const { access_token, refresh_token, expiry_date } = tokens;

    // Use the helper function to get the model
    const OrgSettings = getOrgSettingsModel(orgDb);

    await OrgSettings.updateOne(
      { tenant_id: user.tenant_id },
      {
        $set: {
          google_calendar_refresh_token: refresh_token,
          access_token: access_token,
          last_updated: new Date(),
          updated_by: user.email,
        },
      },
      { upsert: true }
    );

    res.json({
      accessToken: access_token,
      expiresIn: (expiry_date - Date.now()) / 1000,
    });
  } catch (error) {
    console.error("Error exchanging auth code:", error);
    res.status(500).json({ error: "Token exchange failed" });
  }
};

const refreshToken = async (tenant_id) => {
  try {
    const formattedDb = `org_${tenant_id.replace(/-/g, "")}`;
    const orgDb = mongoose.connection.useDb(formattedDb);
    const OrgSettings = getOrgSettingsModel(orgDb);

    const orgSettings = await OrgSettings.findOne({ tenant_id });

    if (!orgSettings?.google_calendar_refresh_token) {
      throw new Error("No refresh token found for organization");
    }

    mobileClient.setCredentials({
      refresh_token: orgSettings.google_calendar_refresh_token,
    });
    const { credentials } = await mobileClient.refreshAccessToken();

    await OrgSettings.updateOne(
      { tenant_id },
      {
        $set: {
          access_token: credentials.access_token,
          last_updated: new Date(),
        },
      }
    );

    return credentials.access_token;
  } catch (error) {
    console.error("Error refreshing token:", error);
    throw error;
  }
};

const getLiveSwitchToken = async (req, res) => {
  const { code } = req.body;
  if (!code)
    return res.status(400).json({ error: "Authorization code is required" });

  const options = {
    method: "POST",
    url: "https://supbubble-prod.us.auth0.com/oauth/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    data: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: process.env.LIVESWITCH_CLIENT_ID,
      client_secret: process.env.LIVESWITCH_CLIENT_SECRET,
      code,
      redirect_uri: "physio.gem.auth://callback",
    }),
  };

  try {
    const response = await axios.request(options);
    const { access_token, refresh_token, expires_in, token_type } =
      response.data;
    return res.status(200).json({
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresIn: expires_in,
      tokenType: token_type,
    });
  } catch (error) {
    console.error("LiveSwitch error:", error);
    const errData = error.response?.data;
    if (errData?.access_token) {
      return res.status(200).json({
        accessToken: errData.access_token,
        refreshToken: errData.refresh_token,
        expiresIn: errData.expires_in,
        tokenType: errData.token_type,
      });
    }
    return res.status(500).json({
      error: "LiveSwitch token exchange failed",
      details: error.message,
    });
  }
};

const verifyToken = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ error: "No token provided" });

    const token = authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Invalid token format" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findOne({ email: decoded.email });

    if (!user) return res.status(404).json({ error: "User not found" });

    const dbName = `org_${user.tenant_id.replace(/-/g, "")}`;
    const orgDb = mongoose.connection.useDb(dbName);

    // Create Doctor model
    const doctorSchema = new mongoose.Schema({}, { strict: false });
    const Doctor = orgDb.model("Doctor", doctorSchema, "doctors");

    const doctor = await Doctor.findOne({ email: decoded.email });

    if (!doctor) return res.status(404).json({ error: "Doctor not found" });

    return res.json({
      is_admin: user.is_admin || false,
      doctor_first_name: doctor.doctor_first_name || "",
      doctor_last_name: doctor.doctor_last_name || "",
      email: decoded.email,
      tenant_id: user.tenant_id,
      organization_name: doctor.organization_name || "",
      doctor_phone: doctor.doctor_phone || "",
    });
  } catch (error) {
    console.error("Error verifying token:", error);
    return res.status(401).json({ error: "Failed to verify token" });
  }
};

module.exports = { exchange, refreshToken, getLiveSwitchToken, verifyToken };
