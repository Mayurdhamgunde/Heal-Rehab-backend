// config/config.js
require("dotenv").config();
module.exports = {
  email: {
    user: "support@healtrackai.com",
    pass: process.env.Password,
  },
};
