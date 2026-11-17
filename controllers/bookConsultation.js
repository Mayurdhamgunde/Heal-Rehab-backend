const express = require("express");
const router = express.Router();
const { getPatientModel } = require("../db/patientSchema");
const { getConsultationModel } = require("../db/consultationSchema"); // Import the new schema
const { ObjectId } = require("mongoose").Types;
const { getTherapySession } = require("../db/therepy");
const { getPrescriptionModel } = require("../db/prescriptionSchema");
const Organization = require("../db/OrganizationSchema");
const { generateImageSasTokenLogo } = require("../utils/azureutils");
const saveConsultation = async (req, res) => {
  try {
    const { patientId } = req.params;
    const {
      patientSymptoms,
      causes,
      notes,
      results,
      consultationDate,
      consultationTime,
      appointmentId,
      prescription, // Optional prescription object from frontend
    } = req.body;

    // Assuming req.user contains the doctor's _id or id along with names
    const {
      organization_name,
      doctor_first_name,
      doctor_last_name,
      tenant_id,
      _id, // Assuming the JWT/Auth middleware attaches the doctor's DB ID here
      doctor_id, // or here
    } = req.user;

    const doctorId = _id || doctor_id; // Fallback to ensure we get an ID
    const doctorFullName = `${doctor_first_name} ${doctor_last_name}`;

    if (!ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid patient ID" });
    }

    // 1. Fetch Patient details (Needed for Prescription: patient_name)
    const Patient = getPatientModel(req.orgDb);
    const patientData = await Patient.findById(patientId).select(
      "patient_first_name patient_last_name",
    );

    if (!patientData) {
      return res.status(404).json({ error: "Patient not found" });
    }

    // 2. Handle Optional Prescription Logic
    let savedPrescriptionId = null;

    if (prescription) {
      const Prescription = getPrescriptionModel(req.orgDb);

      // Generate a simple prescription number if not provided
      const prescriptionNumber =
        prescription.prescription_number ||
        `PRE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      const newPrescription = new Prescription({
        prescription_number: prescriptionNumber,
        patient_id: patientId,
        patient_name: `${patientData.patient_first_name} ${patientData.patient_last_name}`,
        doctor_id: doctorId,
        doctor_name: doctorFullName,
        prescription_date: consultationDate
          ? new Date(consultationDate)
          : new Date(),
        vitals: prescription.vitals,
        medications: prescription.medications,
        diagnosis: prescription.diagnosis || results, // Fallback to consultation result if diagnosis empty
        notes: prescription.notes, // Prescription specific notes
        status: "Active",
      });

      const savedPrescription = await newPrescription.save();
      savedPrescriptionId = savedPrescription._id;
    }

    // 3. Prepare Consultation Logic
    const normalizeTime = (time) => {
      if (!time) return null;
      const [hours, minutes, seconds] = time.split(":").map(Number);
      const period = hours >= 12 ? "PM" : "AM";
      const hours12 = hours % 12 || 12;
      return `${hours12}:${minutes.toString().padStart(2, "0")} ${period}`;
    };

    const formattedTime = normalizeTime(consultationTime);
    const consultationDateTime = consultationDate
      ? new Date(consultationDate)
      : new Date();

    const Consultation = getConsultationModel(req.orgDb);

    const newConsultation = new Consultation({
      patientId: patientId,
      organizationName: organization_name,
      doctorName: doctorFullName,
      consultationDate: consultationDateTime,
      consultationTime: formattedTime,
      organizationId: tenant_id,
      doctorId: req.user.doctor_id,
      patientSymptoms,
      causes,
      notes, // Consultation notes
      results,
      status: "Completed",
      ...(appointmentId && { therapy_id: new ObjectId(appointmentId) }),
      ...(savedPrescriptionId && { prescriptionId: savedPrescriptionId }), // Link Prescription
    });

    const savedConsultation = await newConsultation.save();

    // 4. Update Appointment/Therapy Status if applicable
    if (appointmentId) {
      const TherapySession = getTherapySession(req.orgDb);
      await TherapySession.findByIdAndUpdate(
        appointmentId,
        {
          $set: {
            status: "completed",
            consultationId: savedConsultation._id, // Save consultation ID in therapy
          },
        },
        { new: true },
      );
    }

    return res.status(201).json({
      message: "Consultation saved successfully",
      consultation: savedConsultation,
      prescriptionId: savedPrescriptionId, // Return ID for confirmation
    });
  } catch (error) {
    console.error("Error booking consultation:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const editConsultation = async (req, res) => {
  try {
    const { consultationId } = req.params;
    const {
      patientSymptoms,
      causes,
      notes,
      results,
      consultationDate,
      consultationTime,
      prescription, // Optional prescription object to update
    } = req.body;

    // Get doctor details from authenticated user
    const {
      organization_name,
      doctor_first_name,
      doctor_last_name,
      tenant_id,
      _id,
      doctor_id,
    } = req.user;

    const doctorId = _id || doctor_id;
    const doctorFullName = `${doctor_first_name} ${doctor_last_name}`;

    // Validate consultation ID
    if (!ObjectId.isValid(consultationId)) {
      return res.status(400).json({ error: "Invalid consultation ID" });
    }

    // 1. Find existing consultation
    const Consultation = getConsultationModel(req.orgDb);
    const existingConsultation = await Consultation.findById(consultationId);

    if (!existingConsultation) {
      return res.status(404).json({ error: "Consultation not found" });
    }

    // 2. Fetch Patient details (needed for prescription updates)
    const Patient = getPatientModel(req.orgDb);
    const patientData = await Patient.findById(
      existingConsultation.patientId,
    ).select("patient_first_name patient_last_name");

    if (!patientData) {
      return res.status(404).json({ error: "Patient not found" });
    }

    // 3. Handle Prescription Update Logic
    let updatedPrescriptionId = existingConsultation.prescriptionId;

    if (prescription) {
      const Prescription = getPrescriptionModel(req.orgDb);

      if (existingConsultation.prescriptionId) {
        // Update existing prescription
        const prescriptionUpdateData = {
          prescription_date: consultationDate
            ? new Date(consultationDate)
            : existingConsultation.consultationDate,
          vitals: prescription.vitals,
          medications: prescription.medications,
          diagnosis: prescription.diagnosis || results,
          notes: prescription.notes,
          patient_name: `${patientData.patient_first_name} ${patientData.patient_last_name}`,
          doctor_name: doctorFullName,
        };

        await Prescription.findByIdAndUpdate(
          existingConsultation.prescriptionId,
          { $set: prescriptionUpdateData },
          { new: true, runValidators: true },
        );
      } else {
        // Create new prescription if one didn't exist
        const prescriptionNumber =
          prescription.prescription_number ||
          `PRE-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        const newPrescription = new Prescription({
          prescription_number: prescriptionNumber,
          patient_id: existingConsultation.patientId,
          patient_name: `${patientData.patient_first_name} ${patientData.patient_last_name}`,
          doctor_id: doctorId,
          doctor_name: doctorFullName,
          prescription_date: consultationDate
            ? new Date(consultationDate)
            : existingConsultation.consultationDate,
          vitals: prescription.vitals,
          medications: prescription.medications,
          diagnosis: prescription.diagnosis || results,
          notes: prescription.notes,
          status: "Active",
        });

        const savedPrescription = await newPrescription.save();
        updatedPrescriptionId = savedPrescription._id;
      }
    }

    // 4. Prepare consultation update data
    const normalizeTime = (time) => {
      if (!time) return null;
      const [hours, minutes, seconds] = time.split(":").map(Number);
      const period = hours >= 12 ? "PM" : "AM";
      const hours12 = hours % 12 || 12;
      return `${hours12}:${minutes.toString().padStart(2, "0")} ${period}`;
    };

    const formattedTime = consultationTime
      ? normalizeTime(consultationTime)
      : existingConsultation.consultationTime;

    const consultationDateTime = consultationDate
      ? new Date(consultationDate)
      : existingConsultation.consultationDate;

    // 5. Update consultation
    const consultationUpdateData = {
      organizationName: organization_name,
      doctorName: doctorFullName,
      consultationDate: consultationDateTime,
      consultationTime: formattedTime,
      organizationId: tenant_id,
      patientSymptoms:
        patientSymptoms !== undefined
          ? patientSymptoms
          : existingConsultation.patientSymptoms,
      causes: causes !== undefined ? causes : existingConsultation.causes,
      notes: notes !== undefined ? notes : existingConsultation.notes,
      results: results !== undefined ? results : existingConsultation.results,
      ...(updatedPrescriptionId && { prescriptionId: updatedPrescriptionId }),
    };

    const updatedConsultation = await Consultation.findByIdAndUpdate(
      consultationId,
      { $set: consultationUpdateData },
      { new: true, runValidators: true },
    );

    return res.status(200).json({
      message: "Consultation updated successfully",
      consultation: updatedConsultation,
      prescriptionId: updatedPrescriptionId,
    });
  } catch (error) {
    console.error("Error updating consultation:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Get all consultations for a patient
const getConsultations = async (req, res) => {
  try {
    const { patientId } = req.params;

    if (!ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid patient ID" });
    }

    const Consultation = getConsultationModel(req.orgDb);

    // Find all consultations linked to this patientId
    const consultations = await Consultation.find({
      patientId: patientId,
    }).sort({
      consultationDate: -1,
    });

    res.status(200).json(consultations);
  } catch (error) {
    console.error("Error fetching consultations:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const getConsultationById = async (req, res) => {
  try {
    const { consultationId } = req.params;

    if (!ObjectId.isValid(consultationId)) {
      return res.status(400).json({ error: "Invalid Consultation ID" });
    }

    // Initialize Models
    const Consultation = getConsultationModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);
    const Prescription = getPrescriptionModel(req.orgDb);

    // 1. Fetch the Consultation
    const consultation = await Consultation.findById(consultationId);

    if (!consultation) {
      return res.status(404).json({ error: "Consultation not found" });
    }

    // 2. Fetch Linked Data (Patient & Prescription) in parallel
    // We use Promise.all for performance to fetch both simultaneously
    const [patient, prescription] = await Promise.all([
      // Fetch Patient
      consultation.patientId
        ? Patient.findById(consultation.patientId)
        : Promise.resolve(null),

      // Fetch Prescription (only if prescriptionId exists)
      consultation.prescriptionId
        ? Prescription.findById(consultation.prescriptionId)
        : Promise.resolve(null),
    ]);

    // 3. Return Consolidated Response
    res.status(200).json({
      consultation,
      patient,
      prescription, // Will be null if no prescription is linked
    });
  } catch (error) {
    console.error("Error fetching single consultation:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
const getPrescriptionPrintData = async (req, res) => {
  try {
    // 1. We start directly with the prescriptionId
    const { prescriptionId } = req.params;

    if (!ObjectId.isValid(prescriptionId)) {
      return res.status(400).json({ error: "Invalid Prescription ID" });
    }

    // Initialize Models
    const Prescription = getPrescriptionModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);

    // 2. Fetch the Prescription Record First
    const prescription = await Prescription.findById(prescriptionId).lean();

    if (!prescription) {
      return res.status(404).json({ error: "Prescription record not found" });
    }

    // 3. Fetch Linked Data (Patient & Organization) in parallel
    // We use the patient_id found inside the prescription document
    const [patient, organization] = await Promise.all([
      prescription.patient_id
        ? Patient.findById(prescription.patient_id).lean()
        : Promise.resolve(null),

      Organization.findOne({
        tenant_id: req.user.tenant_id,
      }),
    ]);

    // 4. Process Organization Logo (SAS Token)
    let logoUrl = organization?.organization_logo || "";
    if (logoUrl) {
      // Ensure generateImageSasTokenLogo is available in your scope
      logoUrl = await generateImageSasTokenLogo(logoUrl);
    }

    // 5. Prepare Data Packet
    const printData = {
      prescription: {
        ...prescription,
        // Ensure vitals are accessible even if empty
        vitals: prescription.vitals || {},
        has_notes: !!prescription.notes,
        // Format dates for display if needed here, or handle in frontend
        date: prescription.prescription_date,
      },
      patient: patient
        ? {
            _id: patient._id,
            // Combine names safely
            name: `${patient.patient_first_name || ""} ${patient.patient_last_name || ""}`.trim(),
            age: patient.age || "",
            gender: patient.gender || "",
            uhid: patient.uhid || "",
            mobile: patient.mobile || "",
            address: patient.address || "",
            allergies: patient.allergies || [],
          }
        : {
            // Fallback if patient record was deleted but exists in prescription snapshot
            name: prescription.patient_name || "Unknown Patient",
            _id: prescription.patient_id,
            age: "",
            gender: "",
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
        // This is the doctor printing the document (usually the logged-in user)
        name: `${req.user.doctor_first_name} ${req.user.doctor_last_name}`,
        specialization: req.user.specialization || "",
        registration_number: req.user.registration_number || "",
        qualification: req.user.qualification || "",
        signature: req.user.signature || "", // If you have signature URL
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
}; // Update consultation details
const updateConsultation = async (req, res) => {
  try {
    const { consultationId } = req.params; // We don't necessarily need patientId here anymore, but keeping it in params is fine
    const updateData = req.body;

    if (!ObjectId.isValid(consultationId)) {
      return res.status(400).json({ error: "Invalid Consultation ID" });
    }

    const Consultation = getConsultationModel(req.orgDb);

    // Filter out undefined fields
    const filteredUpdate = {};
    for (const key in updateData) {
      if (updateData[key] !== undefined) {
        if (key === "consultationDate") {
          filteredUpdate[key] = new Date(updateData[key]);
        } else {
          filteredUpdate[key] = updateData[key];
        }
      }
    }

    const updatedConsultation = await Consultation.findByIdAndUpdate(
      consultationId,
      { $set: filteredUpdate },
      { new: true },
    );

    if (!updatedConsultation) {
      return res.status(404).json({ error: "Consultation not found" });
    }

    res.status(200).json(updatedConsultation);
  } catch (error) {
    console.error("Error updating consultation:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Update consultation result (therapy needed or not)
const patchConsultation = async (req, res) => {
  try {
    const { consultationId } = req.params;
    const { results, therapyDetails } = req.body;

    if (!ObjectId.isValid(consultationId)) {
      return res.status(400).json({ error: "Invalid Consultation ID" });
    }

    if (!["therapy_needed", "no_therapy_needed"].includes(results)) {
      return res.status(400).json({ error: "Invalid result value" });
    }

    const Consultation = getConsultationModel(req.orgDb);

    const updateData = {
      results: results,
    };

    if (results === "therapy_needed" && therapyDetails) {
      updateData.therapyDetails = therapyDetails;
    }

    const updatedConsultation = await Consultation.findByIdAndUpdate(
      consultationId,
      { $set: updateData },
      { new: true },
    );

    if (!updatedConsultation) {
      return res.status(404).json({ error: "Consultation not found" });
    }

    res.status(200).json(updatedConsultation);
  } catch (error) {
    console.error("Error updating consultation result:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

const printConsultation = async (req, res) => {
  try {
    // 1. Start with the consultationId
    const { consultationId } = req.params;

    if (!ObjectId.isValid(consultationId)) {
      return res.status(400).json({ error: "Invalid Consultation ID" });
    }

    // Initialize Models
    const Consultation = getConsultationModel(req.orgDb);
    const Patient = getPatientModel(req.orgDb);
    const Prescription = getPrescriptionModel(req.orgDb);

    // 2. Fetch the Consultation Record First
    const consultation = await Consultation.findById(consultationId).lean();

    if (!consultation) {
      return res.status(404).json({ error: "Consultation record not found" });
    }

    // 3. Fetch Linked Data (Patient, Organization, and optionally Prescription) in parallel
    const [patient, organization, prescription] = await Promise.all([
      consultation.patientId
        ? Patient.findById(consultation.patientId).lean()
        : Promise.resolve(null),

      Organization.findOne({
        tenant_id: req.user.tenant_id,
      }),

      consultation.prescriptionId
        ? Prescription.findById(consultation.prescriptionId).lean()
        : Promise.resolve(null),
    ]);

    // 4. Process Organization Logo (SAS Token)
    let logoUrl = organization?.organization_logo || "";
    if (logoUrl) {
      // Ensure generateImageSasTokenLogo is available in your scope
      logoUrl = await generateImageSasTokenLogo(logoUrl);
    }

    // 5. Prepare Data Packet
    const printData = {
      consultation: {
        ...consultation,
        date: consultation.consultationDate,
        time: consultation.consultationTime,
        symptoms: consultation.patientSymptoms || "",
        causes: consultation.causes || "",
        results: consultation.results || "",
        notes: consultation.notes || "",
      },
      // Include prescription data if it was linked to the consultation
      prescription: prescription
        ? {
            ...prescription,
            vitals: prescription.vitals || {},
            has_notes: !!prescription.notes,
            date: prescription.prescription_date,
          }
        : null,
      patient: patient
        ? {
            _id: patient._id,
            name: `${patient.patient_first_name || ""} ${patient.patient_last_name || ""}`.trim(),
            age: patient.age || "",
            gender: patient.gender || "",
            uhid: patient.uhid || "",
            mobile: patient.mobile || "",
            address: patient.address || "",
            allergies: patient.allergies || [],
          }
        : {
            // Fallback if patient record was deleted
            name: consultation.doctorName
              ? "Patient Data Unavailable"
              : "Unknown Patient",
            _id: consultation.patientId,
            age: "",
            gender: "",
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
        // The doctor printing the document (usually the logged-in user)
        name: `${req.user.doctor_first_name} ${req.user.doctor_last_name}`,
        specialization: req.user.specialization || "",
        registration_number: req.user.registration_number || "",
        qualification: req.user.qualification || "",
        signature: req.user.signature || "",
      },
    };

    res.status(200).json(printData);
  } catch (error) {
    console.error("Get Consultation Print Data Error:", error);
    res.status(500).json({
      message: "Error fetching consultation print data",
      error: error.message,
    });
  }
};

module.exports = {
  saveConsultation,
  getConsultations,
  patchConsultation,
  updateConsultation,
  editConsultation,
  getConsultationById,
  getPrescriptionPrintData,
  printConsultation,
};
