const axios = require("axios");
const { google } = require("googleapis");
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;
const moment = require("moment-timezone");
const { refreshToken } = require("../codeexchange/refreshToken");
const { getTherapyPlanModel, getTherapySession } = require("../db/therepy");
const { getPatientModel } = require("../db/patientSchema");
const { getPaymentModel } = require("../db/paymentSchema");
const { getPrescriptionModel } = require("../db/prescriptionSchema");
const { addToWhatsAppQueue } = require("./WhatsappQueueController");
const Organization = require("../db/OrganizationSchema");
const { AccessToken } = require("livekit-server-sdk");
const { addAppointmentToWhatsAppQueue } = require("./WhatsappQueueController");
const getCompleteSessionDetails = async (req, res) => {
  try {
    const { id } = req.params; // Therapy Session ID

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid Session ID format" });
    }

    // 1. Initialize Models
    const TherapySession = getTherapySession(req.orgDb);
    const TherapyPlan = getTherapyPlanModel(req.orgDb);
    const Prescription = getPrescriptionModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);

    // 2. Fetch the Core Session Data
    const session = await TherapySession.findById(id).lean();
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // 3. Parallel fetching of related entities for performance
    const [prescription, patient, therapyPlan] = await Promise.all([
      session.prescription_id
        ? Prescription.findById(session.prescription_id).lean()
        : null,
      Patient.findById(session.patient_id)
        .select("patient_first_name patient_last_name email phone gender")
        .lean(),
      session.plan_id ? TherapyPlan.findById(session.plan_id) : null,
    ]);

    // 4. Extract and filter Images from the Therapy Plan
    // We use the helper method to get fresh SAS tokens
    let sessionImages = { presession: [], postsession: [] };

    if (therapyPlan) {
      const allImagesWithTokens = await therapyPlan.getImagesWithSasTokens();

      // Filter images specifically linked to this Session ID
      sessionImages.presession = allImagesWithTokens.filter(
        (img) =>
          img.session_type === "presession" &&
          img.SessionId?.toString() === id.toString(),
      );
      sessionImages.postsession = allImagesWithTokens.filter(
        (img) =>
          img.session_type === "postsession" &&
          img.SessionId?.toString() === id.toString(),
      );
    }

    // 5. Build the Unified Response
    return res.status(200).json({
      success: true,
      data: {
        session_info: {
          ...session,
          duration: session.session_duration,
          status: session.status,
          remarks: session.postsession_remarks,
          is_retrospective: session.completed_retrospectively || false,
        },
        patient_details: patient,
        prescription: prescription || {
          message: "No prescription issued for this session",
        },
        media: sessionImages,
        plan_context: therapyPlan
          ? {
              plan_name: therapyPlan.plan_name,
              total_sessions: therapyPlan.total_sessions,
              plan_id: therapyPlan._id,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("Error fetching complete session details:", error);
    return res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
};

const createConsultation = async (req, res) => {
  try {
    const { body: Convo, user, orgDb } = req;
    const {
      organization_name,
      doctor_phone,
      doctor_id: requestingDoctorId,
    } = user;
    // Initialize Mongoose models using the connection
    const TherapySession = getTherapySession(orgDb);
    const TherapyPlan = getTherapyPlanModel(orgDb);
    const Patient = getPatientModel(orgDb);

    // Validate required fields
    const requiredFields = [
      "contactId",
      "therepy_type",
      "therepy_start_time",
      "therepy_end_time",
      "therepy_date",
      "doctor_id",
      "doctor_name",
      // Additional consultation-specific fields
    ];

    if (requiredFields.some((field) => !Convo[field])) {
      return res.status(400).json({ msg: "Missing required fields" });
    }

    // Find patient using Mongoose
    const patient = await Patient.findById(Convo.contactId);
    if (!patient) return res.status(404).json({ msg: "Patient not found" });

    // For consultations, therapy plan might be optional
    let therapyPlan = null;
    if (Convo.plan_id) {
      therapyPlan = await TherapyPlan.findById(Convo.plan_id);
      if (!therapyPlan) {
        return res.status(404).json({ msg: "Therapy plan not found" });
      }
    }

    // Parse and validate date
    const therapyDate = moment.tz(
      Convo.therepy_date,
      "YYYY-MM-DD",
      "Asia/Kolkata",
    );
    if (!therapyDate.isValid()) {
      throw new Error(`Invalid therapy date: ${Convo.therepy_date}`);
    }

    // Construct start and end times
    const startDateTime = moment.tz(
      `${Convo.therepy_date} ${Convo.therepy_start_time}`,
      "YYYY-MM-DD HH:mm",
      "Asia/Kolkata",
    );
    const endDateTime = moment.tz(
      `${Convo.therepy_date} ${Convo.therepy_end_time}`,
      "YYYY-MM-DD HH:mm",
      "Asia/Kolkata",
    );

    if (!startDateTime.isValid() || !endDateTime.isValid()) {
      throw new Error("Invalid date format for start or end time.");
    }

    let responseData = null;
    const type = Convo.therepy_type?.toLowerCase();

    if (type === "online" || type === "video" || type === "livekit") {
      const roomName = `session-${new mongoose.Types.ObjectId()}`;

      // Calculate TTL (Time-To-Live) in seconds.
      // Valid from NOW until 1 hour after the session ends.
      const now = moment();
      const ttlSeconds = Math.max(
        endDateTime.diff(now, "seconds") + 3600,
        3600,
      );

      const apiKey = process.env.LIVEKIT_API_KEY;
      const apiSecret = process.env.LIVEKIT_API_SECRET;

      if (!apiKey || !apiSecret) {
        console.warn(
          "LiveKit API Key or Secret is missing. Cannot generate video tokens.",
        );
      } else {
        // Generate Patient Token
        const patientToken = new AccessToken(apiKey, apiSecret, {
          identity: `patient-${patient._id}`,
          name: `${patient.patient_first_name} ${patient.patient_last_name}`,
          ttl: ttlSeconds,
        });
        patientToken.addGrant({ roomJoin: true, room: roomName });
        const patientJwt = await patientToken.toJwt();

        // Generate Doctor Token
        const doctorToken = new AccessToken(apiKey, apiSecret, {
          identity: `doctor-${Convo.doctor_id}`,
          name: Convo.doctor_name,
          ttl: ttlSeconds,
        });
        doctorToken.addGrant({ roomJoin: true, room: roomName });
        const doctorJwt = await doctorToken.toJwt();

        // Construct the frontend URLs to be sent via WhatsApp
        const patientBaseUrl =
          process.env.PATIENT_FRONTEND_URL || "https://healtrack.ai/session";
        const doctorBaseUrl =
          process.env.DOCTOR_FRONTEND_URL ||
          "https://doctor.healtrack.ai/session";

        responseData = {
          Id: roomName,
          HostJoinUrl: `${doctorBaseUrl}/${roomName}?token=${doctorJwt}`,
          ParticipantJoinUrl: `${patientBaseUrl}/${roomName}?token=${patientJwt}`,
          Status: "Scheduled",
        };
      }
    }

    const orgSettings = await orgDb
      .collection("organization_settings")
      .findOne({ tenant_id: user.tenant_id });

    if (!orgSettings?.access_token) {
      throw new Error("No Google Calendar access token found for organization");
    }

    const event = createGoogleCalendarEventobj(
      Convo,
      responseData,
      startDateTime,
      endDateTime,
      patient,
      orgSettings.calendar_email || "organization@example.com",
    );

    const createGoogleCalendarEvent = async (accessToken) => {
      try {
        const calendarResponse = await axios.post(
          "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          event,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
          },
        );
        return calendarResponse.data.id;
      } catch (error) {
        if (error.response && error.response.status === 401) {
          // Token expired, refresh and try again
          const newAccessToken = await refreshToken(user.tenant_id);
          // Update the organization's access token
          await orgDb.collection("organization_settings").updateOne(
            { tenant_id: user.tenant_id },
            {
              $set: {
                access_token: newAccessToken,
                last_updated: new Date(),
              },
            },
          );
          return createGoogleCalendarEvent(newAccessToken);
        }
        throw error;
      }
    };

    const googleCalendarEventId = await createGoogleCalendarEvent(
      orgSettings.access_token,
    );

    const consultationSessionData = {
      patient_id: Convo.contactId,
      patient_name: `${patient.patient_first_name} ${patient.patient_last_name}`,
      therepy_id: responseData ? responseData.Id : null,
      therepy_type: Convo.therepy_type,
      therepy_link: responseData ? responseData.ParticipantJoinUrl : null,
      host_join_link: responseData ? responseData.HostJoinUrl : null,
      therepy_start_time: Convo.therepy_start_time,
      therepy_end_time: Convo.therepy_end_time,
      therepy_date: therapyDate.format("YYYY-MM-DD"),
      doctor_id: Convo.doctor_id,
      doctor_name: Convo.doctor_name,
      plan_id: Convo.plan_id || null,
      location_id: Convo?.location_id,
      location_name: Convo?.location_name,
      location_address: Convo?.location_address || null,
      conversation_status: responseData ? responseData.Status : null,
      embedded_conversation_url: responseData
        ? responseData.EmbeddedConversationUrl
        : null,
      google_calendar_event_id: googleCalendarEventId,
      created_by: requestingDoctorId,
      status: "Scheduled",
      // Consultation-specific fields
      is_consultation: true,
      therapy_reason: Convo.therapy_reason,
      patientSymptoms: Convo.patientSymptoms,
      organization_name: organization_name,
      doctor_phone: doctor_phone,
      source: "doctor", // Mark consultations created from mobile app
    };

    // Create a new consultation session using the Mongoose model
    const newConsultationSession = new TherapySession(consultationSessionData);

    // Save the new consultation session
    const savedSession = await newConsultationSession.save();

    // ==========================================
    // 4. WHATSAPP QUEUE NOTIFICATION
    // ==========================================
    // Fetch organization info for the WhatsApp message
    const organization = await Organization.findOne({
      tenant_id: user.tenant_id,
    }).lean();

    if (organization && patient.patient_phone) {
      // Check the therapy type
      const isOnline =
        type === "online" || type === "video" || type === "livekit";

      // Only add to the queue if it is an online session
      if (isOnline) {
        await addAppointmentToWhatsAppQueue(
          user.tenant_id,
          patient,
          savedSession,
          { doctor_name: Convo.doctor_name },
          organization,
        );
      }
    }

    // Update the patient using Mongoose
    patient.therepys.push(savedSession._id);
    await patient.save();

    return res.status(200).json({
      responseData,
      patient: patient,
      consultation: savedSession,
    });
  } catch (error) {
    console.error("Error in createConsultation:", error);
    return res.status(500).json({ msg: error.message });
  }
};

const createTherepy = async (req, res) => {
  try {
    const { ["x-liveswitch-token"]: liveSwitchToken } = req.headers;
    const { body: Convo, user, orgDb } = req;
    const {
      doctor_first_name,
      doctor_last_name,
      organization_name,
      doctor_phone,
      doctor_id: requestingDoctorId,
      tenant_id,
    } = user;

    // Initialize Mongoose models using the connection
    const TherapySession = getTherapySession(orgDb);
    const TherapyPlan = getTherapyPlanModel(orgDb);
    const Patient = getPatientModel(orgDb);

    // Validate required fields
    const requiredFields = [
      "contactId",
      "therepy_type",
      "therepy_start_time",
      "therepy_end_time",
      "therepy_date",
      "doctor_id",
      "doctor_name",
      "plan_id",
    ];

    if (requiredFields.some((field) => !Convo[field])) {
      return res.status(400).json({ msg: "Missing required fields" });
    }

    // Find patient using Mongoose
    const patient = await Patient.findById(Convo.contactId);
    if (!patient) return res.status(404).json({ msg: "Patient not found" });

    // Find therapy plan using Mongoose
    const therapyPlan = await TherapyPlan.findById(Convo.plan_id);
    if (!therapyPlan) {
      return res.status(404).json({ msg: "Therapy plan not found" });
    }

    // Parse and validate date
    const therapyDate = moment.tz(
      Convo.therepy_date,
      "YYYY-MM-DD",
      "Asia/Kolkata",
    );
    if (!therapyDate.isValid()) {
      throw new Error(`Invalid therapy date: ${Convo.therepy_date}`);
    }

    // Construct start and end times
    const startDateTime = moment.tz(
      `${Convo.therepy_date} ${Convo.therepy_start_time}`,
      "YYYY-MM-DD HH:mm",
      "Asia/Kolkata",
    );
    const endDateTime = moment.tz(
      `${Convo.therepy_date} ${Convo.therepy_end_time}`,
      "YYYY-MM-DD HH:mm",
      "Asia/Kolkata",
    );

    if (!startDateTime.isValid() || !endDateTime.isValid()) {
      throw new Error("Invalid date format for start or end time.");
    }

    let responseData = null;

    // ==========================================
    // 1. LIVEKIT VIDEO TOKEN GENERATION LOGIC
    // ==========================================
    const type = Convo.therepy_type?.toLowerCase();

    if (type === "online" || type === "video" || type === "livekit") {
      const roomName = `session-${new mongoose.Types.ObjectId()}`;

      // Calculate TTL (Time-To-Live) in seconds.
      // Valid from NOW until 1 hour after the session ends.
      const now = moment();
      const ttlSeconds = Math.max(
        endDateTime.diff(now, "seconds") + 3600,
        3600,
      );

      const apiKey = process.env.LIVEKIT_API_KEY;
      const apiSecret = process.env.LIVEKIT_API_SECRET;

      if (!apiKey || !apiSecret) {
        console.warn(
          "LiveKit API Key or Secret is missing. Cannot generate video tokens.",
        );
      } else {
        // Generate Patient Token
        const patientToken = new AccessToken(apiKey, apiSecret, {
          identity: `patient-${patient._id}`,
          name: `${patient.patient_first_name} ${patient.patient_last_name}`,
          ttl: ttlSeconds,
        });
        patientToken.addGrant({ roomJoin: true, room: roomName });
        const patientJwt = await patientToken.toJwt();

        // Generate Doctor Token
        const doctorToken = new AccessToken(apiKey, apiSecret, {
          identity: `doctor-${Convo.doctor_id}`,
          name: Convo.doctor_name,
          ttl: ttlSeconds,
        });
        doctorToken.addGrant({ roomJoin: true, room: roomName });
        const doctorJwt = await doctorToken.toJwt();

        // Construct the frontend URLs to be sent via WhatsApp
        const patientBaseUrl =
          process.env.PATIENT_FRONTEND_URL || "https://healtrack.ai/session";
        const doctorBaseUrl =
          process.env.DOCTOR_FRONTEND_URL ||
          "https://doctor.healtrack.ai/session";

        responseData = {
          Id: roomName,
          HostJoinUrl: `${doctorBaseUrl}/${roomName}?token=${doctorJwt}`,
          ParticipantJoinUrl: `${patientBaseUrl}/${roomName}?token=${patientJwt}`,
          Status: "Scheduled",
        };
      }
    }

    // ==========================================
    // 2. GOOGLE CALENDAR EVENT GENERATION
    // ==========================================
    const orgSettings = await orgDb
      .collection("organization_settings")
      .findOne({ tenant_id: user.tenant_id });

    if (!orgSettings?.access_token) {
      throw new Error("No Google Calendar access token found for organization");
    }

    const event = createGoogleCalendarEventobj(
      Convo,
      responseData,
      startDateTime,
      endDateTime,
      patient,
      orgSettings.calendar_email || "organization@example.com",
    );

    const createGoogleCalendarEvent = async (accessToken) => {
      try {
        const calendarResponse = await axios.post(
          "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          event,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
          },
        );
        return calendarResponse.data.id;
      } catch (error) {
        if (error.response && error.response.status === 401) {
          // Token expired, refresh and try again
          const newAccessToken = await refreshToken(user.tenant_id);
          // Update the organization's access token
          await orgDb.collection("organization_settings").updateOne(
            { tenant_id: user.tenant_id },
            {
              $set: {
                access_token: newAccessToken,
                last_updated: new Date(),
              },
            },
          );
          return createGoogleCalendarEvent(newAccessToken);
        }
        throw error;
      }
    };

    const googleCalendarEventId = await createGoogleCalendarEvent(
      orgSettings.access_token,
    );

    // ==========================================
    // 3. SAVE THERAPY SESSION TO DATABASE
    // ==========================================
    const therapySessionData = {
      patient_id: Convo.contactId,
      patient_name: `${patient.patient_first_name} ${patient.patient_last_name}`,
      therepy_id: responseData ? responseData.Id : null,
      therepy_type: Convo.therepy_type,
      // Defaulting to the patient's link so it's easily accessible for WhatsApp queue
      therepy_link: responseData ? responseData.ParticipantJoinUrl : null,
      host_join_link: responseData ? responseData.HostJoinUrl : null, // Store doctor link separately if schema allows
      therepy_start_time: Convo.therepy_start_time,
      therepy_end_time: Convo.therepy_end_time,
      therepy_date: therapyDate.format("YYYY-MM-DD"),
      doctor_id: Convo.doctor_id,
      doctor_name: Convo.doctor_name,
      plan_id: Convo.plan_id,
      location_id: Convo?.location_id,
      location_name: Convo?.location_name,
      location_address: Convo?.location_address || null,
      conversation_status: responseData ? responseData.Status : null,
      embedded_conversation_url: responseData
        ? responseData.EmbeddedConversationUrl
        : null,
      google_calendar_event_id: googleCalendarEventId,
      created_by: requestingDoctorId,
      status: "Scheduled",
      source: "doctor", // Mark appointments created from mobile app
    };

    // Create a new therapy session using the Mongoose model
    const newTherapySession = new TherapySession(therapySessionData);

    // Save the new therapy session
    const savedSession = await newTherapySession.save();
    // Fetch organization info for the WhatsApp message
    const organization = await Organization.findOne({
      tenant_id: user.tenant_id,
    }).lean();

    if (organization && patient.patient_phone) {
      // Check the therapy type
      const sessionType = Convo.therepy_type?.toLowerCase();
      const isOnline =
        sessionType === "online" ||
        sessionType === "video" ||
        sessionType === "livekit";

      // Only add to the queue if it is an online session
      if (isOnline) {
        await addAppointmentToWhatsAppQueue(
          user.tenant_id,
          patient,
          savedSession,
          { doctor_name: Convo.doctor_name },
          organization,
        );
      }
    }
    // Update the patient using Mongoose
    patient.therepys.push(savedSession._id);
    await patient.save();

    // Use the TherapyPlan model methods to add the session
    await therapyPlan.addSession(savedSession._id, "Scheduled");

    return res.status(200).json({
      responseData,
      patient: patient,
      therapy: savedSession,
    });
  } catch (error) {
    console.error("Error in createTherepy:", error);
    return res.status(500).json({ msg: error.message });
  }
};
const updateTherepy = async (req, res) => {
  try {
    const { ["x-liveswitch-token"]: liveSwitchToken } = req.headers;
    const { body: updatedTherapy, user, orgDb } = req;
    const {
      doctor_first_name,
      doctor_last_name,
      organization_name,
      doctor_phone,
      doctor_id: requestingDoctorId,
    } = user;

    // Initialize Mongoose models using the connection
    const TherapySession = getTherapySession(orgDb);
    const TherapyPlan = getTherapyPlanModel(orgDb);
    const Patient = getPatientModel(orgDb);

    // Validate therapy ID
    if (!updatedTherapy._id) {
      return res.status(400).json({ msg: "Therapy ID is required" });
    }

    // Validate required fields
    const requiredFields = [
      "patient_id",
      "therepy_type",
      "therepy_start_time",
      "therepy_end_time",
      "therepy_date",
      "doctor_id",
      "doctor_name",
      "plan_id",
    ];

    if (requiredFields.some((field) => !updatedTherapy[field])) {
      return res.status(400).json({ msg: "Missing required fields" });
    }

    // Find existing therapy using Mongoose
    const existingTherapy = await TherapySession.findById(updatedTherapy._id);

    if (!existingTherapy) {
      return res.status(404).json({ msg: "Therapy session not found" });
    }

    // Find patient using Mongoose
    const patient = await Patient.findById(updatedTherapy.patient_id);

    if (!patient) {
      return res.status(404).json({ msg: "Patient not found" });
    }

    // Parse and validate date
    const therapyDate = moment.tz(
      updatedTherapy.therepy_date,
      "YYYY-MM-DD",
      "Asia/Kolkata",
    );
    if (!therapyDate.isValid()) {
      throw new Error(`Invalid therapy date: ${updatedTherapy.therepy_date}`);
    }

    // Construct start and end times
    const startDateTime = moment.tz(
      `${updatedTherapy.therepy_date} ${updatedTherapy.therepy_start_time}`,
      "YYYY-MM-DD HH:mm",
      "Asia/Kolkata",
    );
    const endDateTime = moment.tz(
      `${updatedTherapy.therepy_date} ${updatedTherapy.therepy_end_time}`,
      "YYYY-MM-DD HH:mm",
      "Asia/Kolkata",
    );

    if (!startDateTime.isValid() || !endDateTime.isValid()) {
      throw new Error("Invalid date format for start or end time.");
    }

    let responseData = null;

    // Create LiveSwitch conversation for online therapy
    if (
      liveSwitchToken &&
      updatedTherapy.therepy_type.toLowerCase() === "liveswitch"
    ) {
      const appointmentDate = moment.tz(
        updatedTherapy.therepy_date,
        "YYYY-MM-DD",
        "Asia/Kolkata",
      );
      const formattedDate = appointmentDate.format("DD-MM-YYYY");
      const formattedTime = moment(
        updatedTherapy.therepy_start_time,
        "HH:mm",
      ).format("hh:mm A");

      const patientMessage = `Dear ${patient.patient_first_name} ${patient.patient_last_name},
Your Appointment has been Updated With Dr. ${updatedTherapy.doctor_name} On ${formattedDate} at ${formattedTime}.
For any queries please call ${doctor_phone}
Regards,
${organization_name}
Team Click to Join Therapy`;

      responseData = await createLiveSwitchConversation(
        liveSwitchToken,
        patient,
        patientMessage,
        updatedTherapy,
      );
    }

    // Update Google Calendar event
    const orgSettings = await orgDb
      .collection("organization_settings")
      .findOne({ tenant_id: user.tenant_id });

    if (!orgSettings?.access_token) {
      throw new Error("No Google Calendar access token found for organization");
    }

    const event = createGoogleCalendarEventobj(
      updatedTherapy,
      responseData,
      startDateTime,
      endDateTime,
      patient,
      orgSettings.calendar_email || "organization@example.com",
    );

    const updateGoogleCalendarEvent = async (accessToken) => {
      try {
        // If no existing Google Calendar event, create a new one
        if (!existingTherapy.google_calendar_event_id) {
          const calendarResponse = await axios.post(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            event,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
            },
          );
          return calendarResponse.data.id;
        }

        // Update existing event
        await axios.put(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events/${existingTherapy.google_calendar_event_id}`,
          event,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
          },
        );
        return existingTherapy.google_calendar_event_id;
      } catch (error) {
        // Handle missing calendar event (404/410)
        if (
          error.response &&
          (error.response.status === 404 || error.response.status === 410)
        ) {
          console.warn(
            "Google Calendar event not found. Creating a new one instead.",
          );
          const calendarResponse = await axios.post(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            event,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
            },
          );
          return calendarResponse.data.id;
        }

        if (error.response && error.response.status === 401) {
          // Token expired, refresh and try again
          const newAccessToken = await refreshToken(user.tenant_id);
          await orgDb.collection("organization_settings").updateOne(
            { tenant_id: user.tenant_id },
            {
              $set: {
                access_token: newAccessToken,
                last_updated: new Date(),
              },
            },
          );
          return updateGoogleCalendarEvent(newAccessToken);
        }
        throw error;
      }
    };

    const googleCalendarEventId = await updateGoogleCalendarEvent(
      orgSettings.access_token,
    );

    // Update existing therapy using Mongoose
    existingTherapy.patient_id = updatedTherapy.patient_id;
    existingTherapy.patient_name = `${patient.patient_first_name} ${patient.patient_last_name}`;
    existingTherapy.therepy_id = responseData
      ? responseData.Id
      : existingTherapy.therepy_id;
    existingTherapy.therepy_type = updatedTherapy.therepy_type;
    existingTherapy.therepy_link = responseData
      ? responseData.HostJoinUrl
      : existingTherapy.therepy_link;
    existingTherapy.therepy_start_time = updatedTherapy.therepy_start_time;
    existingTherapy.therepy_end_time = updatedTherapy.therepy_end_time;
    existingTherapy.therepy_date = therapyDate.format("YYYY-MM-DD");
    existingTherapy.doctor_id = updatedTherapy.doctor_id;
    existingTherapy.doctor_name = updatedTherapy.doctor_name;
    existingTherapy.plan_id = updatedTherapy.plan_id;
    existingTherapy.conversation_status = responseData
      ? responseData.Status
      : existingTherapy.conversation_status;
    existingTherapy.embedded_conversation_url = responseData
      ? responseData.EmbeddedConversationUrl
      : existingTherapy.embedded_conversation_url;
    existingTherapy.google_calendar_event_id = googleCalendarEventId;
    existingTherapy.updated_by = requestingDoctorId;

    // Save the updated therapy session
    const updatedSession = await existingTherapy.save();

    // Check if plan_id has changed and update references accordingly

    // If the therapy status has changed, update the plan accordingly
    if (
      updatedTherapy.status &&
      updatedTherapy.status !== existingTherapy.status
    ) {
      const plan = await TherapyPlan.findById(updatedTherapy.plan_id);
      if (plan) {
        await plan.updateSessionStatus(
          updatedSession._id,
          updatedTherapy.status,
        );
      }
    }

    return res.status(200).json({
      msg: "Therapy session updated successfully",
      therapy: updatedSession,
      responseData,
    });
  } catch (error) {
    console.error("Error in updateTherepy:", error);
    return res.status(500).json({ msg: error.message });
  }
};
const createLiveSwitchConversation = async (
  liveSwitchToken,
  patient,
  message,
  therapyData,
) => {
  const url = `https://public-api.production.liveswitch.com/v1/conversations`;
  const headers = {
    Authorization: `Bearer ${liveSwitchToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const conversationBody = {
    phone: patient.patient_phone,
    type: "LiveConversation",
    autoStartRecording: therapyData.autoStartRecording,
    sendSmsNotification: therapyData.sendSmsNotification,
    message,
  };
  const response = await axios.post(url, conversationBody, { headers });
  return {
    Id: response.data.id,
    Type: response.data.type,
    HostJoinUrl: response.data.hostJoinUrl,
    ParticipantJoinUrl: response.data.participantJoinUrl,
    ConversationUrl: response.data.conversationUrl,
    EmbeddedConversationUrl: response.data.embeddedConversationUrl,
    CreatedAt: response.data.createdAt,
    UpdatedAt: response.data.updatedAt,
    Name: response.data.name,
    ContactId: response.data.contactId,
    Status: response.data.status,
  };
};

const createGoogleCalendarEventobj = (
  therapyData,
  responseData,
  startDateTime,
  endDateTime,
  patient,
  doctorEmail,
) => {
  const event = {
    summary: `${patient.patient_first_name} ${patient.patient_last_name} - ${therapyData.doctor_name} - ${therapyData.therepy_type}`,
    location: therapyData.therepy_type,
    description: `Patient: ${patient.patient_first_name} ${
      patient.patient_last_name
    }
Type: ${therapyData.therepy_type}
${
  therapyData.therepy_type.toLowerCase() === "liveswitch" && responseData
    ? `Join URL: ${responseData.ParticipantJoinUrl}`
    : `${therapyData.therepy_type} therapy session`
}`,
    start: {
      dateTime: startDateTime.toISOString(),
      timeZone: "Asia/Kolkata",
    },
    end: {
      dateTime: endDateTime.toISOString(),
      timeZone: "Asia/Kolkata",
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "email", minutes: 24 * 60 },
        { method: "popup", minutes: 10 },
      ],
    },
    attendees: [],
  };

  // Helper function to validate email format
  const isValidEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  // Only add attendees with valid email addresses
  if (patient.patient_email && isValidEmail(patient.patient_email)) {
    event.attendees.push({ email: patient.patient_email });
  }

  if (
    therapyData.doctor_email &&
    isValidEmail(therapyData.doctor_email) &&
    therapyData.doctor_email !== doctorEmail
  ) {
    event.attendees.push({ email: therapyData.doctor_email });
  }

  // If no valid attendees, remove the empty attendees array
  if (event.attendees.length === 0) {
    delete event.attendees;
  }

  return event;
};

const getConvo = async (req, res) => {
  try {
    await loadTokens();

    const { conversationId } = req.body;
    const url = `https://ls-sbx-integration-app-cus-001.azurewebsites.net/api/v1/Contact/Conversations/${conversationId}`;
    const headers = {
      Authorization: process.env.Token,
      "x-organization-id": process.env.x_organization_id,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const response = await axios.get(url, { headers });
    const responseData = {
      Id: response.data.Id,
      Type: response.data.Type,
      HostJoinUrl: response.data.HostJoinUrl,
      ParticipantJoinUrl: response.data.ParticipantJoinUrl,
      ConversationUrl: response.data.ConversationUrl,
    };
    return res.status(200).json({ responseData });
  } catch (error) {
    console.error("Error getting therepys for patient:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const getTherepy = async (req, res) => {
  try {
    const { id } = req.params;
    const patient = await req.orgDb
      .collection("patients")
      .findOne(
        { _id: new ObjectId(id) },
        { projection: { therepys: 1, _id: 0 } },
      );

    if (!patient) {
      return res.status(404).json({ error: "Patient not found" });
    }

    if (!patient.therepys || patient.therepys.length === 0) {
      return res.status(200).json({ therepys: 0 });
    }

    const therepys = await req.orgDb
      .collection("therepys")
      .find({ _id: { $in: patient.therepys } })
      .toArray();

    res.status(200).json({
      therepys: therepys,
    });
  } catch (error) {
    console.error("Error getting therepys for patient:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const createTherapyPlan = async (req, res) => {
  try {
    const { patientId } = req.params;
    const therapyPlanData = req.body;
    const { user, orgDb } = req;

    // 1. Parse Prescription Data (if provided)
    let prescriptionData = null;
    if (req.body.prescription) {
      try {
        prescriptionData =
          typeof req.body.prescription === "string"
            ? JSON.parse(req.body.prescription)
            : req.body.prescription;
      } catch (error) {
        return res
          .status(400)
          .json({ error: "Invalid prescription data format" });
      }
    }

    // Calculate discounted amount if discount percentage is provided
    let finalTotalAmount = parseFloat(therapyPlanData.total_amount || 0);
    let discountAmount = 0;

    if (
      therapyPlanData.discount_percentage &&
      therapyPlanData.discount_percentage > 0
    ) {
      const discountPercentage = parseFloat(
        therapyPlanData.discount_percentage,
      );

      // Validate discount percentage (should be between 0 and 100)
      if (discountPercentage < 0 || discountPercentage > 100) {
        return res.status(400).json({
          msg: "Discount percentage must be between 0 and 100",
        });
      }

      // Calculate discount amount and final total
      discountAmount = (finalTotalAmount * discountPercentage) / 100;
      finalTotalAmount = finalTotalAmount - discountAmount;

      // Update therapy plan data with calculated values
      therapyPlanData.original_amount = therapyPlanData.total_amount;
      therapyPlanData.discount_amount = discountAmount.toString();
      therapyPlanData.total_amount = finalTotalAmount.toString();
    }

    // Validate amounts with discounted total
    if (therapyPlanData.received_amount && therapyPlanData.total_amount) {
      const receivedAmount = parseFloat(therapyPlanData.received_amount);
      const totalAmount = parseFloat(therapyPlanData.total_amount);

      if (receivedAmount > totalAmount) {
        return res.status(400).json({
          msg: "Received amount cannot be greater than total amount (after discount)",
        });
      }
      therapyPlanData.balance = (totalAmount - receivedAmount).toString();
    } else {
      therapyPlanData.received_amount = therapyPlanData.received_amount || "0";
      therapyPlanData.balance = therapyPlanData.total_amount || "0";
    }

    // Get models
    const TherapyPlan = getTherapyPlanModel(orgDb);
    const Patient = getPatientModel(orgDb);
    const Payment = getPaymentModel(orgDb);
    const Prescription = getPrescriptionModel(orgDb);

    const patientObjectId = new mongoose.Types.ObjectId(patientId);

    // 2. Check for existing active therapy plan (Fast lean check)
    const patientDoc = await Patient.findById(patientObjectId)
      .select("therapy_plans patient_first_name patient_last_name")
      .lean();

    if (!patientDoc) {
      return res.status(404).json({ msg: "Patient not found" });
    }

    if (patientDoc.therapy_plans && patientDoc.therapy_plans.length > 0) {
      const existingActivePlan = await TherapyPlan.findOne({
        _id: { $in: patientDoc.therapy_plans },
        status: "Active",
      })
        .select("_id therapy_name therapy_start therapy_end status")
        .lean();

      if (existingActivePlan) {
        return res.status(409).json({
          msg: "Patient already has an active therapy plan. Please close or complete the existing plan before creating a new one.",
          activePlan: {
            _id: existingActivePlan._id,
            therapy_name: existingActivePlan.therapy_name,
            therapy_start: existingActivePlan.therapy_start,
            therapy_end: existingActivePlan.therapy_end,
            status: existingActivePlan.status,
          },
        });
      }
    }

    // 3. Handle Prescription Creation
    let savedPrescriptionId = null;
    if (
      prescriptionData &&
      prescriptionData.medications &&
      prescriptionData.medications.length > 0
    ) {
      const prescriptionNumber =
        prescriptionData.prescription_number ||
        `PRE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      const newPrescription = new Prescription({
        prescription_number: prescriptionNumber,
        patient_id: patientId,
        patient_name: `${patientDoc.patient_first_name} ${patientDoc.patient_last_name}`,
        doctor_id: user.doctor_id,
        doctor_name:
          user.doctor_name ||
          `${user.doctor_first_name || ""} ${user.doctor_last_name || ""}`.trim(),
        prescription_date: new Date(),
        vitals: prescriptionData.vitals || {},
        medications: prescriptionData.medications,
        diagnosis:
          prescriptionData.diagnosis ||
          therapyPlanData.patient_diagnosis ||
          "Therapy Plan Prescription",
        notes: prescriptionData.notes || "",
        status: "Active",
      });

      const savedPrescription = await newPrescription.save();
      savedPrescriptionId = savedPrescription._id;
    }

    // 4. Create and save therapy plan
    const newPlan = new TherapyPlan({
      ...therapyPlanData,
      created_by: user.doctor_id,
      prescription_id: savedPrescriptionId,
      prescriptions: savedPrescriptionId ? [savedPrescriptionId] : [],
    });
    const savedPlan = await newPlan.save();

    // Create payment record if received amount > 0
    const receivedAmount = parseFloat(therapyPlanData.received_amount || 0);
    const totalAmount = parseFloat(therapyPlanData.total_amount || 0);
    const balance = totalAmount - receivedAmount;

    if (receivedAmount > 0) {
      await Payment.create({
        amount: receivedAmount,
        type: "CASH",
        therapy_plan_id: savedPlan._id,
        patient_id: patientObjectId,
        doctor_id: user.doctor_id,
        balance_after_payment: balance,
        received_amount_total: receivedAmount,
        tenant_id: user.tenant_id,
        addon_services: [],
        payment_number: 1,
        discount_applied: discountAmount > 0 ? discountAmount : null,
        original_amount: therapyPlanData.original_amount || null,
      });
    }

    // 5. Build the Journey entry
    const performerName =
      user.doctor_name ||
      `${user.doctor_first_name || ""} ${user.doctor_last_name || ""}`.trim();

    const journeyEntry = {
      stage: "Treatment Plan Created",
      performed_by_id: user.doctor_id,
      performed_by_name: performerName,
      performed_at: new Date(),
      notes: `Plan: ${savedPlan.therapy_name || "New Treatment Plan"}`,
      status: "Completed",
    };

    // 6. Fast Single-Trip Conditional Update
    // Pushes therapy plan reference and attaches "Treatment Plan Created" only if not already recorded
    let updatedPatient = await Patient.findOneAndUpdate(
      {
        _id: patientObjectId,
        "patient_journey.stage": { $ne: "Treatment Plan Created" },
      },
      {
        $push: {
          therapy_plans: savedPlan._id,
          patient_journey: journeyEntry,
        },
      },
      { new: true },
    );

    // If journey marker already exists, push only the plan reference
    if (!updatedPatient) {
      updatedPatient = await Patient.findByIdAndUpdate(
        patientObjectId,
        { $push: { therapy_plans: savedPlan._id } },
        { new: true },
      );
    }

    // Queue WhatsApp notification asynchronously
    try {
      const organization = await Organization.findOne({
        tenant_id: user.tenant_id,
      }).lean();

      if (organization && updatedPatient.patient_phone) {
        await addToWhatsAppQueue(
          user.tenant_id,
          updatedPatient,
          savedPlan,
          organization,
        );
      }
    } catch (queueErr) {
      console.error("Error queueing WhatsApp message:", queueErr);
    }

    // Response packet
    const responseData = {
      plan: savedPlan,
      paymentCreated: receivedAmount > 0 ? "Success" : "No initial payment",
      prescriptionCreated: savedPrescriptionId !== null,
      prescriptionId: savedPrescriptionId,
    };

    if (discountAmount > 0) {
      responseData.discountDetails = {
        original_amount: therapyPlanData.original_amount,
        discount_percentage: therapyPlanData.discount_percentage,
        discount_amount: discountAmount,
        final_amount: finalTotalAmount,
        savings: discountAmount,
      };
    }

    return res.status(201).json(responseData);
  } catch (error) {
    console.error("Error in createTherapyPlan:", {
      message: error.message,
      stack: error.stack,
      details: error,
    });
    return res.status(500).json({
      msg: "Server error",
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};
const getPlans = async (req, res) => {
  const { patientId } = req.params;

  try {
    // Find the patient by their ID
    const patient = await req.orgDb
      .collection("patients")
      .findOne({ patient_id: patientId });

    if (!patient) {
      return res.status(404).json({ msg: "Patient not found" });
    }

    // Extract therapy plan ObjectIds from the patient document
    const therapyPlanIds = patient.therapy_plans.map((id) => ObjectId(id));

    // Fetch all therapy plans based on these ObjectIds
    const therapyPlans = await req.orgDb.collection("plans").find({
      _id: { $in: therapyPlanIds },
    });

    // Return the patient data along with the therapy plans
    return res.json({
      patientData: {
        ...patient.toObject(),
        therapy_plans: therapyPlans,
      },
    });
  } catch (error) {
    console.error("Error fetching patient or therapy plans:", error);
    res.status(500).json({ msg: "Server error" });
  }
};

const deleteTherapy = async (req, res) => {
  try {
    const { ["x-liveswitch-token"]: liveSwitchToken } = req.headers;
    const { user, orgDb } = req;
    const therapyId = req.params.id;

    // Initialize Mongoose models using the connection
    const TherapySession = getTherapySession(orgDb);
    const TherapyPlan = getTherapyPlanModel(orgDb);
    const Patient = getPatientModel(orgDb);

    // Find the therapy session using Mongoose
    const therapy = await TherapySession.findById(therapyId);
    if (!therapy) {
      return res.status(404).json({ msg: "Therapy session not found" });
    }

    // Find the patient using Mongoose
    const patient = await Patient.findById(therapy.patient_id);
    if (!patient) {
      return res.status(404).json({ msg: "Patient not found" });
    }

    // Find the therapy plan using Mongoose
    if (therapy.plan_id) {
      const therapyPlan = await TherapyPlan.findById(therapy.plan_id);
      if (therapyPlan) {
        // Update the therapy plan to remove this session
        await TherapyPlan.updateOne(
          { _id: therapy.plan_id },
          {
            $pull: {
              therapy_sessions: { _id: new mongoose.Types.ObjectId(therapyId) },
            },
          },
        );

        // Update completed/remaining sessions count if necessary
        if (therapy.status === "Completed") {
          await TherapyPlan.updateOne(
            { _id: therapy.plan_id },
            { $inc: { completed_sessions: -1 } },
          );
        }
      }
    }

    // Delete Google Calendar event if it exists
    if (therapy.google_calendar_event_id) {
      // Get organization settings for Google Calendar
      const orgSettings = await orgDb
        .collection("organization_settings")
        .findOne({ tenant_id: user.tenant_id });

      if (orgSettings?.access_token) {
        const deleteGoogleCalendarEvent = async (accessToken) => {
          try {
            await axios.delete(
              `https://www.googleapis.com/calendar/v3/calendars/primary/events/${therapy.google_calendar_event_id}`,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                },
              },
            );
          } catch (error) {
            // --- UPDATE START: Handle non-existent events ---
            // If event is not found (404) or gone (410), consider it success
            if (
              error.response &&
              (error.response.status === 404 || error.response.status === 410)
            ) {
              console.warn(
                "Google Calendar event not found or already deleted. Proceeding.",
              );
              return;
            }
            // --- UPDATE END ---

            if (error.response && error.response.status === 401) {
              // Token expired, refresh and retry
              const newAccessToken = await refreshToken(user.tenant_id);

              // Update the organization's access token
              await orgDb.collection("organization_settings").updateOne(
                { tenant_id: user.tenant_id },
                {
                  $set: {
                    access_token: newAccessToken,
                    last_updated: new Date(),
                  },
                },
              );

              // Retry the deletion with the new access token
              return deleteGoogleCalendarEvent(newAccessToken);
            }
            console.error("Error deleting Google Calendar event:", error);
            throw error;
          }
        };

        // --- UPDATE START: Wrap in try/catch to prevent blocking DB deletion ---
        try {
          await deleteGoogleCalendarEvent(orgSettings.access_token);
        } catch (calendarError) {
          console.error(
            "Failed to delete Google Calendar event, but proceeding to delete therapy from DB:",
            calendarError.message,
          );
        }
        // --- UPDATE END ---
      } else {
        console.log(
          "Skipping Google Calendar deletion due to missing access token",
        );
      }
    }

    // Remove the therapy reference from the patient's document using Mongoose
    patient.therepys.pull(therapyId);
    await patient.save();

    // Delete the therapy session using Mongoose
    await TherapySession.deleteOne({ _id: therapyId });

    return res
      .status(200)
      .json({ msg: "Therapy session deleted successfully" });
  } catch (error) {
    console.error("Error in deleteTherapy:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", error: error.message });
  }
};

const createBulkTherapy = async (req, res) => {
  try {
    const { body: data, user, orgDb } = req;
    // 1. Extract location_id and other fields
    const { sessions, contactId, plan_id, location_id, location_name } = data;

    const TherapySession = getTherapySession(orgDb);
    const TherapyPlan = getTherapyPlanModel(orgDb);
    const Patient = getPatientModel(orgDb);

    // 2. Validate Patient and Plan
    const patient = await Patient.findById(contactId);
    const therapyPlan = await TherapyPlan.findById(plan_id);

    if (!patient) return res.status(404).json({ msg: "Patient not found" });
    if (!therapyPlan)
      return res.status(404).json({ msg: "Therapy plan not found" });

    // 3. Setup Google Calendar (Get Settings & Define Helper)
    const orgSettings = await orgDb
      .collection("organization_settings")
      .findOne({ tenant_id: user.tenant_id });

    if (!orgSettings?.access_token) {
      throw new Error("No Google Calendar access token found for organization");
    }

    // --- DEFINE THE HELPER FUNCTION INSIDE HERE ---
    const createGoogleCalendarEvent = async (accessToken, eventObj) => {
      try {
        const calendarResponse = await axios.post(
          "https://www.googleapis.com/calendar/v3/calendars/primary/events",
          eventObj,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
          },
        );
        return calendarResponse.data.id;
      } catch (error) {
        if (error.response && error.response.status === 401) {
          console.log("Token expired, refreshing...");
          const newAccessToken = await refreshToken(user.tenant_id);
          await orgDb.collection("organization_settings").updateOne(
            { tenant_id: user.tenant_id },
            {
              $set: {
                access_token: newAccessToken,
                last_updated: new Date(),
              },
            },
          );
          return createGoogleCalendarEvent(newAccessToken, eventObj); // Retry with new token
        }
        throw error;
      }
    };
    // ----------------------------------------------

    const createdSessionIds = [];
    const savedSessions = [];

    // 4. Loop through sessions
    for (const session of sessions) {
      const startDateTime = moment.tz(
        `${session.therepy_date} ${session.therepy_start_time}`,
        "YYYY-MM-DD HH:mm",
        "Asia/Kolkata",
      );
      const endDateTime = moment.tz(
        `${session.therepy_date} ${session.therepy_end_time}`,
        "YYYY-MM-DD HH:mm",
        "Asia/Kolkata",
      );

      // Build the event object using your existing helper
      const eventObj = createGoogleCalendarEventobj(
        { ...data, ...session }, // Merge main data with specific session data
        null,
        startDateTime,
        endDateTime,
        patient,
        orgSettings.calendar_email || "organization@example.com",
      );

      // Call the inner function we defined above
      const googleCalendarEventId = await createGoogleCalendarEvent(
        orgSettings.access_token,
        eventObj,
      );

      const newSession = new TherapySession({
        patient_id: contactId,
        patient_name: `${patient.patient_first_name} ${patient.patient_last_name}`,
        therepy_type: data.therepy_type,
        therepy_date: session.therepy_date,
        therepy_start_time: session.therepy_start_time,
        therepy_end_time: session.therepy_end_time,
        doctor_id: data.doctor_id,
        doctor_name: data.doctor_name,
        plan_id: plan_id,
        location_id: location_id, // <--- Added location_id
        location_name: location_name, // <--- Added location_name
        google_calendar_event_id: googleCalendarEventId,
        status: "Scheduled",
        source: "doctor",
      });

      const saved = await newSession.save();
      createdSessionIds.push(saved._id);
      savedSessions.push(saved);
      // Update Plan for each session
      await therapyPlan.addSession(saved._id, "Scheduled");
    }

    // 5. Bulk Update Patient
    patient.therepys.push(...createdSessionIds);
    await patient.save();

    return res.status(200).json({
      msg: `${createdSessionIds.length} sessions booked successfully`,
      sessions: savedSessions,
    });
  } catch (error) {
    console.error("Bulk Booking Error:", error);
    res.status(500).json({ msg: error.message });
  }
};

const createSession = async (req, res) => {
  try {
    const { body: data, user, orgDb } = req;

    const TherapySession = getTherapySession(orgDb);
    const Patient = getPatientModel(orgDb);

    const {
      contactId,
      session_type,
      issue_dealt_with,
      counselor_impression,
      location_id,
      location_name,
      location_address,
      session_date,
      session_time,
      rehab_indicators,
      clinical_observations,
    } = data;

    if (!contactId || !session_type) {
      return res
        .status(400)
        .json({ msg: "Missing required session information." });
    }

    if (!["Individual", "Family"].includes(session_type)) {
      return res
        .status(400)
        .json({ msg: "Session type must be either 'Individual' or 'Family'." });
    }

    if (clinical_observations?.withdrawal_symptoms) {
      if (!Array.isArray(clinical_observations.withdrawal_symptoms)) {
        return res
          .status(400)
          .json({ msg: "withdrawal_symptoms must be an array." });
      }

      const validSymptoms = [
        "tremors",
        "sweating",
        "nausea",
        "insomnia",
        "none",
      ];
      const isValid = clinical_observations.withdrawal_symptoms.every((sym) =>
        validSymptoms.includes(sym),
      );

      if (!isValid) {
        return res.status(400).json({
          msg: `Invalid withdrawal_symptoms. Allowed values are: ${validSymptoms.join(", ")}`,
        });
      }
    }

    const patientObjectId = new mongoose.Types.ObjectId(contactId);

    // Lean check for patient name
    const patient = await Patient.findById(patientObjectId)
      .select("patient_first_name patient_last_name")
      .lean();
    if (!patient) return res.status(404).json({ msg: "Patient not found." });

    const now = moment().tz("Asia/Kolkata");
    const finalDate = session_date || now.format("YYYY-MM-DD");
    const finalTime = session_time || now.format("HH:mm");

    const existingSessionCount = await TherapySession.countDocuments({
      patient_id: contactId,
    });
    const session_number = existingSessionCount + 1;

    const sessionData = {
      patient_id: contactId,
      patient_name: `${patient.patient_first_name} ${patient.patient_last_name}`,
      doctor_id: user.doctor_id,
      doctor_name: `${user.doctor_first_name} ${user.doctor_last_name}`,
      session_number,
      therepy_type: session_type,
      issue_dealt_with: issue_dealt_with || "",
      counselor_impression: counselor_impression || "",
      therepy_date: finalDate,
      therepy_start_time: finalTime,
      therepy_end_time: finalTime,
      location_id: location_id || null,
      location_name: location_name || null,
      location_address: location_address || null,
      status: "Completed",
      source: "doctor",
      rehab_indicators: rehab_indicators || {},
      clinical_observations: clinical_observations || {},
    };

    const newSession = new TherapySession(sessionData);
    const savedSession = await newSession.save();

    // Prepare single journey entry
    const journeyEntry = {
      stage: "Counselling Started",
      performed_by_id: user.doctor_id,
      performed_by_name: `${user.doctor_first_name} ${user.doctor_last_name}`,
      performed_at: new Date(),
      notes: `First session recorded: ${session_type} Session (#${session_number})`,
      status: "Completed",
    };

    // Fast atomic update: pushes session AND conditionally adds journey stage in 1 roundtrip
    const updatedPatient = await Patient.findOneAndUpdate(
      {
        _id: patientObjectId,
        "patient_journey.stage": { $ne: "Counselling Started" },
      },
      {
        $push: {
          therepys: savedSession._id,
          patient_journey: journeyEntry,
        },
      },
      { new: true },
    );

    // Fallback if journey entry was already recorded
    if (!updatedPatient) {
      await Patient.findByIdAndUpdate(patientObjectId, {
        $push: { therepys: savedSession._id },
      });
    }

    return res.status(201).json({
      msg: "Session recorded successfully",
      session: savedSession,
    });
  } catch (error) {
    console.error("Error creating manual session:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", details: error.message });
  }
};

const editSession = async (req, res) => {
  try {
    const { id } = req.params;
    const { body: data, orgDb } = req;

    const TherapySession = getTherapySession(orgDb);

    const session = await TherapySession.findById(id);
    if (!session) {
      return res.status(404).json({ msg: "Session not found." });
    }

    if (
      data.session_type &&
      !["Individual", "Family"].includes(data.session_type)
    ) {
      return res
        .status(400)
        .json({ msg: "Session type must be either 'Individual' or 'Family'." });
    }

    // --- WITHDRAWAL SYMPTOMS VALIDATION ---
    if (data.clinical_observations?.withdrawal_symptoms) {
      if (!Array.isArray(data.clinical_observations.withdrawal_symptoms)) {
        return res
          .status(400)
          .json({ msg: "withdrawal_symptoms must be an array." });
      }

      const validSymptoms = [
        "tremors",
        "sweating",
        "nausea",
        "insomnia",
        "none",
      ];
      const isValid = data.clinical_observations.withdrawal_symptoms.every(
        (sym) => validSymptoms.includes(sym),
      );

      if (!isValid) {
        return res.status(400).json({
          msg: `Invalid withdrawal_symptoms. Allowed values are: ${validSymptoms.join(", ")}`,
        });
      }
    }

    // Standard fields
    if (data.session_number !== undefined)
      session.session_number = data.session_number;
    if (data.session_type !== undefined)
      session.therepy_type = data.session_type;
    if (data.issue_dealt_with !== undefined)
      session.issue_dealt_with = data.issue_dealt_with;
    if (data.counselor_impression !== undefined)
      session.counselor_impression = data.counselor_impression;
    if (data.therepy_date !== undefined)
      session.therepy_date = data.therepy_date;

    // Merge Rehab Indicators
    if (data.rehab_indicators) {
      session.rehab_indicators = {
        ...session.rehab_indicators,
        ...data.rehab_indicators,
      };
    }

    // Merge Clinical Observations
    if (data.clinical_observations) {
      session.clinical_observations = {
        ...session.clinical_observations,
        ...data.clinical_observations,
      };
    }

    const updatedSession = await session.save();

    return res.status(200).json({
      msg: "Session updated successfully",
      session: updatedSession,
    });
  } catch (error) {
    console.error("Error editing manual session:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", details: error.message });
  }
};
// Add these scoring weights at the top of your controller file
// 1. Existing Rehab Weights
const INDICATOR_WEIGHTS = {
  craving_intensity: {
    overwhelming: 1,
    strong: 2,
    moderate: 3,
    mild: 4,
    none: 5,
  },
  behavioural_compliance: {
    resistant: 1,
    passive: 2,
    cooperative: 3,
    engaged: 4,
    proactive: 5,
  },
  emotional_stability: {
    volatile: 1,
    distressed: 2,
    unsettled: 3,
    stable: 4,
    regulated: 5,
  },
  sleep_quality: { none: 1, poor: 2, disturbed: 3, fair: 4, restful: 5 },
  session_impression: {
    concerning: 1,
    below_expectations: 2,
    neutral: 3,
    positive: 4,
    breakthrough: 5,
  },
};
const WITHDRAWAL_SEVERITY = {
  tremors: 5, // most severe
  insomnia: 4,
  sweating: 4,
  nausea: 3, // least severe of the four
  none: 0,
};
// 2. New Clinical Weights
const CLINICAL_WEIGHTS = {
  appetite: { poor: 1, fair: 3, good: 5, excellent: 5 },
  physical_appearance: {
    unkempt: 1,
    disheveled: 2,
    fair: 3,
    neat: 4,
    well_groomed: 5,
  },
};

