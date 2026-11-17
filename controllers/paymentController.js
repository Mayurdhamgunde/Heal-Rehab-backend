const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;
// Adjust this path to wherever paymentSchema.js lives in your project.
const { PAYMENT_MODES, PAYMENT_PURPOSES } = require("../db/paymentSchema");

/* -------------------------------------------------------------------------- */
/* Config & small helpers                                                      */
/* -------------------------------------------------------------------------- */

const TZ = "Asia/Kolkata";
const IST_OFFSET_MS = 330 * 60 * 1000; // IST has no DST
const MAX_PAGE_SIZE = 100;
const MAX_REPORT_DAYS = 366;

// Roles allowed to touch payments. Override with PAYMENT_ROLES="accounts,admin".
const PAYMENT_ROLES = (process.env.PAYMENT_ROLES || "accounts,payments,admin")
  .split(",")
  .map((r) => r.trim().toLowerCase())
  .filter(Boolean);

const IS_REFUND = { $eq: ["$entry_type", "REFUND"] };
const SIGNED_AMOUNT = {
  $cond: [IS_REFUND, { $multiply: ["$amount", -1] }, "$amount"],
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pad2 = (n) => String(n).padStart(2, "0");
const sendError = (res, status, message) =>
  res.status(status).json({ success: false, error: message });
const unwrap = (r) =>
  r && typeof r === "object" && "ok" in r && "value" in r ? r.value : r; // driver v5 vs v6

const asObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return ObjectId.isValid(s) && new ObjectId(s).toString() === s
    ? new ObjectId(s)
    : null;
};

const compact = (obj) =>
  Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null),
  );

const tenantMatch = (req) => {
  const t = req.tenant_id || req.tenantId || req.user?.tenant_id;
  return t ? { tenant_id: String(t) } : {};
};

const actor = (req) => ({
  id: asObjectId(req.user?._id || req.user?.id),
  name:
    req.user?.name ||
    [req.user?.first_name, req.user?.last_name].filter(Boolean).join(" ") ||
    req.user?.email ||
    undefined,
});

// Rows that count towards money. Rows created before `status` existed are treated as active.
const activeMatch = (req) => ({
  ...tenantMatch(req),
  status: { $ne: "VOIDED" },
});

/* ------------------------------- IST helpers ------------------------------ */

const istParts = (date) => {
  const d = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
};
// Start (00:00 IST) of a month / day, as a real UTC instant. Month/day may overflow safely.
const istMonthStart = (year, month) =>
  new Date(Date.UTC(year, month - 1, 1) - IST_OFFSET_MS);
const istDayStart = (year, month, day) =>
  new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MS);

const parseIstDay = (str) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ""));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const start = istDayStart(y, mo, d);
  const check = istParts(start);
  return check.year === y && check.month === mo && check.day === d
    ? start
    : null;
};

const resolveRange = (q) => {
  const now = istParts(new Date());
  let start, end, type, label;

  if (q.period === "today") {
    start = istDayStart(now.year, now.month, now.day);
    end = istDayStart(now.year, now.month, now.day + 1);
    type = "today";
    label = `${now.year}-${pad2(now.month)}-${pad2(now.day)}`;
  } else if (q.period === "this_month") {
    start = istMonthStart(now.year, now.month);
    end = istMonthStart(now.year, now.month + 1);
    type = "this_month";
    label = `${now.year}-${pad2(now.month)}`;
  } else if (q.period === "this_year") {
    start = istMonthStart(now.year, 1);
    end = istMonthStart(now.year + 1, 1);
    type = "this_year";
    label = String(now.year);
  } else if (q.month || q.year) {
    const month = parseInt(q.month, 10) || now.month;
    const year = parseInt(q.year, 10) || now.year;
    if (month < 1 || month > 12 || year < 2000 || year > 2100)
      return { error: "Invalid month/year" };
    start = istMonthStart(year, month);
    end = istMonthStart(year, month + 1);
    type = "month";
    label = `${year}-${pad2(month)}`;
  } else if (q.from && q.to) {
    start = parseIstDay(q.from);
    const toStart = parseIstDay(q.to);
    if (!start || !toStart) return { error: "from/to must be YYYY-MM-DD" };
    end = new Date(toStart.getTime() + 24 * 60 * 60 * 1000); // `to` is inclusive
    if (end <= start) return { error: "`to` must not be before `from`" };
    if ((end - start) / 86400000 > MAX_REPORT_DAYS)
      return { error: `Range cannot exceed ${MAX_REPORT_DAYS} days` };
    type = "custom";
    label = `${q.from}..${q.to}`;
  } else {
    return { error: "Provide period, month/year, or from/to" };
  }
  return { start, end, type, label };
};

