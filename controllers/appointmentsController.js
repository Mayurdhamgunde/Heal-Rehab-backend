const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;
const moment = require("moment-timezone");
const { getTherapyPlanModel, getTherapySession } = require("../db/therepy");
const { refreshToken } = require("../codeexchange/refreshToken");
const Organization = require("../db/OrganizationSchema"); // <-- Add this
const {
  generateImageSasToken,
  generateImageSasTokenLogo,
  generatepatientImageSasToken,
} = require("../utils/azureutils");
const getEventsCount = async (req, res) => {
  try {
    // Get the start and end of the current day in India
    const accessToken = req.headers.auth.split("Bearer ")[1];
    const nowInIndia = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
    );
    const startOfDay = new Date(nowInIndia.setHours(0, 0, 0, 0)).toISOString();
    const endOfDay = new Date(
      nowInIndia.setHours(23, 59, 59, 999),
    ).toISOString();

    const response = await axios.get(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        params: {
          timeMin: startOfDay,
          timeMax: endOfDay,
          singleEvents: true,
          q: "https://api.staging.liveswitch.com/contact/s/",
        },
      },
    );

    const Number = response.data.items.length;
    return res.status(200).json({ Number: Number });
  } catch (error) {
    console.log(error);
    return res.status(500).json({ message: error.message });
  }
};

const getTheropySlots = async (req, res) => {
  try {
    const { date } = req.query;

    // Convert the date string to a Date object
    const searchDate = new Date(date);

    // Set the start and end times for the day (9:00 AM to 5:00 PM)
    const startTime = new Date(
      searchDate.getFullYear(),
      searchDate.getMonth(),
      searchDate.getDate(),
      9,
      0,
      0,
    );
    const endTime = new Date(
      searchDate.getFullYear(),
      searchDate.getMonth(),
      searchDate.getDate(),
      17,
      0,
      0,
    );

    // Query the therepy collection to get the occupied slots
    const occupiedSlots = await req.orgDb
      .collection("therepys")
      .find({
        therepy_date: date,
        $or: [
          {
            $and: [
              { therepy_start_time: { $lte: startTime } },
              { therepy_end_time: { $gte: endTime } },
            ],
          },
          {
            $and: [
              { therepy_start_time: { $gte: startTime } },
              { therepy_start_time: { $lte: endTime } },
            ],
          },
          {
            $and: [
              { therepy_end_time: { $gte: startTime } },
              { therepy_end_time: { $lte: endTime } },
            ],
          },
        ],
      })
      .project({ therepy_start_time: 1, therepy_end_time: 1 })
      .toArray();

    // Generate the available time slots
    const availableSlots = [];
    let currentSlot = startTime;
    while (currentSlot < endTime) {
      const isSlotAvailable = occupiedSlots.every((slot) => {
        const slotStartTime = new Date(
          searchDate.getFullYear(),
          searchDate.getMonth(),
          searchDate.getDate(),
          +slot.therepy_start_time.split(":")[0],
          +slot.therepy_start_time.split(":")[1],
          0,
        );
        const slotEndTime = new Date(
          searchDate.getFullYear(),
          searchDate.getMonth(),
          searchDate.getDate(),
          +slot.therepy_end_time.split(":")[0],
          +slot.therepy_end_time.split(":")[1],
          0,
        );
        return currentSlot < slotStartTime || currentSlot >= slotEndTime;
      });

      if (isSlotAvailable) {
        availableSlots.push({
          start: currentSlot.toISOString(),
          end: new Date(currentSlot.getTime() + 60 * 60 * 1000).toISOString(),
        });
      }

      currentSlot = new Date(currentSlot.getTime() + 60 * 60 * 1000);
    }

    res.status(200).json({ availableSlots });
  } catch (error) {
    console.error("Error getting available slots:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const getAllAppointments = async (db, doctorId, date) => {
  try {
    // Validate input
    if (!date || !doctorId) {
      throw new Error("Invalid input: date and doctorId are required");
    }

    // Parse the date string safely
    const queryDate = new Date(date);
    if (isNaN(queryDate.getTime())) {
      throw new Error(`Invalid date format: ${date}`);
    }

    // Create start and end of day in UTC
    const startOfDay = new Date(
      Date.UTC(
        queryDate.getUTCFullYear(),
        queryDate.getUTCMonth(),
        queryDate.getUTCDate(),
        0,
        0,
        0,
        0,
      ),
    );
    const endOfDay = new Date(
      Date.UTC(
        queryDate.getUTCFullYear(),
        queryDate.getUTCMonth(),
        queryDate.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    );

    const query = {
      doctor_id: new ObjectId(doctorId),
      therepy_date: {
        $gte: startOfDay.toISOString().split("T")[0],
        $lte: endOfDay.toISOString().split("T")[0],
      },
      status: { $ne: "completed" },
    };

    const appointments = await db.collection("therepys").find(query).toArray();

    return appointments;
  } catch (error) {
    console.error("Error in getAllAppointments:", error);
    throw error;
  }
};
const checkDoctorAvailability = async (
  db,
  doctorId,
  date,
  slotDuration = 30,
  allowHalfHourOffsets = true,
) => {
  try {
    // Validate inputs
    if (!db) throw new Error("Database connection is required");
    if (!doctorId) throw new Error("Doctor ID is required");
    if (!date) throw new Error("Date is required");

    // Validate slot duration
    const validDurations = [30, 60, 90, 120];
    if (!validDurations.includes(slotDuration)) {
      throw new Error(
        `Invalid slot duration. Must be one of: ${validDurations.join(
          ", ",
        )} minutes.`,
      );
    }

    // Convert the date string to a moment object in Indian timezone
    const checkDate = moment
      .tz(date, "YYYY-MM-DD", "Asia/Kolkata")
      .startOf("day");

    // Define working hours (9 AM to 9 PM)
    const workingHours = {
      start: moment(checkDate).hour(9).minute(0),
      end: moment(checkDate).hour(21).minute(0),
    };

    // Generate all possible slots
    const slots = [];
    let currentSlotTime = moment(workingHours.start);

    while (currentSlotTime.isBefore(workingHours.end)) {
      const slotStart = moment(currentSlotTime);
      const slotEnd = moment(currentSlotTime).add(slotDuration, "minutes");

      // Break if slot would extend beyond working hours
      if (slotEnd.isAfter(workingHours.end)) break;

      slots.push({
        start: slotStart.format("HH:mm"),
        end: slotEnd.format("HH:mm"),
        duration: slotDuration,
        status: "free",
      });

      // Determine next slot time based on offset preference
      if (allowHalfHourOffsets && slotDuration >= 60) {
        // For 1-hour or longer slots, allow half-hour offsets
        currentSlotTime.add(30, "minutes");
      } else {
        // Default: move to next full slot
        currentSlotTime.add(slotDuration, "minutes");
      }
    }

    // Fetch appointments
    const appointments = await db
      .collection("therepys")
      .find({
        doctor_id: new ObjectId(doctorId),
        therepy_date: checkDate.format("YYYY-MM-DD"),
      })
      .toArray();

    // Mark occupied slots
    appointments.forEach((appointment) => {
      // Create full datetime moments for appointment times
      const appointmentStart = moment.tz(
        `${checkDate.format("YYYY-MM-DD")} ${appointment.therepy_start_time}`,
        "YYYY-MM-DD HH:mm",
        "Asia/Kolkata",
      );
      const appointmentEnd = moment.tz(
        `${checkDate.format("YYYY-MM-DD")} ${appointment.therepy_end_time}`,
        "YYYY-MM-DD HH:mm",
        "Asia/Kolkata",
      );

      // Mark slots as occupied
      slots.forEach((slot) => {
        const slotStart = moment.tz(
          `${checkDate.format("YYYY-MM-DD")} ${slot.start}`,
          "YYYY-MM-DD HH:mm",
          "Asia/Kolkata",
        );
        const slotEnd = moment.tz(
          `${checkDate.format("YYYY-MM-DD")} ${slot.end}`,
          "YYYY-MM-DD HH:mm",
          "Asia/Kolkata",
        );

        // Check if the slot is completely or partially within the appointment time
        if (
          (slotStart.isSameOrAfter(appointmentStart) &&
            slotStart.isBefore(appointmentEnd)) ||
          (slotEnd.isAfter(appointmentStart) &&
            slotEnd.isSameOrBefore(appointmentEnd)) ||
          (slotStart.isSameOrBefore(appointmentStart) &&
            slotEnd.isSameOrAfter(appointmentEnd))
        ) {
          slot.status = "occupied";
        }
      });
    });

    return slots;
  } catch (error) {
    console.error("Error in checkDoctorAvailability:", error);
    throw error;
  }
};

const uploadSessionImages = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit per file
    files: 10, // Maximum 10 files
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"), false);
    }
  },
});

