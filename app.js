require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const { connectDB, url, database, imgBucket } = require("./db/connect");
const routes = require("./routers/route");
const { sessionMiddleware, connectOrgDb } = require("./middleware/orgConnect");
const { initializeSubscriptionCronJobs } = require("./utils/cronjobs");
const Mediprorouter = require("./routers/mediproroutes");
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  "https://healtrackai.com",
  "https://www.healtrackai.com",
  "https://doctor.healtrackai.com",
  "https://www.doctor.healtrackai.com",
  "https://doctor.healtrack.ai",
  "https://www.doctor.healtrack.ai",
  "https://admin.healtrack.ai",
  "https://www.admin.healtrack.ai",
  "https://admin.healtrackai.com",
  "https://www.admin.healtrackai.com",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:8081",
  "https://rehab.healtrack.ai",
  "https://www.rehab.healtrack.ai",
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS: " + origin));
    }
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use(sessionMiddleware);
app.use("", routes);
app.use("/medipro", Mediprorouter);
const start = async () => {
  try {
    await connectDB();
    initializeSubscriptionCronJobs();
    app.listen(PORT, () => {
      console.log(`Server is connected on port ${PORT}`);
    });
  } catch (error) {
    console.error("Error connecting to the database:", error);
    process.exit(1);
  }
};

start();
