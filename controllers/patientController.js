const mongoose = require("mongoose");
const { getPatientModel } = require("../db/patientSchema"); // Update path as needed
const { getDoctorModel } = require("../db/doctorschema");
const { getTherapyPlanModel } = require("../db/therepy");
const { v4: uuidv4 } = require("uuid");
const { BlobServiceClient } = require("@azure/storage-blob");
const {
  generatePatientDocumentSasToken,
  getBlobNameFromPatientDocumentURL,
  generatepatientImageSasToken,
  generatePatientConsentSasToken,
  generateImageSasToken,
} = require("../utils/azureutils");

const getPatient = async (req, res) => {
  try {
    const Patient = getPatientModel(req.orgDb);

    const patientData = await Patient.findById(req.params.id).lean();

    if (!patientData) {
      return res.status(404).json({ msg: "Patient doesn't exist." });
    }

    const concurrentTasks = [];

    // ---- Task 1: Fetch Therapy Plans ---- //
    if (
      Array.isArray(patientData.therapy_plans) &&
      patientData.therapy_plans.length > 0
    ) {
      concurrentTasks.push(
        (async () => {
          const TherapyPlan = getTherapyPlanModel(req.orgDb);
          const therapyPlans = await TherapyPlan.find({
            _id: { $in: patientData.therapy_plans },
          }).lean();
          patientData.therapy_plans = therapyPlans;
        })(),
      );
    } else {
      patientData.therapy_plans = [];
    }

    // ---- Task 2: Generate SAS token for Patient Image ---- //
    if (patientData.patient_image) {
      concurrentTasks.push(
        (async () => {
          patientData.patient_image = await generatepatientImageSasToken(
            patientData.patient_image,
          );
        })(),
      );
    }

    // ---- Task 3: Generate SAS token for Witness Image ---- //
    if (patientData.witness_photo_url) {
      concurrentTasks.push(
        (async () => {
          patientData.witness_photo_url = await generatepatientImageSasToken(
            patientData.witness_photo_url,
          );
        })(),
      );
    }

    // ---- Task 4: Generate SAS tokens for documents ---- //
    if (
      Array.isArray(patientData.documents) &&
      patientData.documents.length > 0
    ) {
      concurrentTasks.push(
        (async () => {
          patientData.documents = await Promise.all(
            patientData.documents.map(async (doc) => ({
              ...doc,
              document_url: await generatePatientDocumentSasToken(
                doc.document_url,
              ),
            })),
          );
        })(),
      );
    }

    // ---- Task 5: Generate SAS tokens for Consent History ---- //
    if (
      Array.isArray(patientData.consent_history) &&
      patientData.consent_history.length > 0
    ) {
      concurrentTasks.push(
        (async () => {
          patientData.consent_history = await Promise.all(
            patientData.consent_history.map(async (consent) => {
              const sasUrl = await generatePatientConsentSasToken(
                consent.document_url,
              );
              return {
                ...consent,
                document_url: sasUrl,
              };
            }),
          );
        })(),
      );
    }

    // ---- Task 6: Care team photos + Journey doctor photos (single Doctor query) ---- //
    const careTeamHasMembers =
      Array.isArray(patientData.care_team) && patientData.care_team.length > 0;

    const journeyHasEntries =
      Array.isArray(patientData.patient_journey) &&
      patientData.patient_journey.length > 0;

    if (careTeamHasMembers || journeyHasEntries) {
      concurrentTasks.push(
        (async () => {
          const Doctor = getDoctorModel(req.orgDb);

          // Collect unique doctor IDs from BOTH care_team and patient_journey
          const careTeamIds = careTeamHasMembers
            ? patientData.care_team
                .map((m) => m.doctor_id?.toString())
                .filter(Boolean)
            : [];

          const journeyIds = journeyHasEntries
            ? patientData.patient_journey
                .map((j) => j.performed_by_id?.toString())
                .filter(Boolean)
            : [];

          const uniqueDoctorIds = [...new Set([...careTeamIds, ...journeyIds])];

          // Single DB query for all doctors across both arrays
          const doctors = await Doctor.find(
            { _id: { $in: uniqueDoctorIds } },
            { _id: 1, doctors_photo: 1 },
          ).lean();

          // Generate all SAS tokens concurrently and build a lookup map
          const doctorPhotoMap = {};
          await Promise.all(
            doctors.map(async (doc) => {
              doctorPhotoMap[doc._id.toString()] = doc.doctors_photo
                ? await generateImageSasToken(doc.doctors_photo)
                : null;
            }),
          );

          // Map photos back into care_team
          if (careTeamHasMembers) {
            patientData.care_team = patientData.care_team.map((member) => ({
              ...member,
              doctor_photo:
                doctorPhotoMap[member.doctor_id?.toString()] ?? null,
            }));
          }

          // Map photos back into patient_journey
          if (journeyHasEntries) {
            patientData.patient_journey = patientData.patient_journey.map(
              (entry) => ({
                ...entry,
                performed_by_photo:
                  doctorPhotoMap[entry.performed_by_id?.toString()] ?? null,
              }),
            );
          }
        })(),
      );
    }

    await Promise.all(concurrentTasks);

    return res.status(200).json({ patientData });
  } catch (err) {
    console.error("Error getting patient:", err);
    return res.status(500).json({ msg: "Internal server error" });
  }
};

