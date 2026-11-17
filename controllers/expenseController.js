const { ObjectId } = require("mongoose").Types;
const multer = require("multer");
const { BlobServiceClient } = require("@azure/storage-blob");
const { v4: uuidv4 } = require("uuid");
const { getExpenseModel } = require("../db/expenseSchema"); // Adjust path as needed
const { generateImageSasToken } = require("../utils/azureutils"); // Assuming this exists based on your architecture

// --- MULTER CONFIGURATION ---
const uploadExpenseBill = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept images and PDFs for bills/receipts
    if (
      file.mimetype.startsWith("image/") ||
      file.mimetype === "application/pdf"
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only image and PDF files are allowed"), false);
    }
  },
});

// --- HELPER: UPLOAD TO AZURE ---
const uploadBillToAzure = async (file, tenantId) => {
  if (!file) return null;

  const blobServiceClient = BlobServiceClient.fromConnectionString(
    process.env.AZURE_STORAGE_CONNECTION_STRING,
  );

  const containerName = "expense-receipts";
  const containerClient = blobServiceClient.getContainerClient(containerName);

  await containerClient.createIfNotExists();

  const fileExtension = file.originalname.split(".").pop();
  const blobName = `${tenantId}/${uuidv4()}.${fileExtension}`;
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.upload(file.buffer, file.buffer.length, {
    blobHTTPHeaders: {
      blobContentType: file.mimetype,
    },
  });

  return blockBlobClient.url;
};

// --- HELPER: DELETE FROM AZURE ---
const deleteBillFromAzure = async (fileUrl) => {
  if (!fileUrl) return;

  try {
    const urlObj = new URL(fileUrl);
    const pathParts = urlObj.pathname.split("/");
    const containerName = pathParts[1];
    const blobName = pathParts.slice(2).join("/");

    const blobServiceClient = BlobServiceClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
    );
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.deleteIfExists();
  } catch (error) {
    console.error(`Failed to delete old bill from Azure: ${error.message}`);
  }
};
const {
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} = require("@azure/storage-blob");

