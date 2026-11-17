const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const expenseSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    category: {
      type: String,
      required: true,
      // e.g., "Equipment", "Salary", "Utilities", "Maintenance", "Miscellaneous"
    },
    expenseDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    paymentMethod: {
      type: String,
      enum: ["Cash", "Credit Card", "Bank Transfer", "UPI", "Other"],
      default: "Cash",
    },
    inovoiceNumber: {
      type: String,
    },
    vendor_name: { type: String },
    status: {
      type: String,
      enum: ["Pending", "Paid", "Cancelled"],
      default: "Paid",
    },
    addedById: {
      type: ObjectId,
      ref: "doctors", // Or "users" depending on your primary auth collection
      required: true,
      index: true,
    },
    addedByName: {
      type: String,
      required: true,
    },
    notes: {
      type: String,
    },
    receiptUrl: {
      type: String, // Useful if you upload bills/receipts to Azure/AWS
    },
  },
  { timestamps: true },
);

module.exports = {
  getExpenseModel: function (connection) {
    return connection.model("Expense", expenseSchema, "expenses");
  },
  expenseSchema,
};
