const { getPatientModel } = require("../db/patientSchema");
const mongoose = require("mongoose");
const Organization = require("../db/OrganizationSchema");
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  BlobSASPermissions,
  generateBlobSASQueryParameters,
} = require("@azure/storage-blob");
require("dotenv").config();

const {
  generatepatientImageSasToken,
  generateImageSasTokenLogo,
} = require("../utils/azureutils");

const blobServiceClient = BlobServiceClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING,
);
const containerClient = blobServiceClient.getContainerClient(
  process.env.AZURE_STORAGE_ACCOUNT_NAME,
);

// Helper to get BOTH the container and the blob name from the URL
const getBlobDetailsFromURL = (url) => {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split("/").filter(Boolean);

    if (pathParts.length < 2) return null;

    return {
      containerName: pathParts[0],
      blobName: pathParts.slice(1).join("/"),
    };
  } catch (e) {
    return null;
  }
};

const generateConsentImageSasToken = async (imageUrl) => {
  try {
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;

    if (!imageUrl) return null;

    const blobDetails = getBlobDetailsFromURL(imageUrl);
    if (!blobDetails) {
      console.error("Failed to extract blob details from URL:", imageUrl);
      return null;
    }

    const { containerName, blobName } = blobDetails;

    const sharedKeyCredential = new StorageSharedKeyCredential(
      accountName,
      accountKey,
    );

    const sasContainerClient =
      blobServiceClient.getContainerClient(containerName);
    const blobClient = sasContainerClient.getBlobClient(blobName);

    const exists = await blobClient.exists();
    if (!exists) {
      console.error(
        `Blob does not exist: Container [${containerName}], Blob [${blobName}]`,
      );
      return null;
    }

    const startsOn = new Date();
    const expiresOn = new Date(startsOn);
    expiresOn.setHours(startsOn.getHours() + 48);

    const sasOptions = {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse("r"),
      startsOn,
      expiresOn,
    };

    const sasToken = generateBlobSASQueryParameters(
      sasOptions,
      sharedKeyCredential,
    ).toString();

    return `${blobClient.url}?${sasToken}`;
  } catch (error) {
    console.error("Error generating SAS token for consent image:", error);
    return null;
  }
};

const uploadImageToAzure = async (fileBuffer, originalName, mimeType) => {
  try {
    const uniqueName = `${Date.now()}-${originalName.replace(/\s+/g, "-")}`;
    const blockBlobClient = containerClient.getBlockBlobClient(uniqueName);

    await blockBlobClient.uploadData(fileBuffer, {
      blobHTTPHeaders: { blobContentType: mimeType },
    });

    return blockBlobClient.url;
  } catch (error) {
    console.error("Azure upload error:", error);
    throw new Error("Failed to upload image to Azure");
  }
};