const calculateSessionScore = (session) => {
  // 1. SAFETY CHECK: If session is null or undefined, skip it entirely
  if (!session) return null;

  // 2. Destructure with fallbacks (empty objects) so it never crashes
  const rehab_indicators = session.rehab_indicators || {};
  const clinical_observations = session.clinical_observations || {};

  // 3. If both are completely empty, return null
  if (
    Object.keys(rehab_indicators).length === 0 &&
    Object.keys(clinical_observations).length === 0
  ) {
    return null;
  }

  let totalScore = 0;
  let validMetrics = 0;

  // Grade Rehab Indicators
  for (const [key, weights] of Object.entries(INDICATOR_WEIGHTS)) {
    const value = rehab_indicators[key];
    if (value && weights[value]) {
      totalScore += weights[value];
      validMetrics++;
    }
  }

  // Grade Clinical Observations
  for (const [key, weights] of Object.entries(CLINICAL_WEIGHTS)) {
    const value = clinical_observations[key];
    if (value && weights[value]) {
      totalScore += weights[value];
      validMetrics++;
    }
  }

  // Handle Withdrawal Symptoms (Penalty system with severity)
  if (Array.isArray(clinical_observations.withdrawal_symptoms)) {
    const symptoms = clinical_observations.withdrawal_symptoms;

    if (symptoms.length === 0) {
      totalScore += 5; // Clean sheet, perfect score
    } else {
      // Find the single most severe symptom
      let highestSeverity = 0;
      symptoms.forEach((sym) => {
        // Default severity is 2 if the symptom isn't in our dictionary
        const severity = WITHDRAWAL_SEVERITY[sym.toLowerCase()] || 2;
        if (severity > highestSeverity) highestSeverity = severity;
      });

      // Translate severity penalty into our 1-5 scoring system
      const symptomScore = Math.max(1, 6 - highestSeverity);
      totalScore += symptomScore;
    }
    validMetrics++;
  }

  // Calculate final percentage
  return validMetrics > 0
    ? Math.round((totalScore / validMetrics / 5) * 100)
    : null;
};
/**
 * Validate a time string in HH:mm format.
 * Returns the value if valid, otherwise returns the fallback.
 */