const NumberOfPatients = async (req, res) => {
  try {
    const Patient = getPatientModel(req.orgDb);

    // Use estimatedDocumentCount if no filters → but here filter exists, so use countDocuments
    const doctorId = req.user.doctor_id;

    if (!doctorId) {
      return res.status(400).json({ message: "doctor_id is required" });
    }

    // Fast count with projection avoided
    const patientCount = await Patient.countDocuments(
      { doctor_id: doctorId },
      { hint: { doctor_id: 1 } }, // improves speed if indexed
    );

    return res.status(200).json({ numberOfPatients: patientCount });
  } catch (error) {
    console.error("Error retrieving patient count:", error);
    res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

const deletePatientDocument = async (req, res) => {
  try {
    const patientId = req.params.patientId;
    const documentId = req.params.documentId;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid patient ID" });
    }

    const PatientModel = getPatientModel(req.orgDb);
    const patient = await PatientModel.findById(patientId);

    if (!patient) {
      return res.status(404).json({ msg: "Patient not found" });
    }

    // Find the document to delete
    const documentIndex = patient.documents.findIndex(
      (doc) => doc._id.toString() === documentId,
    );

    if (documentIndex === -1) {
      return res.status(404).json({ msg: "Document not found" });
    }
    const documentToDelete = patient.documents[documentIndex];

    // Delete from Azure Blob Storage
    try {
      const blobServiceClient = BlobServiceClient.fromConnectionString(
        process.env.AZURE_STORAGE_CONNECTION_STRING,
      );
      const containerName = "patient-documents";
      const containerClient =
        blobServiceClient.getContainerClient(containerName);

      const blobName = getBlobNameFromPatientDocumentURL(
        documentToDelete.document_url,
      );
      if (blobName) {
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        const exists = await blockBlobClient.exists();
        if (exists) {
          await blockBlobClient.delete();
        }
      }
    } catch (error) {
      console.error("Error deleting document from blob storage:", error);
    }

    // Remove document from patient's documents array
    patient.documents.splice(documentIndex, 1);
    await patient.save();

    res.status(200).json({
      msg: "Document deleted successfully",
    });
  } catch (err) {
    console.error("Error deleting document:", err);
    res.status(500).json({ error: "Error deleting document" });
  }
};
const PatientSearch = async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({ message: "Search query is required" });
    }

    const Patient = getPatientModel(req.orgDb);
    const patients = await Patient.find({
      $or: [
        { patient_first_name: { $regex: query, $options: "i" } },
        { patient_last_name: { $regex: query, $options: "i" } },
        { patient_email: { $regex: query, $options: "i" } },
        { patient_phone: { $regex: query, $options: "i" } },
        { patient_id: { $regex: query, $options: "i" } },
        { UHID: { $regex: query, $options: "i" } }, // ← UHID search
        {
          $expr: {
            $regexMatch: {
              input: {
                $concat: ["$patient_first_name", " ", "$patient_last_name"],
              },
              regex: query,
              options: "i",
            },
          },
        },
      ],
    })
      .lean()
      .limit(20);

    // Generate SAS tokens for patient images
    const patientsWithSas = await Promise.all(
      patients.map(async (patient) => {
        if (!patient.patient_image) return patient;
        try {
          const url = await generatepatientImageSasToken(patient.patient_image);
          return { ...patient, patient_image: url };
        } catch {
          return { ...patient, patient_image: null };
        }
      }),
    );

    res.status(200).json({ patients: patientsWithSas });
  } catch (error) {
    console.error("Error searching patients:", error);
    res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};
