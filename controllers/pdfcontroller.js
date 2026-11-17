const { MongoClient } = require("mongodb");
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const Organization = require("../db/OrganizationSchema");

// Import the SAS token generator function
const { generateImageSasTokenLogo } = require("../utils/azureutils"); // Adjust path as needed
// Add this helper function at the top of your file, after the imports
const generateInvoiceNumber = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");

  // Format: INV-YYYY-MM-DD-HHMMSS
  return `INV-${year}-${month}-${day}-${hours}${minutes}${seconds}`;
};

const generateTherapyPlanPDF = async (req, res) => {
  let dbClient;
  try {
    const { id } = req.params;

    // Validate planId format
    if (!ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ message: "Invalid therapy plan ID format" });
    }

    // Find the therapy plan
    const therapyPlan = await req.orgDb
      .collection("plans")
      .findOne({ _id: new ObjectId(id) });
    if (!therapyPlan) {
      return res.status(404).json({ message: "Therapy plan not found" });
    }

    // Find the patient who owns this plan
    const patient = await req.orgDb.collection("patients").findOne(
      { therapy_plans: new ObjectId(id) },
      {
        projection: {
          patient_first_name: 1,
          patient_last_name: 1,
          patient_email: 1,
          patient_phone: 1,
          patient_address: 1,
          date_of_birth: 1,
        },
      }
    );
    if (!patient) {
      return res
        .status(404)
        .json({ message: "Patient not found for this therapy plan" });
    }

    // Get organization details for the header
    const organization = await Organization.findOne({
      tenant_id: req.user.tenant_id,
    });
    if (!organization) {
      return res.status(404).json({ message: "Organization not found" });
    }
    const invoiceNumber = generateInvoiceNumber();
    // Generate SAS token for logo if it exists
    if (organization.organization_logo) {
      organization.organization_logo = await generateImageSasTokenLogo(
        organization.organization_logo
      );
    }

    // Get therapy sessions info
    let therapySessions = [];
    if (
      therapyPlan.therapy_sessions &&
      Array.isArray(therapyPlan.therapy_sessions) &&
      therapyPlan.therapy_sessions.length > 0
    ) {
      const sessionIds = therapyPlan.therapy_sessions.map((session) =>
        session._id instanceof ObjectId
          ? session._id
          : new ObjectId(session._id.$oid || session._id)
      );

      therapySessions = await req.orgDb
        .collection("therepys")
        .find({ _id: { $in: sessionIds } })
        .toArray();
    }

    // Create a new PDF document
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
      autoFirstPage: true,
      bufferPages: true, // Important for page numbering
      info: {
        Title: `Therapy Plan for ${patient.patient_first_name} ${patient.patient_last_name}`,
        Author: organization.organization_name,
        Subject: "Therapy Plan Report",
        Keywords: "therapy, medical, plan, report",
        Creator: "HealTrack",
      },
    });

    // Capture PDF data in buffers
    const buffers = [];
    doc.on("data", (chunk) => {
      buffers.push(chunk);
    });

    // On PDF generation end, convert to base64 and return JSON
    doc.on("end", () => {
      if (buffers.length === 0) {
        console.error("No PDF data was captured");
        return res.status(500).json({ message: "No PDF data generated" });
      }
      const pdfData = Buffer.concat(buffers);
      const base64PDF = pdfData.toString("base64");
      return res.json({ pdf: base64PDF });
    });

    // Define some colors and styles
    const primaryColor = "#007B8E"; // Updated company color
    const secondaryColor = "#6b7280";
    const headerBgColor = "#f3f4f6";

    // Store the starting y position for use in the footer function
    let contentStartY;

    // --- Build PDF Content ---
    // Add header with logo and organization info
    await addHeader(doc, organization, primaryColor);
    contentStartY = doc.y;

    // Add title
    doc.moveDown(1);
    doc
      .fontSize(20) // Slightly larger font
      .font("Helvetica-Bold")
      .fillColor(primaryColor)
      .text("THERAPY PLAN REPORT", {
        align: "center",
        width: doc.page.width - 330, // Ensure full width usage
      });
    doc.moveDown(1.5);
    doc
      .fontSize(12)
      .font("Helvetica-Bold")
      .fillColor(primaryColor)
      .text(`Invoice Number: ${invoiceNumber}`, 50, doc.y, {
        align: "right",
        width: doc.page.width - 100,
      });

    doc
      .fontSize(10)
      .font("Helvetica")
      .fillColor("#666666")
      .text(`Generated on: ${new Date().toLocaleString()}`, 50, doc.y + 5, {
        align: "right",
        width: doc.page.width - 100,
      });

    doc.moveDown(1.5);
    // Patient Information Section
    addSectionHeading(doc, "Patient Information", primaryColor);

    const patientInfo = [
      ["Name", `${patient.patient_first_name} ${patient.patient_last_name}`],
    ];

    if (patient.date_of_birth) {
      patientInfo.push([
        "Date of Birth",
        `${new Date(patient.date_of_birth).toLocaleDateString()}`,
      ]);
    }

    if (patient.patient_email) {
      patientInfo.push(["Email", patient.patient_email]);
    }

    if (patient.patient_phone) {
      patientInfo.push(["Phone", patient.patient_phone]);
    }

    if (patient.patient_address) {
      patientInfo.push(["Address", patient.patient_address]);
    }

    createTable(doc, patientInfo, headerBgColor, primaryColor);
    doc.moveDown(1);

    // Therapy Plan Details Section
    addSectionHeading(doc, "Therapy Plan Details", primaryColor);

    const therapyDetails = [
      ["Therapy", therapyPlan.therapy_name],
      ["Diagnosis", therapyPlan.patient_diagnosis],
      ["Symptoms", therapyPlan.patient_symptoms],
      ["Category", therapyPlan.patient_therapy_category],
      ["Duration", therapyPlan.therapy_duration],
      ["Start Date", new Date(therapyPlan.therapy_start).toLocaleDateString()],
      ["End Date", new Date(therapyPlan.therapy_end).toLocaleDateString()],
    ];

    createTable(doc, therapyDetails, headerBgColor, primaryColor);
    doc.moveDown(1);

    // Payment Information Section
    addSectionHeading(doc, "Payment Information", primaryColor);

    const paymentInfo = [
      ["Total Amount", "Rs." + therapyPlan.total_amount],
      ["Amount Received", "Rs." + therapyPlan.received_amount],
      ["Balance", "Rs." + therapyPlan.balance],
      ["Payment Type", therapyPlan.payment_type],
    ];

    if (therapyPlan.per_session_amount) {
      paymentInfo.push([
        "Per Session Amount",
        "Rs." + therapyPlan.per_session_amount,
      ]);
    }

    if (therapyPlan.estimated_sessions) {
      paymentInfo.push(["Estimated Sessions", therapyPlan.estimated_sessions]);
    }

    if (therapyPlan.completed_sessions !== undefined) {
      paymentInfo.push(["Completed Sessions", therapyPlan.completed_sessions]);
    }

    if (therapyPlan.remaining_sessions !== undefined) {
      paymentInfo.push(["Remaining Sessions", therapyPlan.remaining_sessions]);
    }

    createTable(doc, paymentInfo, headerBgColor, primaryColor);
    doc.moveDown(1);
    addDiscountInfoBox(doc, therapyPlan, headerBgColor, primaryColor);
    // Therapy Sessions Section (if available)
    if (therapySessions.length > 0) {
      addSectionHeading(doc, "Sessions", primaryColor);

      const sessionHeaders = ["Date", "Time", "Type", "Status"];
      const sessionRows = therapySessions.map((session) => {
        const status = session.status || "Scheduled";
        const sessionDate = new Date(session.therepy_date).toLocaleDateString();
        const sessionTime = `${session.therepy_start_time} - ${session.therepy_end_time}`;
        return [sessionDate, sessionTime, session.therepy_type, status];
      });

      createTableWithHeaders(
        doc,
        sessionHeaders,
        sessionRows,
        headerBgColor,
        primaryColor
      );
      doc.moveDown(1);
    }

    // Payment History Section (if available)
    if (therapyPlan.payment_history && therapyPlan.payment_history.length > 0) {
      addSectionHeading(doc, "Payment History", primaryColor);

      const paymentHeaders = ["Payment #", "Date", "Amount", "Type"];
      const paymentRows = therapyPlan.payment_history.map((payment) => {
        const paymentDate = new Date(payment.date).toLocaleDateString();
        return [
          payment.payment_number || "-",
          paymentDate,
          "Rs." + payment.amount,
          payment.type,
        ];
      });

      createTableWithHeaders(
        doc,
        paymentHeaders,
        paymentRows,
        headerBgColor,
        primaryColor
      );
      doc.moveDown(1);
    }
    addTreatmentGuidelines(doc, therapyPlan, primaryColor);
    // Doctor Signature Section - UPDATED VERSION
    doc.moveDown(1.5); // Add space before the signature section

    // Set common styles
    doc.fontSize(10).font("Helvetica").fillColor("#000000");

    const rightMargin = doc.page.width - 50; // 50 is the right margin
    const signatureWidth = 200; // Width for signature area
    const signatureX = rightMargin - signatureWidth;

    // Add "Prepared by" text on a single line
    doc.text(
      `Prepared by: ${req.user.doctor_first_name} ${req.user.doctor_last_name}`,
      signatureX,
      doc.y,
      {
        width: signatureWidth,
        align: "right",
        lineBreak: false, // Ensure name stays in one line
      }
    );

    // Add date with reduced spacing (8 pixels instead of 15)
    doc.text(
      `Date: ${new Date().toLocaleDateString()}`,
      signatureX,
      doc.y + 8,
      {
        width: signatureWidth,
        align: "right",
        lineBreak: false,
      }
    );

    // Add signature line with adjusted spacing
    const lineY = doc.y + 15; // Reduced spacing before line
    doc.moveTo(signatureX, lineY).lineTo(rightMargin, lineY).stroke();

    // Add "Doctor Signature" text centered under the line
    doc.text("Doctor Signature", signatureX, lineY + 5, {
      align: "center",
      width: signatureWidth,
    });

    // Update doc.y for subsequent content
    doc.y = lineY + 25;

    // Add page numbers to all pages
    const pageCount = doc.bufferedPageCount;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      // Add footer with page numbers
      addFooter(doc, organization, i + 1, pageCount, contentStartY);
    }

    // Finalize the PDF
    doc.end();
  } catch (error) {
    console.error("Error generating therapy plan PDF:", error);
    return res
      .status(500)
      .json({ message: "Error generating PDF", error: error.message });
  } finally {
    if (dbClient) await dbClient.close();
  }
};