const validateTimeFormat = (value, fallback) => {
  if (typeof value === "string" && /^\d{2}:\d{2}$/.test(value.trim())) {
    return value.trim();
  }
  return fallback;
};

/**
 * Resolve an aftercare config with defaults applied. Pure — no DB access —
 * so the same resolved shape can be persisted as a config_snapshot on
 * session #1 of a journey and later read back to keep every subsequent
 * on-demand session consistent with it.
 *
 * @param {object} [aftercareConfig={}]
 *   {
 *     monthly_sessions   : number,   // Phase-1 count (default 6)
 *     relapse_offsets    : number[], // Phase-2 month offsets (default [12,18,24,30])
 *     session_start_time : string,   // "HH:mm" (default "10:00")
 *     session_end_time   : string,   // "HH:mm" (default "10:30")
 *   }
 */
const resolveAftercareConfig = (aftercareConfig = {}) => {
  const rawMonthly = parseInt(aftercareConfig.monthly_sessions, 10);
  const monthly_sessions =
    Number.isInteger(rawMonthly) && rawMonthly > 0 ? rawMonthly : 6;

  const rawOffsets = aftercareConfig.relapse_offsets;
  const relapse_offsets =
    Array.isArray(rawOffsets) &&
    rawOffsets.length > 0 &&
    rawOffsets.every((n) => Number.isInteger(n) && n > 0)
      ? rawOffsets
      : [12, 18, 24, 30];

  return {
    monthly_sessions,
    relapse_offsets,
    session_start_time: validateTimeFormat(
      aftercareConfig.session_start_time,
      "10:00",
    ),
    session_end_time: validateTimeFormat(
      aftercareConfig.session_end_time,
      "10:30",
    ),
  };
};

