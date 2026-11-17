const mongoose = require("mongoose");
require("dotenv").config();
const {
  startWhatsAppWorker,
} = require("../controllers/WhatsappQueueController");

const uri = process.env.MONGO_LINK;

const connectDB = async () => {
  try {
    await mongoose.connect(uri);
    startWhatsAppWorker();
    console.log("Connected to db....");
  } catch (error) {
    console.log(error);
  }
};

module.exports = {
  connectDB,
  url: process.env.MONGO_LINK,
  database: "Registration",
  imgBucket: "photos",
};
