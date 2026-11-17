const mongoose = require("mongoose");
const { Schema } = mongoose;
const { ObjectId } = mongoose.Types;

const blogSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      minLength: 200,
    },
    image: {
      type: String,
      required: false,
    },
    videos: [
      {
        id: String,
        title: String,
        url: String,
        description: String,
      },
    ],
    genre: {
      type: String,
      required: true,
    },
    readTime: {
      type: String,
      enum: ["2", "3", "4", "5", "6", "7", "8", "9", "10"],
      required: true,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    doctor_id: {
      type: ObjectId,
      ref: "Doctor",
      required: true,
    },
    doctor_name: {
      type: String,
      required: true,
    },
    tenant_id: {
      type: String,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["published", "draft", "archived"],
      default: "published",
    },
    org_name: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

// Create indexes for frequently queried fields
blogSchema.index({ tenant_id: 1 });
blogSchema.index({ doctor_id: 1 });
blogSchema.index({ genero: 1 });
blogSchema.index({ date: -1 });

// Create a dedicated database for blogs
const blogsDb = mongoose.connection.useDb("blogs");
const Blog = blogsDb.model("Blog", blogSchema, "blogs");

module.exports = Blog;
