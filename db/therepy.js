const mongoose = require("mongoose");
const { Schema } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/**
 * Therapy Session Schema
 * Represents individual therapy sessions
 */
const TherapySessionSchema = new Schema(
  {
    patient_id: { type: String, required: true },
    patient_name: { type: String, required: true },
    therepy_id: { type: String }, // LiveSwitch conversation ID
    therepy_type: {
      type: String,
      required: true,
      enum: [
        "In Clinic",
        "In Home",
        "IP/ICU",
        "Online",
        "Individual",
        "Family",
        "Group",
        "Aftercare",
        "Follow-up",
      ],
    },
    prescription_id: { type: ObjectId, ref: "Prescription" },
    is_consultation: { type: Boolean },
    consultationId: { type: ObjectId },
    therepy_link: { type: String }, // For virtual sessions
    host_join_link: { type: String },
    therepy_start_time: { type: String }, // Format: HH:mm
    therepy_end_time: { type: String }, // Format: HH:mm
    therepy_date: { type: String, required: true }, // Format: YYYY-MM-DD
    doctor_id: { type: ObjectId, required: true, ref: "Doctor" },
    doctor_name: { type: String, required: true },
    plan_id: { type: ObjectId, ref: "TherapyPlan" },
    conversation_status: { type: String },
    embedded_conversation_url: { type: String },
    google_calendar_event_id: { type: String },
    created_by: { type: ObjectId, ref: "Doctor" },
    session_start_time: { type: Date },
    patientUser: { type: ObjectId },
    session_end_time: { type: Date },
    session_duration: { type: Number }, // In minutes
    session_number: { type: Number },
    location_address: { type: String },
    location_name: { type: String },
    location_id: { type: String },
    source: {
      type: String,
      enum: ["patient", "doctor"],
      default: "doctor",
    },
    status: {
      type: String,
      enum: [
        "Scheduled",
        "in_progress",
        "pending_counselor",
        "pending_medical",
        "completed",
        "Completed",
        "Cancelled",
        "No Show",
      ],
      default: "Scheduled",
    },
    notes: { type: String },
    // Added presession and postsession remarks fields
    presession_remarks: { type: String },
    postsession_remarks: { type: String },
    issue_dealt_with: { type: String },
    counselor_impression: { type: String },

    // ─────────────────────────────────────────────
    // FOLLOW-UP & RECOVERY METRICS (NEW)
    // ─────────────────────────────────────────────
    patient_complaints: { type: String },
    issues_addressed: { type: String },
    recovery_status: { type: String },
    other_communication: { type: String },
    recovery_domain_scores: {
      alcohol_drug_free: { type: Number, default: 0 },
      physical_well_being: { type: Number, default: 0 },
      family_relationships: { type: Number, default: 0 },
      crime_free_status: { type: Number, default: 0 },
      gainfully_employed: { type: Number, default: 0 },
      financial_stability: { type: Number, default: 0 },
    },
    total_recovery_score: { type: Number, default: 0 },

    // ─────────────────────────────────────────────
    // AFTERCARE — TWO-DOCTOR TEAM
    // Every Aftercare session is jointly owned by a
    // physician and a counsellor. doctor_id/doctor_name
    // above are mirrored from the physician so existing
    // doctor-scoped queries keep working; this object is
    // the authoritative per-role record.
    // ─────────────────────────────────────────────
    aftercare_team: {
      physician_id: { type: ObjectId, ref: "Doctor" },
      physician_name: { type: String },
      counsellor_id: { type: ObjectId, ref: "Doctor" },
      counsellor_name: { type: String },
    },
    aftercare_meta: {
      phase: {
        type: String,
        enum: ["monthly_monitoring", "relapse_prevention"],
      },
      offset_months: { type: Number },
      sequence_index: { type: Number }, // 0-based position in the overall schedule
      reference_date: { type: String }, // YYYY-MM-DD anchor, same across the whole journey
      config_snapshot: {
        monthly_sessions: { type: Number },
        relapse_offsets: { type: [Number] },
        session_start_time: { type: String },
        session_end_time: { type: String },
      },
    },
    attachments: [
      {
        name: { type: String },
        url: { type: String },
        type: { type: String },
        size: { type: Number },
        uploaded_at: { type: Date, default: Date.now },
      },
    ],

    // ─────────────────────────────────────────────
    // REHAB INDICATORS
    // Counsellor-assessed per Individual session.
    // All fields optional — fill what's observable,
    // skip what isn't relevant to this session.
    // ─────────────────────────────────────────────
    rehab_indicators: {
      // How strong is the urge to use right now?
      craving_intensity: {
        type: String,
        enum: ["none", "mild", "moderate", "strong", "overwhelming"],
        default: null,
      },

      // Is the patient actually participating in the therapeutic process?
      behavioural_compliance: {
        type: String,
        enum: ["resistant", "passive", "cooperative", "engaged", "proactive"],
        default: null,
      },

      // How regulated is the patient emotionally — not just their mood?
      emotional_stability: {
        type: String,
        enum: ["volatile", "distressed", "unsettled", "stable", "regulated"],
        default: null,
      },

      // Self-reported or counsellor-observed sleep from the previous night
      sleep_quality: {
        type: String,
        enum: ["none", "poor", "disturbed", "fair", "restful"],
        default: null,
      },

      // Counsellor's overall read on this session — one line max
      session_impression: {
        type: String,
        enum: [
          "concerning",
          "below_expectations",
          "neutral",
          "positive",
          "breakthrough",
        ],
        default: null,
      },
    },

    // ─────────────────────────────────────────────
    // CLINICAL OBSERVATIONS
    // Physical state — observable by counsellor or
    // nurse at the time of the session.
    // Kept separate from rehab_indicators so they
    // can be queried and displayed independently.
    // ─────────────────────────────────────────────
    clinical_observations: {
      // Active withdrawal symptoms at time of session — multi-select
      withdrawal_symptoms: {
        type: [String],
        enum: ["tremors", "sweating", "nausea", "insomnia", "none"],
        default: [],
      },

      // How the patient is eating — counsellor or nurse observed
      appetite: {
        type: String,
        enum: ["poor", "fair", "normal", "good"],
        default: null,
      },

      // Grooming and self-care — a quiet but reliable recovery signal
      physical_appearance: {
        type: String,
        enum: ["dishevelled", "unkempt", "adequate", "well_groomed"],
        default: null,
      },
    },
  },
  {
    timestamps: true,
  },
);

