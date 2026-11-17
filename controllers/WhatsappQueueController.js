const WhatsAppQueue = require("../db/WhatsappQueueSchema");
const { WhatsAppTherapyReminderService } = require("./whatsappController");
const moment = require("moment"); // Make sure moment is required for time formatting

// ---------------------------------------------------------------------------
// Job types THIS server knows how to process.
// The queue collection is shared with another server that also handles
// "prescription_link" jobs. This worker must never claim those, otherwise
// they would be sent with the wrong template.
// ---------------------------------------------------------------------------
const SUPPORTED_JOB_TYPES = ["plan_creation", "appointment_scheduled"];

// Existing function for plans
const addToWhatsAppQueue = async (tenant_id, patient, plan, organization) => {
  try {
    await WhatsAppQueue.create({
      tenant_id,
      jobType: "plan_creation",
      patient,
      plan,
      organization,
      status: "pending",
      nextRunAt: new Date(),
    });
    console.log(
      `Enqueued WhatsApp plan message for: ${patient.patient_first_name}`,
    );
  } catch (error) {
    console.error("Failed to add plan to WhatsApp queue:", error);
  }
};

// Function for appointments
const addAppointmentToWhatsAppQueue = async (
  tenant_id,
  patient,
  session,
  doctor,
  organization,
) => {
  try {
    await WhatsAppQueue.create({
      tenant_id,
      jobType: "appointment_scheduled",
      patient,
      session,
      doctor,
      organization,
      status: "pending",
      nextRunAt: new Date(),
    });
    console.log(
      `Enqueued WhatsApp appointment message for: ${patient.patient_first_name}`,
    );
  } catch (error) {
    console.error("Failed to add appointment to WhatsApp queue:", error);
  }
};

const processWhatsAppQueue = async () => {
  let job;

  try {
    // Only claim jobs this server supports.
    // The $or also covers very old documents that were created before the
    // jobType field existed (they were always plan jobs).
    job = await WhatsAppQueue.findOneAndUpdate(
      {
        status: "pending",
        nextRunAt: { $lte: new Date() },
        $or: [
          { jobType: { $in: SUPPORTED_JOB_TYPES } },
          { jobType: { $exists: false } },
        ],
      },
      { $set: { status: "processing" } },
      { new: true, sort: { createdAt: 1 } },
    );

    if (!job) return;

    console.log(
      `[${process.pid}] Processing WhatsApp job: ${job._id} (Type: ${job.jobType}) for tenant: ${job.tenant_id}`,
    );
    const whatsappService = new WhatsAppTherapyReminderService();
    let messagePayload;

    // ==========================================
    // LOGIC FOR APPOINTMENT SCHEDULING
    // ==========================================
    if (job.jobType === "appointment_scheduled") {
      const patientName = job.patient?.patient_first_name || "Patient";
      const doctorName =
        job.doctor?.doctor_name || job.session?.doctor_name || "Doctor";
      const orgName = job.organization?.organization_name || "Our Clinic";
      const sessionDate = moment(job.session.therepy_date).format("DD-MM-YYYY");
      const sessionTime = moment(
        job.session.therepy_start_time,
        "HH:mm",
      ).format("h:mm A");
      const sessionType = job.session.therepy_type || "Clinic";

      // We extract just the path/token from the full URL for the button parameter
      let urlSuffix = "";
      if (job.session.therepy_link) {
        // Assuming therepy_link looks like: https://healtrack.ai/session/123?token=abc
        // We strip the base domain because Meta button config usually holds the base URL
        try {
          const urlObj = new URL(job.session.therepy_link);
          urlSuffix = urlObj.pathname + urlObj.search; // results in "/session/123?token=abc"
        } catch (e) {
          urlSuffix = job.session.therepy_link; // Fallback
        }
      }

      messagePayload = {
        messaging_product: "whatsapp",
        to: whatsappService.formatPhoneNumber(job.patient.patient_phone),
        type: "template",
        template: {
          name: "online_appointment", // EXACT name of your Meta template
          language: { code: "en" },
          components: [
            {
              type: "header",
              parameters: [{ type: "text", text: patientName }], // {{1}} Header
            },
            {
              type: "body",
              parameters: [
                { type: "text", text: doctorName }, // {{1}} Body
                { type: "text", text: sessionDate }, // {{2}} Body
                { type: "text", text: sessionTime }, // {{3}} Body
                { type: "text", text: sessionType }, // {{4}} Body
              ],
            },
            // Include button ONLY if it's an online session and we have a link
            ...(urlSuffix &&
            (sessionType.toLowerCase() === "online" ||
              sessionType.toLowerCase() === "video" ||
              sessionType.toLowerCase() === "livekit")
              ? [
                  {
                    type: "button",
                    sub_type: "url",
                    index: "0",
                    parameters: [
                      { type: "text", text: urlSuffix.replace(/^\//, "") }, // Remove leading slash if present
                    ],
                  },
                ]
              : []),
          ],
        },
      };
    }
    // ==========================================
    // LOGIC FOR PLAN CREATION
    // ==========================================
    else if (job.jobType === "plan_creation") {
      const patientName = job.patient?.patient_first_name || "Patient";
      const planName = job.plan?.therapy_name || "Therapy Plan";
      const orgName = job.organization?.organization_name || "Our Clinic";
      const tenantId = job.tenant_id || "unknown";
      const planId = job.plan?._id ? job.plan._id.toString() : "unknown";

      messagePayload = {
        messaging_product: "whatsapp",
        to: whatsappService.formatPhoneNumber(job.patient.patient_phone),
        type: "template",
        template: {
          name: "plan_creation_reminder",
          language: { code: "en" },
          components: [
            {
              type: "header",
              parameters: [{ type: "text", text: patientName }],
            },
            {
              type: "body",
              parameters: [
                { type: "text", text: planName },
                { type: "text", text: orgName },
              ],
            },
            {
              type: "button",
              sub_type: "url",
              index: "0",
              parameters: [
                { type: "text", text: `/plan/patient/${tenantId}/${planId}` },
              ],
            },
          ],
        },
      };
    }
    // ==========================================
    // UNKNOWN JOB TYPE: fail loudly, never send a wrong template
    // ==========================================
    else {
      throw new Error(`Unsupported jobType: ${job.jobType}`);
    }

    // Send the message
    await whatsappService.sendWhatsAppMessage(messagePayload);

    job.status = "completed";
    await job.save();
    console.log(`WhatsApp job ${job._id} completed successfully`);
  } catch (error) {
    if (error.response && error.response.data) {
      console.error(
        `Meta API Error for job ${job?._id}:`,
        JSON.stringify(error.response.data, null, 2),
      );
    } else {
      console.error("Error processing WhatsApp queue job:", error.message);
    }

    if (job) {
      job.attempts = (job.attempts || 0) + 1;
      job.lastError = error.response?.data?.error?.message || error.message;
      if (job.attempts >= job.maxAttempts) {
        job.status = "failed";
      } else {
        job.status = "pending";
        job.nextRunAt = new Date(Date.now() + job.attempts * 10000);
      }
      await job.save();
    }
  }
};

const startWhatsAppWorker = () => {
  setInterval(() => {
    processWhatsAppQueue().catch((err) =>
      console.error("WhatsApp Worker error:", err),
    );
  }, 5000);
};

module.exports = {
  addToWhatsAppQueue,
  addAppointmentToWhatsAppQueue,
  startWhatsAppWorker,
};
