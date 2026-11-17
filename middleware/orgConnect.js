const { MongoClient } = require("mongodb");
const session = require("express-session");
const MongoStore = require("connect-mongo");

// MongoDB connection string
const mongoUrl = process.env.MONGO_LINK;

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: mongoUrl }),
  cookie: { secure: process.env.NODE_ENV === "production" },
});
module.exports = { sessionMiddleware };
