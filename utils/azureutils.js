const {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require("@azure/storage-blob");

const getBlobNameFromURL = (url) => {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    // Remove container name and leading slash to get blob name
    const containerName = "imagesforhealtrack";
    return pathname.replace(`/${containerName}/`, "");
  } catch (error) {
    console.error("Error parsing blob URL:", error);
    return null;
  }
};
const generatePatientDocumentSasToken = async (documentUrl) => {
  try {
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
    const containerName = "patient-documents";

    if (!documentUrl) return null;

    const blobName = getBlobNameFromPatientDocumentURL(documentUrl);
    if (!blobName) return null;

    const sharedKeyCredential = new StorageSharedKeyCredential(
      accountName,
      accountKey,
    );

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);

    // Generate SAS token that expires in 48 hours
    const startsOn = new Date();
    const expiresOn = new Date(startsOn);
    expiresOn.setHours(startsOn.getHours() + 48);

    const sasOptions = {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse("r"), // Read-only permission
      startsOn,
      expiresOn,
    };

    const sasToken = generateBlobSASQueryParameters(
      sasOptions,
      sharedKeyCredential,
    ).toString();

    return `${blobClient.url}?${sasToken}`;
  } catch (error) {
    console.error("Error generating SAS token for patient document:", error);
    return null;
  }
};

// Helper function to extract blob name from URL for patient documents
const getBlobNameFromPatientDocumentURL = (url) => {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const containerName = "patient-documents";
    return pathname.replace(`/${containerName}/`, "");
  } catch (error) {
    console.error("Error parsing patient document blob URL:", error);
    return null;
  }
};
// Function to generate SAS token for a single image
const generateImageSasToken = async (imageUrl) => {
  try {
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
    const containerName = "imagesforhealtrack";

    if (!imageUrl) return null;

    const blobName = getBlobNameFromURL(imageUrl);
    if (!blobName) return null;

    const sharedKeyCredential = new StorageSharedKeyCredential(
      accountName,
      accountKey,
    );

    // Generate SAS token that expires in 48 hours
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

    // 👇 OPTIMIZATION: Construct the URL directly instead of using BlobServiceClient
    const baseUrl = `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}`;

    return `${baseUrl}?${sasToken}`;
  } catch (error) {
    console.error("Error generating SAS token:", error);
    return null;
  }
};
const getBlobNameFromURL1 = (url) => {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;

    // Remove the leading slash and container name
    const parts = pathname.split("/").filter(Boolean); // Split by "/" and remove empty strings
    if (parts.length < 2) {
      console.error("Invalid URL structure:", url);
      return null;
    }

    // The blob name is everything after the container name
    const blobName = parts.slice(1).join("/"); // Join all parts after the container name
    return blobName;
  } catch (error) {
    console.error("Error parsing blob URL:", error);
    return null;
  }
};
const generatePatientConsentSasToken = async (documentUrl) => {
  try {
    if (!documentUrl) return null;

    // Use your existing shared helper to dynamically get container and blob names
    const blobDetails = getBlobDetailsFromURL(documentUrl);
    if (!blobDetails) return null;

    const { containerName, blobName } = blobDetails;

    // Initialize credentials like in your other functions
    const sharedKeyCredential = new StorageSharedKeyCredential(
      process.env.AZURE_STORAGE_ACCOUNT_NAME,
      process.env.AZURE_STORAGE_ACCOUNT_KEY,
    );

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const sasContainerClient =
      blobServiceClient.getContainerClient(containerName);
    const blobClient = sasContainerClient.getBlobClient(blobName);

    // Generate SAS token that expires in 48 hours (matching your other utils)
    const startsOn = new Date();
    const expiresOn = new Date(startsOn);
    expiresOn.setHours(startsOn.getHours() + 48);

    const sasOptions = {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse("r"), // Read-only
      startsOn,
      expiresOn,
    };

    const sasToken = generateBlobSASQueryParameters(
      sasOptions,
      sharedKeyCredential,
    ).toString();

    return `${blobClient.url}?${sasToken}`;
  } catch (error) {
    console.error("Error generating SAS token for consent document:", error);
    // Fallback: return the original URL if token generation fails
    return documentUrl;
  }
};
const generateImageSasTokenLogo = async (imageUrl) => {
  try {
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
    const containerName = "organizationlogos";

    if (!imageUrl) {
      console.error("Image URL is missing");
      return null;
    }

    const blobName = getBlobNameFromURL1(imageUrl);
    if (!blobName) {
      console.error("Failed to extract blob name from URL");
      return null;
    }

    const sharedKeyCredential = new StorageSharedKeyCredential(
      accountName,
      accountKey,
    );

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blobClient = containerClient.getBlobClient(blobName);

    // Check if the blob exists
    const exists = await blobClient.exists();
    if (!exists) {
      console.error("Blob does not exist:", blobName);
      return null;
    }

    // Generate SAS token that expires in 24 hours (1 day)
    const startsOn = new Date();
    const expiresOn = new Date(startsOn);
    expiresOn.setHours(startsOn.getHours() + 48); // Changed from +2 to +24 hours

    const sasOptions = {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse("r"), // Read-only permission
      startsOn,
      expiresOn,
    };

    const sasToken = generateBlobSASQueryParameters(
      sasOptions,
      sharedKeyCredential,
    ).toString();

    return `${blobClient.url}?${sasToken}`;
  } catch (error) {
    console.error("Error generating SAS token:", error);
    return null;
  }
};
// Function to process multiple doctors and generate SAS tokens for their images
const processMultipleDoctorsImages = async (doctors) => {
  try {
    if (!Array.isArray(doctors)) {
      return [];
    }

    const processedDoctors = await Promise.all(
      doctors.map(async (doctor) => {
        const sasUrl = doctor.doctors_photo
          ? await generateImageSasToken(doctor.doctors_photo)
          : null;

        return {
          ...doctor,
          doctors_photo: sasUrl,
        };
      }),
    );

    return processedDoctors;
  } catch (error) {
    console.error("Error processing multiple doctors:", error);
    return doctors; // Return original array if processing fails
  }
};
function getSessionBlobNameFromUrl(
  fullUrl,
  containerName = "therapy-session-images",
) {
  try {
    const { pathname } = new URL(fullUrl);
    const prefix = `/${containerName}/`;
    const idx = pathname.indexOf(prefix);
    if (idx < 0) {
      console.error(
        `Container name "${containerName}" not found in URL:`,
        fullUrl,
      );
      return null;
    }
    // remove the leading "/containerName/"
    return pathname.slice(idx + prefix.length);
  } catch (err) {
    console.error("Error parsing session image URL:", err, fullUrl);
    return null;
  }
}

