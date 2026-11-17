const Razorpay = require("razorpay");
const mongoose = require("mongoose");
const ConsultationPayment = require("../db/ConsultationPayment");
const RefundOrder = require("../db/refundOrder");
const PatientUser = require("../db/patientUser");
const { getDoctorModel } = require("../db/doctorschema");
const { createConsultation } = require("../controllers/therepyController");
const { TherapySessionSchema } = require("../db/therepy");
const { getPaymentModel } = require("../db/paymentSchema");

/** =============================
 *  APPROVE REFUND for future use for to doctor and that organization
 * ============================= */
exports.approveRefund = async (req, res) => {
  try {
    const { therapy_id, organization_name } = req.body;

    if (!therapy_id || !organization_name) {
      return res
        .status(400)
        .json({ msg: "therapy_id & organization_name required" });
    }

    /** 1️⃣ ConsultationPayment */
    const payment = await ConsultationPayment.findOne({
      therapy_id: new mongoose.Types.ObjectId(therapy_id),
    });

    if (!payment) return res.status(404).json({ msg: "Payment not found" });
    if (payment.refund_status !== "pending")
      return res.status(400).json({ msg: "Refund must be pending" });

    /** 2️⃣ Razorpay Refund */
    const refund = await razorpay.payments.refund(payment.razorpay_payment_id, {
      amount: Math.round(payment.amount * 100),
    });

    /** 3️⃣ Update ConsultationPayment */
    payment.refund_status = "refunded";
    payment.refund_id = refund.id;
    payment.status = "refunded";
    await payment.save();

    /** 4️⃣ RefundOrder (audit) */
    await RefundOrder.create({
      payment_id: payment._id,
      razorpay_order_id: payment.razorpay_order_id,
      razorpay_payment_id: payment.razorpay_payment_id,
      refund_id: refund.id,
      amount: payment.amount,
      currency: payment.currency,
      therapy_id: payment.therapy_id,
      patient_id: payment.patient_id,
      reason: payment.refund_reason || "Approved by doctor",
      status: "approved",
    });

    /** 5️⃣ Patient consultations */
    await PatientUser.updateOne(
      {
        _id: payment.patient_id,
        "consultations.therapy_id": payment.therapy_id,
      },
      { $set: { "consultations.$.status": "Refunded" } },
    );

    /** 6️⃣ Org ledger */
    const tenantDbName = "org_" + organization_name.replace(/-/g, "");
    const orgDb = mongoose.connection.useDb(tenantDbName);
    const Payment = getPaymentModel(orgDb);

    await Payment.updateOne(
      { therapyId: payment.therapy_id },
      { $set: { refund_status: "refunded" } },
    );

    res.json({
      success: true,
      msg: "Refund approved & processed",
      refund_id: refund.id,
    });
  } catch (err) {
    console.error("Approve refund failed:", err);
    res.status(500).json({ msg: "Refund approval failed" });
  }
};

/** =============================
 *  REJECT REFUND  for future use for to doctor and that organization
 * ============================= */
exports.rejectRefund = async (req, res) => {
  try {
    const { therapy_id, organization_name, reason } = req.body;

    if (!therapy_id || !organization_name) {
      return res
        .status(400)
        .json({ msg: "therapy_id & organization_name required" });
    }

    /** 1️⃣ ConsultationPayment */
    const payment = await ConsultationPayment.findOne({
      therapy_id: new mongoose.Types.ObjectId(therapy_id),
    });

    if (!payment) return res.status(404).json({ msg: "Payment not found" });
    if (payment.refund_status !== "pending")
      return res.status(400).json({ msg: "Refund must be pending" });

    payment.refund_status = "rejected";
    payment.refund_reason = reason || "Rejected by doctor";
    await payment.save();

    /** 2️⃣ Patient consultations */
    await PatientUser.updateOne(
      {
        _id: payment.patient_id,
        "consultations.therapy_id": payment.therapy_id,
      },
      { $set: { "consultations.$.status": "Cancelled" } },
    );

    /** 3️⃣ Org ledger */
    const tenantDbName = "org_" + organization_name.replace(/-/g, "");
    const orgDb = mongoose.connection.useDb(tenantDbName);
    const Payment = getPaymentModel(orgDb);

    await Payment.updateOne(
      { therapyId: payment.therapy_id },
      {
        $set: {
          refund_status: "rejected",
          refund_reason: payment.refund_reason,
        },
      },
    );

    res.json({
      success: true,
      msg: "Refund rejected",
    });
  } catch (err) {
    console.error("Reject refund failed:", err);
    res.status(500).json({ msg: "Refund rejection failed" });
  }
};