/**
 * Build the full ordered list of aftercare slots (phase + month offset +
 * label + sequence position) implied by a resolved config. Does not touch
 * the DB — just describes the journey's shape so we can tell which slot
 * comes next.
 */
const buildAftercareSchedule = (config) => {
  const schedule = [];

  // Phase 1: monthly monitoring
  for (let month = 1; month <= config.monthly_sessions; month++) {
    schedule.push({
      offsetMonths: month,
      phase: "monthly_monitoring",
      label: `Aftercare – Month ${month}`,
    });
  }

  // Phase 2: relapse prevention at configured month offsets
  config.relapse_offsets.forEach((offset, idx) => {
    schedule.push({
      offsetMonths: offset,
      phase: "relapse_prevention",
      label: `Aftercare – Relapse Prevention ${idx + 1}`,
    });
  });

  return schedule.map((slot, sequenceIndex) => ({ ...slot, sequenceIndex }));
};

/**
 * Create the NEXT single aftercare session for a patient — not the whole
 * schedule. Meant to be called once per visit; it looks at whatever
 * aftercare sessions already exist for the patient to figure out where
 * they are in the journey (anchor date + config are inherited from
 * session #1), then creates just the next slot.
 *
 * Every aftercare session is jointly owned by a physician and a
 * counsellor — both required on every call, since who actually
 * administers a given visit can change over the course of the journey.
 *
 * @param {object} orgDb
 * @param {object} patient          - Mongoose Patient document
 * @param {object} team             - { physicianId, physicianName, counsellorId, counsellorName }
 * @param {Date}   [referenceDate]  - Only used to anchor a brand-new journey (ignored once one exists)
 * @param {object} [aftercareConfig={}] - Only used to configure a brand-new journey (ignored once one exists)
 *
 * @returns {object} { session, isComplete, schedule, nextIndex }
 *   session    - the newly created session doc, or null if the journey was already complete
 *   isComplete - true if this was (or would have been) the last slot in the schedule
 */