// Helper function to add header with logo
async function addHeader(doc, organization, primaryColor) {
  try {
    const leftMargin = 50; // Left margin
    const logoHeight = 80;
    const logoWidth = 100;

    // Initialize y position
    let currentY = 40;

    // Add logo if available
    if (organization.organization_logo) {
      try {
        // Download the logo with SAS token
        const response = await axios.get(organization.organization_logo, {
          responseType: "arraybuffer",
        });
        const logoBuffer = Buffer.from(response.data);

        // Add logo to PDF (on the left)
        doc.image(logoBuffer, leftMargin, currentY, {
          fit: [logoWidth, logoHeight],
          align: "left",
        });

        // Move text position to be right of the logo
        const textX = leftMargin + logoWidth + 10;

        // Add organization name to the right of logo
        doc
          .fontSize(16)
          .font("Helvetica-Bold")
          .fillColor(primaryColor)
          .text(organization.organization_name, textX, currentY, {
            align: "left",
            width: doc.page.width - textX - 50,
          });

        currentY += 25; // Move down after org name

        // Organization contact info - aligned with the right of logo
        doc.fontSize(10).font("Helvetica").fillColor("#666666");

        // Handle address properly
        let addressText = "";
        if (organization.organization_address) {
          if (typeof organization.organization_address === "object") {
            const address = organization.organization_address;
            const addressParts = [];

            if (address.city) addressParts.push(address.city);
            if (address.state) addressParts.push(address.state);
            if (address.country) addressParts.push(address.country);

            addressText = addressParts.join(", ");
          } else if (typeof organization.organization_address === "string") {
            addressText = organization.organization_address;
          }
        }

        if (addressText) {
          doc.text(addressText, textX, currentY, {
            align: "left",
            width: doc.page.width - textX - 50,
          });
          currentY += 15;
        }

        if (organization.organization_phone) {
          doc.text(
            `Phone: ${organization.organization_phone}`,
            textX,
            currentY,
            {
              align: "left",
              width: doc.page.width - textX - 50,
            }
          );
          currentY += 15;
        }

        if (organization.organization_email) {
          doc.text(
            `Email: ${organization.organization_email}`,
            textX,
            currentY,
            {
              align: "left",
              width: doc.page.width - textX - 50,
            }
          );
          currentY += 15;
        }

        // Make sure we have enough space below the logo
        currentY = Math.max(currentY, 40 + logoHeight + 10);
      } catch (logoError) {
        console.error("Error adding logo:", logoError);
        // If logo fails, show organization name more prominently
        doc
          .fontSize(16)
          .font("Helvetica-Bold")
          .fillColor(primaryColor)
          .text(organization.organization_name, leftMargin, currentY, {
            align: "left",
            width: doc.page.width - 100,
          });

        currentY += 25;

        // Add contact info with left alignment
        addContactInfo(doc, organization, leftMargin, currentY);
        currentY = doc.y + 10;
      }
    } else {
      // No logo, just show organization name more prominently
      doc
        .fontSize(16)
        .font("Helvetica-Bold")
        .fillColor(primaryColor)
        .text(organization.organization_name, leftMargin, currentY, {
          align: "left",
          width: doc.page.width - 100,
        });

      currentY += 25;

      // Add contact info with left alignment
      addContactInfo(doc, organization, leftMargin, currentY);
      currentY = doc.y + 10;
    }

    // Add horizontal line
    doc.moveDown(0.5);
    doc
      .strokeColor(primaryColor)
      .lineWidth(1)
      .moveTo(50, currentY)
      .lineTo(doc.page.width - 50, currentY)
      .stroke();

    // Update y position for subsequent content
    doc.y = currentY + 10;
  } catch (error) {
    console.error("Error in addHeader:", error);
    // Fallback to simple text header
    doc
      .fontSize(16)
      .font("Helvetica-Bold")
      .text(organization.organization_name, 50, 40, { align: "left" });
    doc.y = 70;
  }
}