exports.refundDashboardStats = async (req, res) => {
  try {
    const { organization_name, doctor_id } = req.query;

    const tenantDbName = "org_" + organization_name.replace(/-/g, "");
    const orgDb = mongoose.connection.useDb(tenantDbName);
    const Payment = getPaymentModel(orgDb);

    const baseFilter = doctor_id
      ? { doctor_id: new mongoose.Types.ObjectId(doctor_id) }
      : {};

    const [pending, refunded, rejected] = await Promise.all([
      Payment.countDocuments({ ...baseFilter, refund_status: "pending" }),
      Payment.countDocuments({ ...baseFilter, refund_status: "refunded" }),
      Payment.countDocuments({ ...baseFilter, refund_status: "rejected" }),
    ]);

    res.json({
      pending,
      refunded,
      rejected,
    });
  } catch (err) {
    res.status(500).json({ msg: "Dashboard stats failed" });
  }
};

// super admin controllers below

/**
 * =============================
 * SUPER ADMIN — GET REFUND REQUESTS
 * =============================
 * Scope:
 * - ALL organizations
 * - Optional filters: org, doctor
 */

exports.getSuperAdminRefundRequests = async (req, res) => {
  try {
    const { organization_name, doctor_id, status } = req.query;

    const filter = {};

    // Apply status filter ONLY if provided
    if (status) {
      filter.refund_status = status;
    }

    // Convert organization_name to tenant_id format for filtering
    if (organization_name) {
      // Remove 'org_' prefix if present
      const tenantIdWithoutDashes = organization_name.startsWith("org_")
        ? organization_name.replace("org_", "")
        : organization_name;

      // Reconstruct UUID with dashes in format: 8-4-4-4-12
      const tenantId = tenantIdWithoutDashes.replace(
        /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
        "$1-$2-$3-$4-$5",
      );

      filter.tenant_id = tenantId;
    }

    // Apply doctor_id filter if provided
    if (doctor_id) {
      filter.doctor_id = new mongoose.Types.ObjectId(doctor_id);
    }

    // Get ConsultationPayment records with filters applied
    const requests = await ConsultationPayment.find(filter).sort({
      created_at: -1,
    });

    // Get patient details for each request (only Name, email, phoneNumber, organization name)
    const enrichedRequests = await Promise.all(
      requests.map(async (request) => {
        const requestObj = request.toObject();

        if (request.patient_id) {
          const patient = await PatientUser.findById(request.patient_id)
            .select("Name Hospital_Clinic email phoneNumber")
            .lean();

          if (patient) {
            requestObj.patient_name = patient.Name;
            requestObj.patient_email = patient.email;
            requestObj.patient_phoneNumber = patient.phoneNumber;

            // Get organization name from Hospital_Clinic array if available
            if (patient.Hospital_Clinic && patient.Hospital_Clinic.length > 0) {
              requestObj.patient_organization_name =
                patient.Hospital_Clinic[0].organizationName;
            }
          }
        }

        return requestObj;
      }),
    );

    const count = await ConsultationPayment.countDocuments(filter);

    res.json({
      success: true,
      status: status || "all",
      count,
      requests: enrichedRequests,
    });
  } catch (err) {
    console.error("Super admin get refunds failed:", err);
    res.status(500).json({
      success: false,
      msg: "Failed to fetch refund requests",
      error: err.message,
    });
  }
};

/**
 * =============================
 * SUPER ADMIN — APPROVE REFUND
 * (MANUAL BANK / UPI REFUND)
 * action = approve | reject
 * =============================
 */

