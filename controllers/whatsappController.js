const axios = require("axios");
const moment = require("moment");
const { getTherapySession, getTherapyPlanModel } = require("../db/therepy"); // Adjust path
const { getDoctorModel } = require("../db/doctorschema"); // Adjust path
const { getPatientModel } = require("../db/patientSchema"); // Adjust path
const Organization = require("../db/OrganizationSchema"); // Adjust path
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;

/**
 * WhatsApp Business API Service for Therapy Session Reminders
 * Uses the provided message template and environment variables
 */
class WhatsAppTherapyReminderService {
  constructor() {
    this.accessToken = process.env.permanentAccessToken;
    this.phoneNumberId = process.env.phoneNumberId;
    this.baseURL = `https://graph.facebook.com/v23.0/${this.phoneNumberId}/messages`;

    if (!this.accessToken || !this.phoneNumberId) {
      throw new Error(
        "Missing required environment variables: permanentAccessToken or phoneNumberId",
      );
    }
  }

  /**
   * Send therapy session reminder using WhatsApp template
   * @param {Object} sessionData - Therapy session data
   * @param {Object} patientData - Patient information
   * @param {Object} doctorData - Doctor information
   * @param {Object} organizationData - Organization details
   * @returns {Promise<Object>} API response
   */
  async sendTherapySessionReminder(
    sessionData,
    patientData,
    doctorData,
    organizationData,
  ) {
    try {
      // Validate required data
      this.validateReminderData(
        sessionData,
        patientData,
        doctorData,
        organizationData,
      );

      // Format the template parameters (now returns 8 parameters)
      const templateParams = this.formatTemplateParameters(
        sessionData,
        patientData,
        doctorData,
        organizationData,
      );

      // Prepare WhatsApp message payload
      const messagePayload = {
        messaging_product: "whatsapp",
        to: this.formatPhoneNumber(patientData.patient_phone),
        type: "template",
        template: {
          name: "reminder",
          language: {
            code: "en",
          },
          components: [
            {
              type: "header",
              parameters: [
                templateParams[0], // {{1}} - Patient name for header
              ],
            },
            {
              type: "body",
              parameters: templateParams.slice(1), // Parameters 2-8 for body (7 parameters)
            },
          ],
        },
      };

      // Send the message
      const response = await this.sendWhatsAppMessage(messagePayload);

      return {
        success: true,
        messageId: response.data.messages[0].id,
        recipientId: response.data.contacts[0].wa_id,
        sessionId: sessionData._id,
        sentAt: new Date().toISOString(),
      };
    } catch (error) {
      console.error("Error sending therapy session reminder:", error);

      // Enhanced error logging
      if (error.response) {
        console.error("API Error Response:", {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data,
          headers: error.response.headers,
        });
      }

      throw new Error(`Failed to send WhatsApp reminder: ${error.message}`);
    }
  }

  /**
   * Send reminder using text message (fallback method)
   * @param {Object} sessionData - Therapy session data
   * @param {Object} patientData - Patient information
   * @param {Object} doctorData - Doctor information
   * @param {Object} organizationData - Organization details
   * @returns {Promise<Object>} API response
   */
  async sendTextReminder(
    sessionData,
    patientData,
    doctorData,
    organizationData,
  ) {
    try {
      // Format the message text
      const messageText = this.formatReminderMessage(
        sessionData,
        patientData,
        doctorData,
        organizationData,
      );

      const messagePayload = {
        messaging_product: "whatsapp",
        to: this.formatPhoneNumber(patientData.patient_phone),
        type: "text",
        text: {
          body: messageText,
        },
      };

      const response = await this.sendWhatsAppMessage(messagePayload);

      return {
        success: true,
        messageId: response.data.messages[0].id,
        recipientId: response.data.contacts[0].wa_id,
        sessionId: sessionData._id,
        sentAt: new Date().toISOString(),
      };
    } catch (error) {
      console.error("Error sending text reminder:", error);
      throw error;
    }
  }

  /**
   * Send WhatsApp message via Graph API
   * @param {Object} payload - Message payload
   * @returns {Promise<Object>} API response
   */
  async sendWhatsAppMessage(payload) {
    const config = {
      method: "post",
      url: this.baseURL,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      data: payload,
    };

    return await axios(config);
  }

