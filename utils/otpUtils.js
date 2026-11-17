// utils/otpUtils.js

const crypto = require("crypto");

// Function to generate a random OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Function to generate hash for an OTP
function generateOTPHash(otp) {
  const hash = crypto.createHash("sha256");
  hash.update(otp);
  return hash.digest("hex");
}

// Function to verify OTP against its hash
function verifyOTP(otp, otpHash) {
  const hash = generateOTPHash(otp);
  return hash === otpHash;
}

module.exports = { generateOTP, generateOTPHash, verifyOTP };