const DoctorPatientSearch = async (req, res) => {
  try {
    const { query, doctorId } = req.query;
    if (!query) {
      return res.status(400).json({ message: "Search query is required" });
    }

    const targetDoctorId = doctorId || req.doctor_id || req.user?._id;
    if (!targetDoctorId) {
      return res
        .status(400)
        .json({ message: "Doctor ID is required for this search." });
    }

    const Patient = getPatientModel(req.orgDb);

    const searchCondition = {
      $or: [
        { patient_first_name: { $regex: query, $options: "i" } },
        { patient_last_name: { $regex: query, $options: "i" } },
        { patient_email: { $regex: query, $options: "i" } },
        { patient_phone: { $regex: query, $options: "i" } },
        { patient_id: { $regex: query, $options: "i" } },
        { UHID: { $regex: query, $options: "i" } },
        {
          $expr: {
            $regexMatch: {
              input: {
                $concat: ["$patient_first_name", " ", "$patient_last_name"],
              },
              regex: query,
              options: "i",
            },
          },
        },
      ],
    };

    // Run parallel queries to utilize indexes efficiently, mirroring getDoctorPatients
    const [primaryMatches, careTeamMatches] = await Promise.all([
      Patient.find({ doctor_id: targetDoctorId, ...searchCondition })
        .lean()
        .limit(20)
        .exec(),
      Patient.find({
        "care_team.doctor_id": targetDoctorId,
        ...searchCondition,
      })
        .lean()
        .limit(20)
        .exec(),
    ]);

    // Deduplicate results (a patient can be in both queries)
    const seen = new Set();
    const combinedMatches = [...primaryMatches, ...careTeamMatches].filter(
      (p) => {
        const id = p._id.toString();
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      },
    );

    // Enforce final limit
    const finalMatches = combinedMatches.slice(0, 20);

    // Reuse your existing attachSasTokens helper function
    // Add this block
    const patientsWithSas = await Promise.all(
      finalMatches.map(async (patient) => {
        if (!patient.patient_image) return patient;
        try {
          const url = await generatepatientImageSasToken(patient.patient_image);
          return { ...patient, patient_image: url };
        } catch {
          return { ...patient, patient_image: null };
        }
      }),
    );

    res.status(200).json({ patients: patientsWithSas });
  } catch (error) {
    console.error("Error searching doctor's patients:", error);
    res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};
const uploadPatientDocument = async (req, res) => {
  try {
    const patientId = req.params.patientId || req.body.patientId;
    const documentName = req.body.document_name;
    const documentType = req.body.document_type || "Other";
    const uploadedBy = `${req.doctor_first_name} ${req.doctor_last_name}`;

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    if (!documentName) {
      return res.status(400).json({ error: "Document name is required" });
    }

    // Check if patientId is valid
    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid patient ID" });
    }

    // Get the Patient model for this organization
    const PatientModel = getPatientModel(req.orgDb);

    // Find the patient in the database
    const patient = await PatientModel.findById(patientId);

    if (!patient) {
      return res.status(404).json({ msg: "Patient not found" });
    }

    // Azure Blob Storage connection
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerName = "patient-documents";
    const containerClient = blobServiceClient.getContainerClient(containerName);

    // Create container if it doesn't exist
    await containerClient.createIfNotExists();

    // Generate unique filename
    const fileExtension = req.file.originalname.split(".").pop();
    const blobName = `${patientId}-${uuidv4()}.${fileExtension}`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Upload file
    await blockBlobClient.upload(req.file.buffer, req.file.buffer.length, {
      tier: "Cool",
    });

    // Get the URL of the uploaded blob
    const documentUrl = blockBlobClient.url;

    // Create document object
    const newDocument = {
      document_name: documentName,
      document_url: documentUrl,
      document_upload_date: new Date(),
      document_type: documentType,
      uploaded_by: uploadedBy,
      file_size: req.file.size,
      file_extension: fileExtension,
    };

    // Add document to patient's documents array
    patient.documents.push(newDocument);
    await patient.save();

    // Generate SAS token for the newly uploaded document
    const documentUrlWithSas =
      await generatePatientDocumentSasToken(documentUrl);

    console.log("Document uploaded successfully");
    res.status(200).json({
      msg: "Document uploaded successfully",
      document: {
        ...newDocument,
        document_url: documentUrlWithSas, // Return the URL with SAS token
      },
    });
  } catch (err) {
    console.error("Error uploading document:", err);
    res.status(500).json({ error: "Error uploading document" });
  }
};

