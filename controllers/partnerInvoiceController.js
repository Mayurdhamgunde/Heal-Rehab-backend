const { getInvoiceModel } = require("../db/partnerInvoiceSchema");

// 1. CREATE INVOICE
const createInvoice = async (req, res) => {
  try {
    const {
      customer, // { id, name, billing_address, gstin... }
      invoice_details, // { invoice_number, invoice_date, due_date... }
      items, // Array of items
      financials, // { sub_total, tax_total, grand_total... }
      initial_payment, // Optional: { amount, mode... }
    } = req.body;

    // Use the model attached to the current organization's DB
    const Invoice = getInvoiceModel(req.orgDb);

    // 1. Check for Duplicate Invoice Number in THIS database
    const existing = await Invoice.findOne({
      invoice_number: invoice_details.invoice_number,
    });

    if (existing) {
      return res.status(400).json({ msg: "Invoice number already exists." });
    }

    // 2. Construct Invoice
    const newInvoice = new Invoice({
      invoice_number: invoice_details.invoice_number,
      invoice_date: invoice_details.invoice_date,
      due_date: invoice_details.due_date,
      series_id: invoice_details.series_id,
      type: invoice_details.type,

      customer: {
        partner_id: customer.id || null, // Can be null if manual customer
        name: customer.name,
        billing_address: customer.billing_address,
        gstin: customer.gstin,
        place_of_supply: customer.place_of_supply,
      },

      items: items.map((item) => ({
        item_name: item.item,
        description: item.description,
        hsn_sac: item.hsn_sac, // Optional
        quantity: item.qty,
        unit: item.unit,
        price_per_unit: item.pricePerUnit,
        discount_percent: item.discountPercent,
        discount_amount: item.discountAmount,
        tax_rate: item.taxRate,
        tax_amount: item.taxAmount,
        tax_type: item.taxLabel?.includes("IGST") ? "IGST" : "GST",
        total_amount: item.amount,
      })),

      sub_total: financials.sub_total,
      tax_total: financials.tax_total,
      round_off: financials.roundOff
        ? Math.round(financials.grand_total) - financials.grand_total
        : 0,
      grand_total: financials.grand_total,
      amount_in_words: financials.amount_in_words, // You can generate this in backend or frontend

      status: "Draft",
      created_by: req.user ? req.user._id : null,
    });

    // 3. Handle Initial Payment (if user marked "Paid" immediately)
    if (initial_payment && initial_payment.amount > 0) {
      newInvoice.payments.push({
        amount: initial_payment.amount,
        payment_mode: initial_payment.paymentType || "Cash",
        reference_no: initial_payment.referenceNo,
        payment_date: new Date(),
      });
      // Status auto-updates in pre-save hook
    }

    const savedInvoice = await newInvoice.save();

    res.status(201).json({
      message: "Invoice created successfully",
      invoice: savedInvoice,
    });
  } catch (error) {
    console.error("Create Invoice Error:", error);
    res
      .status(500)
      .json({ msg: "Error creating invoice", error: error.message });
  }
};

// 2. GET INVOICE BY ID
const getInvoiceById = async (req, res) => {
  try {
    const Invoice = getInvoiceModel(req.orgDb);
    const invoice = await Invoice.findById(req.params.id);

    if (!invoice) return res.status(404).json({ msg: "Invoice not found" });

    res.status(200).json(invoice);
  } catch (error) {
    res
      .status(500)
      .json({ msg: "Error fetching invoice", error: error.message });
  }
};

// 3. UPDATE INVOICE
const updateInvoice = async (req, res) => {
  try {
    const Invoice = getInvoiceModel(req.orgDb);
    const { id } = req.params;

    // Find first to check status
    const invoice = await Invoice.findById(id);
    if (!invoice) return res.status(404).json({ msg: "Invoice not found" });

    // Optional: Prevent editing if already sent/paid
    if (invoice.status === "Paid") {
      return res.status(400).json({ msg: "Cannot edit a paid invoice" });
    }

    // Apply updates from req.body (simplified)
    // In production, you might want to specifically map fields to prevent overwriting 'payments' accidentally
    Object.assign(invoice, req.body);

    const updatedInvoice = await invoice.save();
    res
      .status(200)
      .json({ message: "Updated successfully", invoice: updatedInvoice });
  } catch (error) {
    res
      .status(500)
      .json({ msg: "Error updating invoice", error: error.message });
  }
};

// 4. ADD PAYMENT
const addPayment = async (req, res) => {
  try {
    const Invoice = getInvoiceModel(req.orgDb);
    const { id } = req.params;
    const { amount, payment_mode, reference_no, notes, payment_date } =
      req.body;

    const invoice = await Invoice.findById(id);
    if (!invoice) return res.status(404).json({ msg: "Invoice not found" });

    if (amount > invoice.balance_due + 1) {
      return res
        .status(400)
        .json({ msg: "Payment amount exceeds balance due" });
    }

    invoice.payments.push({
      amount,
      payment_mode,
      reference_no,
      notes,
      payment_date: payment_date || new Date(),
    });

    const result = await invoice.save(); // Middleware will update balance_due & status

    res.status(200).json({
      message: "Payment added",
      new_balance: result.balance_due,
      status: result.status,
    });
  } catch (error) {
    res.status(500).json({ msg: "Error adding payment", error: error.message });
  }
};

module.exports = {
  createInvoice,
  getInvoiceById,
  updateInvoice,
  addPayment,
};