/**
 * Create the NEXT single aftercare session for a patient.
 * Updated to explicitly respect the date and time sent from the UI.
 */
const generateNextAftercareSession = async ({
  orgDb,
  patient,
  team,
  referenceDate,
  aftercareConfig = {},
}) => {
  const TherapySession = getTherapySession(orgDb);

  // ── Figure out where this patient already is in their aftercare journey ───
  const existingSessions = await TherapySession.find({
    patient_id: patient._id.toString(),
    therepy_type: "Aftercare",
  })
    .sort({ "aftercare_meta.sequence_index": 1 })
    .lean();

  let config;
  let anchorReferenceDate;

  if (existingSessions.length > 0) {
    // Journey already started — inherit anchor + config from the first session
    const anchorSession = existingSessions[0];
    config =
      anchorSession.aftercare_meta?.config_snapshot?.monthly_sessions != null
        ? anchorSession.aftercare_meta.config_snapshot
        : resolveAftercareConfig({});
    anchorReferenceDate =
      anchorSession.aftercare_meta?.reference_date ||
      moment().tz("Asia/Kolkata").format("YYYY-MM-DD");
  } else {
    // First session of a brand-new journey — resolve config + anchor now
    config = resolveAftercareConfig(aftercareConfig);
    anchorReferenceDate = moment(referenceDate)
      .tz("Asia/Kolkata")
      .format("YYYY-MM-DD");
  }

  const schedule = buildAftercareSchedule(config);
  const nextIndex = existingSessions.length;

  if (nextIndex >= schedule.length) {
    // Nothing left to create — journey already complete.
    return { session: null, isComplete: true, schedule, nextIndex };
  }

  const slot = schedule[nextIndex];

  // --- MODIFICATION: strictly use the exact date passed from the frontend UI ---
  const sessionDate = moment(referenceDate).tz("Asia/Kolkata");

  const patientName = `${patient.patient_first_name} ${patient.patient_last_name}`;

  const sessionData = {
    patient_id: patient._id,
    patient_name: patientName,

    // Mirror the physician into the generic doctor_id/doctor_name fields
    doctor_id: team.physicianId,
    doctor_name: team.physicianName,

    therepy_type: "Aftercare",

    // Explicitly apply the UI-provided Date and Time overrides
    therepy_date: sessionDate.format("YYYY-MM-DD"),
    therepy_start_time:
      aftercareConfig.session_start_time || config.session_start_time,
    therepy_end_time:
      aftercareConfig.session_end_time || config.session_end_time,

    issue_dealt_with: slot.label,
    counselor_impression: "",

    status: "Scheduled",
    source: "doctor",

    aftercare_team: {
      physician_id: team.physicianId,
      physician_name: team.physicianName,
      counsellor_id: team.counsellorId,
      counsellor_name: team.counsellorName,
    },

    aftercare_meta: {
      phase: slot.phase,
      offset_months: slot.offsetMonths,
      sequence_index: slot.sequenceIndex,
      reference_date: anchorReferenceDate, // Keep the original anchor to maintain timeline consistency
      config_snapshot: config,
    },
  };

  const newSession = new TherapySession(sessionData);
  const saved = await newSession.save();

  // Link to patient's sessions array
  patient.therepys.push(saved._id);
  await patient.save();

  return {
    session: saved,
    isComplete: nextIndex + 1 >= schedule.length,
    schedule,
    nextIndex,
  };
};