const ArchivePatient = async (req, res) => {
  try {
    const patientId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ message: "Invalid patient ID format" });
    }

    const Patient = getPatientModel(req.orgDb);
    const patientObjectId = new mongoose.Types.ObjectId(patientId);

    const { archived_reason, follow_Up_Date } = req.body;
    const archived_by =
      `${req.user.doctor_first_name} ${req.user.doctor_last_name}`.trim();
    const now = new Date();

    const setFields = {
      status: "Archived",
      archived_at: now,
      ...(archived_by && { archived_by }),
      ...(archived_reason && { archived_reason }),
      ...(follow_Up_Date && { follow_Up_Date: new Date(follow_Up_Date) }),
    };

    const journeyEntry = {
      stage: "Discharged",
      performed_by_id: req.user.doctor_id || req.user._id,
      performed_by_name: archived_by,
      performed_at: now,
      notes: archived_reason
        ? `Discharged: ${archived_reason}`
        : "Patient discharged",
      status: "Completed",
    };

    // Fast atomic update: sets archive fields AND pushes "Discharged" stage in 1 roundtrip (if not present)
    let archivedPatient = await Patient.findOneAndUpdate(
      {
        _id: patientObjectId,
        "patient_journey.stage": { $ne: "Discharged" },
      },
      {
        $set: setFields,
        $push: { patient_journey: journeyEntry },
      },
      { new: true },
    );

    // Fallback if "Discharged" stage was already logged
    if (!archivedPatient) {
      archivedPatient = await Patient.findByIdAndUpdate(
        patientObjectId,
        { $set: setFields },
        { new: true },
      );

      if (!archivedPatient) {
        return res
          .status(404)
          .json({ message: "Patient not found in database" });
      }
    }

    return res.status(200).json({
      message: "Patient archived successfully",
      archivedPatient,
    });
  } catch (error) {
    console.error("Error archiving patient:", error);
    return res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

const UnarchivePatient = async (req, res) => {
  try {
    const patientId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ message: "Invalid patient ID format" });
    }

    const Patient = getPatientModel(req.orgDb);
    const patientObjectId = new mongoose.Types.ObjectId(patientId);
    const unarchived_by =
      `${req.user.doctor_first_name} ${req.user.doctor_last_name}`.trim();

    // Fast atomic update: reactivate patient, clear archive fields, and remove "Discharged" stage
    const unarchivedPatient = await Patient.findByIdAndUpdate(
      patientObjectId,
      {
        $set: {
          status: "Active",
          unarchived_at: new Date(),
          unarchived_by,
        },
        $unset: {
          archived_at: "",
          archived_by: "",
          archived_reason: "",
        },
        $pull: {
          patient_journey: { stage: "Discharged" },
        },
      },
      { new: true },
    );

    if (!unarchivedPatient) {
      return res.status(404).json({ message: "Patient not found in database" });
    }

    return res.status(200).json({
      message: "Patient unarchived successfully",
      unarchivedPatient,
    });
  } catch (error) {
    console.error("Error unarchiving patient:", error);
    return res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

const GetArchivedPatients = async (req, res) => {
  try {
    const Patient = getPatientModel(req.orgDb);

    // Find all patients with the "Archived" status
    const archivedPatients = await Patient.find({ status: "Archived" })
      .sort({ archived_at: -1 }) // Sorts by most recently archived
      .lean();

    // Generate SAS tokens for patient images to ensure they load correctly
    const patientsWithSas = await Promise.all(
      archivedPatients.map(async (patient) => {
        if (!patient.patient_image) return patient;
        try {
          const url = await generatepatientImageSasToken(patient.patient_image);
          return { ...patient, patient_image: url };
        } catch {
          return { ...patient, patient_image: null };
        }
      }),
    );

    return res.status(200).json({
      count: patientsWithSas.length,
      patients: patientsWithSas,
    });
  } catch (error) {
    console.error("Error fetching archived patients:", error);
    return res
      .status(500)
      .json({ message: "Internal server error", error: error.message });
  }
};

const saveRehabIntakeForm = async (req, res) => {
  try {
    const { patientId } = req.params;
    const intakeData = req.body;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid patient ID" });
    }

    const PatientModel = getPatientModel(req.orgDb);

    // Find patient and update with rehab_assessment data
    const updatedPatient = await PatientModel.findByIdAndUpdate(
      patientId,
      {
        $set: {
          rehab_assessment: {
            ...intakeData,
            submitted_at: new Date(),
          },
        },
      },
      { new: true }, // Return updated document
    );

    if (!updatedPatient) {
      return res.status(404).json({ message: "Patient not found" });
    }

    return res.status(200).json({
      message: "Rehab intake assessment saved successfully",
      rehab_assessment: updatedPatient.rehab_assessment,
    });
  } catch (error) {
    console.error("Error saving rehab intake:", error);
    res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

const getRehabIntakeForm = async (req, res) => {
  try {
    const { patientId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid patient ID" });
    }

    const PatientModel = getPatientModel(req.orgDb);

    // Fetch ONLY the rehab_assessment field for performance
    const patient = await PatientModel.findById(
      patientId,
      "rehab_assessment",
    ).lean();

    if (!patient) {
      return res.status(404).json({ message: "Patient not found" });
    }

    return res.status(200).json({
      // Return the assessment if it exists, otherwise return an empty object
      rehab_assessment: patient.rehab_assessment || {},
    });
  } catch (error) {
    console.error("Error fetching rehab intake:", error);
    res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

module.exports = {
  getPatient,
  NumberOfPatients,
  PatientSearch,
  uploadPatientDocument,
  deletePatientDocument,
  ArchivePatient,
  UnarchivePatient,
  GetArchivedPatients,
  saveRehabIntakeForm,
  getRehabIntakeForm,
  DoctorPatientSearch,
};