// 1. Initial Creation (Saves data + witness/guardian photo directly to Patient)
const createConsentForm = async (req, res) => {
  try {
    const { patientId } = req.params;
    const data = req.body;

    const files = req.files || {};
    let witnessPhotoUrl = null;

    // Look for guardian_photo (or fallback to witness_photo just in case)
    const uploadedGuardianPhoto = files.guardian_photo
      ? files.guardian_photo[0]
      : files.witness_photo
        ? files.witness_photo[0]
        : null;

    // Upload Guardian/Witness Photo to Azure
    if (uploadedGuardianPhoto) {
      witnessPhotoUrl = await uploadImageToAzure(
        uploadedGuardianPhoto.buffer,
        uploadedGuardianPhoto.originalname,
        uploadedGuardianPhoto.mimetype,
      );
    }

    const Patient = getPatientModel(req.orgDb);

    // Build the update object based on the new single-schema structure
    const updatePayload = {
      $set: {
        "consent_details.is_agreed":
          data.is_agreed === "true" || data.is_agreed === true,
        "consent_details.consent_date": data.consent_date || new Date(),
        "consent_details.form_type": data.form_type || "High Risk Consent",
        // Root level patient schema fields for witness
        witness_name: data.guardian_name || data.witness_name,
        witness_relationship:
          data.guardian_relationship || data.witness_relationship,
      },
    };

    if (witnessPhotoUrl) {
      updatePayload.$set["witness_photo_url"] = witnessPhotoUrl;
    }

    const updatedPatient = await Patient.findByIdAndUpdate(
      patientId,
      updatePayload,
      { new: true },
    );

    if (!updatedPatient) {
      return res
        .status(404)
        .json({ success: false, message: "Patient not found" });
    }

    return res.status(201).json({ success: true, patient: updatedPatient });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// 2. Later Step: Uploading the physically signed scan and attaching to patient history
const uploadSignedDocument = async (req, res) => {
  try {
    const { patientId } = req.params; // Changed from consentId to patientId

    if (!req.file) {
      return res.status(400).json({ message: "No document file provided" });
    }

    const documentUrl = await uploadImageToAzure(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
    );

    const Patient = getPatientModel(req.orgDb);

    // Create the consent history entry
    const consentEntry = {
      document_url: documentUrl,
      uploaded_at: new Date(),
      uploaded_by_id: req.doctor_id,
      uploaded_by_name: `${req.user.doctor_first_name} ${req.user.doctor_last_name}`,
      notes: req.body.notes || "Signed document attached",
    };

    const updatedPatient = await Patient.findByIdAndUpdate(
      patientId,
      { $push: { consent_history: consentEntry } },
      { new: true },
    );

    if (!updatedPatient) {
      return res.status(404).json({ message: "Patient not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Signed document attached successfully",
      consent_history: updatedPatient.consent_history,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// 3. Print Generation: Pulls all needed data straight from Patient Model
const printConsentForm = async (req, res) => {
  try {
    const { patientId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid Patient ID" });
    }

    const Patient = getPatientModel(req.orgDb);

    const [patient, organization] = await Promise.all([
      Patient.findById(patientId).lean(),
      Organization.findOne({ tenant_id: req.user.tenant_id }).lean(),
    ]);

    if (!patient) {
      return res.status(404).json({ error: "Patient record not found" });
    }

    if (organization?.organization_logo) {
      organization.organization_logo = await generateImageSasTokenLogo(
        organization.organization_logo,
      );
    }

    let patientPhotoUrl = patient.patient_image || "";
    let witnessPhotoUrl = patient.witness_photo_url || "";

    if (patientPhotoUrl) {
      patientPhotoUrl = await generatepatientImageSasToken(patientPhotoUrl);
    }
    if (witnessPhotoUrl) {
      witnessPhotoUrl = await generateConsentImageSasToken(witnessPhotoUrl);
    }

    let referredBy = patient.referral_source || "";
    if (referredBy === "Other" && patient.referral_details) {
      referredBy = patient.referral_details;
    } else if (patient.referral_details) {
      referredBy = `${referredBy} - ${patient.referral_details}`;
    }

    const addressLine =
      patient.patient_address1 || patient.address?.street || "";
    const cityOrTaluka = patient.address?.city || "";
    const districtOrState = patient.address?.state || "";

    let fullAddress = addressLine;
    if (cityOrTaluka) {
      fullAddress += fullAddress ? `, ${cityOrTaluka}` : cityOrTaluka;
    }
    const organizationHead = organization?.organization_heads?.[0] || {};
    const printData = {
      consent: {
        reg_no: patient.UHID || "",
        date: patient.consent_details?.consent_date || new Date(),
        form_type: patient.consent_details?.form_type || "High Risk Consent",
        witness_name: patient.witness_name || "",
        witness_relationship: patient.witness_relationship || "",
        photos: {
          patient_photo: patientPhotoUrl,
          witness_photo: witnessPhotoUrl,
        },
      },
      patient: {
        _id: patient._id,
        name: [
          patient.patient_first_name,
          patient.patient_middle_name,
          patient.patient_last_name,
        ]
          .filter((namePart) => namePart && namePart.trim() !== "")
          .join(" "),
        age: patient.patient_age || "",
        gender: patient.gender || "",
        dob: patient.date_of_birth || "",
        mobile: patient.patient_phone || patient.patient_alternate_number || "",
        email: patient.patient_email || "",
        address_full: fullAddress,
        marital_status: patient.marital_status || "",
        guardian_phone:
          patient.guardian_phone || patient.guardian_contact || "",
        guardian_relation: patient.guardian_relation || "",
        guardian_phone_2:
          patient.guardian_phone_2 || patient.guardian_alternate_contact || "",
        guardian_relation_2: patient.guardian_relation_2 || "",
        address_breakdown: {
          address: addressLine,
          ap: patient.patient_address2 || "",
          tq: cityOrTaluka,
          dist: districtOrState,
          zip: patient.address?.zip || "",
        },
        referred_by: referredBy,
        identity_card: {
          type: patient.identity_card?.type || "",
          number: patient.identity_card?.number || "",
        },
        education: patient.education || "",
        caste: patient.caste || "",
        occupation: patient.occupation || "",
        annual_income: patient.annual_income || "",
        treatment_days: patient.treatment_days || "", // <--- ADDED HERE
        prior_treatment: patient.prior_treatment || "",
      },
      organization: {
        name: organization?.organization_name || "Institute Name",
        address: organization?.organization_address || {},
        logo: organization?.organization_logo || "",
        phone: organization?.organization_phone,
        email: organization?.organization_email,
        head: {
          name: organizationHead.name || "",
          degree: organizationHead.degree || "",
          reg_no: organizationHead.reg_no || "",
        },
      },
      doctor: {
        name: `${req.user.doctor_first_name} ${req.user.doctor_last_name}`,
      },
    };

    res.status(200).json(printData);
  } catch (error) {
    console.error("Get Consent Print Data Error:", error);
    res.status(500).json({
      message: "Error fetching consent print data",
      error: error.message,
    });
  }
};

module.exports = { createConsentForm, uploadSignedDocument, printConsentForm };