// Helper function to add contact information
function addContactInfo(doc, organization, x, y) {
  doc.fontSize(10).font("Helvetica").fillColor("#666666");
  let currentY = y;

  // Handle address
  let addressText = "";
  if (organization.organization_address) {
    if (typeof organization.organization_address === "object") {
      const address = organization.organization_address;
      const addressParts = [];

      if (address.city) addressParts.push(address.city);
      if (address.state) addressParts.push(address.state);
      if (address.country) addressParts.push(address.country);

      addressText = addressParts.join(", ");
    } else if (typeof organization.organization_address === "string") {
      addressText = organization.organization_address;
    }
  }

  if (addressText) {
    doc.text(addressText, x, currentY, {
      align: "left",
      width: doc.page.width - 100,
    });
    currentY += 15;
  }

  if (organization.organization_phone) {
    doc.text(`Phone: ${organization.organization_phone}`, x, currentY, {
      align: "left",
      width: doc.page.width - 100,
    });
    currentY += 15;
  }

  if (organization.organization_email) {
    doc.text(`Email: ${organization.organization_email}`, x, currentY, {
      align: "left",
      width: doc.page.width - 100,
    });
    currentY += 15;
  }

  doc.y = currentY;
}

// Helper function to add section headings - FIXED FOR LEFT ALIGNMENT
function addSectionHeading(doc, title, color) {
  // Check if we need to add a page break before this section
  // Allow 40pt space for the heading + a bit more for content
  if (doc.y > doc.page.height - 120) {
    doc.addPage();
  }

  // Explicitly use left alignment for ALL section headings
  doc
    .fontSize(12)
    .font("Helvetica-Bold")
    .fillColor(color)
    .text(title, 50, doc.y, {
      align: "left",
      width: doc.page.width - 100,
    });
  doc.moveDown(0.5);
}