exports.decideRefund = async (req, res) => {
  try {
    const { therapy_id, organization_name, action, note } = req.body;

    if (!therapy_id || !organization_name || !action) {
      return res.status(400).json({
        msg: "therapy_id, organization_name and action are required",
      });
    }

    if (!["approve", "reject"].includes(action)) {
      return res.status(400).json({ msg: "Invalid action" });
    }

    const payment = await ConsultationPayment.findOne({
      therapy_id: new mongoose.Types.ObjectId(therapy_id),
    });

    if (!payment) {
      return res.status(404).json({ msg: "Payment not found" });
    }

    if (payment.refund_status !== "pending") {
      return res.status(400).json({
        msg: "Refund must be in pending state",
      });
    }

    /** =============================
     * UPDATE CONSULTATIONPAYMENTS
     * ============================= */
    payment.refund_status = action === "approve" ? "approved" : "rejected";
    payment.refund_reason =
      note ||
      (action === "approve"
        ? "Approved by super admin"
        : "Rejected by super admin");

    await payment.save();

    /** =============================
     * UPDATE PATIENT VIEW
     * ============================= */
    await PatientUser.updateOne(
      {
        _id: payment.patient_id,
        "consultations.therapy_id": payment.therapy_id,
      },
      {
        $set: {
          "consultations.$.status":
            action === "approve" ? "Cancelled" : "Cancelled",
        },
      },
    );

    /** =============================
     * UPDATE ORG PAYMENTS DASHBOARD
     * ============================= */
    const tenantDbName = "org_" + organization_name.replace(/-/g, "");
    const orgDb = mongoose.connection.useDb(tenantDbName);
    const Payment = getPaymentModel(orgDb);

    await Payment.updateOne(
      { therapyId: payment.therapy_id },
      { $set: { refund_status: payment.refund_status } },
    );

    res.json({
      success: true,
      msg:
        action === "approve"
          ? "Refund approved (awaiting transfer)"
          : "Refund rejected",
      refund_status: payment.refund_status,
    });
  } catch (err) {
    console.error("Refund decision failed:", err);
    res.status(500).json({ msg: "Refund decision failed" });
  }
};

/**
 * =============================
 * SUPER ADMIN — MARK REFUND COMPLETED
 * =============================
 */
exports.markRefundCompleted = async (req, res) => {
  try {
    const { therapy_id, organization_name, doctor_id } = req.body;

    if (!therapy_id || !organization_name || !doctor_id) {
      return res
        .status(400)
        .json({ msg: "therapy_id , organization_name & doctor_id required" });
    }

    const payment = await ConsultationPayment.findOne({
      therapy_id: new mongoose.Types.ObjectId(therapy_id),
    });

    if (!payment) {
      return res.status(404).json({ msg: "Payment not found" });
    }
    if (payment.refund_status === "refunded") {
      return res.status(400).json({ msg: "Already refunded for this therapy" });
    }
    if (payment.refund_status !== "approved") {
      return res.status(400).json({
        msg: "Refund must be approved before marking as refunded",
      });
    }

    /** 🔹 Update consultationpayments */
    payment.refund_status = "refunded";
    // payment.refund_id = transaction_ref || "manual-transfer";
    await payment.save();

    /** 🔹 Create refund audit */
    await RefundOrder.create({
      payment_id: payment._id,
      razorpay_order_id: payment.razorpay_order_id,
      razorpay_payment_id: payment.razorpay_payment_id,
      amount: payment.amount,
      currency: payment.currency,
      therapy_id: payment.therapy_id,
      patient_id: payment.patient_id,
      doctor_id: payment.doctor_id,
      tenant_id: payment.tenant_id,
      reason: payment.refund_reason,
      status: "processed",
    });

    /** 🔹 Update patient UI */
    await PatientUser.updateOne(
      {
        _id: payment.patient_id,
        "consultations.therapy_id": payment.therapy_id,
      },
      { $set: { "consultations.$.status": "Refunded" } },
    );

    /** 🔹 Update org payments */
    const tenantDbName = "org_" + organization_name.replace(/-/g, "");
    const orgDb = mongoose.connection.useDb(tenantDbName);
    const Payment = getPaymentModel(orgDb);

    await Payment.updateOne(
      { therapyId: payment.therapy_id },
      { $set: { refund_status: "refunded" } },
    );

    res.json({
      success: true,
      msg: "Refund marked as completed",
    });
  } catch (err) {
    console.error("Mark refund completed failed:", err);
    res.status(500).json({ msg: "Failed to mark refund completed" });
  }
};