/* ------------------------------ Receipt numbers --------------------------- */

const nextReceiptNumber = async (orgDb, prefix, tenantId, when) => {
  const { year, month } = istParts(when);
  const fyStart = month >= 4 ? year : year - 1; // Indian financial year
  const fy = `${String(fyStart).slice(-2)}${String(fyStart + 1).slice(-2)}`;
  const key = `${prefix}:${tenantId || "default"}:${fy}`;
  const r = await orgDb
    .collection("payment_counters")
    .findOneAndUpdate(
      { _id: key },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" },
    );
  const seq = unwrap(r)?.seq;
  if (!seq) throw new Error("Could not allocate receipt number");
  return `${prefix}-${fy}-${String(seq).padStart(6, "0")}`;
};

/* -------------------------------- Validation ------------------------------ */

const parseAmount = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1e9 ? round2(n) : null;
};

const cleanStr = (v, max = 500) => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s.slice(0, max) : undefined;
};

/**
 * Validates only the keys present in `input`. With {create:true}, required keys are enforced.
 * Returns { errors, value }.
 */
const validateFields = (input, { create = false } = {}) => {
  const errors = [];
  const value = {};

  if (create) {
    const pid = asObjectId(input.patient_id);
    if (!pid) errors.push("patient_id is required and must be a valid id");
    else value.patient_id = pid;
  }

  if (create || input.amount !== undefined) {
    const amt = parseAmount(input.amount);
    if (amt === null) errors.push("amount must be a positive number");
    else value.amount = amt;
  }

  if (create || input.mode !== undefined) {
    const mode = String(input.mode || "").toUpperCase();
    if (!PAYMENT_MODES.includes(mode))
      errors.push(`mode must be one of: ${PAYMENT_MODES.join(", ")}`);
    else value.mode = mode;
  }

  if (input.purpose !== undefined) {
    const purpose = String(input.purpose).toUpperCase();
    if (!PAYMENT_PURPOSES.includes(purpose))
      errors.push(`purpose must be one of: ${PAYMENT_PURPOSES.join(", ")}`);
    else value.purpose = purpose;
  }

  if (input.date !== undefined) {
    const d = new Date(input.date);
    if (Number.isNaN(d.getTime())) errors.push("date is invalid");
    else if (d.getTime() > Date.now() + 5 * 60 * 1000)
      errors.push("date cannot be in the future");
    else value.date = d;
  }

  if (input.line_items !== undefined) {
    if (!Array.isArray(input.line_items) || input.line_items.length > 50) {
      errors.push("line_items must be an array (max 50)");
    } else {
      const items = [];
      for (const it of input.line_items) {
        const name = cleanStr(it?.name, 100);
        const a = Number(it?.amount);
        if (!name || !Number.isFinite(a) || a < 0) {
          errors.push("each line item needs a name and a non-negative amount");
          break;
        }
        items.push({ name, amount: round2(a) });
      }
      value.line_items = items;
    }
  }

  for (const key of [
    "receipt_number",
    "transaction_ref",
    "notes",
    "location_id",
    "location_name",
    "location_address",
  ]) {
    if (input[key] !== undefined)
      value[key] = cleanStr(input[key], key === "notes" ? 1000 : 200);
  }

  if (
    input.invoice_id !== undefined &&
    input.invoice_id !== null &&
    input.invoice_id !== ""
  ) {
    const inv = asObjectId(input.invoice_id);
    if (!inv) errors.push("invoice_id is invalid");
    else value.invoice_id = inv;
  }

  if (input.isViaHealtrack !== undefined)
    value.isViaHealtrack = Boolean(input.isViaHealtrack);

  if (value.line_items && value.amount !== undefined) {
    const sum = value.line_items.reduce((s, i) => s + i.amount, 0);
    if (sum > value.amount + 0.001)
      errors.push("line_items total cannot exceed amount");
  }

  return { errors, value };
};