const editAfterCareAppointment = async (req, res) => {
  try {
    const therapy_id = req.params.id;

    const {
      counselor_impression,
      session_start_time,
      session_end_time,
      manual_duration,
      Typeofmeet,
      therepy_date,
      physician_id,
      physician_name,
      counsellor_id,
      counsellor_name,
      // Follow-up specific fields: Medical & Counselor Review
      patient_complaints,
      issues_addressed,
      recovery_status,
      other_communication,
      recovery_domain_scores,
      total_recovery_score,
    } = req.body;

    // Parse prescription from FormData or JSON string
    let prescription = null;
    if (req.body.prescription) {
      try {
        prescription =
          typeof req.body.prescription === "string"
            ? JSON.parse(req.body.prescription)
            : req.body.prescription;
      } catch (error) {
        console.error("Error parsing prescription data:", error);
        return res
          .status(400)
          .json({ error: "Invalid prescription data format" });
      }
    }

    if (!therapy_id) {
      return res.status(400).json({ error: "Appointment ID is required" });
    }

    const isUpdatingTimes = session_start_time || session_end_time;
    if (isUpdatingTimes && (!session_start_time || !session_end_time)) {
      return res.status(400).json({
        error:
          "Both session start time and end time are required when updating session timing",
      });
    }

    const TherapySession = getTherapySession(req.orgDb);
    const Prescription = getPrescriptionModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);

    const therapy = await TherapySession.findById(therapy_id);
    if (!therapy) {
      return res.status(404).json({ error: "Therapy session not found" });
    }

    const validMeetTypes = ["Phone Call", "Home Visit"];
    if (Typeofmeet) {
      if (therapy.therepy_type !== "Aftercare") {
        return res.status(400).json({
          error: "Typeofmeet can only be set on Aftercare sessions",
        });
      }
      if (!validMeetTypes.includes(Typeofmeet)) {
        return res.status(400).json({
          error: "Invalid Typeofmeet. Must be 'Phone Call' or 'Home Visit'",
        });
      }
    }

    let startTime, endTime, sessionDuration;

    if (isUpdatingTimes) {
      startTime = moment(session_start_time).tz("Asia/Kolkata");
      endTime = moment(session_end_time).tz("Asia/Kolkata");

      if (!endTime.isAfter(startTime)) {
        return res.status(400).json({
          error: "Session end time must be after start time",
        });
      }

      sessionDuration = manual_duration || endTime.diff(startTime, "minutes");

      if (sessionDuration < 0 || sessionDuration > 1440) {
        return res.status(400).json({
          error:
            "Invalid session duration. Duration must be between 0 and 1440 minutes (24 hours)",
        });
      }
    }

    let savedPrescriptionId = therapy.prescription_id || null;

    if (
      prescription &&
      prescription.medications &&
      prescription.medications.length > 0
    ) {
      if (therapy.prescription_id) {
        const updatedPrescription = await Prescription.findByIdAndUpdate(
          therapy.prescription_id,
          {
            $set: {
              vitals: prescription.vitals || {},
              medications: prescription.medications,
              diagnosis: prescription.diagnosis || "General Therapy",
              notes: prescription.notes || "",
              ...(prescription.prescription_number && {
                prescription_number: prescription.prescription_number,
              }),
            },
          },
          { new: true },
        );

        if (updatedPrescription) {
          savedPrescriptionId = updatedPrescription._id;
        } else {
          savedPrescriptionId = null;
        }
      }

      if (!savedPrescriptionId) {
        const patientData = await Patient.findById(therapy.patient_id).select(
          "patient_first_name patient_last_name",
        );

        if (patientData) {
          const prescriptionNumber =
            prescription.prescription_number ||
            `PRE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

          const newPrescription = new Prescription({
            prescription_number: prescriptionNumber,
            patient_id: therapy.patient_id,
            patient_name: `${patientData.patient_first_name} ${patientData.patient_last_name}`,
            doctor_id: therapy.doctor_id,
            doctor_name: therapy.doctor_name,
            prescription_date: (
              endTime || moment().tz("Asia/Kolkata")
            ).toDate(),
            vitals: prescription.vitals || {},
            medications: prescription.medications,
            diagnosis: prescription.diagnosis || "General Therapy",
            notes: prescription.notes || "",
            status: "Active",
          });

          const savedPrescription = await newPrescription.save();
          savedPrescriptionId = savedPrescription._id;
          therapy.prescription_id = savedPrescriptionId;
        }
      }
    }

    let newPostsessionImages = [];
    if (req.files && req.files.length > 0) {
      try {
        newPostsessionImages = await uploadImagesToAzure(
          req.files,
          therapy_id,
          "postsession",
        );

        newPostsessionImages = newPostsessionImages.map((image) => ({
          ...image,
          SessionId: therapy_id,
        }));
      } catch (uploadError) {
        console.error("Error uploading post-session images:", uploadError);
        return res.status(500).json({
          error: "Failed to upload post-session images",
        });
      }
    }

    if (therepy_date) {
      therapy.therepy_date = therepy_date;
    }

    if (physician_id && counsellor_id) {
      therapy.aftercare_team = {
        physician_id,
        physician_name,
        counsellor_id,
        counsellor_name,
      };

      therapy.doctor_id = physician_id;
      therapy.doctor_name = physician_name;
    }

    if (isUpdatingTimes) {
      therapy.session_start_time = startTime.toDate();
      therapy.session_end_time = endTime.toDate();
      therapy.session_duration = sessionDuration;
    }

    if (counselor_impression && counselor_impression.trim() !== "") {
      therapy.counselor_impression = counselor_impression;
    }

    if (Typeofmeet) {
      therapy.Typeofmeet = Typeofmeet;
    }

    // ── Apply Follow-up & Aftercare Clinical Fields ──
    if (patient_complaints !== undefined) {
      therapy.patient_complaints = patient_complaints;
    }
    if (issues_addressed !== undefined) {
      therapy.issues_addressed = issues_addressed;
    }
    if (recovery_status !== undefined) {
      therapy.recovery_status = recovery_status;
    }
    if (other_communication !== undefined) {
      therapy.other_communication = other_communication;
    }
    if (recovery_domain_scores !== undefined) {
      therapy.recovery_domain_scores = recovery_domain_scores;
    }
    if (total_recovery_score !== undefined) {
      therapy.total_recovery_score = total_recovery_score;
    }

    therapy.edited_after_completion = true;
    therapy.last_edited_at = moment().tz("Asia/Kolkata").toDate();
    therapy.last_edited_by = req.user.id || req.user._id;

    if (newPostsessionImages.length > 0) {
      therapy.postsession_images = [
        ...(therapy.postsession_images || []),
        ...newPostsessionImages,
      ];
    }

    await therapy.save();

    return res.status(200).json({
      message: "Appointment updated successfully",
      session_start_time: therapy.session_start_time,
      session_end_time: therapy.session_end_time,
      session_duration: therapy.session_duration,
      prescriptionId: savedPrescriptionId,
      prescriptionUpdated: savedPrescriptionId !== null,
      Typeofmeet: therapy.Typeofmeet || null,
      status: therapy.status,
    });
  } catch (error) {
    console.error("Error editing appointment:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
const createAftercareSessions = async (req, res) => {
  try {
    const { patientId } = req.params;
    const {
      physician_id,
      physician_name,
      counsellor_id,
      counsellor_name,
      reference_date,
      aftercare_config,
    } = req.body;
    const { orgDb } = req;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ msg: "Invalid patient ID format" });
    }

    if (
      !physician_id ||
      !physician_name ||
      !counsellor_id ||
      !counsellor_name
    ) {
      return res.status(400).json({
        msg: "physician_id, physician_name, counsellor_id and counsellor_name are all required — every aftercare session needs both doctors assigned",
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(physician_id) ||
      !mongoose.Types.ObjectId.isValid(counsellor_id)
    ) {
      return res
        .status(400)
        .json({ msg: "Invalid physician_id or counsellor_id format" });
    }

    const Patient = getPatientModel(orgDb);
    const patient = await Patient.findById(patientId);
    if (!patient) {
      return res.status(404).json({ msg: "Patient not found" });
    }

    const referenceDate = reference_date
      ? new Date(reference_date)
      : new Date();
    if (Number.isNaN(referenceDate.getTime())) {
      return res.status(400).json({ msg: "Invalid reference_date format" });
    }

    const result = await generateNextAftercareSession({
      orgDb,
      patient,
      team: {
        physicianId: physician_id,
        physicianName: physician_name,
        counsellorId: counsellor_id,
        counsellorName: counsellor_name,
      },
      referenceDate,
      aftercareConfig: aftercare_config || {},
    });

    // Journey was already complete before this call — nothing to create.
    if (!result.session) {
      return res.status(200).json({
        message:
          "Aftercare journey already complete — no session left to create",
        patient_id: patient._id,
        aftercare: {
          is_complete: true,
          total_planned: result.schedule.length,
          sessions_created: result.nextIndex,
        },
      });
    }

    const s = result.session;
    return res.status(201).json({
      message: "Next aftercare session created successfully",
      patient_id: patient._id,
      aftercare: {
        session_id: s._id,
        sequence_index: s.aftercare_meta.sequence_index,
        total_planned: result.schedule.length,
        remaining_after_this: result.schedule.length - (result.nextIndex + 1),
        is_complete: result.isComplete,
        phase: s.aftercare_meta.phase,
        date: s.therepy_date,
        start_time: s.therepy_start_time,
        end_time: s.therepy_end_time,
        label: s.issue_dealt_with,
        team: {
          physician: { id: physician_id, name: physician_name },
          counsellor: { id: counsellor_id, name: counsellor_name },
        },
      },
    });
  } catch (error) {
    console.error("Error creating aftercare session:", {
      message: error.message,
      stack: error.stack,
    });

    if (error.name === "ValidationError") {
      return res.status(400).json({
        msg: "Validation error",
        errors: Object.values(error.errors).map((e) => e.message),
      });
    }

    if (error.name === "CastError") {
      return res.status(400).json({ msg: "Invalid ID format" });
    }

    res.status(500).json({
      msg: "Server error while creating aftercare session",
      error: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

const VALID_SESSION_TYPES = [
  "In Clinic",
  "In Home",
  "IP/ICU",
  "Online",
  "Individual",
  "Family",
  "Group",
  "Aftercare",
  "Follow-up",
];

const getSessionsByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { orgDb } = req;
    const { from, to, status, sessionType, page, limit } = req.query;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid Patient ID format" });
    }

    const TherapySession = getTherapySession(orgDb);
    const Patient = getPatientModel(orgDb);

    const patient = await Patient.findById(patientId).lean();
    if (!patient) {
      return res.status(404).json({ error: "Patient not found" });
    }

    const filter = {
      patient_id: patientId,
      therepy_type: { $ne: "Follow-up" }, // Explicitly exclude "Follow-up" sessions from this main query
    };

    if (from || to) {
      filter.therepy_date = {};
      if (from) filter.therepy_date.$gte = from;
      if (to) filter.therepy_date.$lte = to;
    }
    if (status) filter.status = status;

    if (
      sessionType &&
      VALID_SESSION_TYPES.includes(sessionType) &&
      sessionType !== "Follow-up"
    ) {
      filter.therepy_type = sessionType;
    }

    // ── Pagination params ───────────────────────────────────────────────────
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 5);
    const skip = (pageNum - 1) * limitNum;

    // ── Fetch the filtered set, newest first ─────────────────────────────────
    const filteredSessions = await TherapySession.find(filter)
      .sort({ therepy_date: -1, therepy_start_time: -1 })
      .lean();

    // ── Paginate ──────────────────────────────────────────────────────────────
    const totalCount = filteredSessions.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / limitNum));
    const sessions = filteredSessions.slice(skip, skip + limitNum);

    return res.status(200).json({
      success: true,
      count: sessions.length,
      pagination: {
        total_count: totalCount,
        total_pages: totalPages,
        current_page: pageNum,
        limit: limitNum,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1,
      },
      patient_details: {
        patient_id: patientId,
        patient_name: `${patient.patient_first_name} ${patient.patient_last_name}`,
      },
      sessions,
    });
  } catch (error) {
    console.error("Error fetching sessions for patient:", error);
    return res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
};

const getPatientRecoveryTrend = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { orgDb } = req;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid Patient ID format" });
    }

    const TherapySession = getTherapySession(orgDb);
    const Patient = getPatientModel(orgDb);

    const patient = await Patient.findById(patientId).lean();
    if (!patient) {
      return res.status(404).json({ error: "Patient not found" });
    }

    // Now exclude both Aftercare and Follow-up from recovery trends
    const allPatientSessions = await TherapySession.find({
      patient_id: patientId,
      therepy_type: { $nin: ["Aftercare", "Follow-up"] },
    })
      .sort({ therepy_date: 1, createdAt: 1 })
      .lean();

    // ── Build the chronological score series, skipping unscoreable sessions ──
    const series = [];
    allPatientSessions.forEach((session) => {
      const score = calculateSessionScore(session);
      if (score !== null) {
        series.push({
          session_id: session._id,
          date: session.therepy_date,
          score,
        });
      }
    });

    // ── Headline delta: latest vs previous (NOT latest vs first) ────────────
    let change = null;
    let currentScore = null;

    if (series.length > 0) {
      currentScore = series[series.length - 1].score;
    }

    if (series.length >= 2) {
      const previousScore = series[series.length - 2].score;
      const latestScore = series[series.length - 1].score;
      const netChange = latestScore - previousScore;
      const percentageChange =
        previousScore !== 0 ? Math.round((netChange / previousScore) * 100) : 0;

      change = {
        previous_score: previousScore,
        current_score: latestScore,
        net_change: netChange,
        percentage_change: percentageChange,
        trend:
          netChange > 0 ? "Improving" : netChange < 0 ? "Declining" : "Stable",
      };
    }

    return res.status(200).json({
      success: true,
      patient_details: {
        patient_id: patientId,
        patient_name: `${patient.patient_first_name} ${patient.patient_last_name}`,
      },
      current_score: currentScore,
      change,
      series,
    });
  } catch (error) {
    console.error("Error fetching patient recovery trend:", error);
    return res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
};

const createGroupSession = async (req, res) => {
  try {
    const { body: data, user, orgDb } = req;

    const TherapySession = getTherapySession(orgDb);
    const Patient = getPatientModel(orgDb);

    const {
      patients,
      session_number,
      session_type,
      location_id,
      location_name,
      location_address,
      issue_dealt_with: shared_issue,
      counselor_impression: shared_impression,
    } = data;

    if (!patients || !Array.isArray(patients) || patients.length === 0) {
      return res
        .status(400)
        .json({ msg: "A non-empty 'patients' array is required." });
    }

    if (!session_number || !session_type) {
      return res
        .status(400)
        .json({ msg: "Missing required session information." });
    }

    if (!["Group"].includes(session_type)) {
      return res.status(400).json({ msg: "Session type must be 'Group'." });
    }

    const contactIds = patients.map((p) => p.contactId);
    if (new Set(contactIds).size !== contactIds.length) {
      return res
        .status(400)
        .json({ msg: "Duplicate patient IDs found in the request." });
    }

    const now = moment().tz("Asia/Kolkata");
    const currentDate = now.format("YYYY-MM-DD");
    const currentTime = now.format("HH:mm");

    const patientDocs = await Patient.find({ _id: { $in: contactIds } })
      .select("patient_first_name patient_last_name")
      .lean();
    const patientMap = new Map(patientDocs.map((p) => [p._id.toString(), p]));

    const missingIds = contactIds.filter((id) => !patientMap.has(id));
    if (missingIds.length > 0) {
      return res.status(404).json({
        msg: "Some patients were not found.",
        missing_ids: missingIds,
      });
    }

    const results = [];
    const errors = [];

    const doctorName = `${user.doctor_first_name} ${user.doctor_last_name}`;

    for (const patientEntry of patients) {
      const { contactId, issue_dealt_with, counselor_impression } =
        patientEntry;

      try {
        const patient = patientMap.get(contactId);

        const sessionData = {
          patient_id: contactId,
          patient_name: `${patient.patient_first_name} ${patient.patient_last_name}`,
          doctor_id: user.doctor_id,
          doctor_name: doctorName,
          session_number,
          therepy_type: session_type,
          issue_dealt_with: issue_dealt_with ?? shared_issue ?? "",
          counselor_impression: counselor_impression ?? shared_impression ?? "",
          therepy_date: currentDate,
          therepy_start_time: currentTime,
          therepy_end_time: currentTime,
          location_id: location_id || null,
          location_name: location_name || null,
          location_address: location_address || null,
          status: "Completed",
          source: "doctor",
        };

        const newSession = new TherapySession(sessionData);
        const savedSession = await newSession.save();

        const patientObjectId = new mongoose.Types.ObjectId(contactId);

        const journeyEntry = {
          stage: "Counselling Started",
          performed_by_id: user.doctor_id,
          performed_by_name: doctorName,
          performed_at: new Date(),
          notes: `First session recorded: Group Session (#${session_number})`,
          status: "Completed",
        };

        // Conditionally attach "Sessions Started" only if not present
        const updatedPatient = await Patient.findOneAndUpdate(
          {
            _id: patientObjectId,
            "patient_journey.stage": { $ne: "Counselling Started" },
          },
          {
            $push: {
              therepys: savedSession._id,
              patient_journey: journeyEntry,
            },
          },
          { new: true },
        );

        if (!updatedPatient) {
          await Patient.findByIdAndUpdate(patientObjectId, {
            $push: { therepys: savedSession._id },
          });
        }

        results.push({
          contactId,
          session_id: savedSession._id,
          status: "success",
        });
      } catch (patientError) {
        errors.push({
          contactId,
          status: "failed",
          reason: patientError.message,
        });
      }
    }

    const allFailed = results.length === 0;
    const httpStatus = allFailed ? 500 : errors.length > 0 ? 207 : 201;

    return res.status(httpStatus).json({
      msg: allFailed
        ? "Group session creation failed for all patients."
        : errors.length > 0
          ? "Group session partially recorded. Some patients failed."
          : "Group session recorded successfully for all patients.",
      summary: {
        total: patients.length,
        succeeded: results.length,
        failed: errors.length,
      },
      results,
      errors,
    });
  } catch (error) {
    console.error("Error creating group session:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", details: error.message });
  }
};
const { generateImageSasTokenLogo } = require("../utils/azureutils");
const getAftercareSessionsByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { orgDb } = req;
    const { from, to } = req.query;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid Patient ID format" });
    }

    const TherapySession = getTherapySession(orgDb);
    const Patient = getPatientModel(orgDb);

    const patient = await Patient.findById(patientId).lean();
    if (!patient) {
      return res.status(404).json({ error: "Patient not found" });
    }

    // ── Organization + logo SAS token ────────────────────────────────────────
    const organization = await Organization.findOne({
      tenant_id: req.user.tenant_id,
    }).lean();

    let orgLogo = organization?.organization_logo || "";
    if (orgLogo) {
      try {
        orgLogo = await generateImageSasTokenLogo(orgLogo);
      } catch (err) {
        console.warn("Failed to generate SAS token for org logo:", err.message);
        orgLogo = "";
      }
    }

    // ── Filter: Aftercare sessions only, this patient only ──────────────────
    const filter = {
      patient_id: patientId,
      therepy_type: "Aftercare",
    };

    if (from || to) {
      filter.therepy_date = {};
      if (from) filter.therepy_date.$gte = from;
      if (to) filter.therepy_date.$lte = to;
    }

    const rawSessions = await TherapySession.find(filter)
      .sort({ therepy_date: 1, therepy_start_time: 1 }) // chronological — oldest first, for a recovery timeline
      .lean();

    // ── Shape for print/recovery-tracking view ───────────────────────────────
    const printReadySessions = rawSessions.map((session) => ({
      session_id: session._id,
      date: session.therepy_date || null,
      start_time: session.therepy_start_time || null,
      end_time: session.therepy_end_time || null,
      meet_type: session.Typeofmeet || null, // "Phone Call" | "Home Visit" | null
      status: session.status || "Scheduled",
      doctor_name: session.doctor_name || "N/A", // kept for backward compat — mirrors the physician
      aftercare_team: {
        physician_name:
          session.aftercare_team?.physician_name ||
          session.doctor_name ||
          "N/A",
        counsellor_name: session.aftercare_team?.counsellor_name || null,
      },
      sequence_index: session.aftercare_meta?.sequence_index ?? null,
      phase: session.aftercare_meta?.phase || null,
      location_name: session.location_name || null,
      location_address: session.location_address || null,
      issue_dealt_with: session.issue_dealt_with || null,
      counselor_impression: session.counselor_impression || null,
      presession_remarks: session.presession_remarks || null,
      postsession_remarks: session.postsession_remarks || null,
      notes: session.notes || null,
      rehab_indicators: session.rehab_indicators || null,
      clinical_observations: session.clinical_observations || null,
      is_system_generated: session.source === "system",
    }));

    // ── Group by meet type for form-style rendering ──────────────────────────
    const phoneCallSessions = printReadySessions.filter(
      (s) => s.meet_type === "Phone Call",
    );
    const homeVisitSessions = printReadySessions.filter(
      (s) => s.meet_type === "Home Visit",
    );
    const otherSessions = printReadySessions.filter(
      (s) => s.meet_type !== "Phone Call" && s.meet_type !== "Home Visit",
    );

    return res.status(200).json({
      success: true,
      patient_details: {
        patient_id: patientId,
        patient_name: `${patient.patient_first_name} ${patient.patient_last_name}`,
      },
      organization: {
        name: organization?.organization_name || "Institute Name",
        address: organization?.organization_address || {},
        logo: orgLogo,
        phone: organization?.organization_phone || "",
        email: organization?.organization_email || "",
      },
      total_aftercare_sessions: printReadySessions.length,
      sessions: printReadySessions,
      grouped: {
        phone_call: phoneCallSessions,
        home_visit: homeVisitSessions,
        other: otherSessions,
      },
    });
  } catch (error) {
    console.error("Error fetching aftercare sessions for patient:", error);
    return res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
};

const getFollowupSessionsByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { orgDb } = req;
    const { from, to, status, page, limit } = req.query;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid Patient ID format" });
    }

    const TherapySession = getTherapySession(orgDb);
    const Patient = getPatientModel(orgDb);

    const patient = await Patient.findById(patientId).lean();
    if (!patient) {
      return res.status(404).json({ error: "Patient not found" });
    }

    const filter = {
      patient_id: patientId,
      therepy_type: "Follow-up",
    };

    if (from || to) {
      filter.therepy_date = {};
      if (from) filter.therepy_date.$gte = from;
      if (to) filter.therepy_date.$lte = to;
    }
    if (status) filter.status = status;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, parseInt(limit, 10) || 5);
    const skip = (pageNum - 1) * limitNum;

    // Fetch newest follow-ups first (Descending order)
    const filteredSessions = await TherapySession.find(filter)
      .sort({ therepy_date: -1, createdAt: -1 })
      .lean();

    const totalCount = filteredSessions.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / limitNum));
    const sessions = filteredSessions.slice(skip, skip + limitNum);

    return res.status(200).json({
      success: true,
      count: sessions.length,
      pagination: {
        total_count: totalCount,
        total_pages: totalPages,
        current_page: pageNum,
        limit: limitNum,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1,
      },
      patient_details: {
        patient_id: patientId,
        patient_name: `${patient.patient_first_name} ${patient.patient_last_name}`,
      },
      sessions,
    });
  } catch (error) {
    console.error("Error fetching follow-up sessions for patient:", error);
    return res.status(500).json({
      error: "Internal server error",
      details: error.message,
    });
  }
};