async function generateSessionImageSasToken(rawUrl, expiresInHours = 48) {
  if (!rawUrl) return null;

  // 1) Normalize to full URL if needed
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const containerName = "therapy-session-images";
  const fullUrl = rawUrl.startsWith("http")
    ? rawUrl
    : `https://${accountName}.blob.core.windows.net${rawUrl}`;

  // 2) Get blobName (everything after "/containerName/")
  const blobName = getSessionBlobNameFromUrl(fullUrl, containerName);
  if (!blobName) return null;

  // 3) Create credentials & build SAS parameters
  const sharedKey = new StorageSharedKeyCredential(
    accountName,
    process.env.AZURE_STORAGE_ACCOUNT_KEY,
  );

  const startsOn = new Date();
  const expiresOn = new Date(startsOn.getTime() + expiresInHours * 3600 * 1000);

  const sasOptions = {
    containerName,
    blobName,
    permissions: BlobSASPermissions.parse("r"),
    startsOn,
    expiresOn,
  };

  const sasToken = generateBlobSASQueryParameters(
    sasOptions,
    sharedKey,
  ).toString();

  // 4) Return the full URL with SAS
  return `${fullUrl}?${sasToken}`;
}

const uploadImageToAzure = async (fileBuffer, originalName, mimeType) => {
  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );
    const containerClient = blobServiceClient.getContainerClient(
      process.env.AZURE_STORAGE_ACCOUNT_NAME,
    );

    // Create a unique filename
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

// 2. Shared SAS Extractor
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

// 3. Shared SAS Token Generator
const generatepatientImageSasToken = async (imageUrl) => {
  try {
    if (!imageUrl) return null;

    const blobDetails = getBlobDetailsFromURL(imageUrl);
    if (!blobDetails) return null;

    const { containerName, blobName } = blobDetails;

    // Creating credentials does not make a network request
    const sharedKeyCredential = new StorageSharedKeyCredential(
      process.env.AZURE_STORAGE_ACCOUNT_NAME,
      process.env.AZURE_STORAGE_ACCOUNT_KEY,
    );

    // Generating the token locally in memory
    const startsOn = new Date();
    const expiresOn = new Date(startsOn);
    expiresOn.setHours(startsOn.getHours() + 48); // 48-hour expiration

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

    // Construct the URL directly without fetching from the blobClient
    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    const baseUrl = `https://${accountName}.blob.core.windows.net/${containerName}/${blobName}`;

    return `${baseUrl}?${sasToken}`;
  } catch (error) {
    console.error("Error generating image SAS token:", error);
    return null;
  }
};

const deleteBlobFromAzure = async (imageUrl) => {
  if (!imageUrl) return false;

  try {
    const blobDetails = getBlobDetailsFromURL(imageUrl);
    if (!blobDetails) return false;

    const { containerName, blobName } = blobDetails;

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );

    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.deleteIfExists();
    return true;
  } catch (error) {
    console.error("Failed to delete blob from Azure:", error);
    return false;
  }
};

module.exports = {
  generateImageSasToken,
  processMultipleDoctorsImages,
  generateImageSasTokenLogo,
  generatePatientDocumentSasToken,
  getBlobNameFromPatientDocumentURL,
  generateSessionImageSasToken,
  uploadImageToAzure,
  generatePatientConsentSasToken,
  generatepatientImageSasToken,
  deleteBlobFromAzure,
};