// Virtual for session completion percentage
TherapySessionSchema.virtual("completion_percentage").get(function () {
  if (!this.session_start_time || !this.session_end_time) return 0;

  const moment = require("moment"); // Add moment import if not available
  const plannedDuration = moment(this.therepy_end_time, "HH:mm").diff(
    moment(this.therepy_start_time, "HH:mm"),
    "minutes",
  );

  const actualDuration = this.session_duration || 0;
  return Math.min(100, Math.round((actualDuration / plannedDuration) * 100));
});

TherapySessionSchema.index({ patient_id: 1, start_time: -1 });
TherapySessionSchema.index({ doctor_id: 1, status: 1 });
TherapySessionSchema.index({ plan_id: 1, status: 1 });

/**
 * Addon Service Schema
 * Represents additional services added to a therapy plan
 */
const AddonServiceSchema = new Schema({
  name: { type: String, required: true },
  amount: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  description: { type: String },
  status: {
    type: String,
    enum: ["Active", "Completed", "Cancelled"],
    default: "Active",
  },
});

/**
 * Payment History Schema
 * Records all payments made for a therapy plan
 */
const PaymentHistorySchema = new Schema({
  amount: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  type: {
    type: String,
    required: true,
    enum: [
      "CASH",
      "Cash",
      "card",
      "ONLINE",
      "online",
      "ONLINE",
      "one-time",
      "recurring",
      "At Counter",
    ],
  },
  payment_number: { type: Number },
  session_number: { type: Number },
  addon_services: [AddonServiceSchema],
  last_modified: { type: Date },
  notes: { type: String },
  therapyId: { type: String },
  receipt_url: { type: String },
  recorded_by: { type: ObjectId, ref: "Doctor" },
  // Added discount tracking in payment history
  discount_applied: { type: Number }, // Discount amount applied to this payment
  original_plan_amount: { type: String }, // Original plan amount before discount
});

/**
 * Session Reference Schema
 * Lightweight reference to therapy sessions stored in the therapy plan
 */