/* -------------------------------------------------------------------------- */
/* Access control middleware                                                   */
/* -------------------------------------------------------------------------- */

// Expects your auth middleware to set req.user.role. Adjust if your shape differs.
const requirePaymentAccess = (req, res, next) => {
  const roles = []
    .concat(req.user?.roles || req.user?.role || [])
    .map((r) => String(r).toLowerCase());
  if (!roles.some((r) => PAYMENT_ROLES.includes(r))) {
    return sendError(res, 403, "You do not have access to payments");
  }
  next();
};

/* -------------------------------------------------------------------------- */
/* CREATE                                                                      */
/* -------------------------------------------------------------------------- */

// Builds and inserts one PAYMENT row. `value` must come from validateFields(..., { create: true }).
// Shared by createPayment and by package creation (the "received now" amount).
const insertPaymentDoc = async (req, value, patient) => {
  const { orgDb } = req;
  const who = actor(req);
  const date = value.date || new Date();
  const tenantId = tenantMatch(req).tenant_id;

  const receipt_number =
    value.receipt_number ||
    (await nextReceiptNumber(orgDb, "RCPT", tenantId, date));

  const now = new Date();
  const doc = compact({
    ...tenantMatch(req),
    patient_id: value.patient_id,
    location_id: value.location_id ?? patient?.location_id,
    location_name: value.location_name ?? patient?.location_name,
    location_address: value.location_address,
    amount: value.amount,
    entry_type: "PAYMENT",
    mode: value.mode,
    purpose: value.purpose || "OTHER",
    line_items: value.line_items || [],
    date,
    receipt_number,
    transaction_ref: value.transaction_ref,
    notes: value.notes,
    recorded_by_id: who.id,
    recorded_by_name: who.name,
    invoice_id: value.invoice_id,
    isViaHealtrack: value.isViaHealtrack ?? false,
    status: "ACTIVE",
    edit_history: [],
    createdAt: now,
    updatedAt: now,
  });

  const { insertedId } = await orgDb.collection("payments").insertOne(doc);
  return { _id: insertedId, ...doc };
};