const generateExpenseReceiptSasToken = async (fileUrl) => {
  try {
    if (!fileUrl) return null;

    const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
    const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;

    // Dynamically split the URL.
    // Example: /expense-receipts/tenantID/file.pdf
    const urlObj = new URL(fileUrl);
    const pathParts = urlObj.pathname.split("/");

    // This perfectly isolates "expense-receipts" as the container
    const containerName = pathParts[1];

    // This perfectly isolates "tenantID/file.pdf" as the blob name
    const blobName = decodeURIComponent(pathParts.slice(2).join("/"));

    if (!containerName || !blobName) return null;

    const sharedKeyCredential = new StorageSharedKeyCredential(
      accountName,
      accountKey,
    );

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

    // Attach the clean token to your original, correct receiptUrl
    return `${fileUrl}?${sasToken}`;
  } catch (error) {
    console.error("Error generating SAS token for expense receipt:", error);
    return null;
  }
};
// Add a new expense
const addExpense = async (req, res) => {
  try {
    const {
      title,
      amount,
      category,
      expenseDate,
      paymentMethod,
      status,
      notes,
      vendor_name,
      inovoiceNumber, // Keeping your schema's spelling
    } = req.body;

    // Extract user/tenant details from authenticated user
    const { doctor_first_name, doctor_last_name, _id, doctor_id, tenant_id } =
      req.user;
    const userId = _id || doctor_id;
    const userFullName = `${doctor_first_name} ${doctor_last_name}`;

    if (!title || amount === undefined || !category) {
      return res
        .status(400)
        .json({ error: "Title, amount, and category are required" });
    }

    let uploadedReceiptUrl = null;
    if (req.files && req.files.length > 0) {
      uploadedReceiptUrl = await uploadBillToAzure(req.files[0], tenant_id);
    }

    const Expense = getExpenseModel(req.orgDb);

    const newExpense = new Expense({
      title,
      amount,
      category,
      expenseDate: expenseDate ? new Date(expenseDate) : new Date(),
      paymentMethod,
      status: status || "Paid",
      vendor_name,
      inovoiceNumber,
      addedById: userId,
      addedByName: userFullName,
      notes,
      receiptUrl: uploadedReceiptUrl,
    });

    const savedExpense = await newExpense.save();

    return res.status(201).json({
      message: "Expense added successfully",
      expense: savedExpense,
    });
  } catch (error) {
    console.error("Error adding expense:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Edit an existing expense
const editExpense = async (req, res) => {
  try {
    const { expenseId } = req.params;
    const updateData = req.body;

    if (!ObjectId.isValid(expenseId)) {
      return res.status(400).json({ error: "Invalid Expense ID" });
    }

    const Expense = getExpenseModel(req.orgDb);
    const existingExpense = await Expense.findById(expenseId);

    if (!existingExpense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    // Filter out undefined fields and format dates
    const filteredUpdate = {};
    for (const key in updateData) {
      if (updateData[key] !== undefined) {
        if (key === "expenseDate") {
          filteredUpdate[key] = new Date(updateData[key]);
        } else {
          filteredUpdate[key] = updateData[key];
        }
      }
    }

    // Handle File Upload/Replacement
    if (req.files && req.files.length > 0) {
      // 1. Upload new file
      const newReceiptUrl = await uploadBillToAzure(
        req.files[0],
        req.user.tenant_id,
      );
      filteredUpdate.receiptUrl = newReceiptUrl;

      // 2. Delete old file from Azure to save space
      if (existingExpense.receiptUrl) {
        await deleteBillFromAzure(existingExpense.receiptUrl);
      }
    }

    const updatedExpense = await Expense.findByIdAndUpdate(
      expenseId,
      { $set: filteredUpdate },
      { new: true, runValidators: true },
    );

    return res.status(200).json({
      message: "Expense updated successfully",
      expense: updatedExpense,
    });
  } catch (error) {
    console.error("Error updating expense:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Get all expenses for the current organization
const getExpenses = async (req, res) => {
  try {
    // 1. Extract parameters
    const {
      status,
      category,
      timePeriod,
      startDate,
      endDate,
      page = 1,
      limit = 5,
    } = req.query;

    const Expense = getExpenseModel(req.orgDb);
    const query = {};

    if (status) query.status = status;
    if (category) query.category = category;

    // 2. Date-wise search logic based on timePeriod
    let computedStartDate = null;
    let computedEndDate = null;
    const now = new Date();

    if (timePeriod && timePeriod !== "All Time") {
      if (timePeriod === "This Month") {
        computedStartDate = new Date(now.getFullYear(), now.getMonth(), 1);
        computedEndDate = new Date(
          now.getFullYear(),
          now.getMonth() + 1,
          0,
          23,
          59,
          59,
          999,
        );
      } else if (timePeriod === "Last Month") {
        computedStartDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        computedEndDate = new Date(
          now.getFullYear(),
          now.getMonth(),
          0,
          23,
          59,
          59,
          999,
        );
      } else if (timePeriod === "This Year") {
        computedStartDate = new Date(now.getFullYear(), 0, 1);
        computedEndDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
      } else if (timePeriod === "Last Year") {
        computedStartDate = new Date(now.getFullYear() - 1, 0, 1);
        computedEndDate = new Date(
          now.getFullYear() - 1,
          11,
          31,
          23,
          59,
          59,
          999,
        );
      } else if (timePeriod === "Custom") {
        // Fall back to frontend dates if Custom is selected
        if (startDate) computedStartDate = new Date(startDate);
        if (endDate) {
          computedEndDate = new Date(endDate);
          computedEndDate.setUTCHours(23, 59, 59, 999);
        }
      }
    } else if (!timePeriod && (startDate || endDate)) {
      // Legacy support just in case timePeriod isn't passed but dates are
      if (startDate) computedStartDate = new Date(startDate);
      if (endDate) {
        computedEndDate = new Date(endDate);
        computedEndDate.setUTCHours(23, 59, 59, 999);
      }
    }

    // Apply the calculated dates to the MongoDB query
    if (computedStartDate || computedEndDate) {
      query.expenseDate = {};
      if (computedStartDate) query.expenseDate.$gte = computedStartDate;
      if (computedEndDate) query.expenseDate.$lte = computedEndDate;
    }

    // 3. Calculate Pagination variables
    const pageNumber = parseInt(page, 10);
    const pageSize = parseInt(limit, 10);
    const skip = (pageNumber - 1) * pageSize;

    // 4. Fetch data concurrently
    const [expenses, totalCount, uniqueCategories] = await Promise.all([
      // UPDATED: Sorted by createdAt descending (newest added records first)
      // If you don't have timestamps enabled in Mongoose, you can use { _id: -1 } instead.
      Expense.find(query).sort({ createdAt: -1 }).skip(skip).limit(pageSize),
      Expense.countDocuments(query),
      Expense.distinct("category"),
    ]);

    // 5. Return response
    res.status(200).json({
      data: expenses,
      meta: {
        totalItems: totalCount,
        currentPage: pageNumber,
        pageSize: pageSize,
        totalPages: Math.ceil(totalCount / pageSize),
      },
      categories: uniqueCategories.filter(Boolean),
    });
  } catch (error) {
    console.error("Error fetching expenses:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
// Get a single expense by ID
const getExpenseById = async (req, res) => {
  try {
    const { expenseId } = req.params;

    if (!ObjectId.isValid(expenseId)) {
      return res.status(400).json({ error: "Invalid Expense ID" });
    }

    const Expense = getExpenseModel(req.orgDb);
    const expense = await Expense.findById(expenseId).lean(); // Use lean() to allow injecting sasUrl easily

    if (!expense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    // Ensure users can only fetch expenses for their tenant
    if (
      expense.organizationId &&
      expense.organizationId !== req.user.tenant_id
    ) {
      return res
        .status(403)
        .json({ error: "Unauthorized access to this expense" });
    }

    // Generate SAS token if a receipt URL exists
    if (expense.receiptUrl) {
      try {
        // UPDATE THIS LINE: Use the new local helper function
        expense.receiptSasUrl = await generateExpenseReceiptSasToken(
          expense.receiptUrl,
        );
      } catch (sasError) {
        console.error(
          "Failed to generate SAS token for expense receipt:",
          sasError,
        );
        expense.receiptSasUrl = null; // Failsafe so the request doesn't crash completely
      }
    }

    res.status(200).json(expense);
  } catch (error) {
    console.error("Error fetching single expense:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// Delete (or soft delete/cancel) an expense
const cancelExpense = async (req, res) => {
  try {
    const { expenseId } = req.params;

    if (!ObjectId.isValid(expenseId)) {
      return res.status(400).json({ error: "Invalid Expense ID" });
    }

    const Expense = getExpenseModel(req.orgDb);

    const updatedExpense = await Expense.findByIdAndUpdate(
      expenseId,
      { $set: { status: "Cancelled" } },
      { new: true },
    );

    if (!updatedExpense) {
      return res.status(404).json({ error: "Expense not found" });
    }

    res.status(200).json({
      message: "Expense cancelled successfully",
      expense: updatedExpense,
    });
  } catch (error) {
    console.error("Error cancelling expense:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

module.exports = {
  uploadExpenseBill, // Export the multer middleware for your routes
  addExpense,
  editExpense,
  getExpenses,
  getExpenseById,
  cancelExpense,
};
