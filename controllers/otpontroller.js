const nodemailer = require("nodemailer");
require("dotenv").config();
const {
  generateOTP,
  generateOTPHash,
  verifyOTP,
} = require("../utils/otpUtils");
const { email } = require("../config/config");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const { generateImageSasToken } = require("../utils/azureutils");
const User = require("../db/userSchema");
const { getDoctorModel } = require("../db/doctorschema");
const Organization = require("../db/OrganizationSchema");
const { getOrgSettingsModel } = require("../db/orgsetting");

// Create email transporter
const transporter = nodemailer.createTransport({
  host: "smtp.office365.com",
  port: 587,
  secure: false,
  auth: {
    user: email.user,
    pass: email.pass,
  },
});

// Object to store temporary OTPs and their hashes
const otpStore = {};

const sendOtp = (req, res) => {
  const { email: userEmail } = req.body;
  const otp = generateOTP();
  const otpHash = generateOTPHash(otp);

  // Store the OTP and its hash temporarily
  otpStore[userEmail] = otpHash;

  const mailOptions = {
    from: `"HealTrack Support" <${email.user}>`,
    to: userEmail,
    subject: "Your HealTrackPro OTP for Account Verification",

    text: `Dear User,

Welcome to HealTrackPro.

To verify your account, please use the One-Time Password (OTP) below:

${otp}

This OTP is valid for a short period and should be used immediately.
For your security, please do not share this code with anyone.

If you did not request this verification, please reply to this email or contact our support team.

Thank you for choosing HealTrack.

Warm regards,
HealTrack Support
support@healtrackai.com
`,

    html: `
  <div style="font-family: Arial, Helvetica, sans-serif; color:#333; line-height:1.6; max-width:600px; margin:0 auto;">

    <h2 style="color:#2c3e50; margin-bottom:16px;">
      Account Verification Code
    </h2>

    <p>Dear User,</p>

    <p>
      Welcome to <strong>Arogya by HealTrack</strong>.
      To complete your account verification, please use the One-Time Password (OTP) below:
    </p>

    <div style="
      margin: 20px 0;
      padding: 14px;
      text-align: center;
      font-size: 22px;
      letter-spacing: 4px;
      font-weight: bold;
      background-color: #f4f6f8;
      border-radius: 6px;
      color: #000;
    ">
      ${otp}
    </div>

    <p>
      This OTP is valid for a limited time. For security reasons, please do not share
      this code with anyone.
    </p>

    <p>
      If you did not request this verification, please reply to this email immediately.
    </p>

    <p style="margin-top:24px;">
      Warm regards,<br/>
      <strong>HealTrack Support</strong><br/>
      support@healtrackai.com
    </p>

    <hr style="border:none; border-top:1px solid #eaeaea; margin:24px 0;" />

    <p style="font-size:12px; color:#777;">
      This is an automated message sent for account security purposes.
    </p>

  </div>
  `,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log(error);
      res.status(500).json({ message: "Failed to send OTP" });
    } else {
      res.status(200).json({ message: "OTP sent successfully" });
    }
  });
};