const SessionReferenceSchema = new Schema({
  _id: { type: ObjectId, required: true, ref: "TherapySession" },
  status: {
    type: String,
    enum: [
      "Scheduled",
      "scheduled",
      "in_progress",
      "completed",
      "Completed",
      "Cancelled",
      "No Show",
    ],
    default: "Scheduled",
  },
  date: { type: Date },
  session_number: { type: Number },
});

/**
 * Remark Schema for pre/post session remarks
 */
const RemarkSchema = new Schema({
  doctor_name: { type: String },
  presession_remark: { type: String },
  postsession_remarks: { type: String },
  timestamp: { type: Date, default: Date.now },
  session_id: { type: ObjectId, ref: "TherapySession" },
});

/**
 * Session Image Schema
 */
const SessionImageSchema = new Schema({
  original_name: { type: String, required: true },
  url: { type: String, required: true },
  sas_url: { type: String }, // This will be generated dynamically
  size: { type: Number, required: true },
  type: { type: String, required: true }, // MIME type
  uploaded_at: { type: Date, default: Date.now },
  session_number: { type: Number },
  SessionId: { type: ObjectId, ref: "TherapySession" },
});

const VitalsReadingSchema = new Schema({
  recorded_at: { type: Date, default: Date.now, required: true },
  pulse: { type: String, trim: true }, // bpm
  temperature: { type: String, trim: true }, // °F or °C — store the unit in the value, e.g. "98.6°F"
  bp_systolic: { type: String, trim: true },
  bp_diastolic: { type: String, trim: true },
  respiratory_rate: { type: String, trim: true }, // breaths/min
  spo2: { type: String, trim: true }, // %
  weight: { type: String, trim: true },
  blood_glucose: { type: String, trim: true },
  pain_score: { type: String, trim: true }, // 0-10 scale
  notes: { type: String },
  recorded_by: { type: ObjectId, ref: "Doctor" },
  recorded_by_name: { type: String },
});

