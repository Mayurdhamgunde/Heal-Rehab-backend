const PDFDocument = require("pdfkit");
const { ObjectId } = require("mongoose").Types;
const Organization = require("../db/OrganizationSchema");
// IMPORT THE NEW MERGED SCHEMA MODELS
const {
  getInvoiceModel,
  getInvoiceSeriesModel,
} = require("../db/invoiceSchema");
const { getPaymentModel } = require("../db/paymentSchema");
const { getPartnerModel } = require("../db/partnerSchema");
const { generateImageSasTokenLogo } = require("../utils/azureutils");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const handlebars = require("handlebars");

// ==========================================
// 1. HELPER FUNCTIONS
// ==========================================

function formatCurrency(amount) {
  return (
    "₹" +
    (parseFloat(amount) || 0).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function formatDate(date) {
  if (!date) return "";
  return new Date(date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatAddress(addr) {
  if (!addr) return "";
  if (typeof addr === "string") return addr;
  const parts = [addr.street, addr.city, addr.state, addr.zip, addr.country];
  return parts.filter(Boolean).join(", ");
}

// UPDATED: Helper to include Location Info (Name, ID, Address)
const createInvoicePaymentRecord = async (
  orgDb,
  invoiceId,
  recipientId,
  recipientType,
  paymentInfo,
  userId,
  locationDetails = {},
) => {
  const Payment = getPaymentModel(orgDb);
  const paymentAmount = parseFloat(paymentInfo.amount);

  const paymentDoc = {
    amount: paymentAmount,
    base_amount: paymentAmount,
    addons_amount: 0,
    type: paymentInfo.method || "Cash",
    date: new Date(),
    patient_id: recipientType === "Patient" ? new ObjectId(recipientId) : null,
    doctor_id: userId,
    invoice_id: new ObjectId(invoiceId),
    payment_reference: paymentInfo.reference || "",
    description: `Payment for invoice (Type: ${recipientType})`,
    notes: paymentInfo.notes || "",

    // UPDATED: Location Compatibility
    location_address: locationDetails.location_address || null,
    location_name: locationDetails.location_name || null,
    location_id: locationDetails.location_id || null,
  };

  return await Payment.create(paymentDoc);
};

// ==========================================
// 2. CORE CONTROLLERS
// ==========================================

const saveInvoice = async (req, res) => {
  try {
    const {
      invoiceDate,
      dueDate,
      poNumber,
      poDate,
      paymentTerms,
      stateOfSupply,
      invoiceNumber,
      recipientType = "Patient",
      recipientId,
      items,
      tdsRate,
      roundOff,
      paymentInfo,
      seriesId,
      notes,
      termsAndConditions,
      actionType = "save",
      location_name,
      location_id,
      location_address,
    } = req.body;

    if (!recipientId || !items || items.length === 0 || !seriesId) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const Invoice = getInvoiceModel(req.orgDb);
    const InvoiceSeries = getInvoiceSeriesModel(req.orgDb);

    // FETCH RECIPIENT
    let recipientSnapshot = {};
    let recipientAddressFallback = "";

    if (recipientType === "Patient") {
      const patientObj = await req.orgDb
        .collection("patients")
        .findOne({ _id: new ObjectId(recipientId) });
      if (!patientObj)
        return res.status(404).json({ message: "Patient not found" });

      recipientSnapshot = {
        name: `${patientObj.patient_first_name} ${patientObj.patient_last_name}`,
        phone: patientObj.patient_phone,
        email: patientObj.patient_email,
        address: {
          street: patientObj.address?.street || "",
          city: patientObj.address?.city || "",
          state: patientObj.address?.state || "",
          zip: patientObj.address?.zip || "",
          country: patientObj.address?.country || "",
        },
        place_of_supply: stateOfSupply,
      };
      recipientAddressFallback = patientObj.address?.street;
    } else {
      const Partner = getPartnerModel(req.orgDb);
      const partnerObj = await Partner.findById(recipientId);
      if (!partnerObj)
        return res.status(404).json({ message: "Partner not found" });

      recipientSnapshot = {
        name: partnerObj.partner_name,
        phone: partnerObj.phone_number,
        email: partnerObj.email,
        gstin: partnerObj.gstin,
        address: partnerObj.billing_address,
        place_of_supply: stateOfSupply,
      };
      recipientAddressFallback = partnerObj.billing_address?.street;
    }

    // GENERATE/VALIDATE INVOICE NUMBER
    const series = await InvoiceSeries.findById(seriesId);
    if (!series) {
      return res.status(404).json({ message: "Invoice series not found" });
    }

    let finalInvoiceNumber;

    if (invoiceNumber && invoiceNumber.trim()) {
      finalInvoiceNumber = invoiceNumber.trim();

      if (!finalInvoiceNumber.startsWith(series.prefix)) {
        return res.status(400).json({
          message: `Number must start with prefix: ${series.prefix}`,
        });
      }

      const exists = await Invoice.findOne({
        invoice_number: finalInvoiceNumber,
      });
      if (exists) {
        return res.status(400).json({
          message: "Invoice Number already exists",
          error_code: "DUPLICATE",
        });
      }

      const numericPart = finalInvoiceNumber.substring(series.prefix.length);
      const invoiceNum = parseInt(numericPart, 10);

      if (isNaN(invoiceNum)) {
        return res.status(400).json({
          message: "Invalid invoice number format",
        });
      }

      if (invoiceNum > series.current_number) {
        series.current_number = invoiceNum;
        await series.save();
      }
    } else {
      series.current_number += 1;
      await series.save();

      const paddedNumber = String(series.current_number).padStart(4, "0");
      finalInvoiceNumber = `${series.prefix}${paddedNumber}`;
    }

    // PROCESS ITEMS & CALCULATE TOTALS (FIXED FOR DYNAMIC CALCULATION)
    let calculatedSubTotal = 0;
    let calculatedTotalDiscount = 0;
    let calculatedTotalTax = 0;

    const processedItems = items.map((item) => {
      const qty = parseFloat(item.qty) || 0;
      const price = parseFloat(item.pricePerUnit) || 0;
      const baseTotal = qty * price;

      // 1. Calculate Discount Amount dynamically if frontend didn't send it
      let discAmt = parseFloat(item.discountAmount);
      if (isNaN(discAmt) || discAmt === 0) {
        const discPercent = parseFloat(item.discountPercent) || 0;
        discAmt = (baseTotal * discPercent) / 100;
      }

      // 2. Calculate Tax Amount dynamically if frontend didn't send it
      const afterDiscount = baseTotal - discAmt;
      let taxAmt = parseFloat(item.taxAmount);
      if (isNaN(taxAmt) || taxAmt === 0) {
        const taxRate = parseFloat(item.taxRate) || 0;
        taxAmt = (afterDiscount * taxRate) / 100;
      }

      calculatedSubTotal += baseTotal;
      calculatedTotalDiscount += discAmt;
      calculatedTotalTax += taxAmt;

      return {
        item_name: item.item || item.item_name,
        description: item.description,
        hsn_sac: item.hsn_sac,
        quantity: qty,
        unit: item.unit || "Nos",
        price_per_unit: price,
        discount_percent: parseFloat(item.discountPercent) || 0,
        discount_amount: discAmt, // Now safely guaranteed
        tax_rate: parseFloat(item.taxRate) || 0,
        tax_amount: taxAmt, // Now safely guaranteed
        tax_type: item.taxLabel?.includes("IGST") ? "IGST" : "GST",
        line_total: parseFloat(item.amount) || (afterDiscount + taxAmt),
        therapy_plan_id: item.therapyPlanId
          ? new ObjectId(item.therapyPlanId)
          : null,
        is_therapy_plan: !!item.isTherapyPlan,
      };
    });

    const taxableValue = calculatedSubTotal - calculatedTotalDiscount;
    const totalWithTax = taxableValue + calculatedTotalTax;
    const tdsVal = parseFloat(tdsRate) || 0;
    const calculatedTdsAmount = (totalWithTax * tdsVal) / 100;
    const preRoundTotal = totalWithTax - calculatedTdsAmount;

    let finalAmount = preRoundTotal;
    let roundOffAmount = 0;

    if (roundOff) {
      finalAmount = Math.round(preRoundTotal);
      roundOffAmount = finalAmount - preRoundTotal;
    }

    // CONSTRUCT INVOICE DOCUMENT WITH LOCATION DETAILS
    const invoiceData = {
      invoice_number: finalInvoiceNumber,
      series_id: new ObjectId(seriesId),
      invoice_date: invoiceDate ? new Date(invoiceDate) : new Date(),
      due_date: dueDate ? new Date(dueDate) : null,
      po_number: poNumber,
      po_date: poDate ? new Date(poDate) : null,
      recipient_type: recipientType,
      patient_id:
        recipientType === "Patient" ? new ObjectId(recipientId) : null,
      partner_id:
        recipientType === "Partner" ? new ObjectId(recipientId) : null,
      recipient_snapshot: recipientSnapshot,

      // SAVE LOCATION DETAILS IN INVOICE
      location_name: location_name || null,
      location_id: location_id || null,
      location_address: location_address || recipientAddressFallback || null,

      items: processedItems,
      sub_total: calculatedSubTotal,
      total_discount: calculatedTotalDiscount,
      total_tax: calculatedTotalTax,
      tds_rate: tdsVal,
      tds_amount: calculatedTdsAmount,
      round_off_amount: roundOffAmount,
      final_amount: finalAmount,
      payment_terms: paymentTerms,
      notes: notes,
      terms_and_conditions: termsAndConditions,
      status: actionType === "send" ? "Sent" : "Draft",
      created_by: req.user.doctor_id,
      created_by_name: `${req.user.doctor_first_name} ${req.user.doctor_last_name}`,
    };

    if (actionType === "send" && recipientSnapshot.email) {
      invoiceData.shared_at = new Date();
      invoiceData.shared_with = [recipientSnapshot.email];
    }

    const newInvoice = new Invoice(invoiceData);

    // HANDLE INITIAL PAYMENT
    const amountPaid = paymentInfo?.amount_paid
      ? parseFloat(paymentInfo.amount_paid)
      : 0;

    if (amountPaid > 0) {
      await newInvoice.recordPayment(
        amountPaid,
        paymentInfo.payment_method || "Cash",
        paymentInfo.payment_reference,
        paymentInfo.payment_notes,
        req.user.doctor_id,
      );
    }

    const savedInvoice = await newInvoice.save();

    // CREATE SHADOW PAYMENT RECORD (using invoice's location)
    if (amountPaid > 0) {
      try {
        await createInvoicePaymentRecord(
          req.orgDb,
          savedInvoice,
          recipientId,
          recipientType,
          {
            amount: amountPaid,
            method: paymentInfo.payment_method,
            reference: paymentInfo.payment_reference,
            notes: paymentInfo.payment_notes,
          },
          req.user.doctor_id,
        );
      } catch (e) {
        console.error("Shadow payment creation failed:", e);
      }
    }

    res.status(201).json({
      message: `Invoice ${
        actionType === "send" ? "created and sent" : "saved"
      } successfully`,
      invoice: savedInvoice,
    });
  } catch (error) {
    console.error("Save Invoice Error:", error);
    res
      .status(500)
      .json({ message: "Error saving invoice", error: error.message });
  }
};

/**
 * EDIT INVOICE (UPDATE)
 * Note: Invoice number is NOT editable after creation
 */
const editInvoice = async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const {
      invoiceDate,
      dueDate,
      poNumber,
      poDate,
      paymentTerms,
      stateOfSupply,
      recipientType,
      recipientId,
      items,
      tdsRate,
      roundOff,
      paymentInfo,
      notes,
      termsAndConditions,
      actionType,
      location_name,
      location_id,
      location_address,
    } = req.body;

    if (!ObjectId.isValid(invoiceId))
      return res.status(400).json({ message: "Invalid ID" });

    const Invoice = getInvoiceModel(req.orgDb);
    const invoice = await Invoice.findById(invoiceId);

    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    if (invoice.payment_status === "Paid") {
      return res
        .status(400)
        .json({ message: "Cannot edit a fully paid invoice" });
    }

    // 1. UPDATE RECIPIENT SNAPSHOT
    if (recipientId && recipientType) {
      let recipientSnapshot = {};
      let recipientAddressFallback = "";

      if (recipientType === "Patient") {
        const patientObj = await req.orgDb
          .collection("patients")
          .findOne({ _id: new ObjectId(recipientId) });
        if (!patientObj)
          return res.status(404).json({ message: "Patient not found" });

        recipientSnapshot = {
          name: `${patientObj.patient_first_name} ${patientObj.patient_last_name}`,
          phone: patientObj.patient_phone,
          email: patientObj.patient_email,
          address: {
            street: patientObj.address?.street || "",
            city: patientObj.address?.city || "",
            state: patientObj.address?.state || "",
            zip: patientObj.address?.zip || "",
            country: patientObj.address?.country || "",
          },
          place_of_supply:
            stateOfSupply || invoice.recipient_snapshot?.place_of_supply,
        };
        recipientAddressFallback = patientObj.address?.street;
      } else {
        const Partner = getPartnerModel(req.orgDb);
        const partnerObj = await Partner.findById(recipientId);
        if (!partnerObj)
          return res.status(404).json({ message: "Partner not found" });

        recipientSnapshot = {
          name: partnerObj.partner_name,
          phone: partnerObj.phone_number,
          email: partnerObj.email,
          gstin: partnerObj.gstin,
          address: partnerObj.billing_address,
          place_of_supply:
            stateOfSupply || invoice.recipient_snapshot?.place_of_supply,
        };
        recipientAddressFallback = partnerObj.billing_address?.street;
      }

      invoice.recipient_type = recipientType;
      invoice.patient_id =
        recipientType === "Patient" ? new ObjectId(recipientId) : null;
      invoice.partner_id =
        recipientType === "Partner" ? new ObjectId(recipientId) : null;
      invoice.recipient_snapshot = recipientSnapshot;

      // Fallback location address if not explicitly updated
      if (location_address === undefined && !invoice.location_address) {
        invoice.location_address = recipientAddressFallback || null;
      }
    }

    // 2. UPDATE BASIC FIELDS (Allowing deliberate clearing of dates if desired)
    if (invoiceDate !== undefined)
      invoice.invoice_date = invoiceDate
        ? new Date(invoiceDate)
        : invoice.invoice_date;
    if (dueDate !== undefined)
      invoice.due_date = dueDate ? new Date(dueDate) : null;
    if (poNumber !== undefined) invoice.po_number = poNumber;
    if (poDate !== undefined)
      invoice.po_date = poDate ? new Date(poDate) : null;
    if (paymentTerms !== undefined) invoice.payment_terms = paymentTerms;
    if (notes !== undefined) invoice.notes = notes;
    if (termsAndConditions !== undefined)
      invoice.terms_and_conditions = termsAndConditions;

    // 3. UPDATE LOCATION DETAILS
    if (location_name !== undefined) invoice.location_name = location_name;
    if (location_id !== undefined) invoice.location_id = location_id;
    if (location_address !== undefined)
      invoice.location_address = location_address;

    // 4. PROCESS ITEMS & RECALCULATE (FIXED FOR DYNAMIC CALCULATION)
    if (items && items.length > 0) {
      let calculatedSubTotal = 0;
      let calculatedTotalDiscount = 0;
      let calculatedTotalTax = 0;

      invoice.items = items.map((item) => {
        const qty = parseFloat(item.qty) || 0;
        const price = parseFloat(item.pricePerUnit) || 0;
        const baseTotal = qty * price;

        // 1. Calculate Discount Amount dynamically if frontend didn't send it
        let discAmt = parseFloat(item.discountAmount);
        if (isNaN(discAmt) || discAmt === 0) {
          const discPercent = parseFloat(item.discountPercent) || 0;
          discAmt = (baseTotal * discPercent) / 100;
        }

        // 2. Calculate Tax Amount dynamically if frontend didn't send it
        const afterDiscount = baseTotal - discAmt;
        let taxAmt = parseFloat(item.taxAmount);
        if (isNaN(taxAmt) || taxAmt === 0) {
          const taxRate = parseFloat(item.taxRate) || 0;
          taxAmt = (afterDiscount * taxRate) / 100;
        }

        calculatedSubTotal += baseTotal;
        calculatedTotalDiscount += discAmt;
        calculatedTotalTax += taxAmt;

        return {
          item_name: item.item || item.item_name,
          description: item.description,
          hsn_sac: item.hsn_sac,
          quantity: qty,
          unit: item.unit || "Nos", // Fixed missing fallback
          price_per_unit: price,
          discount_percent: parseFloat(item.discountPercent) || 0, // Fixed NaN bug
          discount_amount: discAmt, // Now safely guaranteed
          tax_rate: parseFloat(item.taxRate) || 0, // Fixed NaN bug
          tax_amount: taxAmt, // Now safely guaranteed
          tax_type: item.taxLabel?.includes("IGST") ? "IGST" : "GST",
          line_total: parseFloat(item.amount) || (afterDiscount + taxAmt), // Fixed NaN bug
          therapy_plan_id: item.therapyPlanId
            ? new ObjectId(item.therapyPlanId)
            : null,
          is_therapy_plan: !!item.isTherapyPlan,
        };
      });

      const taxableValue = calculatedSubTotal - calculatedTotalDiscount;
      const totalWithTax = taxableValue + calculatedTotalTax;
      const tdsVal =
        tdsRate !== undefined ? parseFloat(tdsRate) || 0 : invoice.tds_rate;
      const calculatedTdsAmount = (totalWithTax * tdsVal) / 100;
      const preRoundTotal = totalWithTax - calculatedTdsAmount;

      let finalAmount = preRoundTotal;
      let roundOffAmount = 0;

      if (roundOff) {
        finalAmount = Math.round(preRoundTotal);
        roundOffAmount = finalAmount - preRoundTotal;
      }

      invoice.sub_total = calculatedSubTotal;
      invoice.total_discount = calculatedTotalDiscount;
      invoice.total_tax = calculatedTotalTax;
      invoice.tds_rate = tdsVal;
      invoice.tds_amount = calculatedTdsAmount;
      invoice.final_amount = finalAmount;
      invoice.round_off_amount = roundOffAmount;
    }

    // 5. HANDLE STATUS
    if (actionType === "send") {
      invoice.status = "Sent";
      if (invoice.recipient_snapshot?.email && !invoice.shared_at) {
        invoice.shared_at = new Date();
        invoice.shared_with = [invoice.recipient_snapshot.email];
      }
    }

    // 6. HANDLE NEW PAYMENT
    const amountPaid = paymentInfo?.amount_paid
      ? parseFloat(paymentInfo.amount_paid)
      : 0;

    if (amountPaid > 0) {
      await invoice.recordPayment(
        amountPaid,
        paymentInfo.payment_method || "Cash",
        paymentInfo.payment_reference,
        paymentInfo.payment_notes,
        req.user.doctor_id,
      );

      const rId =
        invoice.recipient_type === "Patient"
          ? invoice.patient_id
          : invoice.partner_id;

      try {
        await createInvoicePaymentRecord(
          req.orgDb,
          invoice._id,
          rId,
          invoice.recipient_type,
          {
            amount: amountPaid,
            method: paymentInfo.payment_method,
            reference: paymentInfo.payment_reference,
            notes: paymentInfo.payment_notes,
          },
          req.user.doctor_id,
          {
            location_address: invoice.location_address || null,
            location_name: invoice.location_name || null,
            location_id: invoice.location_id || null,
          },
        );
      } catch (e) {
        console.error("Shadow payment error:", e);
      }
    }

    const updatedInvoice = await invoice.save();

    res.status(200).json({
      message: "Invoice updated successfully",
      invoice: updatedInvoice,
    });
  } catch (error) {
    console.error("Edit Invoice Error:", error);
    res
      .status(500)
      .json({ message: "Error updating invoice", error: error.message });
  }
};

/**
 * RECORD PAYMENT (STANDALONE)
 */
const recordInvoicePayment = async (req, res) => {
  try {
    const { invoiceId } = req.params;
    // UPDATED: Destructure location fields
    const { amount, method, reference, notes } = req.body;

    const Invoice = getInvoiceModel(req.orgDb);
    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    await invoice.recordPayment(
      amount,
      method,
      reference,
      notes,
      req.user.doctor_id,
    );

    const rId =
      invoice.recipient_type === "Patient"
        ? invoice.patient_id
        : invoice.partner_id;

    try {
      await createInvoicePaymentRecord(
        req.orgDb,
        invoiceId,
        rId,
        invoice.recipient_type,
        { amount, method, reference, notes },
        req.user.doctor_id,
        {
          location_address: invoice.location_address || null,
          location_name: invoice.location_name || null,
          location_id: invoice.location_id || null,
        },
      );
    } catch (e) {
      console.error("Shadow payment failed:", e);
    }

    res.json({
      message: "Payment recorded",
      new_balance: invoice.balance_due,
      payment_status: invoice.payment_status,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error recording payment", error: error.message });
  }
};

/**
 * GENERATE PDF
 */
const generateInvoicePDF = async (req, res) => {
  let browser;
  try {
    const { invoiceId } = req.params;
    const Invoice = getInvoiceModel(req.orgDb);
    const invoice = await Invoice.findById(invoiceId);

    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    const organization = await Organization.findOne({
      tenant_id: req.user.tenant_id,
    });
    if (organization?.organization_logo) {
      organization.organization_logo = await generateImageSasTokenLogo(
        organization.organization_logo,
      );
    }

    const templateData = {
      invoice: {
        invoice_number: invoice.invoice_number,
        invoice_date: formatDate(invoice.invoice_date),
        due_date: formatDate(invoice.due_date),
        po_number: invoice.po_number,

        patient_name: invoice.recipient_snapshot.name,
        patient_address_formatted: formatAddress(
          invoice.recipient_snapshot.address,
        ),
        patient_phone: invoice.recipient_snapshot.phone,
        gstin: invoice.recipient_snapshot.gstin,

        subtotal: formatCurrency(invoice.sub_total),
        total_discount: formatCurrency(invoice.total_discount),
        total_tax: formatCurrency(invoice.total_tax),
        tds_amount: formatCurrency(invoice.tds_amount),
        round_off_amount: formatCurrency(invoice.round_off_amount),
        total_amount: formatCurrency(invoice.final_amount),
        total_paid: formatCurrency(invoice.total_paid),
        balance_due: formatCurrency(invoice.balance_due),
        payment_status: invoice.payment_status,
        status: invoice.status,

        items: invoice.items.map((item, i) => ({
          serial_number: i + 1,
          item_name: item.item_name,
          description: item.description,
          hsn_sac: item.hsn_sac,
          quantity: item.quantity,
          rate: formatCurrency(item.price_per_unit),
          tax_percent: item.tax_rate,
          amount: formatCurrency(item.line_total),
        })),

        payments_received: invoice.payments_received.map((p) => ({
          amount: formatCurrency(p.amount),
          date: formatDate(p.date),
          method: p.method,
          reference: p.reference,
        })),
      },
      organization: {
        organization_name: organization.organization_name,
        organization_address_formatted: formatAddress(
          organization.organization_address,
        ),
        organization_logo: organization.organization_logo,
        organization_phone: organization.organization_phone,
        organization_email: organization.organization_email,
      },
      user: req.user,
    };

    const templatePath = path.join(
      __dirname,
      "../templates/invoice-template.html",
    );
    if (!fs.existsSync(templatePath))
      throw new Error("Invoice template not found");

    const templateHtml = fs.readFileSync(templatePath, "utf8");
    const template = handlebars.compile(templateHtml);
    const html = template(templateData);

    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20px", right: "20px", bottom: "40px", left: "20px" },
    });

    await browser.close();
    browser = null;

    const safeNum = invoice.invoice_number.replace(/[^a-zA-Z0-9-_]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="Invoice_${safeNum}.pdf"`,
    );
    res.end(pdfBuffer);
  } catch (error) {
    console.error("PDF Gen Error:", error);
    if (browser) await browser.close();
    res
      .status(500)
      .json({ message: "Error generating PDF", error: error.message });
  }
};

const getInvoices = async (req, res) => {
  try {
    const { page = 1, limit = 10, status, search, recipientType } = req.query;
    const Invoice = getInvoiceModel(req.orgDb);

    const filter = {};
    if (status) filter.status = status;
    if (recipientType) filter.recipient_type = recipientType;

    if (search) {
      const regex = { $regex: search, $options: "i" };
      filter.$or = [
        { invoice_number: regex },
        { "recipient_snapshot.name": regex },
        { "recipient_snapshot.phone": regex },
        { "recipient_snapshot.email": regex },
        { "recipient_snapshot.gstin": regex },
      ];
    }

    const [invoices, total] = await Promise.all([
      Invoice.find(filter)
        .sort({ invoice_date: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .lean(),
      Invoice.countDocuments(filter),
    ]);

    res.json({
      invoices,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Fetch error", error: error.message });
  }
};

const getInvoice = async (req, res) => {
  try {
    const Invoice = getInvoiceModel(req.orgDb);
    const invoice = await Invoice.findById(req.params.invoiceId);
    if (!invoice) return res.status(404).json({ message: "Not found" });
    res.json({ invoice });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

const updateInvoiceStatus = async (req, res) => {
  try {
    const Invoice = getInvoiceModel(req.orgDb);
    const { status } = req.body;

    // 1. STRICT VALIDATION: Check if status is allowed by Schema
    const allowedStatuses = [
      "Draft",
      "Unpaid",
      "Partially Paid",
      "Paid",
      "Overdue",
      "Cancelled",
      "Sent",
    ];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        message: `Invalid status. Allowed values are: ${allowedStatuses.join(", ")}`,
      });
    }

    const invoice = await Invoice.findById(req.params.invoiceId);
    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    // --- 2. LOGIC FOR "PAID" STATUS ---
    if (status === "Paid") {
      // PROTECTION: If already paid, stop here to prevent duplicate payments
      if (invoice.payment_status === "Paid") {
        return res.status(400).json({
          message: "Invoice is already marked as Paid",
          payment_status: invoice.payment_status,
        });
      }

      // Auto-Pay Logic: Only if there is a balance
      if (invoice.balance_due > 0) {
        const amountToPay = invoice.balance_due;
        const method = "Cash";
        const notes = "Auto-marked as Paid";

        // a) Record payment on Invoice
        // Note: recordPayment calls .save(), which triggers middleware
        await invoice.recordPayment(
          amountToPay,
          method,
          "Auto-Paid",
          notes,
          req.user.doctor_id,
        );

        // b) Create Shadow Payment Record
        const recipientId =
          invoice.recipient_type === "Patient"
            ? invoice.patient_id
            : invoice.partner_id;

        try {
          await createInvoicePaymentRecord(
            req.orgDb,
            invoice._id,
            recipientId,
            invoice.recipient_type,
            {
              amount: amountToPay,
              method: method,
              reference: "Auto-Paid",
              notes: notes,
            },
            req.user.doctor_id,
            {
              location_address: invoice.location_address || null,
              location_name: invoice.location_name || null,
              location_id: invoice.location_id || null,
            },
          );
        } catch (paymentError) {
          console.error("Shadow payment error:", paymentError);
        }
      }

      // Explicitly ensure status is Paid (though recordPayment middleware logic usually handles this)
      invoice.payment_status = "Paid";
    }

    // --- 3. LOGIC FOR "SENT" STATUS ---
    else if (status === "Sent") {
      invoice.payment_status = "Sent";
      if (!invoice.shared_at) invoice.shared_at = new Date();
    }

    // --- 4. LOGIC FOR "CANCELLED" ---
    else if (status === "Cancelled") {
      invoice.payment_status = "Cancelled";
    }

    // --- 5. LOGIC FOR OTHER VALID STATUSES (Unpaid, etc.) ---
    else {
      invoice.payment_status = status;
    }

    // Final Save
    // Note: Ensure your Schema Middleware allows "Sent" status without overwriting it to "Unpaid"
    const updatedInvoice = await invoice.save();

    res.json({
      message: `Invoice marked as ${status}`,
      payment_status: updatedInvoice.payment_status,
      invoice: updatedInvoice,
    });
  } catch (e) {
    console.error("Update Status Error:", e);
    res.status(500).json({ error: e.message });
  }
};
const getInvoiceSeries = async (req, res) => {
  try {
    const Series = getInvoiceSeriesModel(req.orgDb);
    const series = await Series.find({ is_active: true }).lean();
    res.json({ series });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

const createInvoiceSeries = async (req, res) => {
  try {
    const Series = getInvoiceSeriesModel(req.orgDb);
    const { seriesName, prefix, startingNumber } = req.body;

    const exists = await Series.findOne({ series_name: seriesName });
    if (exists) return res.status(400).json({ message: "Series exists" });

    const newSeries = new Series({
      series_name: seriesName,
      prefix,
      starting_number: startingNumber || 1,
      current_number: (startingNumber || 1) - 1,
    });

    await newSeries.save();
    res.status(201).json({ message: "Series Created", series: newSeries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
const getInvoicePrintData = async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const Invoice = getInvoiceModel(req.orgDb);

    // 1. Fetch Invoice
    const invoice = await Invoice.findById(invoiceId).lean();
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    // 2. Fetch Organization & Process Logo
    const organization = await Organization.findOne({
      tenant_id: req.user.tenant_id,
    }).lean();

    if (organization?.organization_logo) {
      // Generate secure SAS URL for the logo so UI can render it
      organization.organization_logo = await generateImageSasTokenLogo(
        organization.organization_logo,
      );
    }

    // 3. Prepare Data Packet
    // We format dates here or let UI handle it. Sending raw is usually more flexible.
    const printData = {
      invoice: {
        ...invoice,
        // Helper to ensure balance/totals are numbers
        final_amount: parseFloat(invoice.final_amount),
        sub_total: parseFloat(invoice.sub_total),
        total_tax: parseFloat(invoice.total_tax),
      },
      organization: {
        name: organization.organization_name,
        address: organization.organization_address, // Object { street, city, ... }
        logo: organization.organization_logo,
        gstin: organization.organization_tax_id,
        email: organization.organization_email,
        phone: organization.organization_phone,
      },
      user: {
        name: `${req.user.doctor_first_name} ${req.user.doctor_last_name}`,
      },
    };

    res.json(printData);
  } catch (error) {
    console.error("Get Print Data Error:", error);
    res
      .status(500)
      .json({ message: "Error fetching print data", error: error.message });
  }
};

module.exports = {
  saveInvoice,
  editInvoice,
  getInvoices,
  getInvoice,
  recordInvoicePayment,
  updateInvoiceStatus,
  generateInvoicePDF,
  getInvoiceSeries,
  getInvoicePrintData,
  createInvoiceSeries,
};