const OtpVerification = async (req, res) => {
  const { email: userEmail, otp } = req.body;
  const otpHash = otpStore[userEmail];

  if (!otpHash) {
    console.log("Found not");
    return res.status(400).json({ message: "OTP not found" });
  }

  const isOTPVerified = verifyOTP(otp, otpHash);

  if (isOTPVerified) {
    delete otpStore[userEmail];

    try {
      // Find user in the User model
      const user = await User.findOne({ email: userEmail });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }

      // Connect to the organization-specific database
      const dbName = `org_${user.tenant_id.replace(/-/g, "")}`;
      const orgDb = mongoose.connection.useDb(dbName);
      const organization = await Organization.findOne({
        tenant_id: user.tenant_id,
      });
      // Get Doctor model for this specific organization
      const Doctor = getDoctorModel(orgDb);
      // Check if organization has access token
      const OrganizationSettings = getOrgSettingsModel(orgDb);
      const orgSettings = await OrganizationSettings.findOne({
        tenant_id: user.tenant_id,
      });

      const hasAccessToken = !!(orgSettings && orgSettings.access_token);
      // Find the doctor in the organization's database
      const doctor = await Doctor.findOne({ doctor_email: userEmail });

      if (!doctor) {
        return res.status(404).json({ error: "Doctor not found" });
      }

      // Generate SAS token for doctor's photo if it exists
      let doctorPhoto = doctor.doctors_photo;
      if (doctorPhoto) {
        doctorPhoto = await generateImageSasToken(doctor.doctors_photo);
      }

      // Generate JWT token
      const tokenPayload = {
        email: userEmail,
        tenant_id: user.tenant_id,
        doctor_id: doctor._id,
        is_admin: doctor.is_admin,
        doctor_first_name: doctor.doctor_first_name,
        doctor_last_name: doctor.doctor_last_name,
        organization_name: doctor.organization_name,
        doctor_phone: doctor.doctor_phone,
      };

      const token = jwt.sign(tokenPayload, process.env.JWT_SECRET);
      res.status(200).json({
        message: "OTP verification successful",
        token,
        is_admin: doctor.is_admin,
        doctor_id: doctor._id,
        doctor_first_name: doctor.doctor_first_name,
        doctor_last_name: doctor.doctor_last_name,
        doctor_photo: doctorPhoto,
        organization_industry: organization.organization_industry,
        organization_location: organization.organization_locations,
        has_access_token: hasAccessToken, // Add this to the response
      });
    } catch (error) {
      console.error("Error during OTP verification:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  } else {
    console.log("not verfied");
    res.status(400).json({ message: "OTP verification failed" });
  }
};

const OtpVerificationandSetPassword = async (req, res) => {
  const { email: userEmail, password, otp } = req.body;

  const otpHash = otpStore[userEmail];

  if (!otpHash) {
    console.log("OTP not found");
    return res.status(400).json({ message: "OTP not found" });
  }

  const isOTPVerified = verifyOTP(otp, otpHash);

  if (!isOTPVerified) {
    console.log("OTP verification failed");
    return res.status(400).json({ message: "OTP verification failed" });
  }

  delete otpStore[userEmail];

  try {
    // Hash the password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(
      password + process.env.JWT_SECRET_KEY,
      saltRounds,
    );

    // Update the user's password using Mongoose
    const result = await User.updateOne(
      { email: userEmail },
      { $set: { password: hashedPassword } },
    );

    if (result.modifiedCount === 0) {
      return res
        .status(404)
        .json({ error: "User not found or password not updated" });
    }

    res.status(200).json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Error during OTP verification:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
const OtpVerificationSuperAdmin = async (req, res) => {
  const { email: userEmail, otp } = req.body;
  const otpHash = otpStore[userEmail];

  if (!otpHash) {
    console.log("Found not");
    return res.status(400).json({ message: "OTP not found" });
  }

  const isOTPVerified = verifyOTP(otp, otpHash);

  if (isOTPVerified) {
    delete otpStore[userEmail];

    try {
      // Find user in the User model
      const user = await User.findOne({
        email: userEmail.toLowerCase(),
        superAdmin: true,
      });

      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      if (!user) {
        return res.status(403).json({
          message: "Super admin not found or access denied",
        });
      }

      if (!user.password) {
        return res.status(400).json({
          message: "Password not set. Please reset your password.",
        });
      }

      // 3. Generate JWT (minimal + safe)
      const tokenPayload = {
        user_id: user._id,
        email: user.email,
        superAdmin: true,
        role: "superadmin",
      };

      const token = jwt.sign(tokenPayload, process.env.JWT_SECRET);

      // 4. Update last login
      await User.updateOne(
        { _id: user._id },
        { $set: { last_login: new Date() } },
      );

      return res.status(200).json({
        message: "Super admin login successful",
        token,
        role: "superadmin",
        email: user.email,
      });
    } catch (error) {
      console.error("Error during OTP verification:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  } else {
    console.log("not verfied");
    res.status(400).json({ message: "OTP verification failed" });
  }
};

const SuperAdminLogin = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      message: "Email and password are required",
    });
  }

  try {
    // 1. Find super admin user
    const user = await User.findOne({
      email: email.toLowerCase(),
      superAdmin: true,
    });

    if (!user) {
      return res.status(403).json({
        message: "Super admin not found or access denied",
      });
    }

    if (!user.password) {
      return res.status(400).json({
        message: "Password not set. Please reset your password.",
      });
    }

    // 2. Verify password
    const passwordToCheck = password + process.env.JWT_SECRET_KEY;
    const isValid = await bcrypt.compare(passwordToCheck, user.password);

    if (!isValid) {
      return res.status(401).json({
        message: "Invalid credentials",
      });
    }

    // 3. Generate JWT (minimal + safe)
    const tokenPayload = {
      user_id: user._id,
      email: user.email,
      superAdmin: true,
      role: "superadmin",
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET);

    // 4. Update last login
    await User.updateOne(
      { _id: user._id },
      { $set: { last_login: new Date() } },
    );

    return res.status(200).json({
      message: "Super admin login successful",
      token,
      role: "superadmin",
      email: user.email,
    });
  } catch (error) {
    console.error("Super admin login error:", error);
    return res.status(500).json({
      error: "Internal server error",
    });
  }
};