// Helper function to create tables with key-value pairs
function createTable(doc, data, headerBgColor, textColor) {
  const rowHeight = 20;
  const cellPadding = 5;
  const tableWidth = doc.page.width - 100; // 50pt margin on each side
  const colWidth = tableWidth / 2;

  // Calculate table height
  const tableHeight = data.length * rowHeight;

  // Check if table will fit on current page, if not, add a new page
  if (doc.y + tableHeight > doc.page.height - 70) {
    doc.addPage();
  }

  let tableTop = doc.y;
  // Draw table
  data.forEach((row, i) => {
    const rowTop = tableTop + i * rowHeight;

    // Check if this row will be off the page, if so add a new page
    if (rowTop + rowHeight > doc.page.height - 70) {
      doc.addPage();
      // Adjust the rowTop value for the new page
      return createTable(doc, data.slice(i), headerBgColor, textColor);
    }

    // Draw background for the key cell (first column)
    doc.fillColor(headerBgColor).rect(50, rowTop, colWidth, rowHeight).fill();

    // Reset fill color for text
    doc
      .fillColor(textColor)
      .font("Helvetica-Bold")
      .fontSize(9)
      .text(row[0], 50 + cellPadding, rowTop + 6, {
        width: colWidth - 2 * cellPadding,
      });

    // Value cell (second column)
    doc
      .fillColor("#000000")
      .font("Helvetica")
      .fontSize(9)
      .text(row[1], 50 + colWidth + cellPadding, rowTop + 6, {
        width: colWidth - 2 * cellPadding,
      });

    // Draw cell borders
    doc
      .strokeColor("#cccccc")
      .lineWidth(0.5)
      .rect(50, rowTop, colWidth, rowHeight)
      .rect(50 + colWidth, rowTop, colWidth, rowHeight)
      .stroke();
  });

  // Update the y position for subsequent content
  doc.y = tableTop + (doc._rowOffset || 0) + data.length * rowHeight + 10;
  return doc.y;
}