// Helper function to upload images to Azure Blob Storage
const uploadImagesToAzure = async (files, sessionId, sessionType) => {
  try {
    if (!files || files.length === 0) {
      return [];
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerName = "therapy-session-images";
    const containerClient = blobServiceClient.getContainerClient(containerName);

    // Create container if it doesn't exist
    await containerClient.createIfNotExists();

    const uploadedImages = [];

    for (const file of files) {
      const fileExtension = file.originalname.split(".").pop();
      const blobName = `${sessionType}/${sessionId}/${uuidv4()}.${fileExtension}`;
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      // Upload file with metadata
      await blockBlobClient.upload(file.buffer, file.buffer.length, {
        blobHTTPHeaders: {
          blobContentType: file.mimetype,
        },
        metadata: {
          originalName: file.originalname,
          sessionId: sessionId.toString(),
          sessionType: sessionType,
          uploadDate: new Date().toISOString(),
        },
      });

      // Generate SAS token for the uploaded image
      const imageUrlWithSas = await generateImageSasToken(blockBlobClient.url);

      uploadedImages.push({
        original_name: file.originalname,
        url: blockBlobClient.url,
        sas_url: imageUrlWithSas,
        size: file.size,
        type: file.mimetype,
        uploaded_at: new Date(),
      });
    }

    return uploadedImages;
  } catch (error) {
    console.error("Error uploading images to Azure:", error);
    throw error;
  }
};

const startAppointment = async (req, res) => {
  try {
    const therapy_id = req.params.id;
    const { presession_remarks } = req.body;

    if (!therapy_id) {
      return res.status(400).json({ error: "Therapy ID is required" });
    }

    // Initialize Mongoose models
    const TherapySession = getTherapySession(req.orgDb);
    const TherapyPlan = getTherapyPlanModel(req.orgDb);

    // Find the therapy session using Mongoose
    const therapy = await TherapySession.findById(therapy_id);

    if (!therapy) {
      return res.status(404).json({ error: "Therapy not found" });
    }

    // Check if therapy is already started or completed
    if (therapy.status === "in_progress" || therapy.status === "completed") {
      return res.status(400).json({
        error: `Therapy session is already ${therapy.status}`,
      });
    }

    const sessionStartTime = moment().tz("Asia/Kolkata").toDate();

    // Get session number from therapy plan
    let sessionNumber = 1;
    if (therapy.plan_id) {
      const therapyPlan = await TherapyPlan.findById(therapy.plan_id);
      if (therapyPlan) {
        // Find the session in the plan to get its number
        const sessionRef = therapyPlan.therapy_sessions.find(
          (session) => session._id.toString() === therapy_id.toString(),
        );
        if (sessionRef) {
          sessionNumber = sessionRef.session_number;
        }
      }
    }

    // Handle pre-session image uploads
    let presessionImages = [];
    if (req.files && req.files.length > 0) {
      try {
        presessionImages = await uploadImagesToAzure(
          req.files,
          therapy_id,
          "presession",
        );

        // Add session number and session ID to each image
        presessionImages = presessionImages.map((image) => ({
          ...image,
          session_number: sessionNumber,
          SessionId: therapy_id,
        }));
      } catch (uploadError) {
        console.error("Error uploading pre-session images:", uploadError);
        return res.status(500).json({
          error: "Failed to upload pre-session images",
        });
      }
    }

    // Update the therapy session
    therapy.session_start_time = sessionStartTime;
    therapy.status = "in_progress";

    // Add presession remarks if provided
    if (presession_remarks && presession_remarks.trim() !== "") {
      therapy.presession_remarks = presession_remarks;
    }

    // Save the updated therapy session
    await therapy.save();

    // If the therapy document has a plan_id and remarks are not empty, update the corresponding plan document
    if (therapy.plan_id) {
      const therapyPlan = await TherapyPlan.findById(therapy.plan_id);
      if (therapyPlan) {
        if (presessionImages.length > 0) {
          therapyPlan.presession_images.push(...presessionImages);
        }
        if (presession_remarks && presession_remarks.trim()) {
          await therapyPlan.addPresessionRemark(
            therapy.doctor_name,
            presession_remarks,
            therapy_id,
          );
        }
        await therapyPlan.save();
      }
    }

    res.status(200).json({
      message: "Therapy started successfully",
      session_start_time: sessionStartTime,
      session_number: sessionNumber,
      presession_images_count: presessionImages.length,
      presession_images: presessionImages.map((img) => ({
        original_name: img.original_name,
        sas_url: img.sas_url,
        size: img.size,
        uploaded_at: img.uploaded_at,
        session_number: img.session_number,
        session_id: img.SessionId,
      })),
    });
  } catch (error) {
    console.error("Error starting therapy:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const endAppointment = async (req, res) => {
  try {
    const therapy_id = req.params.id;
    const { postsession_remarks } = req.body;

    if (!therapy_id) {
      return res.status(400).json({ error: "Appointment ID is required" });
    }

    // Initialize Mongoose models using the provided functions
    const TherapySession = getTherapySession(req.orgDb);
    const TherapyPlan = getTherapyPlanModel(req.orgDb);

    // Find the therapy session using Mongoose
    const therapy = await TherapySession.findById(therapy_id);

    if (!therapy) {
      return res.status(404).json({ error: "Therapy session not found" });
    }

    // Check if therapy is in progress
    if (therapy.status !== "in_progress") {
      return res.status(400).json({ error: "Appointment is not in progress" });
    }

    // Calculate session duration
    const sessionEndTime = moment().tz("Asia/Kolkata").toDate();
    const sessionDuration = moment(sessionEndTime).diff(
      moment(therapy.session_start_time),
      "minutes",
    );

    // Get session number from therapy plan
    let sessionNumber = 1;
    if (therapy.plan_id) {
      const therapyPlan = await TherapyPlan.findById(therapy.plan_id);
      if (therapyPlan) {
        // Find the session in the plan to get its number
        const sessionRef = therapyPlan.therapy_sessions.find(
          (session) => session._id.toString() === therapy_id.toString(),
        );
        if (sessionRef) {
          sessionNumber = sessionRef.session_number;
        }
      }
    }

    // Handle post-session image uploads
    let postsessionImages = [];
    if (req.files && req.files.length > 0) {
      try {
        postsessionImages = await uploadImagesToAzure(
          req.files,
          therapy_id,
          "postsession",
        );

        // Add session number and session ID to each image
        postsessionImages = postsessionImages.map((image) => ({
          ...image,
          session_number: sessionNumber,
          SessionId: therapy_id,
        }));
      } catch (uploadError) {
        console.error("Error uploading post-session images:", uploadError);
        return res.status(500).json({
          error: "Failed to upload post-session images",
        });
      }
    }

    // Get organization settings for Google Calendar
    const orgSettings = await req.orgDb
      .collection("organization_settings")
      .findOne({ tenant_id: req.user.tenant_id });

    // Handle Google Calendar integration
    if (orgSettings?.access_token && therapy.google_calendar_event_id) {
      const updateGoogleCalendarEvent = async (accessToken) => {
        try {
          // Update the Google Calendar event to mark it as completed
          await axios.patch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events/${therapy.google_calendar_event_id}`,
            {
              status: "confirmed",
              transparency: "opaque",
              colorId: "8", // Use a specific color for completed events
              description: `${
                therapy.description || ""
              }\n\nSession completed on ${moment(sessionEndTime).format(
                "MMMM Do YYYY, h:mm a",
              )}\nDuration: ${sessionDuration} minutes${
                postsession_remarks
                  ? `\n\nPost-session remarks: ${postsession_remarks}`
                  : ""
              }`,
            },
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
            },
          );
        } catch (error) {
          if (error.response && error.response.status === 401) {
            // Token expired, refresh and try again
            const newAccessToken = await refreshToken(req.user.tenant_id);

            // Update the organization's access token
            await req.orgDb.collection("organization_settings").updateOne(
              { tenant_id: req.user.tenant_id },
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

      // Execute the calendar update
      await updateGoogleCalendarEvent(orgSettings.access_token);
    }

    // Update therapy session properties
    therapy.session_end_time = sessionEndTime;
    therapy.session_duration = sessionDuration;
    therapy.status = "completed";

    // Add postsession remarks if provided
    if (postsession_remarks && postsession_remarks.trim() !== "") {
      therapy.postsession_remarks = postsession_remarks;
    }

    // Save the updated therapy session
    await therapy.save();

    // Update the corresponding therapy plan
    if (therapy.plan_id) {
      const therapyPlan = await TherapyPlan.findById(therapy.plan_id);

      if (therapyPlan) {
        // Use the TherapyPlan model methods to update session status
        await therapyPlan.updateSessionStatus(therapy_id, "completed");
        if (postsessionImages.length > 0) {
          therapyPlan.postsession_images.push(...postsessionImages);
        }

        // Add post-session remarks to the plan if applicable
        if (postsession_remarks && postsession_remarks.trim() !== "") {
          await therapyPlan.addPostsessionRemark(
            therapy.doctor_name,
            postsession_remarks,
            therapy_id,
          );
        }
        await therapyPlan.save();
      }
    }

    // Return success response
    res.status(200).json({
      message: "Appointment ended successfully",
      session_end_time: sessionEndTime,
      session_duration: sessionDuration,
      session_number: sessionNumber,
      postsession_images_count: postsessionImages.length,
      postsession_images: postsessionImages.map((img) => ({
        original_name: img.original_name,
        sas_url: img.sas_url,
        size: img.size,
        uploaded_at: img.uploaded_at,
        session_number: img.session_number,
        session_id: img.SessionId,
      })),
    });
  } catch (error) {
    console.error("Error ending appointment:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
const { getPrescriptionModel } = require("../db/prescriptionSchema");
const { getPatientModel } = require("../db/patientSchema");
const markPreviousAppointmentCompleted = async (req, res) => {
  try {
    const therapy_id = req.params.id;

    const {
      counselor_impression,
      session_start_time,
      session_end_time,
      manual_duration,
      Typeofmeet, // "Phone Call" | "Home Visit" | undefined — only meaningful for Aftercare sessions
    } = req.body;

    // --- PARSE JSON STRINGS FROM FORMDATA ---

    // Parse Prescription
    let prescription = null;
    if (req.body.prescription) {
      try {
        prescription =
          typeof req.body.prescription === "string"
            ? JSON.parse(req.body.prescription)
            : req.body.prescription;
        console.log("Parsed prescription data:", prescription);
      } catch (error) {
        console.error("Error parsing prescription data:", error);
        return res
          .status(400)
          .json({ error: "Invalid prescription data format" });
      }
    }

    // Parse Rehab Indicators
    let rehab_indicators = null;
    if (req.body.rehab_indicators) {
      try {
        rehab_indicators =
          typeof req.body.rehab_indicators === "string"
            ? JSON.parse(req.body.rehab_indicators)
            : req.body.rehab_indicators;
      } catch (error) {
        console.error("Error parsing rehab indicators:", error);
        return res
          .status(400)
          .json({ error: "Invalid rehab_indicators data format" });
      }
    }

    // Parse Clinical Observations
    let clinical_observations = null;
    if (req.body.clinical_observations) {
      try {
        clinical_observations =
          typeof req.body.clinical_observations === "string"
            ? JSON.parse(req.body.clinical_observations)
            : req.body.clinical_observations;
      } catch (error) {
        console.error("Error parsing clinical observations:", error);
        return res
          .status(400)
          .json({ error: "Invalid clinical_observations data format" });
      }
    }

    // Validation
    if (!therapy_id) {
      return res.status(400).json({ error: "Appointment ID is required" });
    }

    if (!session_start_time || !session_end_time) {
      return res.status(400).json({
        error: "Session start time and end time are required",
      });
    }

    // Initialize models
    const TherapySession = getTherapySession(req.orgDb);
    const Prescription = getPrescriptionModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);

    const therapy = await TherapySession.findById(therapy_id);
    if (!therapy) {
      return res.status(404).json({ error: "Therapy session not found" });
    }

    if (therapy.status === "completed") {
      return res.status(400).json({
        error: "Appointment is already marked as completed",
      });
    }

    // ── Typeofmeet validation ────────
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

    // --- WITHDRAWAL SYMPTOMS VALIDATION ---
    if (clinical_observations && clinical_observations.withdrawal_symptoms) {
      if (!Array.isArray(clinical_observations.withdrawal_symptoms)) {
        return res
          .status(400)
          .json({ error: "withdrawal_symptoms must be an array." });
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
          error: `Invalid withdrawal_symptoms. Allowed values are: ${validSymptoms.join(", ")}`,
        });
      }
    }

    const startTime = moment(session_start_time).tz("Asia/Kolkata");
    const endTime = moment(session_end_time).tz("Asia/Kolkata");

    if (!endTime.isAfter(startTime)) {
      return res.status(400).json({
        error: "Session end time must be after start time",
      });
    }

    const sessionDuration =
      manual_duration || endTime.diff(startTime, "minutes");

    if (sessionDuration < 0 || sessionDuration > 1440) {
      return res.status(400).json({
        error:
          "Invalid session duration. Duration must be between 0 and 1440 minutes (24 hours)",
      });
    }

    // --- Prescription Saving Logic ---
    let savedPrescriptionId = null;

    if (
      prescription &&
      prescription.medications &&
      prescription.medications.length > 0
    ) {
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
          prescription_date: endTime.toDate(),
          vitals: prescription.vitals || {},
          medications: prescription.medications,
          diagnosis: prescription.diagnosis || "General Therapy",
          notes: prescription.notes || "",
          status: "Active",
        });

        const savedPrescription = await newPrescription.save();
        savedPrescriptionId = savedPrescription._id;
        therapy.prescription_id = savedPrescriptionId;
      } else {
        console.warn(
          `Patient not found for ID: ${therapy.patient_id}, skipping prescription creation.`,
        );
      }
    }

    // Handle post-session image uploads
    let postsessionImages = [];
    if (req.files && req.files.length > 0) {
      try {
        postsessionImages = await uploadImagesToAzure(
          req.files,
          therapy_id,
          "postsession",
        );

        postsessionImages = postsessionImages.map((image) => ({
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

    // Update therapy session
    therapy.session_start_time = startTime.toDate();
    therapy.session_end_time = endTime.toDate();
    therapy.session_duration = sessionDuration;
    therapy.status = "completed";
    therapy.completed_retrospectively = true;
    therapy.retrospective_completion_date = moment()
      .tz("Asia/Kolkata")
      .toDate();
    therapy.retrospective_completed_by = req.user.id || req.user._id;

    if (counselor_impression && counselor_impression.trim() !== "") {
      therapy.counselor_impression = counselor_impression;
    }

    if (Typeofmeet) {
      therapy.Typeofmeet = Typeofmeet;
    }

    // --- ASSIGN PARSED OBJECTS ---
    if (rehab_indicators) {
      therapy.rehab_indicators = rehab_indicators;
    }

    if (clinical_observations) {
      therapy.clinical_observations = clinical_observations;
    }

    await therapy.save();

    return res.status(200).json({
      message: "Previous appointment marked as completed successfully",
      session_start_time: startTime.toDate(),
      session_end_time: endTime.toDate(),
      session_duration: sessionDuration,
      prescriptionId: savedPrescriptionId,
      prescriptionCreated: savedPrescriptionId !== null,
      postsession_images_count: postsessionImages.length,
      marked_retrospectively: true,
      Typeofmeet: therapy.Typeofmeet || null,
      postsession_images: postsessionImages.map((img) => ({
        original_name: img.original_name,
        sas_url: img.sas_url,
        size: img.size,
        uploaded_at: img.uploaded_at,
        session_id: img.SessionId,
      })),
    });
  } catch (error) {
    console.error("Error marking previous appointment as completed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
// --- HELPER FUNCTION: DELETE FROM AZURE ---
const deleteImageFromAzure = async (blobName, containerName) => {
  try {
    // Ensure you have your connection string in your environment variables
    const AZURE_STORAGE_CONNECTION_STRING =
      process.env.AZURE_STORAGE_CONNECTION_STRING;

    if (!AZURE_STORAGE_CONNECTION_STRING) {
      throw new Error("Azure Storage Connection String not found");
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Delete the blob
    await blockBlobClient.delete();
    console.log(`Successfully deleted blob: ${blobName}`);
    return true;
  } catch (error) {
    // If blob doesn't exist, we can consider it "deleted" to avoid breaking the flow
    if (error.statusCode === 404) {
      console.warn(`Blob not found in Azure (already deleted?): ${blobName}`);
      return true;
    }
    console.error(`Error deleting blob from Azure: ${error.message}`);
    throw error;
  }
};
const editCompletedSession = async (req, res) => {
  try {
    const therapy_id = req.params.id;

    // 1. Extract fields
    const {
      counselor_impression,
      session_start_time,
      session_end_time,
      manual_duration,
    } = req.body;

    // 2. Parse Prescription
    let prescriptionUpdateData = null;
    if (req.body.prescription) {
      try {
        prescriptionUpdateData = JSON.parse(req.body.prescription);
      } catch (error) {
        return res
          .status(400)
          .json({ error: "Invalid prescription data format" });
      }
    }

    // 3. Parse Deleted Images
    let deletedImages = [];
    if (req.body.deleted_images) {
      try {
        deletedImages = JSON.parse(req.body.deleted_images);
      } catch (error) {
        console.error("Error parsing deleted images:", error);
      }
    }

    // 4. Initialize Models
    const TherapySession = getTherapySession(req.orgDb);
    const TherapyPlan = getTherapyPlanModel(req.orgDb);
    const Prescription = getPrescriptionModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);

    // 5. Find Session
    const therapy = await TherapySession.findById(therapy_id);

    if (!therapy) {
      return res.status(404).json({ error: "Therapy session not found" });
    }

    if (therapy.status !== "completed") {
      return res.status(400).json({
        error:
          "This session is not completed yet. Use the completion endpoint instead.",
      });
    }

    // --- TIME & DURATION LOGIC ---
    let startTime = moment(therapy.session_start_time).tz("Asia/Kolkata");
    let endTime = moment(therapy.session_end_time).tz("Asia/Kolkata");
    let duration = therapy.session_duration;
    let timeChanged = false;

    if (session_start_time) {
      startTime = moment(session_start_time).tz("Asia/Kolkata");
      timeChanged = true;
    }
    if (session_end_time) {
      endTime = moment(session_end_time).tz("Asia/Kolkata");
      timeChanged = true;
    }

    if (timeChanged) {
      if (!endTime.isAfter(startTime)) {
        return res
          .status(400)
          .json({ error: "Session end time must be after start time" });
      }
      duration = manual_duration || endTime.diff(startTime, "minutes");
      therapy.session_start_time = startTime.toDate();
      therapy.session_end_time = endTime.toDate();
      therapy.session_duration = duration;
    } else if (manual_duration) {
      therapy.session_duration = manual_duration;
      duration = manual_duration;
    }

    // --- REMARKS LOGIC ---
    if (counselor_impression !== undefined) {
      therapy.counselor_impression = counselor_impression;
    }

    // --- PRESCRIPTION LOGIC ---
    let currentPrescriptionId = therapy.prescription_id;
    if (prescriptionUpdateData) {
      if (currentPrescriptionId) {
        // Update Existing
        const existingPrescription = await Prescription.findById(
          currentPrescriptionId,
        );
        if (existingPrescription) {
          existingPrescription.medications =
            prescriptionUpdateData.medications ||
            existingPrescription.medications;
          existingPrescription.vitals =
            prescriptionUpdateData.vitals || existingPrescription.vitals;
          existingPrescription.diagnosis =
            prescriptionUpdateData.diagnosis || existingPrescription.diagnosis;
          existingPrescription.notes =
            prescriptionUpdateData.notes || existingPrescription.notes;

          if (timeChanged)
            existingPrescription.prescription_date = endTime.toDate();

          await existingPrescription.save();
        }
      } else {
        // Create New
        if (
          prescriptionUpdateData.medications &&
          prescriptionUpdateData.medications.length > 0
        ) {
          const patientData = await Patient.findById(therapy.patient_id);
          const prescriptionNumber =
            prescriptionUpdateData.prescription_number ||
            `PRE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

          const newPrescription = new Prescription({
            prescription_number: prescriptionNumber,
            patient_id: therapy.patient_id,
            patient_name: patientData
              ? `${patientData.patient_first_name} ${patientData.patient_last_name}`
              : "Unknown",
            doctor_id: therapy.doctor_id,
            doctor_name: therapy.doctor_name,
            prescription_date: endTime.toDate(),
            vitals: prescriptionUpdateData.vitals || {},
            medications: prescriptionUpdateData.medications,
            diagnosis: prescriptionUpdateData.diagnosis || "General Therapy",
            notes: prescriptionUpdateData.notes || "",
            status: "Active",
          });

          const savedPrescription = await newPrescription.save();
          therapy.prescription_id = savedPrescription._id;
          currentPrescriptionId = savedPrescription._id;
        }
      }
    }

    // --- IMAGE DELETION LOGIC (DEBUGGED) ---
    if (deletedImages.length > 0 && therapy.plan_id) {
      const therapyPlan = await TherapyPlan.findById(therapy.plan_id);

      if (therapyPlan) {
        for (const imgToDelete of deletedImages) {
          // 1. Remove from Database first
          try {
            await TherapyPlan.updateOne(
              { _id: therapy.plan_id },
              { $pull: { postsession_images: { url: imgToDelete.url } } },
            );
          } catch (dbError) {
            console.error(
              "DB removal failed for image:",
              imgToDelete.url,
              dbError,
            );
          }

          // 2. Delete from Azure Cloud
          if (imgToDelete.url) {
            let blobName, containerName;

            // Step 2a: Parse URL safely
            try {
              const urlObj = new URL(imgToDelete.url);
              const pathParts = urlObj.pathname.split("/");
              // pathParts -> ["", "containerName", "folder", "filename..."]
              containerName = pathParts[1];
              blobName = pathParts.slice(2).join("/");
            } catch (parseErr) {
              console.error(
                "URL Parsing Failed:",
                imgToDelete.url,
                parseErr.message,
              );
              continue; // Skip Azure delete if we can't parse name
            }

            // Step 2b: Call Azure Deletion
            try {
              console.log(
                `Deleting blob: ${blobName} from container: ${containerName}`,
              );
              // Ensure this helper exists in your imports
              await deleteImageFromAzure(blobName, containerName);
            } catch (azureErr) {
              // This is where the previous error was hiding
              console.error(
                "Azure Deletion Failed:",
                azureErr.message || azureErr,
              );
            }
          }
        }
      }
    }

    // --- NEW IMAGE UPLOADS ---
    let newImages = [];
    if (req.files && req.files.length > 0) {
      try {
        newImages = await uploadImagesToAzure(
          req.files,
          therapy_id,
          "postsession",
        );

        let sessionNumber = 1;
        if (therapy.plan_id) {
          const plan = await TherapyPlan.findById(therapy.plan_id);
          const sRef = plan?.therapy_sessions.find(
            (s) => s._id.toString() === therapy_id.toString(),
          );
          if (sRef) sessionNumber = sRef.session_number;
        }

        newImages = newImages.map((image) => ({
          ...image,
          session_number: sessionNumber,
          SessionId: therapy_id,
        }));
      } catch (uploadError) {
        console.error("Error uploading new images:", uploadError);
        return res.status(500).json({ error: "Failed to upload new images" });
      }
    }

    // --- GOOGLE CALENDAR SYNC (Token Retry Included) ---
    const orgSettings = await req.orgDb
      .collection("organization_settings")
      .findOne({ tenant_id: req.user.tenant_id });

    if (
      orgSettings?.access_token &&
      therapy.google_calendar_event_id &&
      (timeChanged || counselor_impression)
    ) {
      const updateGCal = async (accessToken) => {
        try {
          await axios.patch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events/${therapy.google_calendar_event_id}`,
            {
              description: `${
                therapy.description || ""
              }\n\nSession completed on ${endTime.format(
                "MMMM Do YYYY, h:mm a",
              )}\nDuration: ${duration} minutes${
                counselor_impression
                  ? `\n\nPost-session remarks: ${counselor_impression}`
                  : ""
              }\n\n[Updated]`,
            },
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
            },
          );
        } catch (error) {
          // Handle 401 Unauthorized (Token Expiry)
          if (error.response && error.response.status === 401) {
            console.log("GCal Token expired. Refreshing...");
            try {
              // Ensure 'refreshToken' is imported/available
              const newAccessToken = await refreshToken(req.user.tenant_id);
              if (newAccessToken) {
                await req.orgDb.collection("organization_settings").updateOne(
                  { tenant_id: req.user.tenant_id },
                  {
                    $set: {
                      access_token: newAccessToken,
                      last_updated: new Date(),
                    },
                  },
                );
                // Return the result of the retry
                return await updateGCal(newAccessToken);
              }
            } catch (refreshErr) {
              console.error(
                "Failed to refresh GCal token:",
                refreshErr.message,
              );
            }
          } else {
            console.error("GCal update failed", error.message);
          }
        }
      };
      await updateGCal(orgSettings.access_token);
    }

    // --- FINAL SAVES ---
    therapy.last_updated = new Date();
    await therapy.save();

    if (therapy.plan_id) {
      const therapyPlan = await TherapyPlan.findById(therapy.plan_id);
      if (therapyPlan) {
        // Append new images
        if (newImages.length > 0) {
          therapyPlan.postsession_images.push(...newImages);
        }
        // Update remarks
        const sessionIndex = therapyPlan.therapy_sessions.findIndex(
          (s) => s._id.toString() === therapy_id.toString(),
        );
        if (sessionIndex !== -1 && counselor_impression) {
          if (
            therapyPlan.therapy_sessions[sessionIndex].remarks !== undefined
          ) {
            therapyPlan.therapy_sessions[sessionIndex].remarks =
              counselor_impression;
          }
        }
        await therapyPlan.save();
      }
    }

    return res.status(200).json({
      success: true,
      message: "Session details updated successfully",
      data: {
        session_id: therapy._id,
        new_images_uploaded: newImages.length,
        deleted_images_count: deletedImages.length,
      },
    });
  } catch (error) {
    console.error("Error editing session:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const updateSessionStatus = async (req, res) => {
  try {
    const therapy_id = req.params.id;
    const { status, reason } = req.body;

    // 1. Validation
    if (!therapy_id) {
      return res.status(400).json({ error: "Appointment ID is required" });
    }

    const allowedStatuses = ["Cancelled", "No Show"];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: "Invalid status. Allowed values: Cancelled, No Show",
      });
    }

    if (!reason) {
      return res.status(400).json({ error: "Reason is required" });
    }

    // 2. Initialize models — TherapyPlan intentionally excluded (plans are now a separate entity)
    const TherapySession = getTherapySession(req.orgDb);

    // 3. Find session
    const therapy = await TherapySession.findById(therapy_id);
    if (!therapy) {
      return res.status(404).json({ error: "Therapy session not found" });
    }

    if (therapy.status === "completed" || therapy.status === "Completed") {
      return res
        .status(400)
        .json({ error: "Cannot cancel a completed session" });
    }

    // 4. Update therapy session
    therapy.status = status;
    therapy.notes = reason;
    therapy.session_duration = 0;

    await therapy.save();

    return res.status(200).json({
      message: `Session marked as ${status}`,
      status: status,
      id: therapy._id,
    });
  } catch (error) {
    console.error("Error updating session status:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
// Helper function to get session images with SAS tokens
const getSessionImages = async (req, res) => {
  try {
    const therapy_id = req.params.id;
    const { type } = req.query; // 'presession' or 'postsession'

    if (!therapy_id) {
      return res.status(400).json({ error: "Therapy ID is required" });
    }

    const TherapySession = getTherapySession(req.orgDb);
    const therapy = await TherapySession.findById(therapy_id);

    if (!therapy) {
      return res.status(404).json({ error: "Therapy session not found" });
    }

    let images = [];

    if (type === "presession" && therapy.presession_images) {
      images = therapy.presession_images;
    } else if (type === "postsession" && therapy.postsession_images) {
      images = therapy.postsession_images;
    } else if (!type) {
      // Return both if no type specified
      images = [
        ...(therapy.presession_images || []).map((img) => ({
          ...img,
          session_type: "presession",
        })),
        ...(therapy.postsession_images || []).map((img) => ({
          ...img,
          session_type: "postsession",
        })),
      ];
    }

    // Generate fresh SAS tokens for all images
    const imagesWithFreshSas = await Promise.all(
      images.map(async (image) => {
        const freshSasUrl = await generateImageSasToken(image.url);
        return {
          ...image,
          sas_url: freshSasUrl,
        };
      }),
    );

    res.status(200).json({
      message: "Images retrieved successfully",
      images: imagesWithFreshSas,
    });
  } catch (error) {
    console.error("Error retrieving session images:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Helper function to delete session images
const deleteSessionImage = async (req, res) => {
  try {
    const therapy_id = req.params.id;
    const { image_url, session_type } = req.body;

    if (!therapy_id || !image_url || !session_type) {
      return res.status(400).json({
        error: "Therapy ID, image URL, and session type are required",
      });
    }

    const TherapySession = getTherapySession(req.orgDb);
    const therapy = await TherapySession.findById(therapy_id);

    if (!therapy) {
      return res.status(404).json({ error: "Therapy session not found" });
    }

    // Remove image from Azure Blob Storage
    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(
        process.env.AZURE_STORAGE_CONNECTION_STRING,
      );

      const containerName = "therapy-session-images";
      const containerClient =
        blobServiceClient.getContainerClient(containerName);

      // Extract blob name from URL
      const blobName = image_url.split("/").slice(-3).join("/"); // Get last 3 parts
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);

      const exists = await blockBlobClient.exists();
      if (exists) {
        await blockBlobClient.delete();
      }
    } catch (azureError) {
      console.error("Error deleting image from Azure:", azureError);
      return res
        .status(500)
        .json({ error: "Failed to delete image from storage" });
    }

    // Remove image from database
    if (session_type === "presession" && therapy.presession_images) {
      therapy.presession_images = therapy.presession_images.filter(
        (img) => img.url !== image_url,
      );
    } else if (session_type === "postsession" && therapy.postsession_images) {
      therapy.postsession_images = therapy.postsession_images.filter(
        (img) => img.url !== image_url,
      );
    }

    await therapy.save();

    res.status(200).json({
      message: "Image deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting session image:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
// Express route handler
const getDoctorAvailability = async (req, res) => {
  try {
    const { date, doctor_id, slot_duration = 30 } = req.body;
    const slots = await checkDoctorAvailability(
      req.orgDb,
      doctor_id,
      date,
      parseInt(slot_duration),
    );
    res.json(slots);
  } catch (error) {
    console.error("Error checking doctor availability:", error);
    res.status(500).json({
      error: error.message || "Internal server error",
    });
  }
};

const getAllEvents = async (req, res) => {
  try {
    const doctorId = req.doctor_id; // Assuming this is set by your authenticateToken middleware
    const date = new Date(); // Or any specific date you want to query

    // If you need all appointment details:
    const allAppointments = await getAllAppointments(req.orgDb, doctorId, date);

    res.json({ appointments: allAppointments });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const getAllEventDoctor = async (req, res) => {
  try {
    const doctorId = req.params.id; // Assuming this is set by your authenticateToken middleware
    const date = new Date(); // Or any specific date you want to query

    // If you need all appointment details:
    const allAppointments = await getAllAppointments(req.orgDb, doctorId, date);

    res.json({ appointments: allAppointments });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const AllappointmentsToday = async (req, res) => {
  const { orgDb, doctor_id } = req;
  const currentDate = new Date().toISOString().split("T")[0];

  try {
    const therapies = await orgDb
      .collection("therepys")
      .aggregate([
        {
          $match: {
            therepy_date: currentDate,
            doctor_id: { $ne: doctor_id },
            $or: [
              { status: { $exists: false } },
              { status: "in_progress" },
              { status: "Scheduled" },
              { status: "Rescheduled" },
            ],
          },
        },
        {
          $lookup: {
            from: "doctors",
            localField: "doctor_id",
            foreignField: "_id",
            as: "doctor_details",
          },
        },
        {
          $unwind: "$doctor_details",
        },
        {
          $project: {
            _id: 1,
            patient_name: 1,
            therepy_type: 1,
            therepy_remarks: 1,
            therepy_link: 1,
            host_join_link: 1,
            therepy_start_time: 1,
            therepy_end_time: 1,
            therepy_cost: 1,
            therepy_date: 1,
            status: 1,
            patient_id: 1,
            doctor_id: 1,
            is_consultation: 1,
            plan_id: 1,
            therapy_reason: 1,
            doctor_name: {
              $concat: [
                "$doctor_details.doctor_first_name",
                " ",
                "$doctor_details.doctor_last_name",
              ],
            },
            doctor_phone: "$doctor_details.doctor_phone",
          },
        },
      ])
      .toArray();

    if (therapies.length === 0) {
      return res.status(404).json({ message: "No therapies found for today." });
    }

    const therapiesWithStringIds = therapies.map((therapy) => ({
      ...therapy,
      id: therapy._id.toString(),
    }));

    res.json(therapiesWithStringIds);
  } catch (error) {
    console.error("Error fetching therapies:", error);
    res
      .status(500)
      .json({ error: "An error occurred while fetching therapies." });
  }
};

const getAllAppointmentsByDate = async (req, res) => {
  const { orgDb } = req;
  const { date } = req.body; // Get date from request body

  try {
    const therapies = await orgDb
      .collection("therepys")
      .aggregate([
        {
          $match: {
            therepy_date: date,
          },
        },
        {
          $lookup: {
            from: "doctors",
            localField: "doctor_id",
            foreignField: "_id",
            as: "doctor_details",
          },
        },
        {
          $unwind: "$doctor_details",
        },
        {
          $project: {
            _id: 1,
            patient_name: 1,
            therepy_type: 1,
            therepy_remarks: 1,
            therepy_link: 1,
            host_join_link: 1,
            therepy_start_time: 1,
            therepy_end_time: 1,
            therepy_cost: 1,
            therepy_date: 1,
            status: 1,
            patient_id: 1,
            plan_id: 1,
            doctor_name: {
              $concat: [
                "$doctor_details.doctor_first_name",
                " ",
                "$doctor_details.doctor_last_name",
              ],
            },
            doctor_phone: "$doctor_details.doctor_phone",
          },
        },
      ])
      .toArray();

    if (therapies.length === 0) {
      return res
        .status(404)
        .json({ message: `No therapies found for date: ${date}` });
    }

    const therapiesWithStringIds = therapies.map((therapy) => ({
      ...therapy,
      id: therapy._id.toString(),
    }));

    res.json(therapiesWithStringIds);
  } catch (error) {
    console.error("Error fetching therapies:", error);
    res
      .status(500)
      .json({ error: "An error occurred while fetching therapies." });
  }
};

const getAppointmentsByDateRange = async (req, res) => {
  const { orgDb } = req;
  const { startDate, endDate } = req.body;

  try {
    // Validate date inputs
    if (!startDate || !endDate) {
      return res.status(400).json({
        message: "Both startDate and endDate are required in YYYY-MM-DD format",
      });
    }

    const therapies = await orgDb
      .collection("therepys")
      .aggregate([
        {
          $match: {
            therepy_date: {
              $gte: startDate,
              $lte: endDate,
            },
          },
        },
        {
          $lookup: {
            from: "doctors",
            localField: "doctor_id",
            foreignField: "_id",
            as: "doctor_details",
          },
        },
        {
          $unwind: "$doctor_details",
        },
        {
          $project: {
            _id: 1,
            patient_name: 1,
            therepy_type: 1,
            therepy_remarks: 1,
            therepy_link: 1,
            therepy_start_time: 1,
            therepy_end_time: 1,
            therepy_cost: 1,
            therepy_date: 1,
            status: 1,
            therapy_reason: 1,
            host_join_link: 1,
            is_consultation: 1,
            patient_id: 1,
            consultationId: 1,
            doctor_id: 1,
            plan_id: 1,
            doctor_name: {
              $concat: [
                "$doctor_details.doctor_first_name",
                " ",
                "$doctor_details.doctor_last_name",
              ],
            },
            doctor_phone: "$doctor_details.doctor_phone",
          },
        },
        {
          $sort: {
            therepy_date: 1,
            therepy_start_time: 1,
          },
        },
      ])
      .toArray();

    // Generate array of all dates in range
    const dates = [];
    let currentDate = new Date(startDate);
    const end = new Date(endDate);

    while (currentDate <= end) {
      dates.push(currentDate.toISOString().split("T")[0]);
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Initialize appointmentsByDate with empty arrays for all dates
    const appointmentsByDate = dates.reduce((acc, date) => {
      acc[date] = [];
      return acc;
    }, {});

    // Fill in appointments where they exist
    therapies.forEach((therapy) => {
      if (appointmentsByDate.hasOwnProperty(therapy.therepy_date)) {
        appointmentsByDate[therapy.therepy_date].push({
          ...therapy,
          id: therapy._id.toString(),
        });
      }
    });

    res.json({
      totalAppointments: therapies.length,
      appointments: appointmentsByDate,
      dateRange: {
        start: startDate,
        end: endDate,
        totalDays: dates.length,
      },
    });
  } catch (error) {
    console.error("Error fetching therapies:", error);
    res.status(500).json({
      error: "An error occurred while fetching therapies.",
      details: error.message,
    });
  }
};

const getAftercareAppointmentsByDateRange = async (req, res) => {
  const { orgDb } = req;
  const { startDate, endDate } = req.body;

  try {
    // Validate date inputs
    if (!startDate || !endDate) {
      return res.status(400).json({
        message: "Both startDate and endDate are required in YYYY-MM-DD format",
      });
    }

    const therapies = await orgDb
      .collection("therepys")
      .aggregate([
        {
          $match: {
            therepy_date: {
              $gte: startDate,
              $lte: endDate,
            },
            therepy_type: "Aftercare", // <-- Strict backend filter for Aftercare only
          },
        },
        {
          $lookup: {
            from: "doctors",
            localField: "doctor_id",
            foreignField: "_id",
            as: "doctor_details",
          },
        },
        {
          // Using preserveNullAndEmptyArrays ensures sessions aren't dropped if doctor info is missing
          $unwind: {
            path: "$doctor_details",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $project: {
            _id: 1,
            patient_name: 1,
            therepy_type: 1,
            therepy_remarks: 1,
            therepy_link: 1,
            therepy_start_time: 1,
            therepy_end_time: 1,
            therepy_cost: 1,
            therepy_date: 1,
            status: 1,
            therapy_reason: 1,
            host_join_link: 1,
            is_consultation: 1,
            patient_id: 1,
            consultationId: 1,
            doctor_id: 1,
            plan_id: 1,
            aftercare_team: 1, // <-- ADDED THIS LINE to pass both doctors to the UI
            doctor_name: {
              $cond: {
                if: {
                  $and: [
                    "$doctor_details.doctor_first_name",
                    "$doctor_details.doctor_last_name",
                  ],
                },
                then: {
                  $concat: [
                    "$doctor_details.doctor_first_name",
                    " ",
                    "$doctor_details.doctor_last_name",
                  ],
                },
                else: "$doctor_name", // Fallback if lookup fails
              },
            },
            doctor_phone: "$doctor_details.doctor_phone",
          },
        },
        {
          $sort: {
            therepy_date: 1,
            therepy_start_time: 1,
          },
        },
      ])
      .toArray();

    // Generate array of all dates in range
    const dates = [];
    let currentDate = new Date(startDate);
    const end = new Date(endDate);

    while (currentDate <= end) {
      dates.push(currentDate.toISOString().split("T")[0]);
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Initialize appointmentsByDate with empty arrays for all dates
    const appointmentsByDate = dates.reduce((acc, date) => {
      acc[date] = [];
      return acc;
    }, {});

    // Fill in appointments where they exist
    therapies.forEach((therapy) => {
      if (appointmentsByDate.hasOwnProperty(therapy.therepy_date)) {
        appointmentsByDate[therapy.therepy_date].push({
          ...therapy,
          id: therapy._id.toString(),
        });
      }
    });

    res.json({
      totalAppointments: therapies.length,
      appointments: appointmentsByDate,
      dateRange: {
        start: startDate,
        end: endDate,
        totalDays: dates.length,
      },
    });
  } catch (error) {
    console.error("Error fetching aftercare therapies:", error);
    res.status(500).json({
      error: "An error occurred while fetching aftercare therapies.",
      details: error.message,
    });
  }
};

const getFollowupAppointmentsByDateRange = async (req, res) => {
  const { orgDb } = req;
  const { startDate, endDate } = req.body;

  try {
    // Validate date inputs
    if (!startDate || !endDate) {
      return res.status(400).json({
        message: "Both startDate and endDate are required in YYYY-MM-DD format",
      });
    }

    const therapies = await orgDb
      .collection("therepys")
      .aggregate([
        {
          $match: {
            therepy_date: {
              $gte: startDate,
              $lte: endDate,
            },
            therepy_type: "Follow-up", // <-- Strict backend filter for Follow-up only
          },
        },
        {
          $lookup: {
            from: "doctors",
            localField: "doctor_id",
            foreignField: "_id",
            as: "doctor_details",
          },
        },
        {
          // Using preserveNullAndEmptyArrays ensures sessions aren't dropped if doctor info is missing
          $unwind: {
            path: "$doctor_details",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $project: {
            _id: 1,
            patient_name: 1,
            therepy_type: 1,
            therepy_remarks: 1,
            therepy_link: 1,
            therepy_start_time: 1,
            therepy_end_time: 1,
            therepy_cost: 1,
            therepy_date: 1,
            status: 1,
            therapy_reason: 1,
            host_join_link: 1,
            is_consultation: 1,
            patient_id: 1,
            consultationId: 1,
            doctor_id: 1,
            plan_id: 1,
            aftercare_team: 1,
            session_number: 1,
            doctor_name: {
              $cond: {
                if: {
                  $and: [
                    "$doctor_details.doctor_first_name",
                    "$doctor_details.doctor_last_name",
                  ],
                },
                then: {
                  $concat: [
                    "$doctor_details.doctor_first_name",
                    " ",
                    "$doctor_details.doctor_last_name",
                  ],
                },
                else: "$doctor_name", // Fallback if lookup fails
              },
            },
            doctor_phone: "$doctor_details.doctor_phone",
          },
        },
        {
          $sort: {
            therepy_date: 1,
            therepy_start_time: 1,
          },
        },
      ])
      .toArray();

    // Generate array of all dates in range
    const dates = [];
    let currentDate = new Date(startDate);
    const end = new Date(endDate);

    while (currentDate <= end) {
      dates.push(currentDate.toISOString().split("T")[0]);
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Initialize appointmentsByDate with empty arrays for all dates
    const appointmentsByDate = dates.reduce((acc, date) => {
      acc[date] = [];
      return acc;
    }, {});

    // Fill in appointments where they exist
    therapies.forEach((therapy) => {
      if (appointmentsByDate.hasOwnProperty(therapy.therepy_date)) {
        appointmentsByDate[therapy.therepy_date].push({
          ...therapy,
          id: therapy._id.toString(),
        });
      }
    });

    res.json({
      totalAppointments: therapies.length,
      appointments: appointmentsByDate,
      dateRange: {
        start: startDate,
        end: endDate,
        totalDays: dates.length,
      },
    });
  } catch (error) {
    console.error("Error fetching follow-up therapies:", error);
    res.status(500).json({
      error: "An error occurred while fetching follow-up therapies.",
      details: error.message,
    });
  }
};

const getUpcomingFollowUps = async (req, res) => {
  try {
    const { page = 1, limit = 20, from, to } = req.query;

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    // 1. Initialize BOTH models on the tenant's connection
    const Patient = getPatientModel(req.orgDb);
    const TherapyPlan = getTherapyPlanModel(req.orgDb); // <-- INITIALIZE HERE

    // 2. Build the date filter query
    const query = {};
    if (from || to) {
      query.follow_Up_Date = {};
      if (from) {
        const fromDate = new Date(from);
        fromDate.setHours(0, 0, 0, 0);
        query.follow_Up_Date.$gte = fromDate;
      }
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        query.follow_Up_Date.$lte = toDate;
      }
    } else {
      query.follow_Up_Date = { $exists: true, $ne: null };
    }

    // 3. Fetch total count and paginated patients concurrently
    const [patients, totalCount] = await Promise.all([
      Patient.find(query)
        .select("-medical_history -notes -documents -consultations")
        .populate({
          path: "therapy_plans",
          select:
            "therapy_name status closure_reason closure_date therapy_start",
          model: TherapyPlan, // <-- PASS THE DYNAMIC MODEL INSTANCE, NOT A STRING
        })
        .sort({ follow_Up_Date: 1 })
        .skip(skip)
        .limit(limitNum)
        .lean()
        .exec(),
      Patient.countDocuments(query).exec(),
    ]);

    // 4. Attach SAS tokens for images
    const patientsWithSas = await Promise.all(
      patients.map(async (patient) => {
        if (!patient.patient_image) return patient;
        try {
          const url = await generatepatientImageSasToken(patient.patient_image);
          return { ...patient, patient_image: url };
        } catch (err) {
          console.error(
            `Failed SAS token for patient ${patient._id}:`,
            err.message,
          );
          return { ...patient, patient_image: null };
        }
      }),
    );

    const totalPages = Math.ceil(totalCount / limitNum);

    return res.status(200).json({
      success: true,
      patients: patientsWithSas,
      pagination: {
        total_count: totalCount,
        total_pages: totalPages,
        current_page: pageNum,
        limit: limitNum,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1,
      },
    });
  } catch (error) {
    console.error("Error fetching upcoming follow-ups:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};

const getDoctorUpcomingFollowUps = async (req, res) => {
  try {
    const { page = 1, limit = 20, from, to, doctorId } = req.query;

    const targetDoctorId = doctorId || req.doctor_id; // Falls back to auth middleware ID
    if (!targetDoctorId) {
      return res.status(400).json({
        success: false,
        message: "Doctor ID is required to fetch follow-ups.",
      });
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 20;
    const skip = (pageNum - 1) * limitNum;

    // 1. Initialize models on the tenant DB connection
    const Patient = getPatientModel(req.orgDb);
    const TherapyPlan = getTherapyPlanModel(req.orgDb);

    // 2. Build the shared date filter query
    const dateFilter = {};
    if (from || to) {
      dateFilter.follow_Up_Date = {};
      if (from) {
        const fromDate = new Date(from);
        fromDate.setHours(0, 0, 0, 0);
        dateFilter.follow_Up_Date.$gte = fromDate;
      }
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        dateFilter.follow_Up_Date.$lte = toDate;
      }
    } else {
      dateFilter.follow_Up_Date = { $exists: true, $ne: null };
    }

    // 3. Query primary doctor assignments and care team assignments separately for index efficiency
    const [primaryPatients, careTeamPatients] = await Promise.all([
      Patient.find({ doctor_id: targetDoctorId, ...dateFilter })
        .select("-medical_history -notes -documents -consultations")
        .populate({
          path: "therapy_plans",
          select:
            "therapy_name status closure_reason closure_date therapy_start",
          model: TherapyPlan,
        })
        .sort({ follow_Up_Date: 1 })
        .lean()
        .exec(),

      Patient.find({ "care_team.doctor_id": targetDoctorId, ...dateFilter })
        .select("-medical_history -notes -documents -consultations")
        .populate({
          path: "therapy_plans",
          select:
            "therapy_name status closure_reason closure_date therapy_start",
          model: TherapyPlan,
        })
        .sort({ follow_Up_Date: 1 })
        .lean()
        .exec(),
    ]);

    // 4. Deduplicate patients across both primary and care-team lists
    const seen = new Set();
    const allPatients = [...primaryPatients, ...careTeamPatients].filter(
      (patient) => {
        const id = patient._id.toString();
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      },
    );

    // 5. Re-sort chronologically by follow_Up_Date ascending
    allPatients.sort(
      (a, b) => new Date(a.follow_Up_Date) - new Date(b.follow_Up_Date),
    );

    // 6. Paginate merged results
    const totalCount = allPatients.length;
    const paginated = allPatients.slice(skip, skip + limitNum);
    const totalPages = Math.ceil(totalCount / limitNum);

    // 7. Attach SAS tokens for patient profile images
    const patientsWithSas = await Promise.all(
      paginated.map(async (patient) => {
        if (!patient.patient_image) return patient;
        try {
          const url = await generatepatientImageSasToken(patient.patient_image);
          return { ...patient, patient_image: url };
        } catch (err) {
          console.error(
            `Failed SAS token for patient ${patient._id}:`,
            err.message,
          );
          return { ...patient, patient_image: null };
        }
      }),
    );

    return res.status(200).json({
      success: true,
      patients: patientsWithSas,
      pagination: {
        total_count: totalCount,
        total_pages: totalPages,
        current_page: pageNum,
        limit: limitNum,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1,
      },
    });
  } catch (error) {
    console.error("Error fetching doctor's upcoming follow-ups:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};
// New endpoint for web appointments only
const getHealtrackAppointments = async (req, res) => {
  const { orgDb } = req;
  const { startDate, endDate } = req.body;

  try {
    // Validate date inputs
    if (!startDate || !endDate) {
      return res.status(400).json({
        message: "Both startDate and endDate are required in YYYY-MM-DD format",
      });
    }

    const therapies = await orgDb
      .collection("therepys")
      .aggregate([
        {
          $match: {
            therepy_date: {
              $gte: startDate,
              $lte: endDate,
            },
            source: "patient", // Only fetch web appointments
          },
        },
        {
          $lookup: {
            from: "doctors",
            localField: "doctor_id",
            foreignField: "_id",
            as: "doctor_details",
          },
        },
        {
          $unwind: "$doctor_details",
        },
        {
          $project: {
            _id: 1,
            patient_name: 1,
            therepy_type: 1,
            therepy_remarks: 1,
            therepy_link: 1,
            therepy_start_time: 1,
            therepy_end_time: 1,
            therepy_cost: 1,
            therepy_date: 1,
            status: 1,
            therapy_reason: 1,
            is_consultation: 1,
            patient_id: 1,
            doctor_id: 1,
            plan_id: 1,
            doctor_name: {
              $concat: [
                "$doctor_details.doctor_first_name",
                " ",
                "$doctor_details.doctor_last_name",
              ],
            },
            doctor_phone: "$doctor_details.doctor_phone",
          },
        },
        {
          $sort: {
            therepy_date: 1,
            therepy_start_time: 1,
          },
        },
      ])
      .toArray();

    // Generate array of all dates in range
    const dates = [];
    let currentDate = new Date(startDate);
    const end = new Date(endDate);

    while (currentDate <= end) {
      dates.push(currentDate.toISOString().split("T")[0]);
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Initialize appointmentsByDate with empty arrays for all dates
    const appointmentsByDate = dates.reduce((acc, date) => {
      acc[date] = [];
      return acc;
    }, {});

    // Fill in appointments where they exist
    therapies.forEach((therapy) => {
      if (appointmentsByDate.hasOwnProperty(therapy.therepy_date)) {
        appointmentsByDate[therapy.therepy_date].push({
          ...therapy,
          id: therapy._id.toString(),
        });
      }
    });

    res.json({
      totalAppointments: therapies.length,
      appointments: appointmentsByDate,
      dateRange: {
        start: startDate,
        end: endDate,
        totalDays: dates.length,
      },
    });
  } catch (error) {
    console.error("Error fetching web therapies:", error);
    res.status(500).json({
      error: "An error occurred while fetching web therapies.",
      details: error.message,
    });
  }
};

const printSession = async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return res.status(400).json({ error: "Invalid Session ID format" });
    }

    // 1. Initialize Models
    const TherapySession = getTherapySession(req.orgDb);
    const TherapyPlan = getTherapyPlanModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);
    const Prescription = getPrescriptionModel(req.orgDb);

    // 2. Fetch the Core Session Record First
    const session = await TherapySession.findById(sessionId).lean();

    if (!session) {
      return res.status(404).json({ error: "Session record not found" });
    }

    // Inside printSession function
    const [patient, plan, prescription, organization] = await Promise.all([
      session.patient_id
        ? Patient.findById(session.patient_id).lean()
        : Promise.resolve(null),
      session.plan_id
        ? TherapyPlan.findById(session.plan_id).lean()
        : Promise.resolve(null),
      session.prescription_id
        ? Prescription.findById(session.prescription_id).lean()
        : Promise.resolve(null),

      // FIX: Use the imported Organization model instead of organization_settings
      Organization.findOne({ tenant_id: req.user.tenant_id }).lean(),
    ]);

    // 4. Process Organization Logo
    let logoUrl = organization?.organization_logo || "";
    if (logoUrl) {
      logoUrl = await generateImageSasTokenLogo(logoUrl);
    }

    // 5. Fetch ALL Sessions for the Plan & Format Them
    let allSessionsList = [];
    let currentSessionNumber = 1;

    if (plan && plan.therapy_sessions && plan.therapy_sessions.length > 0) {
      // Extract all session IDs from the plan
      const sessionIds = plan.therapy_sessions.map((s) => s._id);

      // Fetch the full details of all these sessions from the database
      const fullSessionsData = await TherapySession.find({
        _id: { $in: sessionIds },
      }).lean();

      // Merge the plan's session_number with the actual start/end times
      allSessionsList = plan.therapy_sessions.map((planSession) => {
        // Find the matching full session document
        const fullSession = fullSessionsData.find(
          (fs) => fs._id.toString() === planSession._id.toString(),
        );

        // Check if this is the session currently being printed
        if (planSession._id.toString() === sessionId.toString()) {
          currentSessionNumber = planSession.session_number;
        }

        return {
          session_id: planSession._id,
          session_number: planSession.session_number,
          status: planSession.status,
          date: fullSession?.therepy_date || planSession.date,
          start_time: fullSession?.therepy_start_time || "",
          end_time: fullSession?.therepy_end_time || "",
        };
      });

      // Sort the list so Session 1 is first, Session 2 is second, etc.
      allSessionsList.sort((a, b) => a.session_number - b.session_number);
    }

    // 6. Prepare Data Packet
    const printData = {
      // OVERARCHING PLAN INFO (Now includes the list of all sessions)
      plan: plan
        ? {
            _id: plan._id,
            plan_name: plan.therapy_name || "Therapy Plan",
            start_date: plan.therapy_start || "",
            end_date: plan.therapy_end || "",
            causes: plan.causes || "",
            symptoms: plan.patient_symptoms || "",
            diagnosis: plan.patient_diagnosis || "",
            total_sessions:
              plan.estimated_sessions || plan.therapy_sessions?.length || 0,
            all_sessions: allSessionsList, // <-- HERE IS YOUR NEW LIST
          }
        : null,

      // SPECIFIC CURRENT SESSION INFO
      session: {
        _id: session._id,
        session_number: currentSessionNumber,
        date: session.therepy_date,
        start_time: session.therepy_start_time,
        end_time: session.therepy_end_time,
        duration: session.session_duration || "",
        presession_remarks: session.presession_remarks || "",
        postsession_remarks: session.postsession_remarks || "",
        status: session.status || "",
        type: session.therepy_type || "",
      },

      // SESSION-SPECIFIC PRESCRIPTION
      prescription: prescription
        ? {
            ...prescription,
            vitals: prescription.vitals || {},
            has_notes: !!prescription.notes,
            date: prescription.prescription_date,
            medications: prescription.medications || [],
          }
        : null,

      // PATIENT DETAILS
      patient: patient
        ? {
            _id: patient._id,
            name: `${patient.patient_first_name || ""} ${patient.patient_last_name || ""}`.trim(),
            age: patient.age || "",
            gender: patient.gender || "",
            uhid: patient.uhid || "",
            mobile: patient.patient_phone || patient.mobile || "",
            address: patient.address || "",
            allergies: patient.allergies || [],
          }
        : {
            name: session.patient_name || "Unknown Patient",
            _id: session.patient_id,
            age: "",
            gender: "",
          },

      // ORGANIZATION DETAILS
      organization: {
        name: organization?.organization_name || "Clinic Name",
        address: organization?.organization_address || {},
        logo: logoUrl,
        gstin: organization?.organization_tax_id || "",
        email: organization?.organization_email || "",
        phone: organization?.organization_phone || "",
      },

      // DOCTOR DETAILS
      user: {
        name: `${req.user.doctor_first_name || ""} ${req.user.doctor_last_name || ""}`.trim(),
        specialization: req.user.specialization || "",
        registration_number: req.user.registration_number || "",
        qualification: req.user.qualification || "",
        signature: req.user.signature || "",
      },
    };

    res.status(200).json(printData);
  } catch (error) {
    console.error("Get Session Print Data Error:", error);
    res.status(500).json({
      message: "Error fetching session print data",
      error: error.message,
    });
  }
};
module.exports = {
  getAllAppointmentsByDate,
  getEventsCount,
  getAllEvents,
  getAllEventDoctor,
  AllappointmentsToday,
  getHealtrackAppointments,
  getDoctorAvailability,
  startAppointment,
  endAppointment,
  getAllAppointments,
  uploadSessionImages,
  markPreviousAppointmentCompleted,
  getAppointmentsByDateRange,
  getAftercareAppointmentsByDateRange,
  updateSessionStatus,
  editCompletedSession,
  printSession,
  getFollowupAppointmentsByDateRange,
  getUpcomingFollowUps,
  getDoctorUpcomingFollowUps,
};