const createPayment = async (req, res) => {
  try {
    const { orgDb } = req;
    const { errors, value } = validateFields(req.body || {}, { create: true });
    if (errors.length) return sendError(res, 400, errors.join("; "));

    const patient = await orgDb
      .collection("patients")
      .findOne(
        { _id: value.patient_id },
        { projection: { location_id: 1, location_name: 1 } },
      );
    if (!patient) return sendError(res, 404, "Patient not found");

    const payment = await insertPaymentDoc(req, value, patient);
    return res.status(201).json({ success: true, payment });
  } catch (err) {
    if (err?.code === 11000)
      return sendError(
        res,
        409,
        "A payment with this receipt number already exists",
      );
    console.error("createPayment error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

/* -------------------------------------------------------------------------- */
/* REFUND                                                                      */
/* -------------------------------------------------------------------------- */

const createRefund = async (req, res) => {
  try {
    const { orgDb } = req;
    const paymentId = asObjectId(req.params.id || req.body?.payment_id);
    if (!paymentId)
      return sendError(res, 400, "A valid payment id is required");

    const amount = parseAmount(req.body?.amount);
    if (amount === null)
      return sendError(res, 400, "amount must be a positive number");

    const reason = cleanStr(req.body?.notes, 1000);
    if (!reason)
      return sendError(res, 400, "notes (reason for refund) is required");

    let mode;
    if (req.body?.mode !== undefined) {
      mode = String(req.body.mode).toUpperCase();
      if (!PAYMENT_MODES.includes(mode))
        return sendError(
          res,
          400,
          `mode must be one of: ${PAYMENT_MODES.join(", ")}`,
        );
    }

    const original = await orgDb
      .collection("payments")
      .findOne({ _id: paymentId, ...tenantMatch(req) });
    if (!original) return sendError(res, 404, "Payment not found");
    if (original.entry_type === "REFUND")
      return sendError(res, 400, "A refund cannot be refunded");
    if (original.status === "VOIDED")
      return sendError(res, 409, "Cannot refund a voided payment");

    const [agg] = await orgDb
      .collection("payments")
      .aggregate([
        { $match: { refund_of: paymentId, status: { $ne: "VOIDED" } } },
        { $group: { _id: null, refunded: { $sum: "$amount" } } },
      ])
      .toArray();
    const refundable = round2(original.amount - (agg?.refunded || 0));
    if (amount > refundable + 0.001) {
      return sendError(
        res,
        409,
        `Refund exceeds refundable balance (${refundable})`,
      );
    }

    const who = actor(req);
    const now = new Date();
    const doc = compact({
      ...tenantMatch(req),
      patient_id: original.patient_id,
      location_id: original.location_id,
      location_name: original.location_name,
      location_address: original.location_address,
      amount,
      entry_type: "REFUND",
      refund_of: original._id,
      mode: mode || original.mode,
      purpose: original.purpose || "OTHER",
      line_items: [],
      date: now,
      receipt_number: await nextReceiptNumber(
        orgDb,
        "RFND",
        tenantMatch(req).tenant_id,
        now,
      ),
      transaction_ref: cleanStr(req.body?.transaction_ref, 200),
      notes: reason,
      recorded_by_id: who.id,
      recorded_by_name: who.name,
      status: "ACTIVE",
      edit_history: [],
      createdAt: now,
      updatedAt: now,
    });

    const { insertedId } = await orgDb.collection("payments").insertOne(doc);
    return res.status(201).json({
      success: true,
      refund: { _id: insertedId, ...doc },
      refundable_remaining: round2(refundable - amount),
    });
  } catch (err) {
    if (err?.code === 11000)
      return sendError(res, 409, "Duplicate receipt number, please retry");
    console.error("createRefund error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

/* -------------------------------------------------------------------------- */
/* READ (list + single)                                                        */
/* -------------------------------------------------------------------------- */

const listPayments = async (req, res) => {
  try {
    const { orgDb } = req;
    const q = req.query;

    const page = Math.max(parseInt(q.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(q.limit, 10) || 25, 1),
      MAX_PAGE_SIZE,
    );

    const match = { ...tenantMatch(req) };
    if (q.patient_id) {
      const pid = asObjectId(q.patient_id);
      if (!pid) return sendError(res, 400, "patient_id is invalid");
      match.patient_id = pid;
    }
    if (q.location_id) match.location_id = String(q.location_id);
    if (q.mode) match.mode = String(q.mode).toUpperCase();
    if (q.purpose) match.purpose = String(q.purpose).toUpperCase();
    if (q.entry_type) match.entry_type = String(q.entry_type).toUpperCase();
    if (q.status) match.status = String(q.status).toUpperCase();
    else if (q.include_voided !== "true") match.status = { $ne: "VOIDED" };
    if (q.receipt_number) match.receipt_number = String(q.receipt_number);

    if (q.from || q.to) {
      match.date = {};
      if (q.from) {
        const s = parseIstDay(q.from);
        if (!s) return sendError(res, 400, "from must be YYYY-MM-DD");
        match.date.$gte = s;
      }
      if (q.to) {
        const e = parseIstDay(q.to);
        if (!e) return sendError(res, 400, "to must be YYYY-MM-DD");
        match.date.$lt = new Date(e.getTime() + 86400000);
      }
    }

    const [rows, total, sums] = await Promise.all([
      orgDb
        .collection("payments")
        .find(match)
        .sort({ date: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      orgDb.collection("payments").countDocuments(match),
      orgDb
        .collection("payments")
        .aggregate([
          { $match: { ...match, status: match.status || { $ne: "VOIDED" } } },
          {
            $group: {
              _id: null,
              collected: { $sum: { $cond: [IS_REFUND, 0, "$amount"] } },
              refunded: { $sum: { $cond: [IS_REFUND, "$amount", 0] } },
            },
          },
        ])
        .toArray(),
    ]);

    // Attach patient names for the page in one query.
    const ids = [...new Set(rows.map((r) => String(r.patient_id)))].map(
      (i) => new ObjectId(i),
    );
    const patients = ids.length
      ? await orgDb
          .collection("patients")
          .find(
            { _id: { $in: ids } },
            {
              projection: {
                patient_first_name: 1,
                patient_last_name: 1,
                UHID: 1,
                patient_id: 1,
              },
            },
          )
          .toArray()
      : [];
    const pmap = new Map(patients.map((p) => [String(p._id), p]));

    const payments = rows.map((r) => {
      const p = pmap.get(String(r.patient_id));
      return {
        ...r,
        patient: p
          ? {
              _id: p._id,
              name: `${p.patient_first_name || ""} ${p.patient_last_name || ""}`.trim(),
              UHID: p.UHID,
              patient_id: p.patient_id,
            }
          : null,
      };
    });

    const collected = round2(sums[0]?.collected || 0);
    const refunded = round2(sums[0]?.refunded || 0);

    return res.json({
      success: true,
      payments,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      totals: { collected, refunded, net: round2(collected - refunded) },
    });
  } catch (err) {
    console.error("listPayments error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

const getPayment = async (req, res) => {
  try {
    const { orgDb } = req;
    const id = asObjectId(req.params.id);
    if (!id) return sendError(res, 400, "Invalid payment id");

    const payment = await orgDb
      .collection("payments")
      .findOne({ _id: id, ...tenantMatch(req) });
    if (!payment) return sendError(res, 404, "Payment not found");

    const [patient, refunds] = await Promise.all([
      orgDb.collection("patients").findOne(
        { _id: payment.patient_id },
        {
          projection: {
            patient_first_name: 1,
            patient_last_name: 1,
            UHID: 1,
            patient_phone: 1,
          },
        },
      ),
      payment.entry_type === "REFUND"
        ? []
        : orgDb
            .collection("payments")
            .find({ refund_of: id })
            .sort({ date: 1 })
            .toArray(),
    ]);

    const activeRefunded = round2(
      refunds
        .filter((r) => r.status !== "VOIDED")
        .reduce((s, r) => s + r.amount, 0),
    );

    return res.json({
      success: true,
      payment,
      patient,
      refunds,
      refundable_remaining:
        payment.entry_type === "REFUND"
          ? 0
          : round2(payment.amount - activeRefunded),
    });
  } catch (err) {
    console.error("getPayment error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

/* -------------------------------------------------------------------------- */
/* UPDATE (audited)                                                            */
/* -------------------------------------------------------------------------- */

const EDITABLE = [
  "amount",
  "mode",
  "purpose",
  "date",
  "line_items",
  "transaction_ref",
  "notes",
  "invoice_id",
  "location_id",
  "location_name",
  "location_address",
];

const updatePayment = async (req, res) => {
  try {
    const { orgDb } = req;
    const id = asObjectId(req.params.id);
    if (!id) return sendError(res, 400, "Invalid payment id");

    const input = Object.fromEntries(
      Object.entries(req.body || {}).filter(([k]) => EDITABLE.includes(k)),
    );
    if (!Object.keys(input).length)
      return sendError(res, 400, "No editable fields supplied");

    const existing = await orgDb
      .collection("payments")
      .findOne({ _id: id, ...tenantMatch(req) });
    if (!existing) return sendError(res, 404, "Payment not found");
    if (existing.status === "VOIDED")
      return sendError(res, 409, "A voided payment cannot be edited");

    // Cross-field validation uses the merged amount so line_items can be checked on their own.
    const { errors, value } = validateFields({
      ...input,
      ...(input.line_items !== undefined && input.amount === undefined
        ? { amount: existing.amount }
        : {}),
    });
    if (errors.length) return sendError(res, 400, errors.join("; "));
    if (
      input.line_items === undefined &&
      value.amount !== undefined &&
      existing.line_items?.length
    ) {
      const sum = existing.line_items.reduce((s, i) => s + i.amount, 0);
      if (sum > value.amount + 0.001)
        return sendError(
          res,
          400,
          "amount cannot be lower than the existing line_items total",
        );
    }

    if (value.amount !== undefined && value.amount !== existing.amount) {
      if (existing.entry_type === "REFUND")
        return sendError(
          res,
          400,
          "Refund amounts cannot be edited; void and recreate it",
        );
      const [agg] = await orgDb
        .collection("payments")
        .aggregate([
          { $match: { refund_of: id, status: { $ne: "VOIDED" } } },
          { $group: { _id: null, refunded: { $sum: "$amount" } } },
        ])
        .toArray();
      if (value.amount < (agg?.refunded || 0) - 0.001) {
        return sendError(
          res,
          409,
          "amount cannot be lower than what has already been refunded",
        );
      }
    }

    const changes = [];
    for (const [field, to] of Object.entries(value)) {
      const from = existing[field];
      const same = JSON.stringify(from ?? null) === JSON.stringify(to ?? null);
      if (!same) changes.push({ field, from: from ?? null, to });
    }
    if (!changes.length)
      return res.json({ success: true, payment: existing, unchanged: true });

    const who = actor(req);
    const r = await orgDb.collection("payments").findOneAndUpdate(
      { _id: id, status: { $ne: "VOIDED" } },
      {
        $set: { ...value, updatedAt: new Date() },
        $push: {
          edit_history: compact({
            edited_at: new Date(),
            edited_by_id: who.id,
            edited_by_name: who.name,
            changes,
          }),
        },
      },
      { returnDocument: "after" },
    );
    const payment = unwrap(r);
    if (!payment)
      return sendError(
        res,
        409,
        "Payment was modified or voided, please reload",
      );

    return res.json({ success: true, payment });
  } catch (err) {
    console.error("updatePayment error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

/* -------------------------------------------------------------------------- */
/* DELETE (soft: void with reason)                                             */
/* -------------------------------------------------------------------------- */

const voidPayment = async (req, res) => {
  try {
    const { orgDb } = req;
    const id = asObjectId(req.params.id);
    if (!id) return sendError(res, 400, "Invalid payment id");

    const reason = cleanStr(req.body?.reason, 1000);
    if (!reason)
      return sendError(res, 400, "reason is required to void a payment");

    const existing = await orgDb
      .collection("payments")
      .findOne({ _id: id, ...tenantMatch(req) });
    if (!existing) return sendError(res, 404, "Payment not found");
    if (existing.status === "VOIDED")
      return sendError(res, 409, "Payment is already voided");

    if (existing.entry_type !== "REFUND") {
      const activeRefunds = await orgDb
        .collection("payments")
        .countDocuments({ refund_of: id, status: { $ne: "VOIDED" } });
      if (activeRefunds > 0)
        return sendError(
          res,
          409,
          "Void the refunds against this payment first",
        );
    }

    const who = actor(req);
    const r = await orgDb.collection("payments").findOneAndUpdate(
      { _id: id, status: { $ne: "VOIDED" } },
      {
        $set: compact({
          status: "VOIDED",
          voided_at: new Date(),
          voided_by_id: who.id,
          voided_by_name: who.name,
          void_reason: reason,
          updatedAt: new Date(),
        }),
      },
      { returnDocument: "after" },
    );
    const payment = unwrap(r);
    if (!payment) return sendError(res, 409, "Payment was already voided");

    return res.json({ success: true, payment });
  } catch (err) {
    console.error("voidPayment error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

/* -------------------------------------------------------------------------- */
/* PATIENT LEDGER                                                              */
/* -------------------------------------------------------------------------- */

const getPatientPaymentSummary = async (req, res) => {
  try {
    const { orgDb } = req;
    const patientId = asObjectId(req.params.patientId);
    if (!patientId) return sendError(res, 400, "Invalid patient id");

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 50, 1),
      MAX_PAGE_SIZE,
    );

    const patient = await orgDb.collection("patients").findOne(
      { _id: patientId },
      {
        projection: {
          billing: 1,
          patient_first_name: 1,
          patient_last_name: 1,
          UHID: 1,
          previous_patient_id: 1,
        },
      },
    );
    if (!patient) return sendError(res, 404, "Patient not found");

    const listMatch = { patient_id: patientId, ...tenantMatch(req) };
    const [byPurpose, payments, total] = await Promise.all([
      orgDb
        .collection("payments")
        .aggregate([
          { $match: { ...listMatch, status: { $ne: "VOIDED" } } },
          {
            $group: {
              _id: "$purpose",
              collected: { $sum: { $cond: [IS_REFUND, 0, "$amount"] } },
              refunded: { $sum: { $cond: [IS_REFUND, "$amount", 0] } },
              payment_count: { $sum: { $cond: [IS_REFUND, 0, 1] } },
            },
          },
        ])
        .toArray(),
      orgDb
        .collection("payments")
        .find(listMatch)
        .sort({ date: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      orgDb.collection("payments").countDocuments(listMatch),
    ]);

    const collected = round2(byPurpose.reduce((s, r) => s + r.collected, 0));
    const refunded = round2(byPurpose.reduce((s, r) => s + r.refunded, 0));
    const netPaid = round2(collected - refunded);

    // The active patient package is the source of truth; patient.billing is only a legacy fallback.
    const activePackage = await orgDb.collection("patient_packages").findOne({
      patient_id: patientId,
      status: "ACTIVE",
      ...tenantMatch(req),
    });

    const packageAmount = activePackage
      ? activePackage.gross_amount || 0
      : patient.billing?.package_amount || 0;
    const discount = activePackage
      ? activePackage.discount_amount || 0
      : patient.billing?.discount || 0;
    const totalDue = round2(Math.max(packageAmount - discount, 0));

    return res.json({
      success: true,
      patient: {
        _id: patient._id,
        name: `${patient.patient_first_name || ""} ${patient.patient_last_name || ""}`.trim(),
        UHID: patient.UHID,
      },
      package: activePackage
        ? {
            _id: activePackage._id,
            name: activePackage.name,
            items: activePackage.items,
            duration_days: activePackage.duration_days,
          }
        : null,
      summary: {
        package_amount: packageAmount,
        discount,
        total_due: totalDue,
        total_collected: collected,
        total_refunded: refunded,
        net_paid: netPaid,
        balance: round2(totalDue - netPaid), // negative = patient has overpaid / credit
      },
      by_purpose: byPurpose.map((r) => ({
        purpose: r._id || "OTHER",
        collected: round2(r.collected),
        refunded: round2(r.refunded),
        net: round2(r.collected - r.refunded),
        payment_count: r.payment_count,
      })),
      payments,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("getPatientPaymentSummary error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

/* -------------------------------------------------------------------------- */
/* REPORTS (no doctor dimension)                                               */
/* -------------------------------------------------------------------------- */

const GROUPS = {
  purpose: { key: "$purpose", label: "$purpose" },
  mode: { key: "$mode", label: "$mode" },
  location: {
    key: { $ifNull: ["$location_id", "unassigned"] },
    label: { $ifNull: ["$location_name", "Unassigned"] },
  },
  staff: {
    key: { $ifNull: ["$recorded_by_id", "unassigned"] },
    label: { $ifNull: ["$recorded_by_name", "Unassigned"] },
  },
  day: {
    key: { $dateToString: { format: "%Y-%m-%d", date: "$date", timezone: TZ } },
    label: {
      $dateToString: { format: "%Y-%m-%d", date: "$date", timezone: TZ },
    },
  },
};

// GET /reports/collections?period=this_month|today|this_year | month=&year= | from=&to=
//     &group_by=purpose|mode|location|staff|day  &location_id=
const getCollectionsReport = async (req, res) => {
  try {
    const { orgDb } = req;
    const range = resolveRange(req.query);
    if (range.error) return sendError(res, 400, range.error);

    const groupBy = req.query.group_by || "purpose";
    const g = GROUPS[groupBy];
    if (!g)
      return sendError(
        res,
        400,
        `group_by must be one of: ${Object.keys(GROUPS).join(", ")}`,
      );

    const match = {
      ...activeMatch(req),
      date: { $gte: range.start, $lt: range.end },
    };
    if (req.query.location_id)
      match.location_id = String(req.query.location_id);

    const rows = await orgDb
      .collection("payments")
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: g.key,
            label: { $first: g.label },
            collected: { $sum: { $cond: [IS_REFUND, 0, "$amount"] } },
            refunded: { $sum: { $cond: [IS_REFUND, "$amount", 0] } },
            payment_count: { $sum: { $cond: [IS_REFUND, 0, 1] } },
            refund_count: { $sum: { $cond: [IS_REFUND, 1, 0] } },
          },
        },
        { $sort: groupBy === "day" ? { _id: 1 } : { collected: -1 } },
      ])
      .toArray();

    const out = rows.map((r) => ({
      key: r._id,
      label: r.label ?? String(r._id),
      collected: round2(r.collected),
      refunded: round2(r.refunded),
      net: round2(r.collected - r.refunded),
      payment_count: r.payment_count,
      refund_count: r.refund_count,
    }));

    const summary = out.reduce(
      (s, r) => ({
        collected: s.collected + r.collected,
        refunded: s.refunded + r.refunded,
        payment_count: s.payment_count + r.payment_count,
        refund_count: s.refund_count + r.refund_count,
      }),
      { collected: 0, refunded: 0, payment_count: 0, refund_count: 0 },
    );

    return res.json({
      success: true,
      period: range.label,
      period_type: range.type,
      group_by: groupBy,
      location_filter: req.query.location_id || "all",
      summary: {
        collected: round2(summary.collected),
        refunded: round2(summary.refunded),
        net: round2(summary.collected - summary.refunded),
        payment_count: summary.payment_count,
        refund_count: summary.refund_count,
      },
      rows: out,
    });
  } catch (err) {
    console.error("getCollectionsReport error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

// GET /reports/monthly-comparison?months=6&location_id=
const getMonthlyComparison = async (req, res) => {
  try {
    const { orgDb } = req;
    const months = Math.min(
      Math.max(parseInt(req.query.months, 10) || 6, 1),
      24,
    );
    const { year, month } = istParts(new Date());

    const start = istMonthStart(year, month - (months - 1));
    const end = istMonthStart(year, month + 1);

    const match = { ...activeMatch(req), date: { $gte: start, $lt: end } };
    if (req.query.location_id)
      match.location_id = String(req.query.location_id);

    const rows = await orgDb
      .collection("payments")
      .aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m", date: "$date", timezone: TZ },
            },
            collected: { $sum: { $cond: [IS_REFUND, 0, "$amount"] } },
            refunded: { $sum: { $cond: [IS_REFUND, "$amount", 0] } },
            payment_count: { $sum: { $cond: [IS_REFUND, 0, 1] } },
          },
        },
      ])
      .toArray();
    const byPeriod = new Map(rows.map((r) => [r._id, r]));

    const comparison = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(year, month - 1 - i, 1));
      const period = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
      const r = byPeriod.get(period);
      const collected = round2(r?.collected || 0);
      const refunded = round2(r?.refunded || 0);
      comparison.push({
        period,
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        collected,
        refunded,
        net: round2(collected - refunded),
        payment_count: r?.payment_count || 0,
      });
    }

    return res.json({
      success: true,
      location_filter: req.query.location_id || "all",
      comparison_months: months,
      comparison, // oldest -> newest
    });
  } catch (err) {
    console.error("getMonthlyComparison error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

module.exports = {
  requirePaymentAccess,
  validateFields,
  insertPaymentDoc,
  createPayment,
  createRefund,
  listPayments,
  getPayment,
  updatePayment,
  voidPayment,
  getPatientPaymentSummary,
  getCollectionsReport,
  getMonthlyComparison,
};