  formatTemplateParameters(
    sessionData,
    patientData,
    doctorData,
    organizationData,
  ) {
    const sessionDate = moment(sessionData.therepy_date).format("DD-MM-YYYY");
    const sessionTime = this.formatSessionTime(
      sessionData.therepy_start_time,
      sessionData.therepy_end_time,
    );
    const location = this.getLocationText(
      sessionData.therepy_type,
      sessionData.therepy_link,
    );
    const doctorName =
      doctorData.fullName ||
      `${doctorData.doctor_first_name} ${doctorData.doctor_last_name}`;

    // Return parameters in the correct order (8 parameters total)
    return [
      { type: "text", text: patientData.patient_first_name }, // {{1}} - Patient name (header)
      { type: "text", text: organizationData.organization_name }, // {{2}} - Organization name
      { type: "text", text: sessionDate }, // {{3}} - Date
      { type: "text", text: sessionTime }, // {{4}} - Time
      { type: "text", text: doctorName }, // {{5}} - Doctor name
      { type: "text", text: location }, // {{6}} - Location
      { type: "text", text: organizationData.organization_phone }, // {{7}} - Organization phone
      { type: "text", text: organizationData.organization_name }, // {{8}} - Organization name (signature)
    ];
  }
  /**
   * Format complete reminder message for text fallback
   */
  formatReminderMessage(
    sessionData,
    patientData,
    doctorData,
    organizationData,
  ) {
    const sessionDate = moment(sessionData.therepy_date).format("DD-MM-YYYY");
    const sessionTime = this.formatSessionTime(
      sessionData.therepy_start_time,
      sessionData.therepy_end_time,
    );
    const location = this.getLocationText(
      sessionData.therepy_type,
      sessionData.therepy_link,
    );
    const doctorName =
      doctorData.fullName ||
      `${doctorData.doctor_first_name} ${doctorData.doctor_last_name}`;

    return `Hi ${patientData.patient_first_name},
This is a reminder from ${organizationData.organization_name} about your appointment scheduled on:
📅 Date: ${sessionDate}
⏰ Time: ${sessionTime}
👨‍⚕️ Doctor: ${doctorName}
🏥 Location: ${location}
Please arrive 10 minutes early. If you need to reschedule, reply to this message or contact us at ${organizationData.organization_phone}.`;
  }

  /**
   * Format session time from start and end times
   * Updated to match your desired format (11AM-12AM)
   */
  formatSessionTime(startTime, endTime) {
    const start = moment(startTime, "HH:mm").format("hA");
    const end = moment(endTime, "HH:mm").format("hA");
    return `${start}-${end}`;
  }

  /**
   * Get location text based on therapy type
   */
  getLocationText(therapyType, therapyLink) {
    switch (therapyType) {
      case "Online":
        return therapyLink
          ? `Online Session (Link will be shared)`
          : "Online Session";
      case "In Home":
        return "At Your Home";
      case "IP/ICU":
        return "Hospital/ICU";
      case "In Clinic":
      default:
        return "At Clinic";
    }
  }

  /**
   * Format phone number for WhatsApp (remove + and ensure proper format)
   */
  formatPhoneNumber(phoneNumber) {
    // Remove all non-numeric characters
    let formatted = phoneNumber.replace(/\D/g, "");

    // If it starts with country code, keep as is
    // If it doesn't start with country code, you might want to add default country code
    // This example assumes Indian numbers (+91), modify as needed
    if (formatted.length === 10) {
      formatted = "91" + formatted; // Add India country code
    }

    return formatted;
  }

  /**
   * Validate required data for sending reminders
   */
  validateReminderData(sessionData, patientData, doctorData, organizationData) {
    const requiredSessionFields = [
      "_id",
      "therepy_date",
      "therepy_start_time",
      "therepy_end_time",
      "therepy_type",
    ];
    const requiredPatientFields = ["patient_first_name", "patient_phone"];
    const requiredDoctorFields = ["doctor_first_name", "doctor_last_name"];
    const requiredOrgFields = ["organization_name", "organization_phone"];

    // Check session data
    for (const field of requiredSessionFields) {
      if (!sessionData[field]) {
        throw new Error(`Missing required session field: ${field}`);
      }
    }

    // Check patient data
    for (const field of requiredPatientFields) {
      if (!patientData[field]) {
        throw new Error(`Missing required patient field: ${field}`);
      }
    }

    // Check doctor data
    for (const field of requiredDoctorFields) {
      if (!doctorData[field]) {
        throw new Error(`Missing required doctor field: ${field}`);
      }
    }

    // Check organization data
    for (const field of requiredOrgFields) {
      if (!organizationData[field]) {
        throw new Error(`Missing required organization field: ${field}`);
      }
    }
  }
}

/**
 * Helper function to send reminder for a specific therapy session
 * @param {string} sessionId - MongoDB ObjectId of the therapy session
 * @param {Object} orgDb - Organization database connection
 * @returns {Promise<Object>} Reminder sending result
 */
