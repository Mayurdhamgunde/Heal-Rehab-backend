const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema.Types;

const invoiceSchema = new mongoose.Schema(
  {
    // --- BASIC DETAILS ---
    invoice_number: {
      type: String,
      required: true,
      unique: true, // Unique within this specific database
      trim: true,
      index: true,
    },
    // Optional: Link to a series config if you have one
    series_id: {
      type: ObjectId,
      ref: "InvoiceSeries",
    },
    invoice_date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    due_date: {
      type: Date,
    },
    type: {
      type: String,
      enum: ["Tax Invoice", "Proforma Invoice", "Bill of Supply"],
      default: "Tax Invoice",
    },
    status: {
      type: String,
      enum: ["Draft", "Sent", "Partially Paid", "Paid", "Overdue", "Cancelled"],
      default: "Draft",
    },

    // --- CUSTOMER SNAPSHOT ---
    // We embed these details so history is preserved even if the Partner changes later
    customer: {
      partner_id: { type: ObjectId, ref: "Partner" },
      name: { type: String, required: true },
      billing_address: {
        street: String,
        city: String,
        state: String,
        zip: String,
        country: String,
      },
      gstin: String,
      place_of_supply: String,
    },

    // --- LINE ITEMS ---
    items: [
      {
        item_name: { type: String, required: true },
        description: String,
        hsn_sac: String,
        quantity: { type: Number, required: true, default: 1 },
        unit: String,
        price_per_unit: { type: Number, required: true }, // Base Price
        discount_percent: { type: Number, default: 0 },
        discount_amount: { type: Number, default: 0 },

        // Tax
        tax_rate: { type: Number, default: 0 },
        tax_amount: { type: Number, default: 0 },
        tax_type: {
          type: String,
          enum: ["GST", "IGST", "NONE"],
          default: "GST",
        },

        // Total for this line
        total_amount: { type: Number, required: true },
      },
    ],

    // --- FINANCIAL SUMMARIES ---
    sub_total: { type: Number, required: true },
    tax_total: { type: Number, default: 0 },
    round_off: { type: Number, default: 0 },
    grand_total: { type: Number, required: true },
    amount_in_words: String,

    // --- PAYMENT TRACKING ---
    balance_due: {
      type: Number,
      default: function () {
        return this.grand_total;
      },
    },
    payments: [
      {
        amount: { type: Number, required: true },
        payment_date: { type: Date, default: Date.now },
        payment_mode: {
          type: String,
          enum: ["Cash", "Online/UPI", "Cheque", "Bank Transfer"],
          default: "Cash",
        },
        reference_no: String,
        notes: String,
      },
    ],

    notes: String, // Terms and Conditions
    created_by: { type: ObjectId, ref: "User" }, // If you track which employee made it
  },
  {
    timestamps: true,
  }
);

// --- MIDDLEWARE ---
invoiceSchema.pre("save", function (next) {
  // 1. Recalculate Balance
  const totalPaid = this.payments
    ? this.payments.reduce((sum, p) => sum + p.amount, 0)
    : 0;
  this.balance_due = this.grand_total - totalPaid;

  // 2. Auto-update Status
  if (this.status !== "Cancelled" && this.status !== "Draft") {
    // Allow small float difference (e.g. 0.01)
    if (this.balance_due <= 0.5) {
      this.status = "Paid";
      this.balance_due = 0;
    } else if (totalPaid > 0) {
      this.status = "Partially Paid";
    } else {
      this.status = "Sent";
    }
  }
  next();
});

// --- EXPORT ---
module.exports = {
  getInvoiceModel: function (connection) {
    return connection.model("Invoice", invoiceSchema, "invoices");
  },
  invoiceSchema,
};