// Helper function to create tables with headers and multiple rows
// Looking at the error location: createTableWithHeaders line 710

function createTableWithHeaders(doc, headers, rows, headerBgColor, textColor) {
  const headerHeight = 25;
  const rowHeight = 20;
  const cellPadding = 5;
  const columnCount = headers.length;
  const tableWidth = doc.page.width - 100; // 50pt margin on each side
  const colWidth = tableWidth / columnCount;

  // Calculate total table height (header + all rows)
  const tableHeight = headerHeight + rows.length * rowHeight;

  // Check if table will fit on current page, if not, add a new page
  if (doc.y + tableHeight > doc.page.height - 70) {
    doc.addPage();
  }

  // Change this from const to let since we're reassigning it later
  let tableTop = doc.y;

  // Draw table headers
  doc.fillColor(headerBgColor);
  doc.rect(50, tableTop, tableWidth, headerHeight).fill();
  doc.fillColor(textColor).font("Helvetica-Bold").fontSize(9);

  headers.forEach((header, i) => {
    doc.text(header, 50 + i * colWidth + cellPadding, tableTop + 8, {
      width: colWidth - 2 * cellPadding,
      align: "left", // Ensure headers are left aligned
    });
  });

  // Draw header bottom border
  doc
    .strokeColor("#cccccc")
    .lineWidth(0.5)
    .moveTo(50, tableTop + headerHeight)
    .lineTo(doc.page.width - 50, tableTop + headerHeight)
    .stroke();

  // Draw table rows with pagination
  let currentY = tableTop + headerHeight;
  let currentPage = 0;

  // Draw rows batch by batch to handle pagination
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    // Change this from const to let since we're reassigning it later
    let rowTop = currentY;

    // Check if this row will be off the page, if so add a new page
    if (rowTop + rowHeight > doc.page.height - 70) {
      // Draw vertical borders for the current page
      for (let i = 0; i <= columnCount; i++) {
        doc
          .strokeColor("#cccccc")
          .lineWidth(0.5)
          .moveTo(50 + i * colWidth, tableTop)
          .lineTo(50 + i * colWidth, rowTop)
          .stroke();
      }

      // Add a new page
      doc.addPage();
      currentPage++;

      // Reset currentY for the new page
      currentY = doc.page.margins.top;
      tableTop = currentY; // This is the problematic line - tableTop was declared as const

      // Redraw headers on the new page
      doc.fillColor(headerBgColor);
      doc.rect(50, tableTop, tableWidth, headerHeight).fill();
      doc.fillColor(textColor).font("Helvetica-Bold").fontSize(9);

      headers.forEach((header, i) => {
        doc.text(header, 50 + i * colWidth + cellPadding, tableTop + 8, {
          width: colWidth - 2 * cellPadding,
          align: "left", // Ensure headers are left aligned on new pages too
        });
      });

      // Draw header bottom border
      doc
        .strokeColor("#cccccc")
        .lineWidth(0.5)
        .moveTo(50, tableTop + headerHeight)
        .lineTo(doc.page.width - 50, tableTop + headerHeight)
        .stroke();

      currentY = tableTop + headerHeight;
      rowTop = currentY; // This is also problematic - rowTop was declared as const
    }

    // Draw row background (alternating)
    if (rowIndex % 2 === 1) {
      doc.fillColor("#f9f9f9").rect(50, rowTop, tableWidth, rowHeight).fill();
    }

    // Draw cell content
    doc.fillColor("#000000").font("Helvetica").fontSize(9);
    row.forEach((cell, colIndex) => {
      doc.text(cell, 50 + colIndex * colWidth + cellPadding, rowTop + 6, {
        width: colWidth - 2 * cellPadding,
        align: "left", // Ensure cell content is left aligned
      });
    });

    // Draw row bottom border
    doc
      .strokeColor("#cccccc")
      .lineWidth(0.5)
      .moveTo(50, rowTop + rowHeight)
      .lineTo(doc.page.width - 50, rowTop + rowHeight)
      .stroke();

    currentY += rowHeight;
  }

  // Draw vertical lines for the last/current page
  for (let i = 0; i <= columnCount; i++) {
    doc
      .strokeColor("#cccccc")
      .lineWidth(0.5)
      .moveTo(50 + i * colWidth, tableTop)
      .lineTo(50 + i * colWidth, currentY)
      .stroke();
  }

  // Update the y position for subsequent content
  doc.y = currentY + 10;
  return doc.y;
}
// Helper function to add footer with page numbers - ENHANCED FOR BETTER VISIBILITY
function addFooter(doc, organization, pageNumber, totalPages, contentStartY) {
  const pageHeight = doc.page.height;
  const footerTop = pageHeight - 50;

  // Save current drawing positions
  const originalY = doc.y;

  // Add horizontal line
  doc
    .strokeColor("#007B8E") // Use the primary color for the line
    .lineWidth(1)
    .moveTo(50, footerTop)
    .lineTo(doc.page.width - 50, footerTop)
    .stroke();

  // Add footer text with organization name and year - ENHANCED SIZE AND VISIBILITY
  const currentYear = new Date().getFullYear();
  doc
    .fontSize(9) // Slightly larger font
    .font("Helvetica-Bold") // Make it bold
    .fillColor("#007B8E") // Use primary color for better visibility
    .text(
      `${organization.organization_name} - ${currentYear} | This is an official document.`,
      50,
      footerTop + 10,
      {
        align: "center",
        width: doc.page.width - 100,
      }
    );

  // Add page number
  doc
    .fontSize(8)
    .font("Helvetica")
    .fillColor("#666666")
    .text(`Page ${pageNumber} of ${totalPages}`, 50, footerTop + 25, {
      align: "center",
      width: doc.page.width - 100,
    });

  // Restore original position
  doc.y = originalY;
}
function addDiscountInfoBox(doc, therapyPlan, headerBgColor, primaryColor) {
  // Check if there's any discount applied
  const hasDiscount =
    therapyPlan.discount_percentage > 0 ||
    (therapyPlan.original_amount &&
      parseFloat(therapyPlan.original_amount) >
        parseFloat(therapyPlan.total_amount));

  if (!hasDiscount) return; // Exit if no discount

  // Check if we need to add a page break
  if (doc.y > doc.page.height - 120) {
    doc.addPage();
  }

  addSectionHeading(doc, "Discount Information", primaryColor);

  const originalAmount = parseFloat(
    therapyPlan.original_amount || therapyPlan.total_amount
  );
  const finalAmount = parseFloat(therapyPlan.total_amount);
  const discountAmount = originalAmount - finalAmount;
  const discountPercentage =
    therapyPlan.discount_percentage || (discountAmount / originalAmount) * 100;

  const discountInfo = [
    ["Original Amount", "Rs." + originalAmount.toFixed(2)],
    ["Discount Percentage", discountPercentage.toFixed(1) + "%"],
    ["Discount Amount", "Rs." + discountAmount.toFixed(2)],
    ["Final Amount (After Discount)", "Rs." + finalAmount.toFixed(2)],
    ["You Save", "Rs." + discountAmount.toFixed(2)],
  ];

  // Create a highlighted box for discount information
  const tableTop = doc.y;
  const tableHeight = discountInfo.length * 20;

  // Draw a border around the discount box
  doc
    .strokeColor(primaryColor)
    .lineWidth(2)
    .rect(45, tableTop - 5, doc.page.width - 90, tableHeight + 10)
    .stroke();

  createTable(doc, discountInfo, headerBgColor, primaryColor);

  // Add a note about the discount
  doc
    .fontSize(8)
    .font("Helvetica-Oblique")
    .fillColor("#666666")
    .text(
      "* Discount has been applied to the original therapy plan amount",
      50,
      doc.y + 5,
      {
        align: "left",
        width: doc.page.width - 100,
      }
    );

  doc.moveDown(1);
}