const TherapyPlanSchema = new Schema(
  {
    // Basic therapy information
    therapy_name: { type: String, required: true },
    patient_diagnosis: { type: String },
    patient_symptoms: { type: String },
    therapy_duration: { type: String },
    therapy_start: { type: String, required: true }, // Format: YYYY-MM-DD
    therapy_end: { type: String, required: true }, // Format: YYYY-MM-DD
    patient_therapy_category: { type: String },

    // Financial information with discount support
    original_amount: { type: String }, // Store original amount before discount
    total_amount: { type: String, required: true }, // Amount after discount (final amount to pay)
    discount_amount: { type: String, default: "0" }, // Calculated discount amount
    received_amount: { type: String, default: "0" },
    location_address: { type: String },
    location_name: { type: String },
    location_id: { type: String },
    balance: {
      type: String,
      default: function () {
        return this.total_amount;
      },
    },
    ICD_11_Codes: { type: String },
    MarksOfIdentification: { type: String },
    prescription_id: { type: ObjectId, ref: "Prescription" },
    prescriptions: [{ type: ObjectId, ref: "Prescription" }], // Keeps a history of all prescriptions added to this plan
    medical_reports: [{ type: ObjectId, ref: "MedicalReport" }], // Keeps a history of all lab/diagnostic reports added to this plan
    vitals_history: [VitalsReadingSchema], // Interval-based vitals checks (pulse, temp, BP, SpO2...) — embedded since each reading is small and only ever viewed in this plan's context
    discount_percentage: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    payment_type: {
      type: String,
      enum: ["one-time", "recurring"],
      default: "one-time",
    },

    // Session information
    estimated_sessions: { type: Number },
    completed_sessions: { type: Number, default: 0 },
    remaining_sessions: {
      type: Number,
      default: function () {
        return this.estimated_sessions;
      },
    },
    per_session_amount: { type: Number },
    therapy_sessions: [SessionReferenceSchema],

    // Addon and payment tracking
    extra_addons: [AddonServiceSchema],
    addons_amount: { type: Number, default: 0 },
    payment_history: [PaymentHistorySchema],
    last_payment_date: { type: Date },
    next_payment_due: { type: Date },
    next_payment_number: { type: Number, default: 1 },

    // Remarks and images
    presession_remarks: [RemarkSchema],
    postsession_remarks: [RemarkSchema],
    presession_images: [SessionImageSchema],
    postsession_images: [SessionImageSchema],

    // Metadata
    created_by: { type: ObjectId, ref: "Doctor" },
    status: {
      type: String,
      enum: [
        "Active",
        "completed",
        "Completed",
        "Cancelled",
        "Paused",
        "On Hold",
      ],
      default: "Active",
    },
    notes: [
      {
        note: { type: String },
        doctor_name: { type: String },
        date: { type: Date, default: Date.now },
      },
    ],
    goal_achievement: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    }, // Percentage
    closure_date: { type: Date },
    closure_reason: {
      type: String,
      enum: ["Completed", "Incomplete", "Dropout", "Refer", "OPD"],
    },
    closure_details: { type: String },
    final_remarks: { type: String },
    treatment_outcome: { type: String },
    follow_up_recommendations: { type: String },
    next_visit_date: { type: Date }, // Post-plan care: next visit scheduled date
    closed_by: { type: ObjectId, ref: "Doctor" },
    closed_by_name: { type: String },
    post_care_prescription_id: { type: ObjectId, ref: "Prescription" },
    // Final statistics (snapshot at closure)
    final_completed_sessions: { type: Number },
    final_total_sessions: { type: Number },
    final_total_amount: { type: String },
    final_received_amount: { type: String },
    final_balance: { type: String },
    final_addons_amount: { type: Number },
    final_discount_percentage: { type: Number },
    final_discount_amount: { type: String },
    final_original_amount: { type: String },

    // Insurance information
    insurance_provider: { type: String },
    insurance_policy_number: { type: String },
    insurance_authorization_number: { type: String },
    insurance_authorized_sessions: { type: Number },
    insurance_copay_amount: { type: Number },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Virtual for days remaining calculation
TherapyPlanSchema.virtual("days_remaining").get(function () {
  const currentDate = new Date();
  currentDate.setHours(0, 0, 0, 0);
  return Math.ceil(
    (new Date(this.therapy_end) - currentDate) / (1000 * 60 * 60 * 24),
  );
});

// Virtual for total images count
TherapyPlanSchema.virtual("total_images_count").get(function () {
  const presessionCount = this.presession_images
    ? this.presession_images.length
    : 0;
  const postsessionCount = this.postsession_images
    ? this.postsession_images.length
    : 0;
  return presessionCount + postsessionCount;
});

// Virtual for calculating savings amount
TherapyPlanSchema.virtual("savings_amount").get(function () {
  if (!this.original_amount || !this.discount_percentage) return 0;
  const originalAmount = parseFloat(this.original_amount);
  return (originalAmount * this.discount_percentage) / 100;
});

// Virtual for effective discount rate (calculated discount percentage)
TherapyPlanSchema.virtual("effective_discount_rate").get(function () {
  if (!this.original_amount || !this.total_amount) return 0;
  const originalAmount = parseFloat(this.original_amount);
  const finalAmount = parseFloat(this.total_amount);
  if (originalAmount === 0) return 0;
  return ((originalAmount - finalAmount) / originalAmount) * 100;
});

// Virtual for progress percentage
TherapyPlanSchema.virtual("progress_percentage").get(function () {
  if (!this.estimated_sessions || this.estimated_sessions === 0) return 0;
  return Math.round((this.completed_sessions / this.estimated_sessions) * 100);
});

// Virtual for payment completion percentage (based on discounted amount)
TherapyPlanSchema.virtual("payment_percentage").get(function () {
  const totalAmount = parseFloat(this.total_amount); // This is the discounted amount
  if (!totalAmount || totalAmount === 0) return 100;

  const receivedAmount = parseFloat(this.received_amount);
  return Math.round((receivedAmount / totalAmount) * 100);
});

// Method to get all images with fresh SAS tokens
TherapyPlanSchema.methods.getImagesWithSasTokens = async function () {
  const { generateSessionImageSasToken } = require("../utils/azureutils");

  const allImages = [];

  // Process presession images
  if (this.presession_images) {
    for (const image of this.presession_images) {
      const sasUrl = await generateSessionImageSasToken(image.url);
      allImages.push({
        ...image.toObject(),
        sas_url: sasUrl,
        session_type: "presession",
      });
    }
  }

  // Process postsession images
  if (this.postsession_images) {
    for (const image of this.postsession_images) {
      const sasUrl = await generateSessionImageSasToken(image.url);
      allImages.push({
        ...image.toObject(),
        sas_url: sasUrl,
        session_type: "postsession",
      });
    }
  }

  return allImages;
};

// Middleware to handle pre-save calculations with discount support
TherapyPlanSchema.pre("save", function (next) {
  // Apply discount if discount_percentage is set and original_amount exists
  if (this.isModified("discount_percentage") && this.original_amount) {
    const originalAmount = parseFloat(this.original_amount);
    const discountPercentage = this.discount_percentage || 0;

    if (discountPercentage > 0 && discountPercentage <= 100) {
      const discountAmount = (originalAmount * discountPercentage) / 100;
      const finalAmount = originalAmount - discountAmount;

      this.discount_amount = discountAmount.toFixed(2);
      this.total_amount = finalAmount.toFixed(2);
    }
  }

  // Calculate balance if total_amount or received_amount changed
  if (this.isModified("total_amount") || this.isModified("received_amount")) {
    const totalAmount = parseFloat(this.total_amount);
    const receivedAmount = parseFloat(this.received_amount);
    this.balance = (totalAmount - receivedAmount).toFixed(2);
  }

  // Handle recurring payment calculations with discount support
  if (
    this.payment_type === "recurring" &&
    this.isModified("estimated_sessions") &&
    this.isModified("per_session_amount")
  ) {
    const estimatedSessions = parseInt(this.estimated_sessions) || 0;
    const perSessionAmount = parseFloat(this.per_session_amount) || 0;
    let calculatedTotal = (estimatedSessions * perSessionAmount).toFixed(2);

    // If there's a discount, store the calculated amount as original_amount
    if (this.discount_percentage > 0) {
      this.original_amount = calculatedTotal;
      const discountAmount =
        (parseFloat(calculatedTotal) * this.discount_percentage) / 100;
      calculatedTotal = (parseFloat(calculatedTotal) - discountAmount).toFixed(
        2,
      );
      this.discount_amount = discountAmount.toFixed(2);
    }

    this.total_amount = calculatedTotal;
  }

  // Calculate remaining sessions
  if (
    this.isModified("estimated_sessions") ||
    this.isModified("completed_sessions")
  ) {
    this.remaining_sessions = Math.max(
      0,
      this.estimated_sessions - this.completed_sessions,
    );
  }

  next();
});

// Static method to find active plans
TherapyPlanSchema.statics.findActivePlans = function () {
  const currentDate = new Date();
  const formattedDate = currentDate.toISOString().split("T")[0];

  return this.find({
    therapy_start: { $lte: formattedDate },
    therapy_end: { $gte: formattedDate },
    status: "Active",
  }).sort({ therapy_end: 1 });
};

// Method to record a payment with discount support
TherapyPlanSchema.methods.recordPayment = function (
  amount,
  type,
  addon_services = [],
  recordedBy = null,
) {
  // Convert to numbers
  const paymentAmount = parseFloat(amount);
  const currentReceived = parseFloat(this.received_amount || 0);
  const totalAmount = parseFloat(this.total_amount || 0); // This is the discounted amount

  // Calculate new values
  const newReceivedAmount = currentReceived + paymentAmount;
  const newBalance = totalAmount - newReceivedAmount;

  // Handle addons
  let addonsAmount = this.addons_amount || 0;
  addon_services.forEach((addon) => {
    addonsAmount += parseFloat(addon.amount);
    this.extra_addons.push({
      name: addon.name,
      amount: parseFloat(addon.amount),
      date: new Date(),
      description: addon.description || null,
    });
  });

  // Determine payment number for recurring payments
  let paymentNumber = null;
  if (this.payment_type === "recurring") {
    const maxPaymentNumber = this.payment_history.reduce(
      (max, payment) =>
        payment.payment_number ? Math.max(max, payment.payment_number) : max,
      0,
    );
    paymentNumber = maxPaymentNumber + 1;
    this.next_payment_number = paymentNumber + 1;

    // Set next payment due date if balance remains
    if (newBalance > 0) {
      this.next_payment_due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    }
  }

  // Update plan values
  this.received_amount = newReceivedAmount.toString();
  this.balance = newBalance.toString();
  this.addons_amount = addonsAmount;
  this.last_payment_date = new Date();

  // Add to payment history with discount information
  this.payment_history.push({
    amount: paymentAmount,
    date: new Date(),
    type,
    payment_number: paymentNumber,
    addon_services: addon_services.map((addon) => ({
      name: addon.name,
      amount: parseFloat(addon.amount),
      description: addon.description || null,
    })),
    recorded_by: recordedBy,
    // Add discount info to payment history if applicable
    discount_applied:
      this.discount_percentage > 0
        ? parseFloat(this.discount_amount || 0)
        : null,
    original_plan_amount: this.original_amount || null,
  });

  return this.save();
};

// Method to add a new therapy session
TherapyPlanSchema.methods.addSession = function (
  sessionId,
  status = "scheduled",
) {
  this.therapy_sessions.push({
    _id: sessionId,
    status,
    date: new Date(),
    session_number: this.therapy_sessions.length + 1,
  });

  return this.save();
};

// Method to update a session status
TherapyPlanSchema.methods.updateSessionStatus = function (
  sessionId,
  newStatus,
) {
  const sessionIndex = this.therapy_sessions.findIndex(
    (session) => session._id.toString() === sessionId.toString(),
  );

  if (sessionIndex === -1) {
    throw new Error("Session not found in this plan");
  }

  this.therapy_sessions[sessionIndex].status = newStatus;

  // Update completed sessions count
  if (newStatus === "completed" || newStatus === "Completed") {
    // Ensure numeric values with fallbacks
    const estimated = Number.isInteger(this.estimated_sessions)
      ? this.estimated_sessions
      : 0;
    const completed = Number.isInteger(this.completed_sessions)
      ? this.completed_sessions
      : 0;

    this.completed_sessions = completed + 1;

    // Calculate remaining sessions safely
    this.remaining_sessions = Math.max(0, estimated - this.completed_sessions);

    // Handle legacy plans without estimated_sessions
    if (isNaN(this.remaining_sessions)) {
      this.remaining_sessions = 0;
      this.estimated_sessions = this.completed_sessions;
    }
  }

  return this.save();
};

// Method to add presession remark
TherapyPlanSchema.methods.addPresessionRemark = function (
  doctorName,
  remark,
  sessionId = null,
) {
  if (!this.presession_remarks) {
    this.presession_remarks = [];
  }

  this.presession_remarks.push({
    doctor_name: doctorName,
    presession_remark: remark,
    timestamp: new Date(),
    session_id: sessionId,
  });

  return this.save();
};

// Method to add postsession remark
TherapyPlanSchema.methods.addPostsessionRemark = function (
  doctorName,
  remark,
  sessionId = null,
) {
  if (!this.postsession_remarks) {
    this.postsession_remarks = [];
  }

  this.postsession_remarks.push({
    doctor_name: doctorName,
    postsession_remarks: remark,
    timestamp: new Date(),
    session_id: sessionId,
  });

  return this.save();
};

// Method to add a vitals reading
TherapyPlanSchema.methods.addVitalsReading = function (reading) {
  if (!this.vitals_history) {
    this.vitals_history = [];
  }

  this.vitals_history.push({
    recorded_at: reading.recorded_at || new Date(),
    pulse: reading.pulse,
    temperature: reading.temperature,
    bp_systolic: reading.bp_systolic,
    bp_diastolic: reading.bp_diastolic,
    respiratory_rate: reading.respiratory_rate,
    spo2: reading.spo2,
    weight: reading.weight,
    blood_glucose: reading.blood_glucose,
    pain_score: reading.pain_score,
    notes: reading.notes,
    recorded_by: reading.recorded_by,
    recorded_by_name: reading.recorded_by_name,
  });

  return this.save();
};

// Method to apply or update discount
TherapyPlanSchema.methods.applyDiscount = function (discountPercentage) {
  if (discountPercentage < 0 || discountPercentage > 100) {
    throw new Error("Discount percentage must be between 0 and 100");
  }

  // Store original amount if not already stored
  if (!this.original_amount) {
    this.original_amount = this.total_amount;
  }

  const originalAmount = parseFloat(this.original_amount);
  const discountAmount = (originalAmount * discountPercentage) / 100;
  const finalAmount = originalAmount - discountAmount;

  this.discount_percentage = discountPercentage;
  this.discount_amount = discountAmount.toFixed(2);
  this.total_amount = finalAmount.toFixed(2);

  // Recalculate balance
  const receivedAmount = parseFloat(this.received_amount || 0);
  this.balance = (finalAmount - receivedAmount).toFixed(2);

  return this.save();
};

// Method to remove discount
TherapyPlanSchema.methods.removeDiscount = function () {
  if (this.original_amount) {
    this.total_amount = this.original_amount;
    this.discount_percentage = 0;
    this.discount_amount = "0";

    // Recalculate balance
    const originalAmount = parseFloat(this.original_amount);
    const receivedAmount = parseFloat(this.received_amount || 0);
    this.balance = (originalAmount - receivedAmount).toFixed(2);

    // Clear original_amount as there's no discount now
    this.original_amount = undefined;
  }

  return this.save();
};
TherapyPlanSchema.pre("findOneAndUpdate", function (next) {
  const update = this.getUpdate();

  // Get the document being updated
  this.model
    .findOne(this.getQuery())
    .then((doc) => {
      if (doc && (doc.status === "Completed" || doc.status === "completed")) {
        // Prevent any updates except specific closure-related fields
        const allowedUpdates = [
          "closure_details",
          "final_remarks",
          "follow_up_recommendations",
          "treatment_outcome",
        ];

        const updateKeys = Object.keys(update.$set || update);
        const hasDisallowedUpdates = updateKeys.some(
          (key) => !allowedUpdates.includes(key),
        );

        if (hasDisallowedUpdates) {
          return next(
            new Error(
              "Cannot modify a completed therapy plan except for closure details",
            ),
          );
        }
      }
      next();
    })
    .catch((err) => next(err));
});

// Method to reopen a completed therapy plan (if needed)
TherapyPlanSchema.methods.reopenTherapy = function (reason, reopenedBy) {
  if (this.status !== "Completed" && this.status !== "completed") {
    throw new Error("Only completed therapy plans can be reopened");
  }

  this.notes.push({
    note: `Therapy plan reopened: ${reason}`,
    doctor_name: reopenedBy,
    date: new Date(),
  });

  // Store closure information in notes for history
  if (this.closure_date) {
    this.notes.push({
      note: `Previous closure: ${this.closure_reason} on ${this.closure_date}`,
      doctor_name: "System",
      date: new Date(),
    });
  }

  // Clear closure fields but keep final statistics for reference
  this.status = "Active";
  this.closure_date = undefined;
  this.closure_reason = undefined;

  return this.save();
};

// Static method to find completed therapy plans
TherapyPlanSchema.statics.findCompletedPlans = function (startDate, endDate) {
  const query = {
    status: { $in: ["Completed", "completed"] },
  };

  if (startDate || endDate) {
    query.closure_date = {};
    if (startDate) query.closure_date.$gte = new Date(startDate);
    if (endDate) query.closure_date.$lte = new Date(endDate);
  }

  return this.find(query).sort({ closure_date: -1 });
};

// Virtual for therapy completion status
TherapyPlanSchema.virtual("completion_status").get(function () {
  if (this.status === "Completed" || this.status === "completed") {
    return "Completed";
  }

  const currentDate = new Date();
  const endDate = new Date(this.therapy_end);

  if (currentDate > endDate) {
    return "Overdue";
  }

  return "In Progress";
});

// Virtual for closure summary
TherapyPlanSchema.virtual("closure_summary").get(function () {
  if (this.status !== "Completed" && this.status !== "completed") {
    return null;
  }

  return {
    date: this.closure_date,
    reason: this.closure_reason,
    details: this.closure_details,
    closed_by: this.closed_by_name,
    sessions_completed: this.final_completed_sessions,
    goal_achievement: this.goal_achievement,
    balance_at_closure: this.final_balance,
  };
});

// Add indexes for better query performance
TherapyPlanSchema.index({ created_by: 1, status: 1 });
TherapyPlanSchema.index({ therapy_start: 1, therapy_end: 1 });
TherapyPlanSchema.index({ status: 1, discount_percentage: 1 });
TherapyPlanSchema.index({ payment_type: 1, next_payment_due: 1 });

// Export models
module.exports = {
  getTherapyPlanModel: function (connection) {
    return connection.model("TherapyPlan", TherapyPlanSchema, "plans");
  },
  getTherapySession: function (connection) {
    return connection.model("TherapySession", TherapySessionSchema, "therepys");
  },
  VitalsReadingSchema,
};