// 1. ADD PRESCRIPTION
const addPrescriptionToPlan = async (req, res) => {
  try {
    const { planId, patientId } = req.params;
    const prescriptionData = req.body;
    const { user, orgDb } = req;

    const TherapyPlan = getTherapyPlanModel(orgDb);
    const Prescription = getPrescriptionModel(orgDb);
    const Patient = getPatientModel(orgDb);

    const plan = await TherapyPlan.findById(planId);
    if (!plan) return res.status(404).json({ msg: "Therapy plan not found" });

    const patientData = await Patient.findById(patientId);
    if (!patientData) return res.status(404).json({ msg: "Patient not found" });

    // FIX 1: Change this from "Ended" to "Completed" so it matches your schema!
    if (plan.prescription_id) {
      await Prescription.findByIdAndUpdate(plan.prescription_id, {
        status: "Completed",
      });
    }

    const prescriptionNumber =
      prescriptionData.prescription_number ||
      `PRE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const newPrescription = new Prescription({
      prescription_number: prescriptionNumber,
      patient_id: patientId,
      patient_name:
        `${patientData.patient_first_name || ""} ${patientData.patient_last_name || ""}`.trim(),
      doctor_id: user.doctor_id,
      doctor_name:
        user.doctor_name ||
        `${user.doctor_first_name || ""} ${user.doctor_last_name || ""}`.trim(),
      // Accept custom date from frontend, fallback to today
      prescription_date: prescriptionData.prescriptionDate
        ? new Date(prescriptionData.prescriptionDate)
        : new Date(),
      vitals: prescriptionData.vitals || {},
      medications: prescriptionData.medications || [],
      diagnosis: prescriptionData.diagnosis || plan.patient_diagnosis,
      notes: prescriptionData.notes || "",
      status: "Active",
    });

    const savedPrescription = await newPrescription.save();

    // Safely ensure the prescriptions array exists before pushing
    if (!plan.prescriptions) {
      plan.prescriptions = [];
    }
    plan.prescriptions.push(savedPrescription._id);
    plan.prescription_id = savedPrescription._id;
    await plan.save();

    return res.status(201).json({
      msg: "Prescription added successfully",
      prescription: savedPrescription,
    });
  } catch (error) {
    console.error("Add Prescription Error: ", error);
    res.status(500).json({ msg: "Server error", error: error.message });
  }
};

// 2. EDIT EXISTING PRESCRIPTION
const editPrescription = async (req, res) => {
  try {
    const { prescriptionId } = req.params;
    const updateData = req.body;
    const Prescription = getPrescriptionModel(req.orgDb);

    const updatedPrescription = await Prescription.findByIdAndUpdate(
      prescriptionId,
      {
        $set: {
          vitals: updateData.vitals,
          medications: updateData.medications,
          notes: updateData.notes,
          // Update the date if provided
          prescription_date: updateData.prescriptionDate
            ? new Date(updateData.prescriptionDate)
            : new Date(),
          updated_at: new Date(),
        },
      },
      { new: true },
    );

    if (!updatedPrescription)
      return res.status(404).json({ msg: "Prescription not found" });

    return res
      .status(200)
      .json({ msg: "Prescription updated", prescription: updatedPrescription });
  } catch (error) {
    res.status(500).json({ msg: "Server error", error: error.message });
  }
};

// 3. END PRESCRIPTION
const endPrescription = async (req, res) => {
  try {
    const { prescriptionId } = req.params;
    const Prescription = getPrescriptionModel(req.orgDb);

    const prescription = await Prescription.findById(prescriptionId);
    if (!prescription)
      return res.status(404).json({ msg: "Prescription not found" });

    const today = new Date().toISOString().split("T")[0];

    // Mark status as Completed (Matching your schema exactly)
    prescription.status = "Completed";

    // Safely check if medications array exists before mapping
    if (prescription.medications && Array.isArray(prescription.medications)) {
      prescription.medications = prescription.medications.map((med) => {
        if (med.end_date) {
          const medEndDate = new Date(med.end_date);
          const todayDate = new Date(today);

          if (!isNaN(medEndDate) && medEndDate > todayDate) {
            med.end_date = today;
          }
        }
        return med;
      });

      // Tell Mongoose the array changed
      prescription.markModified("medications");
    }

    await prescription.save();
    return res
      .status(200)
      .json({ msg: "Prescription completed", prescription });
  } catch (error) {
    console.error("End Prescription Error:", error);
    res.status(500).json({ msg: "Server error", error: error.message });
  }
};

const getPrescriptionsByPlan = async (req, res) => {
  try {
    const { planId } = req.params;
    const TherapyPlan = getTherapyPlanModel(req.orgDb);
    const Prescription = getPrescriptionModel(req.orgDb);

    const plan = await TherapyPlan.findById(planId).lean();
    if (!plan) return res.status(404).json({ msg: "Therapy plan not found" });

    // Bulletproof list of IDs to fetch
    const presIds = [];

    // Add the array if it exists
    if (plan.prescriptions && Array.isArray(plan.prescriptions)) {
      presIds.push(...plan.prescriptions);
    }

    // Fallback: If array was empty/broken but an active prescription exists, grab it
    if (plan.prescription_id) {
      const activeStr = plan.prescription_id.toString();
      const alreadyInArray = presIds.some((id) => id.toString() === activeStr);
      if (!alreadyInArray) {
        presIds.push(plan.prescription_id);
      }
    }

    // FIX: Also include the post-care prescription (issued at closure).
    // This was previously missing here, so once a plan was completed, the
    // Prescription Manager's "Active Rx" view (opened from PlanDetails.tsx)
    // never received the post-care meds — even though the print summary
    // (getTherapyPlanForPrint) already resolves them via this same field.
    if (plan.post_care_prescription_id) {
      const postCareStr = plan.post_care_prescription_id.toString();
      const alreadyInArray = presIds.some(
        (id) => id.toString() === postCareStr,
      );
      if (!alreadyInArray) {
        presIds.push(plan.post_care_prescription_id);
      }
    }

    // If we truly have no prescriptions, return empty
    if (presIds.length === 0) {
      return res.status(200).json({ prescriptions: [] });
    }

    // Fetch them all using our bulletproof array
    const prescriptions = await Prescription.find({
      _id: { $in: presIds },
    })
      .sort({ prescription_date: -1 })
      .lean();

    return res.status(200).json({ prescriptions });
  } catch (error) {
    console.error("Error fetching plan prescriptions:", error);
    return res.status(500).json({ msg: "Server error", error: error.message });
  }
};

const getPrescriptionsByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;

    // Validate the Object ID format
    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid Patient ID format" });
    }

    const Prescription = getPrescriptionModel(req.orgDb);

    // Fetch all prescriptions for the patient, sorted newest to oldest
    const prescriptions = await Prescription.find({
      patient_id: patientId,
    })
      .sort({ prescription_date: -1 })
      .lean();

    return res.status(200).json({ prescriptions });
  } catch (error) {
    console.error("Error fetching patient prescriptions:", error);
    return res.status(500).json({ msg: "Server error", error: error.message });
  }
};

const getPrescriptionPrintDataById = async (req, res) => {
  try {
    const { prescriptionId } = req.params;

    if (!ObjectId.isValid(prescriptionId)) {
      return res.status(400).json({ error: "Invalid Prescription ID" });
    }

    // Initialize Models for the specific organization's DB
    const Prescription = getPrescriptionModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);

    // 1. Fetch the Prescription Record
    const prescription = await Prescription.findById(prescriptionId).lean();

    if (!prescription) {
      return res.status(404).json({ error: "Prescription record not found" });
    }

    // 2. Fetch Linked Data (Patient & Organization) in parallel
    const [patient, organization] = await Promise.all([
      prescription.patient_id
        ? Patient.findById(prescription.patient_id).lean()
        : Promise.resolve(null),

      Organization.findOne({
        tenant_id: req.user.tenant_id,
      }),
    ]);

    // 3. Process Organization Logo (SAS Token)
    let logoUrl = organization?.organization_logo || "";
    if (logoUrl) {
      // Ensure generateImageSasTokenLogo is imported in your controller file
      logoUrl = await generateImageSasTokenLogo(logoUrl);
    }

    // 4. Calculate Age Dynamically (Fallback if patient_age string is empty)
    let finalAge = patient?.patient_age || "";
    if (!finalAge && patient?.date_of_birth) {
      const dob = new Date(patient.date_of_birth);
      const ageDiffMs = Date.now() - dob.getTime();
      const ageDate = new Date(ageDiffMs); // miliseconds from epoch
      finalAge = Math.abs(ageDate.getUTCFullYear() - 1970).toString();
    }

    // 👇 NEW: Extract Medical Professional Name from Organization (using the first one in the array)
    const medicalProfessionalName =
      organization?.medicalProfessional?.length > 0
        ? organization.medicalProfessional[0].name
        : `${req.user.doctor_first_name || ""} ${req.user.doctor_last_name || ""}`.trim();

    // 5. Prepare Data Packet for the Print Template
    const printData = {
      prescription: {
        ...prescription,
        vitals: prescription.vitals || {},
        has_notes: !!prescription.notes,
        date: prescription.prescription_date,
        // Include schedules while preserving legacy fields
        medications: (prescription.medications || []).map((med) => ({
          ...med,
          schedules: med.schedules || [],
          dose_amount: med.dose_amount || "1",
          frequency: med.frequency || "",
          duration: med.duration || "",
        })),
      },
      patient: patient
        ? {
            _id: patient._id,
            name: `${patient.patient_first_name || ""} ${patient.patient_last_name || ""}`.trim(),
            age: finalAge || patient.age || "", // Checking alternate 'age' key
            gender: patient.gender || "Not Specified",
            uhid: patient.UHID || patient.uhid || patient.patient_id || "", // Fallback to lowercase uhid or just patient_id
            mobile:
              patient.patient_phone ||
              patient.guardian_phone ||
              patient.mobile ||
              patient.phone ||
              "", // Check ALL possible phone keys
            address: patient.address || "",
            allergies: patient.allergies || [],
          }
        : {
            name: prescription.patient_name || "Unknown Patient",
            _id: prescription.patient_id,
            age: "",
            gender: "",
            uhid: "",
            mobile: "",
          },
      organization: {
        name: organization?.organization_name || "Clinic Name",
        address: organization?.organization_address || {},
        logo: logoUrl,
        gstin: organization?.organization_tax_id || "",
        email: organization?.organization_email || "",
        phone: organization?.organization_phone || "",
      },
      user: {
        // 👇 UPDATED: Use Medical Professional from org rather than the printing user
        name: medicalProfessionalName,
        specialization: req.user.specialization || "",
        registration_number: req.user.registration_number || "",
        qualification: req.user.qualification || "",
        signature: req.user.signature || "",
      },
    };

    res.status(200).json(printData);
  } catch (error) {
    console.error("Get Prescription Print Data Error:", error);
    res.status(500).json({
      message: "Error fetching prescription print data",
      error: error.message,
    });
  }
};

const completeCounselorPhase = async (req, res) => {
  try {
    const therapy_id = req.params.id;

    const {
      next_appointment_date,
      remove_follow_up_date,
      patient_id,
      issues_addressed,
      recovery_status,
      other_communication,
      recovery_domain_scores,
      total_recovery_score,
    } = req.body;

    if (!therapy_id) {
      return res.status(400).json({ error: "Appointment ID is required" });
    }

    const TherapySession = getTherapySession(req.orgDb);
    const Patient = getPatientModel(req.orgDb);

    let therapy;
    const now = moment().tz("Asia/Kolkata");

    const counselorId = req.user.doctor_id || req.user._id;
    const counselorName =
      req.user.doctor_name ||
      `${req.user.doctor_first_name || ""} ${req.user.doctor_last_name || ""}`.trim();

    if (therapy_id === "new") {
      if (!patient_id) {
        return res
          .status(400)
          .json({ error: "Patient ID is required for a new session" });
      }

      const patient = await Patient.findById(patient_id);
      if (!patient) return res.status(404).json({ error: "Patient not found" });

      therapy = new TherapySession({
        patient_id: patient._id,
        patient_name: `${patient.patient_first_name} ${patient.patient_last_name}`,
        doctor_id: counselorId,
        doctor_name: counselorName,
        therepy_type: "Follow-up",
        therepy_date: now.format("YYYY-MM-DD"),
        status: "pending_medical",
        source: "doctor",
        aftercare_team: {
          counsellor_id: counselorId,
          counsellor_name: counselorName,
        },
      });

      patient.therepys.push(therapy._id);
      await patient.save();
    } else {
      therapy = await TherapySession.findById(therapy_id);

      if (!therapy) {
        return res.status(404).json({ error: "Therapy session not found" });
      }

      if (therapy.status === "completed" || therapy.status === "Completed") {
        return res.status(400).json({ error: "Session is already finalized." });
      }

      // Preserve existing physician team fields while attaching counsellor info
      const existingTeam = therapy.aftercare_team
        ? therapy.aftercare_team.toObject
          ? therapy.aftercare_team.toObject()
          : therapy.aftercare_team
        : {};

      therapy.aftercare_team = {
        ...existingTeam,
        counsellor_id: counselorId,
        counsellor_name: counselorName,
      };
    }

    let postsessionImages = [];
    if (req.files && req.files.length > 0) {
      try {
        postsessionImages = await uploadImagesToAzure(
          req.files,
          therapy._id.toString(),
          "postsession",
        );
        postsessionImages = postsessionImages.map((image) => ({
          ...image,
          SessionId: therapy._id,
        }));
      } catch (uploadError) {
        console.error("Error uploading post-session images:", uploadError);
        return res
          .status(500)
          .json({ error: "Failed to upload post-session images" });
      }
    }

    if (issues_addressed !== undefined)
      therapy.issues_addressed = issues_addressed;
    if (recovery_status !== undefined)
      therapy.recovery_status = recovery_status;
    if (other_communication !== undefined)
      therapy.other_communication = other_communication;
    if (recovery_domain_scores !== undefined)
      therapy.recovery_domain_scores = recovery_domain_scores;
    if (total_recovery_score !== undefined)
      therapy.total_recovery_score = total_recovery_score;

    if (therapy.status === "pending_counselor") {
      therapy.status = "completed";
    } else {
      therapy.status = "pending_medical";
    }

    if (postsessionImages.length > 0) {
      therapy.postsession_images = [
        ...(therapy.postsession_images || []),
        ...postsessionImages,
      ];
    }

    await therapy.save();

    if (remove_follow_up_date) {
      await Patient.findByIdAndUpdate(therapy.patient_id, {
        $unset: { follow_Up_Date: 1 },
      });
    } else if (next_appointment_date) {
      await Patient.findByIdAndUpdate(therapy.patient_id, {
        $set: { follow_Up_Date: new Date(next_appointment_date) },
      });
    }

    return res.status(200).json({
      message:
        therapy.status === "completed"
          ? "Follow-up appointment fully completed successfully"
          : "Counselor phase completed. Awaiting medical completion.",
      status: therapy.status,
      postsession_images_count: postsessionImages.length,
      follow_up_date_updated: !remove_follow_up_date && !!next_appointment_date,
      follow_up_date_removed: !!remove_follow_up_date,
    });
  } catch (error) {
    console.error("Error in completeCounselorPhase:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const completeMedicalPhase = async (req, res) => {
  try {
    const therapy_id = req.params.id;

    let prescription = null;
    if (req.body.prescription) {
      try {
        prescription =
          typeof req.body.prescription === "string"
            ? JSON.parse(req.body.prescription)
            : req.body.prescription;
      } catch (error) {
        return res
          .status(400)
          .json({ error: "Invalid prescription data format" });
      }
    }

    const {
      patient_complaints,
      patient_id,
      next_appointment_date,
      follow_up_date,
      remove_follow_up_date,
    } = req.body;

    if (!therapy_id) {
      return res.status(400).json({ error: "Appointment ID is required" });
    }

    const TherapySession = getTherapySession(req.orgDb);
    const Prescription = getPrescriptionModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);

    let therapy;
    const now = moment().tz("Asia/Kolkata");

    const physicianId = req.user.doctor_id || req.user._id;
    const physicianName =
      req.user.doctor_name ||
      `${req.user.doctor_first_name || ""} ${req.user.doctor_last_name || ""}`.trim();

    if (therapy_id === "new") {
      if (!patient_id) {
        return res
          .status(400)
          .json({ error: "Patient ID is required for a new session" });
      }

      const patient = await Patient.findById(patient_id);
      if (!patient) return res.status(404).json({ error: "Patient not found" });

      therapy = new TherapySession({
        patient_id: patient._id,
        patient_name: `${patient.patient_first_name} ${patient.patient_last_name}`,
        doctor_id: physicianId,
        doctor_name: physicianName,
        therepy_type: "Follow-up",
        therepy_date: now.format("YYYY-MM-DD"),
        status: "pending_counselor",
        source: "doctor",
        aftercare_team: {
          physician_id: physicianId,
          physician_name: physicianName,
        },
      });

      patient.therepys.push(therapy._id);
      await patient.save();
    } else {
      therapy = await TherapySession.findById(therapy_id);
      if (!therapy) {
        return res.status(404).json({ error: "Therapy session not found" });
      }

      if (!["Aftercare", "Follow-up"].includes(therapy.therepy_type)) {
        return res.status(400).json({
          error:
            "Only Aftercare and Follow-up sessions utilize the two-step completion process.",
        });
      }

      if (therapy.status === "completed" || therapy.status === "Completed") {
        return res.status(400).json({ error: "Session is already finalized." });
      }
      if (therapy.status === "pending_counselor") {
        return res
          .status(400)
          .json({ error: "Medical phase is already completed." });
      }

      // Preserve existing counselor team fields while attaching physician info
      const existingTeam = therapy.aftercare_team
        ? therapy.aftercare_team.toObject
          ? therapy.aftercare_team.toObject()
          : therapy.aftercare_team
        : {};

      therapy.doctor_id = physicianId;
      therapy.doctor_name = physicianName;
      therapy.aftercare_team = {
        ...existingTeam,
        physician_id: physicianId,
        physician_name: physicianName,
      };
    }

    if (patient_complaints !== undefined) {
      therapy.patient_complaints = patient_complaints;
    }

    let savedPrescriptionId = therapy.prescription_id || null;

    if (
      prescription &&
      prescription.medications &&
      prescription.medications.length > 0
    ) {
      if (savedPrescriptionId) {
        await Prescription.findByIdAndUpdate(savedPrescriptionId, {
          $set: {
            vitals: prescription.vitals || {},
            medications: prescription.medications,
            diagnosis: prescription.diagnosis || "Therapy Prescription",
            notes: prescription.notes || "",
          },
        });
      } else {
        const patientData = await Patient.findById(therapy.patient_id).select(
          "patient_first_name patient_last_name",
        );
        if (patientData) {
          const prescriptionNumber =
            prescription.prescription_number ||
            `PRE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
          const newPrescription = new Prescription({
            prescription_number: prescriptionNumber,
            patient_id: therapy.patient_id,
            patient_name: `${patientData.patient_first_name} ${patientData.patient_last_name}`,
            doctor_id: physicianId,
            doctor_name: physicianName,
            prescription_date: moment().tz("Asia/Kolkata").toDate(),
            vitals: prescription.vitals || {},
            medications: prescription.medications,
            diagnosis: prescription.diagnosis || "Therapy Prescription",
            notes: prescription.notes || "",
            status: "Active",
          });
          const savedPrescription = await newPrescription.save();
          savedPrescriptionId = savedPrescription._id;
          therapy.prescription_id = savedPrescriptionId;
        }
      }
    }

    if (therapy.status === "pending_medical") {
      therapy.status = "completed";
    } else {
      therapy.status = "pending_counselor";
    }

    await therapy.save();

    const targetFollowUpDate = next_appointment_date || follow_up_date;
    if (remove_follow_up_date) {
      await Patient.findByIdAndUpdate(therapy.patient_id, {
        $unset: { follow_Up_Date: 1 },
      });
    } else if (targetFollowUpDate) {
      await Patient.findByIdAndUpdate(therapy.patient_id, {
        $set: { follow_Up_Date: new Date(targetFollowUpDate) },
      });
    }

    return res.status(200).json({
      message:
        therapy.status === "completed"
          ? "Medical phase completed. Session is now fully finalized."
          : "Medical phase completed. Awaiting counselor completion.",
      prescriptionId: savedPrescriptionId,
      status: therapy.status,
      follow_up_date_updated: !remove_follow_up_date && !!targetFollowUpDate,
      follow_up_date_removed: !!remove_follow_up_date,
    });
  } catch (error) {
    console.error("Error in completeMedicalPhase:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * DELETE /session/:id        body: { reason: string, force?: boolean }
 *
 *  - Admins (req.user.is_admin) can delete any session; everyone else only sessions they
 *    are on (doctor_id, created_by, or physician/counsellor in aftercare_team).
 *  - A reason is required and is saved in the audit record.
 *  - Sessions with clinical data (completed, partly completed, in progress) return 409
 *    REQUIRES_FORCE until resent with force: true. This applies to admins too.
 *  - A full copy goes to the `deleted_sessions` collection before the delete.
 *  - Links are cleaned up: patient.therepys, plan.therapy_sessions (+ completed_sessions
 *    counter) and the Google Calendar event.
 */
const CLINICAL_STATUSES = [
  "completed",
  "Completed",
  "pending_counselor",
  "pending_medical",
  "in_progress",
];
const COMPLETED_STATUSES = ["completed", "Completed"];

const deleteSession = async (req, res) => {
  try {
    const { user, orgDb } = req;
    const sessionId = req.params.id;
    const { reason, force } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return res.status(400).json({ msg: "Invalid session id" });
    }
    if (!user?.doctor_id) {
      return res.status(401).json({ msg: "Invalid user context" });
    }
    const cleanReason = typeof reason === "string" ? reason.trim() : "";
    if (cleanReason.length < 3) {
      return res.status(400).json({ msg: "A reason for deleting is required" });
    }

    const TherapySession = getTherapySession(orgDb);
    const TherapyPlan = getTherapyPlanModel(orgDb);
    const Patient = getPatientModel(orgDb);

    const session = await TherapySession.findById(sessionId).lean();
    if (!session) {
      return res.status(404).json({ msg: "Session not found" });
    }

    // 1. Permission: admins can delete any session; everyone else only sessions they are on.
    const isAdmin = user.is_admin === true;
    const me = String(user.doctor_id);
    const team = session.aftercare_team || {};
    const isOnSession = [
      session.doctor_id,
      session.created_by,
      team.physician_id,
      team.counsellor_id,
    ].some((id) => id && String(id) === me);

    if (!isAdmin && !isOnSession) {
      return res
        .status(403)
        .json({ msg: "You can only delete sessions you are part of" });
    }

    // 3. Clinical data needs an explicit confirmation.
    if (CLINICAL_STATUSES.includes(session.status) && force !== true) {
      return res.status(409).json({
        code: "REQUIRES_FORCE",
        msg: "This session already has clinical records. Resend with force: true to delete it permanently.",
        status: session.status,
        has_prescription: !!session.prescription_id,
      });
    }

    // 4. Archive a full copy first. If this fails nothing has been deleted yet.
    await orgDb.collection("deleted_sessions").insertOne({
      original_id: session._id,
      session,
      deleted_by_id: user.doctor_id,
      deleted_by_name:
        user.doctor_name ||
        `${user.doctor_first_name || ""} ${user.doctor_last_name || ""}`.trim(),
      deleted_as_admin: isAdmin && !isOnSession,
      reason: cleanReason,
      deleted_at: new Date(),
    });

    // Delete. deletedCount guards against two people deleting at the same moment.
    const result = await TherapySession.deleteOne({ _id: session._id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ msg: "Session was already deleted" });
    }

    // 5. Clean up links. Each step is best-effort: the session is already gone, and
    //    leftover references are harmless because lists are loaded with $in lookups.
    const cleanupWarnings = [];

    try {
      if (mongoose.Types.ObjectId.isValid(session.patient_id)) {
        await Patient.updateOne(
          { _id: session.patient_id },
          { $pull: { therepys: session._id } },
        );
      }
    } catch (e) {
      cleanupWarnings.push("patient link");
      console.error("deleteSession: patient cleanup failed:", e.message);
    }

    try {
      if (session.plan_id) {
        await TherapyPlan.updateOne(
          { _id: session.plan_id },
          { $pull: { therapy_sessions: { _id: session._id } } },
        );
        if (COMPLETED_STATUSES.includes(session.status)) {
          // Match both "completed" and "Completed"; never let the counter go negative.
          await TherapyPlan.updateOne(
            { _id: session.plan_id, completed_sessions: { $gt: 0 } },
            { $inc: { completed_sessions: -1 } },
          );
        }
      }
    } catch (e) {
      cleanupWarnings.push("plan link");
      console.error("deleteSession: plan cleanup failed:", e.message);
    }

    if (session.google_calendar_event_id) {
      try {
        const orgSettings = await orgDb
          .collection("organization_settings")
          .findOne({ tenant_id: user.tenant_id });

        if (orgSettings?.access_token) {
          const removeEvent = async (token, retried = false) => {
            try {
              await axios.delete(
                `https://www.googleapis.com/calendar/v3/calendars/primary/events/${session.google_calendar_event_id}`,
                { headers: { Authorization: `Bearer ${token}` } },
              );
            } catch (err) {
              const code = err.response?.status;
              if (code === 404 || code === 410) return; // already gone
              if (code === 401 && !retried) {
                const fresh = await refreshToken(user.tenant_id);
                await orgDb
                  .collection("organization_settings")
                  .updateOne(
                    { tenant_id: user.tenant_id },
                    { $set: { access_token: fresh, last_updated: new Date() } },
                  );
                return removeEvent(fresh, true);
              }
              throw err;
            }
          };
          await removeEvent(orgSettings.access_token);
        }
      } catch (e) {
        cleanupWarnings.push("calendar event");
        console.error("deleteSession: calendar cleanup failed:", e.message);
      }
    }

    return res.status(200).json({
      msg: "Session deleted successfully",
      deleted_session_id: String(session._id),
      // Not removed on purpose: a prescription may still be the patient's active one,
      // and uploaded files are in Azure Blob Storage.
      prescription_retained: session.prescription_id
        ? String(session.prescription_id)
        : null,
      attachments_retained: (session.attachments || []).length,
      cleanup_warnings: cleanupWarnings,
    });
  } catch (error) {
    console.error("Error in deleteSession:", error);
    return res
      .status(500)
      .json({ msg: "Internal server error", error: error.message });
  }
};

module.exports = {
  createTherepy,
  getTherepy,
  getConvo,
  updateTherepy,
  createTherapyPlan,
  getPlans,
  deleteTherapy,
  deleteSession,
  createConsultation,
  getCompleteSessionDetails,
  createBulkTherapy,
  createSession,
  editSession,
  getSessionsByPatient,
  getFollowupSessionsByPatient, // NEW ENDPOINT
  createGroupSession,
  addPrescriptionToPlan,
  editPrescription,
  endPrescription,
  getPrescriptionsByPlan,
  createAftercareSessions,
  getPatientRecoveryTrend,
  getAftercareSessionsByPatient,
  editAfterCareAppointment,
  getPrescriptionPrintDataById,
  completeCounselorPhase,
  getPrescriptionsByPatient,
  completeMedicalPhase,
  deleteSession,
};
