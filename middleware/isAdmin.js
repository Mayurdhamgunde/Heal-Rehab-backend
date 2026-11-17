const jwt = require("jsonwebtoken");
const User = require("../db/userSchema"); // Import the User model
const { getDoctorModel } = require("../db/doctorschema"); // Import the doctor model factory
const { validateSubscription } = require("./checksubscription"); // Import the subscription validation function
const { mongoose } = require("mongoose");
require("dotenv").config();

const authenticateSuperAdmin = async (req, res, next) => {
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
    if (!user.superAdmin) {
      return res.status(403).json({ error: "Access denied. Not admin." });
    }
    req.user = {
      email: userEmail,
      id: user._id,
    };

    await User.updateOne(
      { email: userEmail },
      { $set: { last_login: new Date() } }
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

module.exports = { authenticateSuperAdmin };