async function sendTherapySessionReminder(sessionId, orgDb) {
  try {
    const whatsappService = new WhatsAppTherapyReminderService();

    // Get models for this organization
    const TherapySession = getTherapySession(orgDb);
    const Doctor = getDoctorModel(orgDb);
    const Patient = getPatientModel(orgDb);

    // Try to get TherapyPlan model, but handle if it doesn't exist
    let TherapyPlan = null;
    try {
      TherapyPlan = getTherapyPlanModel(orgDb);
    } catch (error) {
      console.log("TherapyPlan model not available, will skip populate");
    }

    // Build the query with conditional populate
    let sessionQuery = TherapySession.findById(sessionId).populate("doctor_id");

    // Only populate plan_id if TherapyPlan model is available
    if (TherapyPlan) {
      sessionQuery = sessionQuery.populate("plan_id");
    }

    // Fetch session data with populated references
    const session = await sessionQuery;

    if (!session) {
      throw new Error(`Therapy session not found: ${sessionId}`);
    }

    // Fetch patient data
    const patient = await Patient.findById(session.patient_id);
    if (!patient) {
      throw new Error(`Patient not found: ${session.patient_id}`);
    }

    // Get doctor data (either from population or direct fetch)
    let doctor = session.doctor_id;
    if (!doctor || typeof doctor === "string") {
      doctor = await Doctor.findById(session.doctor_id);
    }

    if (!doctor) {
      throw new Error(`Doctor not found: ${session.doctor_id}`);
    }

    // Fetch organization data
    const organization = await Organization.findOne({
      tenant_id: doctor.tenant_id,
    });
    if (!organization) {
      throw new Error(`Organization not found for tenant: ${doctor.tenant_id}`);
    }

    // Send the reminder
    const result = await whatsappService.sendTherapySessionReminder(
      session,
      patient,
      doctor,
      organization,
    );

    return result;
  } catch (error) {
    console.error("Error in sendTherapySessionReminder:", error);
    throw error;
  }
}

/**
 * Alternative version without plan_id populate (if you don't need therapy plan data)
 */
async function sendTherapySessionReminderSimple(sessionId, orgDb) {
  try {
    const whatsappService = new WhatsAppTherapyReminderService();

    // Get models for this organization
    const TherapySession = getTherapySession(orgDb);
    const Doctor = getDoctorModel(orgDb);
    const Patient = getPatientModel(orgDb);

    // Fetch session data with populated doctor only
    const session =
      await TherapySession.findById(sessionId).populate("doctor_id");

    if (!session) {
      throw new Error(`Therapy session not found: ${sessionId}`);
    }

    // Fetch patient data
    const patient = await Patient.findOne({ patient_id: session.patient_id });
    if (!patient) {
      throw new Error(`Patient not found: ${session.patient_id}`);
    }

    // Get doctor data (either from population or direct fetch)
    let doctor = session.doctor_id;
    if (!doctor || typeof doctor === "string") {
      doctor = await Doctor.findById(session.doctor_id);
    }

    if (!doctor) {
      throw new Error(`Doctor not found: ${session.doctor_id}`);
    }

    // Fetch organization data
    const organization = await Organization.findOne({
      tenant_id: doctor.tenant_id,
    });
    if (!organization) {
      throw new Error(`Organization not found for tenant: ${doctor.tenant_id}`);
    }

    // Send the reminder
    const result = await whatsappService.sendTherapySessionReminder(
      session,
      patient,
      doctor,
      organization,
    );

    return result;
  } catch (error) {
    console.error("Error in sendTherapySessionReminderSimple:", error);
    throw error;
  }
}

const sendTherapyReminderController = async (req, res) => {
  try {
    const { sessionId } = req.body;

    // Validate required inputs
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        message: "Invalid request: Missing sessionId.",
      });
    }

    // Send the reminder using the service function
    // Use sendTherapySessionReminder if you have TherapyPlan model
    // Use sendTherapySessionReminderSimple if you don't need therapy plan data
    const result = await sendTherapySessionReminder(sessionId, req.orgDb);

    return res.status(200).json({
      success: true,
      message: "Therapy session reminder sent successfully",
      data: result,
    });
  } catch (error) {
    console.error("Error in sendTherapyReminderController:", error);

    return res.status(500).json({
      success: false,
      message: "Error sending therapy session reminder",
      details: error.message,
    });
  }
};

module.exports = {
  WhatsAppTherapyReminderService,
  sendTherapySessionReminder,
  sendTherapySessionReminderSimple,
  sendTherapyReminderController,
};