// Add this helper function for treatment guidelines
function addTreatmentGuidelines(doc, therapyPlan, primaryColor) {
  // Check if we need to add a page break
  if (doc.y > doc.page.height - 200) {
    doc.addPage();
  }

  addSectionHeading(doc, "Treatment Guidelines & Instructions", primaryColor);

  // Define guidelines based on therapy type/category
  const guidelines = [
    "• The outcome of the treatment will vary from patient to patient.",
    "• Charges once paid cannot be refunded",
    "•  Once paid, the amount can be used for in clinic or home treatment.",
  ];

  // Add category-specific guidelines
  if (therapyPlan.patient_therapy_category) {
    guidelines.push(
      `• Specific to ${therapyPlan.patient_therapy_category}: Follow specialized protocols as discussed`
    );
  }

  // Add payment-related guidelines
  if (therapyPlan.payment_type === "recurring") {
    guidelines.push(
      "• Payments are due as per the agreed schedule to avoid session delays"
    );
    guidelines.push(
      "• Keep payment receipts for your records and insurance claims"
    );
  }

  doc.fontSize(10).font("Helvetica").fillColor("#000000");

  guidelines.forEach((guideline) => {
    doc.text(guideline, 50, doc.y, {
      align: "left",
      width: doc.page.width - 100,
      indent: 10,
    });
    doc.moveDown(0.3);
  });

  doc.moveDown(1);
}
module.exports = { generateTherapyPlanPDF };
