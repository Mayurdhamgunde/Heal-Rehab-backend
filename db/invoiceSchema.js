const mongoose = require("mongoose");
const { Schema } = mongoose;
const { ObjectId } = mongoose.Types;

/**
 * ---------------------------------------------
 * 1. INVOICE SERIES SCHEMA
 * Manages auto-incrementing numbers (e.g. INV-001)
 * ---------------------------------------------
 */
const InvoiceSeriesSchema = new Schema(
  {
    series_name: { type: String, required: true, unique: true }, // e.g., "Main Clinic", "B2B Sales"
    prefix: { type: String, required: true }, // e.g., "INV-", "TAX-"
    current_number: { type: Number, default: 0 },
    starting_number: { type: Number, default: 1 },
    number_format: { type: String, default: "####" }, // #### -> 0001
    year_reset: { type: Boolean, default: false }, // Reset to 1 every year?
    last_reset_year: { type: Number },
    is_active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

/**
 * ---------------------------------------------
 * 2. INVOICE ITEM SCHEMA
 * Merged item details (Medical + B2B)
 * ---------------------------------------------
 */
const InvoiceItemSchema = new Schema({
  // Basic Info
  item_name: { type: String, required: true },
  description: { type: String },

  // Tax & Coding (B2B specific)
  hsn_sac: { type: String }, // HSN/SAC Code for GST

  // Quantities
  quantity: { type: Number, required: true, min: 0, default: 1 },
  unit: { type: String, default: "Nos" }, // e.g. "Sessions", "Kg", "Hours"

  // Pricing
  price_per_unit: { type: Number, required: true, min: 0 }, // Base taxable value

  // Discounts
  discount_percent: { type: Number, default: 0, min: 0, max: 100 },
  discount_amount: { type: Number, default: 0, min: 0 },

  // Taxes
  tax_rate: { type: Number, default: 0, min: 0 }, // e.g. 18 for 18%
  tax_amount: { type: Number, default: 0, min: 0 },
  tax_type: { type: String, enum: ["GST", "IGST", "NONE"], default: "GST" },

  // Totals
  line_total: { type: Number, required: true, min: 0 }, // (Price * Qty) - Discount + Tax

  // Medical Specific References (Optional)
  therapy_plan_id: { type: ObjectId, ref: "TherapyPlan" },
  is_therapy_plan: { type: Boolean, default: false },
});

/**
 * ---------------------------------------------
 * 3. MAIN INVOICE SCHEMA
 * ---------------------------------------------
 */
const InvoiceSchema = new Schema(
  {
    // --- IDENTIFICATION ---
    invoice_number: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    series_id: { type: ObjectId, ref: "InvoiceSeries" },

    // Type of Invoice (Tax Invoice vs Bill of Supply vs Proforma)
    type: {
      type: String,
      enum: ["Tax Invoice", "Proforma Invoice", "Bill of Supply"],
      default: "Tax Invoice",
    },

    invoice_date: { type: Date, required: true, default: Date.now },
    due_date: { type: Date },
    po_number: { type: String }, // Purchase Order Number (B2B)
    po_date: { type: Date },

    // --- RECIPIENT (Unified Patient & Partner) ---
    recipient_type: {
      type: String,
      enum: ["Patient", "Partner"],
      default: "Patient", // or Partner
    },
    // Linking IDs (One will be populated)
    patient_id: { type: ObjectId, ref: "Patient" },
    partner_id: { type: ObjectId, ref: "Partner" },

    // Snapshot (Preserves history even if the profile updates)
    recipient_snapshot: {
      name: { type: String, required: true },
      phone: { type: String },
      email: { type: String },
      gstin: { type: String }, // Critical for B2B
      address: {
        street: String,
        city: String,
        state: String,
        zip: String,
        country: String,
      },
      place_of_supply: { type: String }, // e.g. "27-Maharashtra"
    },

    // --- LINE ITEMS ---
    items: [InvoiceItemSchema],

    // --- FINANCIAL CALCULATIONS ---
    sub_total: { type: Number, required: true, default: 0 }, // Sum of (Qty * Price)

    total_discount: { type: Number, default: 0 },

    total_tax: { type: Number, default: 0 },

    // TDS (Tax Deducted at Source - specific to B2B services)
    tds_rate: { type: Number, default: 0, min: 0, max: 100 },
    tds_amount: { type: Number, default: 0 },

    // Final Math
    round_off_amount: { type: Number, default: 0 },
    final_amount: { type: Number, required: true }, // The Payable Amount
    amount_in_words: { type: String },

    // --- PAYMENT TRACKING ---
    payment_status: {
      type: String,
      enum: [
        "Draft",
        "Unpaid",
        "Partially Paid",
        "Paid",
        "Overdue",
        "Cancelled",
        "Sent",
      ],
      default: "Draft",
    },
    payments_received: [
      {
        amount: { type: Number, required: true },
        date: { type: Date, default: Date.now },
        method: {
          type: String,
          enum: ["Cash", "Online/UPI", "Cheque", "Bank Transfer"],
          default: "Cash",
        },
        reference: { type: String }, // Transaction ID
        notes: { type: String },
        recorded_by: { type: ObjectId, ref: "User" },
      },
    ],
    location_name: { type: String },
    location_id: { type: String },
    location_address: { type: String },
    total_paid: { type: Number, default: 0 },
    balance_due: {
      type: Number,
      default: function () {
        return this.final_amount;
      },
    },

    // --- TERMS & META ---
    payment_terms: {
      type: String,
      default: "Due on Receipt",
    },
    notes: { type: String }, // Footer notes
    terms_and_conditions: { type: String },

    // Audit
    created_by: { type: ObjectId, ref: "User", required: true },
    created_by_name: { type: String },

    pdf_url: { type: String },
    viewed_at: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// --- VIRTUALS ---

// Check if overdue
InvoiceSchema.virtual("is_overdue").get(function () {
  if (
    !this.due_date ||
    this.payment_status === "Paid" ||
    this.payment_status === "Cancelled"
  )
    return false;
  return new Date() > this.due_date;
});

// Calculate days overdue
InvoiceSchema.virtual("days_overdue").get(function () {
  if (!this.is_overdue) return 0;
  const today = new Date();
  const overdueDays = Math.ceil(
    (today - this.due_date) / (1000 * 60 * 60 * 24),
  );
  return overdueDays;
});

// --- INDEXES ---
InvoiceSchema.index({ invoice_number: 1 });
InvoiceSchema.index({ "recipient_snapshot.name": "text" }); // Search by recipient name
InvoiceSchema.index({ partner_id: 1, invoice_date: -1 });
InvoiceSchema.index({ patient_id: 1, invoice_date: -1 });
InvoiceSchema.index({ status: 1 });

// --- MIDDLEWARE: CALCULATIONS ---
// --- MIDDLEWARE: CALCULATIONS ---
InvoiceSchema.pre("save", function (next) {
  // 1. Calculate Subtotal
  this.sub_total = this.items.reduce(
    (sum, item) => sum + item.quantity * item.price_per_unit,
    0,
  );

  // 2. Calculate Totals
  this.total_discount = this.items.reduce(
    (sum, item) => sum + (item.discount_amount || 0),
    0,
  );
  this.total_tax = this.items.reduce(
    (sum, item) => sum + (item.tax_amount || 0),
    0,
  );

  // 3. Taxable & Final Logic
  const taxableValue = this.sub_total - this.total_discount;
  const totalWithTax = taxableValue + this.total_tax;
  this.tds_amount = (totalWithTax * (this.tds_rate || 0)) / 100;
  const preRoundTotal = totalWithTax - this.tds_amount;

  if (!this.final_amount) {
    this.final_amount = Math.round(preRoundTotal);
    this.round_off_amount = this.final_amount - preRoundTotal;
  }

  // 4. Update Payment Status (THE FIX IS HERE)
  this.total_paid = this.payments_received.reduce(
    (sum, p) => sum + p.amount,
    0,
  );
  this.balance_due = this.final_amount - this.total_paid;

  // Only auto-update status if it's not Draft or Cancelled
  if (this.payment_status !== "Draft" && this.payment_status !== "Cancelled") {
    // A. Check for Fully Paid
    if (this.balance_due <= 1.0) {
      this.payment_status = "Paid";
      this.balance_due = 0;
    }
    // B. Check for Partial Payment
    else if (this.total_paid > 0) {
      this.payment_status = "Partially Paid";
    }
    // C. Check for Overdue
    else if (this.is_overdue) {
      this.payment_status = "Overdue";
    }
    // D. PRESERVE "SENT" STATUS
    // If it's already "Sent" and has a balance, keep it "Sent".
    // Don't force it to "Unpaid".
    else if (this.payment_status === "Sent") {
      this.payment_status = "Sent";
    }
    // E. Default to Unpaid
    else {
      this.payment_status = "Unpaid";
    }
  }

  next();
});

// --- STATIC METHODS ---

// Auto-generate next Invoice Number
InvoiceSeriesSchema.statics.getNextInvoiceNumber = async function (
  seriesId,
  connection,
) {
  const SeriesModel = connection ? connection.model("InvoiceSeries") : this;
  const series = await SeriesModel.findById(seriesId);
  if (!series) throw new Error("Invoice series not found");

  const currentYear = new Date().getFullYear();

  // Year Reset Logic
  if (series.year_reset && series.last_reset_year !== currentYear) {
    series.current_number = series.starting_number;
    series.last_reset_year = currentYear;
  } else {
    series.current_number += 1;
  }

  await series.save();

  // Format: PRE-0001
  const paddedNumber = String(series.current_number).padStart(
    series.number_format.length,
    "0",
  );
  const invoiceNumber = `${series.prefix}${paddedNumber}`;

  // Format: PRE-0001-2024 (Optional year suffix)
  if (series.year_reset) {
    return `${invoiceNumber}-${currentYear}`;
  }

  return invoiceNumber;
};

// --- INSTANCE METHODS ---

// Record Payment Helper
InvoiceSchema.methods.recordPayment = function (
  amount,
  method = "Cash",
  reference = "",
  notes = "",
  userId = null,
) {
  const payAmount = parseFloat(amount);
  if (payAmount <= 0) throw new Error("Payment must be > 0");

  if (payAmount > this.balance_due + 1) {
    // +1 tolerance
    throw new Error("Payment exceeds balance");
  }

  this.payments_received.push({
    amount: payAmount,
    method,
    reference,
    notes,
    recorded_by: userId,
  });

  return this.save(); // Middleware will handle status updates
};

// --- EXPORT ---
module.exports = {
  getInvoiceModel: function (connection) {
    return connection.model("Invoice", InvoiceSchema, "invoices");
  },
  getInvoiceSeriesModel: function (connection) {
    return connection.model(
      "InvoiceSeries",
      InvoiceSeriesSchema,
      "invoice_series",
    );
  },
  InvoiceSchema,
  InvoiceSeriesSchema,
};