const PasswordVerificationAndLogin = async (req, res) => {
  const { email: userEmail, password } = req.body;

  // Check if password is provided
  if (!password) {
    return res.status(400).json({ message: "Password not provided" });
  }

  try {
    // Find user using Mongoose model
    const user = await User.findOne({ email: userEmail });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if user has a password field
    if (!user.password) {
      return res.status(400).json({
        message: "User has no password set. Please reset your password.",
      });
    }

    // Verify the password using bcrypt with proper error handling
    try {
      const passwordToCheck = password + process.env.JWT_SECRET_KEY;
      const isPasswordCorrect = await bcrypt.compare(
        passwordToCheck,
        user.password,
      );

      if (!isPasswordCorrect) {
        return res.status(400).json({ message: "Invalid password" });
      }
    } catch (bcryptError) {
      console.error("bcrypt error:", bcryptError);
      return res.status(500).json({ error: "Error verifying password" });
    }

    // Connect to the organization-specific database
    const dbName = `org_${user.tenant_id.replace(/-/g, "")}`;
    const orgDb = mongoose.connection.useDb(dbName);
    const organization = await Organization.findOne({
      tenant_id: user.tenant_id,
    });

    // Check if organization has access token
    const OrganizationSettings = getOrgSettingsModel(orgDb);
    const orgSettings = await OrganizationSettings.findOne({
      tenant_id: user.tenant_id,
    });

    const hasAccessToken = !!(orgSettings && orgSettings.access_token);

    // Get Doctor model for this specific organization
    const Doctor = getDoctorModel(orgDb);

    // Find the doctor using Mongoose model
    const doctor = await Doctor.findOne({ doctor_email: userEmail });

    if (!doctor) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    // Generate SAS token for doctor's photo if it exists
    let doctorPhoto = doctor.doctors_photo;
    if (doctorPhoto) {
      doctorPhoto = await generateImageSasToken(doctor.doctors_photo);
    }

    // Generate JWT token
    const tokenPayload = {
      email: userEmail,
      tenant_id: user.tenant_id,
      doctor_id: doctor._id,
      is_admin: doctor.is_admin,
      doctor_first_name: doctor.doctor_first_name,
      doctor_last_name: doctor.doctor_last_name,
      organization_name: doctor.organization_name,
      doctor_phone: doctor.doctor_phone,
      organization_industry: organization.organization_industry,
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET);

    // Update user's last login time
    await User.updateOne(
      { _id: user._id },
      { $set: { last_login: new Date() } },
    );

    return res.status(200).json({
      message: "Password verification successful",
      token,
      is_admin: doctor.is_admin,
      doctor_id: doctor._id,
      doctor_first_name: doctor.doctor_first_name,
      doctor_last_name: doctor.doctor_last_name,
      doctor_photo: doctorPhoto,
      organization_industry: organization.organization_industry,
      organization_location: organization.organization_locations,
      has_access_token: hasAccessToken, // Add this to the response
    });
  } catch (error) {
    console.error("Error during password verification:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
const authSendOtp = (req, res) => {
  const { ngo_authorised_email: userEmail } = req.body;
  const otp = generateOTP();
  const otpHash = generateOTPHash(otp);

  // Store the OTP and its hash temporarily
  otpStore[userEmail] = otpHash;

  const mailOptions = {
    from: email.user,
    to: userEmail,
    subject: "Your OTP for verification",
    text: `Your OTP for verification is: ${otp}`,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log(error);
      res.status(500).json({ message: error });
    } else {
      console.log("Email sent: " + info.response);
      res.status(200).json({ message: "OTP sent successfully" });
    }
  });
};

const authOtpVerification = (req, res) => {
  const { ngo_authorised_email: userEmail, AuthOtp } = req.body;

  // Retrieve the OTP hash corresponding to the user's email
  const otpHash = otpStore[userEmail];

  if (!otpHash) {
    return res.status(400).json({ message: "OTP not found" });
  }

  const isOTPVerified = verifyOTP(AuthOtp, otpHash);

  if (isOTPVerified) {
    // If OTP is verified, remove it from the store
    delete otpStore[userEmail];
    res.json({ message: "OTP verification successful" });
  } else {
    res.status(400).json({ message: "OTP verification failed" });
  }
};
module.exports = {
  sendOtp,
  OtpVerification,
  authOtpVerification,
  authSendOtp,
  OtpVerificationandSetPassword,
  PasswordVerificationAndLogin,
  SuperAdminLogin,
  OtpVerificationSuperAdmin,
};
