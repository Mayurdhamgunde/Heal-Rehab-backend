/**
 * Replaces uploadPatientDocument (which buffered the whole file in server RAM
 * via multer, then re-uploaded it to Azure) with a direct client -> Azure flow.
 *
 * Flow:
 *   1. requestPatientDocumentUploadUrl  -> issues a short-lived write SAS
 *   2. client PUTs the file straight to Azure (see documentUploadClient.ts)
 *   3. confirmPatientDocumentUpload     -> verifies + saves metadata on the patient
 *
 * Your server never holds the file's bytes at any point. This is what fixes
 * the problem with 10MB+ documents — right now those bytes get buffered into
 * a Node Buffer, held for the duration of the Azure upload, then GC'd, once
 * per concurrent upload. That disappears entirely.
 */

const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  SASProtocol,
} = require("@azure/storage-blob");
const { getPatientModel } = require("../db/patientSchema");
const { generatePatientDocumentSasToken } = require("../utils/azureutils");

const CONTAINER_NAME = "patient-documents";
const MAX_FILE_BYTES = 50 * 1024 * 1024; // matches the old multer limit
const EXTENSION_RE = /^[a-zA-Z0-9]{1,5}$/;

const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
const sharedKeyCredential = new StorageSharedKeyCredential(
  accountName,
  accountKey,
);

function issueUploadSas(blobName, expiryMinutes = 20) {
  // 20 min (not 15) because large files on slow connections need the window
  // to still be valid when the PUT actually finishes, not just when it starts.
  const startsOn = new Date(Date.now() - 5 * 60 * 1000); // clock-skew buffer
  const expiresOn = new Date(Date.now() + expiryMinutes * 60 * 1000);

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName: CONTAINER_NAME,
      blobName,
      permissions: BlobSASPermissions.parse("cw"), // create + write ONLY
      startsOn,
      expiresOn,
      protocol: SASProtocol.Https,
    },
    sharedKeyCredential,
  ).toString();

  const blobUrl = `https://${accountName}.blob.core.windows.net/${CONTAINER_NAME}/${blobName}`;
  return { uploadUrl: `${blobUrl}?${sasToken}`, blobUrl };
}

/**
 * POST /upload-document/url/:patientId
 * body: { fileExtension }
 * -> { uploadUrl, blobUrl, blobName }
 */
const requestPatientDocumentUploadUrl = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { fileExtension } = req.body;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid patient ID" });
    }
    if (!fileExtension || !EXTENSION_RE.test(fileExtension)) {
      return res.status(400).json({ error: "Invalid file extension" });
    }

    const PatientModel = getPatientModel(req.orgDb);
    const patient = await PatientModel.findById(patientId, "_id").lean();
    if (!patient) {
      return res.status(404).json({ msg: "Patient not found" });
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );
    const containerClient =
      blobServiceClient.getContainerClient(CONTAINER_NAME);
    await containerClient.createIfNotExists();

    const blobName = `${patientId}-${uuidv4()}.${fileExtension}`;
    const { uploadUrl, blobUrl } = issueUploadSas(blobName);

    res.status(200).json({ uploadUrl, blobUrl, blobName });
  } catch (err) {
    console.error("Error issuing document upload URL:", err);
    res.status(500).json({ error: "Error issuing upload URL" });
  }
};

/**
 * POST /upload-document/confirm/:patientId
 * body: { blobName, blobUrl, document_name, document_type, file_size, file_extension }
 */
const confirmPatientDocumentUpload = async (req, res) => {
  try {
    const { patientId } = req.params;
    const {
      blobName,
      blobUrl,
      document_name,
      document_type,
      file_size,
      file_extension,
    } = req.body;

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ error: "Invalid patient ID" });
    }
    if (!blobName || !blobUrl) {
      return res
        .status(400)
        .json({ error: "blobName and blobUrl are required" });
    }
    // The blob name is always prefixed with the patientId by requestPatientDocumentUploadUrl —
    // this rejects a confirm call for a blob that wasn't issued to this patient.
    if (!blobName.startsWith(`${patientId}-`)) {
      return res
        .status(403)
        .json({ error: "Blob does not belong to this patient" });
    }
    if (!document_name) {
      return res.status(400).json({ error: "Document name is required" });
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );
    const containerClient =
      blobServiceClient.getContainerClient(CONTAINER_NAME);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    // Confirm the file actually landed, and enforce the size cap server-side —
    // a SAS PUT doesn't cap size on its own.
    const exists = await blockBlobClient.exists();
    if (!exists) {
      return res
        .status(400)
        .json({ error: "Upload not found — it may have failed" });
    }
    const props = await blockBlobClient.getProperties();
    if (props.contentLength > MAX_FILE_BYTES) {
      await blockBlobClient.delete();
      return res.status(400).json({ error: "File exceeds the 50MB limit" });
    }

    // Same Cool tier the old code set at upload time.
    await blockBlobClient.setAccessTier("Cool");

    const PatientModel = getPatientModel(req.orgDb);
    const patient = await PatientModel.findById(patientId);
    if (!patient) {
      return res.status(404).json({ msg: "Patient not found" });
    }

    const uploadedBy = `${req.doctor_first_name} ${req.doctor_last_name}`;
    const newDocument = {
      document_name,
      document_url: blobUrl,
      document_upload_date: new Date(),
      document_type: document_type || "Other",
      uploaded_by: uploadedBy,
      file_size: file_size ?? props.contentLength,
      file_extension: file_extension || blobName.split(".").pop(),
    };

    patient.documents.push(newDocument);
    await patient.save();

    const documentUrlWithSas = await generatePatientDocumentSasToken(blobUrl);

    res.status(200).json({
      msg: "Document uploaded successfully",
      document: { ...newDocument, document_url: documentUrlWithSas },
    });
  } catch (err) {
    console.error("Error confirming document upload:", err);
    res.status(500).json({ error: "Error confirming document upload" });
  }
};

module.exports = {
  requestPatientDocumentUploadUrl,
  confirmPatientDocumentUpload,
};
