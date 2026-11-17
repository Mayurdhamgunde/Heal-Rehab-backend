const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;
// Reused so the "received now" amount becomes a real payment with a proper receipt number.
const {
  validateFields: validatePaymentFields,
  insertPaymentDoc,
} = require("./paymentController");

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const MAX_PAGE_SIZE = 100;
const MAX_ITEMS = 30;
const MAX_MONEY = 1e9;

const IS_REFUND = { $eq: ["$entry_type", "REFUND"] };
const SIGNED_AMOUNT = {
  $cond: [IS_REFUND, { $multiply: ["$amount", -1] }, "$amount"],
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const sendError = (res, status, message) =>
  res.status(status).json({ success: false, error: message });
const unwrap = (r) =>
  r && typeof r === "object" && "ok" in r && "value" in r ? r.value : r; // driver v5 vs v6
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const asObjectId = (v) => {
  if (!v) return null;
  const s = String(v);
  return ObjectId.isValid(s) && new ObjectId(s).toString() === s
    ? new ObjectId(s)
    : null;
};

const cleanStr = (v, max = 500) => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s.slice(0, max) : undefined;
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

const normalize = (v) =>
  v instanceof Date ? v.toISOString() : JSON.stringify(v ?? null);

const parseMoney = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= MAX_MONEY ? round2(n) : null;
};

const parseOptionalInt = (v) => {
  if (v === undefined) return { provided: false };
  if (v === null || v === "") return { provided: true, value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 3650)
    return {
      provided: true,
      error: "duration_days must be a whole number between 1 and 3650",
    };
  return { provided: true, value: n };
};

const parseOptionalDate = (v) => {
  if (v === undefined) return { provided: false };
  if (v === null || v === "") return { provided: true, value: null };
  const d = new Date(v);
  if (
    Number.isNaN(d.getTime()) ||
    d.getFullYear() < 2000 ||
    d.getFullYear() > 2100
  ) {
    return { provided: true, error: "start_date is invalid" };
  }
  return { provided: true, value: d };
};

const parseItems = (raw) => {
  if (!Array.isArray(raw) || raw.length === 0)
    return { error: "At least one charge item is required" };
  if (raw.length > MAX_ITEMS)
    return { error: `A package can have at most ${MAX_ITEMS} items` };
  const items = [];
  for (const it of raw) {
    const name = cleanStr(it?.name, 100);
    const blank =
      it?.amount === undefined || it?.amount === null || it?.amount === "";
    const amount = blank ? NaN : Number(it.amount);
    if (!name || !Number.isFinite(amount) || amount < 0 || amount > MAX_MONEY) {
      return { error: "Each item needs a name and a non-negative amount" };
    }
    items.push({ name, amount: round2(amount) });
  }
  return { items };
};

const sumItems = (items) => round2(items.reduce((s, i) => s + i.amount, 0));

const fullName = (p) =>
  [p?.patient_first_name, p?.patient_middle_name, p?.patient_last_name]
    .filter(Boolean)
    .join(" ");

// Create the indexes the module relies on (notably "one ACTIVE package per patient"). Cheap after the first call.
const indexedDbs = new Set();
const ensureIndexes = async (orgDb) => {
  const key = orgDb?.databaseName || orgDb?.name || orgDb?.db?.databaseName;
  if (key && indexedDbs.has(key)) return;
  try {
    const pkgs = orgDb.collection("patient_packages");
    await pkgs.createIndex(
      { patient_id: 1 },
      {
        unique: true,
        partialFilterExpression: { status: "ACTIVE" },
        name: "one_active_package_per_patient",
      },
    );
    await pkgs.createIndex({ patient_id: 1, status: 1 });
    await pkgs.createIndex({ status: 1, createdAt: -1 });
    await orgDb
      .collection("package_templates")
      .createIndex({ tenant_id: 1, name_key: 1 }, { unique: true });
    if (key) indexedDbs.add(key);
  } catch (err) {
    console.error("Package index setup failed:", err);
  }
};

const paymentTotalsForPatient = async (orgDb, patientId) => {
  const [row] = await orgDb
    .collection("payments")
    .aggregate([
      { $match: { patient_id: patientId, status: { $ne: "VOIDED" } } },
      {
        $group: {
          _id: null,
          collected: { $sum: { $cond: [IS_REFUND, 0, "$amount"] } },
          refunded: { $sum: { $cond: [IS_REFUND, "$amount", 0] } },
        },
      },
    ])
    .toArray();
  const collected = round2(row?.collected || 0);
  const refunded = round2(row?.refunded || 0);
  return { collected, refunded, paid: round2(collected - refunded) };
};

/* -------------------------------------------------------------------------- */
/* PATIENT PACKAGES                                                            */
/* -------------------------------------------------------------------------- */

// POST /packages
const createPackage = async (req, res) => {
  try {
    const { orgDb } = req;
    const b = req.body || {};

    const patientId = asObjectId(b.patient_id);
    if (!patientId)
      return sendError(
        res,
        400,
        "patient_id is required and must be a valid id",
      );

    let template = null;
    let templateId = null;
    if (b.template_id) {
      templateId = asObjectId(b.template_id);
      if (!templateId) return sendError(res, 400, "template_id is invalid");
      template = await orgDb
        .collection("package_templates")
        .findOne({ _id: templateId, ...tenantMatch(req) });
      if (!template) return sendError(res, 404, "Package template not found");
    }

    let items;
    if (b.items === undefined && template) {
      items = template.items;
    } else {
      const parsed = parseItems(b.items);
      if (parsed.error) return sendError(res, 400, parsed.error);
      items = parsed.items;
    }

    const name = cleanStr(b.name, 120) || template?.name;
    if (!name) return sendError(res, 400, "Package name is required");

    const gross = sumItems(items);
    const discount =
      b.discount_amount === undefined || b.discount_amount === ""
        ? 0
        : parseMoney(b.discount_amount);
    if (discount === null)
      return sendError(
        res,
        400,
        "discount_amount must be a non-negative number",
      );
    if (discount > gross + 0.001)
      return sendError(
        res,
        400,
        "Discount cannot be more than the package total",
      );
    const discountReason = cleanStr(b.discount_reason, 300);
    if (discount > 0 && !discountReason)
      return sendError(res, 400, "A reason is required when giving a discount");

    const duration = parseOptionalInt(b.duration_days);
    if (duration.error) return sendError(res, 400, duration.error);
    const start = parseOptionalDate(b.start_date);
    if (start.error) return sendError(res, 400, start.error);

    // Optional amount received at the time of assigning the package (advance / first instalment).
    const net = round2(gross - discount);
    let received = null;
    const rp = b.received_payment;
    if (
      rp &&
      rp.amount !== undefined &&
      rp.amount !== null &&
      rp.amount !== "" &&
      Number(rp.amount) !== 0
    ) {
      const checked = validatePaymentFields(
        { ...rp, patient_id: String(patientId) },
        { create: true },
      );
      if (checked.errors.length)
        return sendError(
          res,
          400,
          `Received payment: ${checked.errors.join("; ")}`,
        );
      if (checked.value.amount > net + 0.001) {
        return sendError(
          res,
          400,
          `The received amount cannot be more than the net payable (${net})`,
        );
      }
      received = {
        ...checked.value,
        purpose: checked.value.purpose || "ADMISSION",
      };
    }

    const patient = await orgDb
      .collection("patients")
      .findOne(
        { _id: patientId },
        { projection: { _id: 1, location_id: 1, location_name: 1 } },
      );
    if (!patient) return sendError(res, 404, "Patient not found");

    await ensureIndexes(orgDb);

    const existing = await orgDb
      .collection("patient_packages")
      .findOne(
        { patient_id: patientId, status: "ACTIVE" },
        { projection: { _id: 1, name: 1 } },
      );
    if (existing) {
      return res.status(409).json({
        success: false,
        error: `This patient already has an active package ("${existing.name}"). Edit or cancel it first.`,
        existing_package_id: existing._id,
      });
    }

    const who = actor(req);
    const now = new Date();
    const doc = compact({
      ...tenantMatch(req),
      patient_id: patientId,
      template_id: templateId,
      name,
      items,
      gross_amount: gross,
      discount_amount: discount,
      discount_reason: discount > 0 ? discountReason : undefined,
      net_amount: net,
      duration_days: duration.value ?? template?.duration_days,
      start_date: start.value || now,
      notes: cleanStr(b.notes, 1000),
      status: "ACTIVE",
      created_by_id: who.id,
      created_by_name: who.name,
      revision_history: [],
      createdAt: now,
      updatedAt: now,
    });

    const { insertedId } = await orgDb
      .collection("patient_packages")
      .insertOne(doc);

    let payment = null;
    if (received) {
      try {
        payment = await insertPaymentDoc(
          req,
          {
            ...received,
            notes: received.notes || `Received when assigning package: ${name}`,
          },
          patient,
        );
      } catch (payErr) {
        // Keep the books consistent: never leave a package behind without the money the user said was received.
        console.error(
          "createPackage: recording the received payment failed, rolling back:",
          payErr,
        );
        await orgDb
          .collection("patient_packages")
          .deleteOne({ _id: insertedId })
          .catch((e) => console.error("Rollback failed:", e));
        return sendError(
          res,
          500,
          "The received payment could not be recorded, so the package was not created. Please try again.",
        );
      }
    }

    return res
      .status(201)
      .json({ success: true, package: { _id: insertedId, ...doc }, payment });
  } catch (err) {
    if (err?.code === 11000)
      return sendError(res, 409, "This patient already has an active package");
    console.error("createPackage error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

// GET /packages?status=ACTIVE|CANCELLED|ALL&search=&patient_id=&page=&limit=
const listPackages = async (req, res) => {
  try {
    const { orgDb } = req;
    const q = req.query;
    const page = Math.max(parseInt(q.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(q.limit, 10) || 10, 1),
      MAX_PAGE_SIZE,
    );

    const match = { ...tenantMatch(req) };
    const status = String(q.status || "ACTIVE").toUpperCase();
    if (status !== "ALL") {
      if (!["ACTIVE", "CANCELLED"].includes(status))
        return sendError(res, 400, "status must be ACTIVE, CANCELLED or ALL");
      match.status = status;
    }
    if (q.patient_id) {
      const pid = asObjectId(q.patient_id);
      if (!pid) return sendError(res, 400, "patient_id is invalid");
      match.patient_id = pid;
    }

    const pipeline = [
      { $match: match },
      {
        $lookup: {
          from: "patients",
          let: { pid: "$patient_id" },
          pipeline: [
            { $match: { $expr: { $eq: ["$_id", "$$pid"] } } },
            {
              $project: {
                patient_first_name: 1,
                patient_middle_name: 1,
                patient_last_name: 1,
                UHID: 1,
                patient_phone: 1,
              },
            },
          ],
          as: "patient",
        },
      },
      { $addFields: { patient: { $arrayElemAt: ["$patient", 0] } } },
    ];

    const search = cleanStr(q.search, 100);
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      pipeline.push(
        {
          $addFields: {
            _pname: {
              $trim: {
                input: {
                  $concat: [
                    { $ifNull: ["$patient.patient_first_name", ""] },
                    " ",
                    { $ifNull: ["$patient.patient_last_name", ""] },
                  ],
                },
              },
            },
          },
        },
        {
          $match: {
            $or: [
              { _pname: rx },
              { "patient.UHID": rx },
              { "patient.patient_phone": rx },
              { name: rx },
            ],
          },
        },
      );
    }

    const ACTIVE = { $eq: ["$status", "ACTIVE"] };
    pipeline.push(
      {
        $lookup: {
          from: "payments",
          let: { pid: "$patient_id" },
          pipeline: [
            {
              $match: {
                status: { $ne: "VOIDED" },
                $expr: { $eq: ["$patient_id", "$$pid"] },
              },
            },
            { $group: { _id: null, net: { $sum: SIGNED_AMOUNT } } },
          ],
          as: "pay",
        },
      },
      {
        $addFields: {
          paid: { $ifNull: [{ $arrayElemAt: ["$pay.net", 0] }, 0] },
        },
      },
      { $addFields: { balance: { $subtract: ["$net_amount", "$paid"] } } },
      { $project: { pay: 0, _pname: 0 } },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $facet: {
          rows: [{ $skip: (page - 1) * limit }, { $limit: limit }],
          meta: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                billed: { $sum: { $cond: [ACTIVE, "$net_amount", 0] } },
                collected: { $sum: { $cond: [ACTIVE, "$paid", 0] } },
                outstanding: {
                  $sum: { $cond: [ACTIVE, { $max: ["$balance", 0] }, 0] },
                },
              },
            },
          ],
        },
      },
    );

    const [result] = await orgDb
      .collection("patient_packages")
      .aggregate(pipeline)
      .toArray();
    const meta = result?.meta?.[0] || {
      total: 0,
      billed: 0,
      collected: 0,
      outstanding: 0,
    };

    const packages = (result?.rows || []).map((r) => ({
      ...r,
      patient: r.patient
        ? {
            _id: r.patient._id,
            name: fullName(r.patient),
            UHID: r.patient.UHID,
            phone: r.patient.patient_phone,
          }
        : null,
      paid: round2(r.paid),
      balance: round2(r.balance),
    }));

    return res.json({
      success: true,
      packages,
      pagination: {
        page,
        limit,
        total: meta.total,
        pages: Math.max(Math.ceil(meta.total / limit), 1),
      },
      totals: {
        billed: round2(meta.billed),
        collected: round2(meta.collected),
        outstanding: round2(meta.outstanding),
      },
    });
  } catch (err) {
    console.error("listPackages error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

// GET /packages/:id
const getPackage = async (req, res) => {
  try {
    const { orgDb } = req;
    const id = asObjectId(req.params.id);
    if (!id) return sendError(res, 400, "Invalid package id");

    const pkg = await orgDb
      .collection("patient_packages")
      .findOne({ _id: id, ...tenantMatch(req) });
    if (!pkg) return sendError(res, 404, "Package not found");

    const [patient, totals] = await Promise.all([
      orgDb.collection("patients").findOne(
        { _id: pkg.patient_id },
        {
          projection: {
            patient_first_name: 1,
            patient_middle_name: 1,
            patient_last_name: 1,
            UHID: 1,
            patient_phone: 1,
          },
        },
      ),
      paymentTotalsForPatient(orgDb, pkg.patient_id),
    ]);

    return res.json({
      success: true,
      package: pkg,
      patient: patient
        ? {
            _id: patient._id,
            name: fullName(patient),
            UHID: patient.UHID,
            phone: patient.patient_phone,
          }
        : null,
      summary: {
        net_amount: pkg.net_amount,
        collected: totals.collected,
        refunded: totals.refunded,
        paid: totals.paid,
        balance: round2(pkg.net_amount - totals.paid), // negative = patient has overpaid / credit
      },
    });
  } catch (err) {
    console.error("getPackage error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

// PATCH /packages/:id  (audited; a price change needs a revision_note)
const updatePackage = async (req, res) => {
  try {
    const { orgDb } = req;
    const id = asObjectId(req.params.id);
    if (!id) return sendError(res, 400, "Invalid package id");
    const b = req.body || {};

    const existing = await orgDb
      .collection("patient_packages")
      .findOne({ _id: id, ...tenantMatch(req) });
    if (!existing) return sendError(res, 404, "Package not found");
    if (existing.status !== "ACTIVE")
      return sendError(res, 409, "Only an active package can be edited");

    const next = {};

    if (b.name !== undefined) {
      const n = cleanStr(b.name, 120);
      if (!n) return sendError(res, 400, "Package name cannot be empty");
      next.name = n;
    }

    let items = existing.items || [];
    if (b.items !== undefined) {
      const parsed = parseItems(b.items);
      if (parsed.error) return sendError(res, 400, parsed.error);
      items = parsed.items;
      next.items = items;
    }

    const gross = sumItems(items);
    let discount = existing.discount_amount || 0;
    if (b.discount_amount !== undefined) {
      discount =
        b.discount_amount === "" || b.discount_amount === null
          ? 0
          : parseMoney(b.discount_amount);
      if (discount === null)
        return sendError(
          res,
          400,
          "discount_amount must be a non-negative number",
        );
    }
    if (discount > gross + 0.001)
      return sendError(
        res,
        400,
        "Discount cannot be more than the package total",
      );

    let reason =
      b.discount_reason !== undefined
        ? cleanStr(b.discount_reason, 300)
        : existing.discount_reason;
    if (discount > 0 && !reason)
      return sendError(res, 400, "A reason is required when giving a discount");
    if (discount === 0) reason = undefined;

    next.gross_amount = gross;
    next.discount_amount = discount;
    next.discount_reason = reason ?? null;
    next.net_amount = round2(gross - discount);

    const duration = parseOptionalInt(b.duration_days);
    if (duration.error) return sendError(res, 400, duration.error);
    if (duration.provided) next.duration_days = duration.value;

    const start = parseOptionalDate(b.start_date);
    if (start.error) return sendError(res, 400, start.error);
    if (start.provided) {
      if (!start.value)
        return sendError(res, 400, "start_date cannot be empty");
      next.start_date = start.value;
    }

    if (b.notes !== undefined) next.notes = cleanStr(b.notes, 1000) ?? null;

    const changes = [];
    for (const [field, to] of Object.entries(next)) {
      const from = existing[field];
      if (normalize(from) !== normalize(to))
        changes.push({ field, from: from ?? null, to: to ?? null });
    }
    if (!changes.length)
      return res.json({ success: true, package: existing, unchanged: true });

    const note = cleanStr(b.revision_note, 300);
    const priceChanged = changes.some((c) => c.field === "net_amount");
    if (priceChanged && !note) {
      return sendError(
        res,
        400,
        "Please give a reason (revision_note) for changing the amount charged",
      );
    }

    const set = Object.fromEntries(
      changes.map((c) => [c.field, next[c.field]]),
    );
    const who = actor(req);
    const r = await orgDb.collection("patient_packages").findOneAndUpdate(
      { _id: id, status: "ACTIVE" },
      {
        $set: { ...set, updatedAt: new Date() },
        $push: {
          revision_history: compact({
            revised_at: new Date(),
            by_id: who.id,
            by_name: who.name,
            note,
            changes,
          }),
        },
      },
      { returnDocument: "after" },
    );
    const pkg = unwrap(r);
    if (!pkg)
      return sendError(
        res,
        409,
        "Package was changed or cancelled, please reload",
      );

    return res.json({ success: true, package: pkg });
  } catch (err) {
    console.error("updatePackage error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

// POST /packages/:id/cancel   (packages are never deleted)
const cancelPackage = async (req, res) => {
  try {
    const { orgDb } = req;
    const id = asObjectId(req.params.id);
    if (!id) return sendError(res, 400, "Invalid package id");

    const reason = cleanStr(req.body?.reason, 500);
    if (!reason)
      return sendError(res, 400, "reason is required to cancel a package");

    const existing = await orgDb
      .collection("patient_packages")
      .findOne({ _id: id, ...tenantMatch(req) });
    if (!existing) return sendError(res, 404, "Package not found");
    if (existing.status === "CANCELLED")
      return sendError(res, 409, "Package is already cancelled");

    const who = actor(req);
    const r = await orgDb.collection("patient_packages").findOneAndUpdate(
      { _id: id, status: "ACTIVE" },
      {
        $set: compact({
          status: "CANCELLED",
          cancelled_at: new Date(),
          cancelled_by_id: who.id,
          cancelled_by_name: who.name,
          cancel_reason: reason,
          updatedAt: new Date(),
        }),
      },
      { returnDocument: "after" },
    );
    const pkg = unwrap(r);
    if (!pkg) return sendError(res, 409, "Package was already cancelled");

    return res.json({ success: true, package: pkg });
  } catch (err) {
    console.error("cancelPackage error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

/* -------------------------------------------------------------------------- */
/* PACKAGE TEMPLATES                                                           */
/* -------------------------------------------------------------------------- */

// POST /packages/templates
const createPackageTemplate = async (req, res) => {
  try {
    const { orgDb } = req;
    const b = req.body || {};

    const name = cleanStr(b.name, 120);
    if (!name) return sendError(res, 400, "Template name is required");

    const parsed = parseItems(b.items);
    if (parsed.error) return sendError(res, 400, parsed.error);

    const duration = parseOptionalInt(b.duration_days);
    if (duration.error) return sendError(res, 400, duration.error);

    await ensureIndexes(orgDb);

    const who = actor(req);
    const now = new Date();
    const doc = compact({
      ...tenantMatch(req),
      name,
      name_key: name.toLowerCase(),
      description: cleanStr(b.description, 500),
      duration_days: duration.value,
      items: parsed.items,
      total_amount: sumItems(parsed.items),
      is_active: b.is_active === undefined ? true : Boolean(b.is_active),
      created_by_id: who.id,
      created_by_name: who.name,
      createdAt: now,
      updatedAt: now,
    });

    const { insertedId } = await orgDb
      .collection("package_templates")
      .insertOne(doc);
    return res
      .status(201)
      .json({ success: true, template: { _id: insertedId, ...doc } });
  } catch (err) {
    if (err?.code === 11000)
      return sendError(res, 409, "A template with this name already exists");
    console.error("createPackageTemplate error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

// GET /packages/templates?active=true&search=&page=&limit=
const listPackageTemplates = async (req, res) => {
  try {
    const { orgDb } = req;
    const q = req.query;
    const page = Math.max(parseInt(q.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(q.limit, 10) || 10, 1),
      MAX_PAGE_SIZE,
    );

    const match = { ...tenantMatch(req) };
    if (q.active === "true") match.is_active = true;
    const search = cleanStr(q.search, 100);
    if (search) match.name = new RegExp(escapeRegex(search), "i");

    const [templates, total] = await Promise.all([
      orgDb
        .collection("package_templates")
        .find(match)
        .sort({ name_key: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      orgDb.collection("package_templates").countDocuments(match),
    ]);

    return res.json({
      success: true,
      templates,
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(Math.ceil(total / limit), 1),
      },
    });
  } catch (err) {
    console.error("listPackageTemplates error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

// PATCH /packages/templates/:id
const updatePackageTemplate = async (req, res) => {
  try {
    const { orgDb } = req;
    const id = asObjectId(req.params.id);
    if (!id) return sendError(res, 400, "Invalid template id");
    const b = req.body || {};

    const set = {};
    if (b.name !== undefined) {
      const name = cleanStr(b.name, 120);
      if (!name) return sendError(res, 400, "Template name cannot be empty");
      set.name = name;
      set.name_key = name.toLowerCase();
    }
    if (b.description !== undefined)
      set.description = cleanStr(b.description, 500) ?? null;
    if (b.items !== undefined) {
      const parsed = parseItems(b.items);
      if (parsed.error) return sendError(res, 400, parsed.error);
      set.items = parsed.items;
      set.total_amount = sumItems(parsed.items);
    }
    const duration = parseOptionalInt(b.duration_days);
    if (duration.error) return sendError(res, 400, duration.error);
    if (duration.provided) set.duration_days = duration.value;
    if (b.is_active !== undefined) set.is_active = Boolean(b.is_active);

    if (!Object.keys(set).length)
      return sendError(res, 400, "No editable fields supplied");
    set.updatedAt = new Date();

    const r = await orgDb
      .collection("package_templates")
      .findOneAndUpdate(
        { _id: id, ...tenantMatch(req) },
        { $set: set },
        { returnDocument: "after" },
      );
    const template = unwrap(r);
    if (!template) return sendError(res, 404, "Template not found");

    return res.json({ success: true, template });
  } catch (err) {
    if (err?.code === 11000)
      return sendError(res, 409, "A template with this name already exists");
    console.error("updatePackageTemplate error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

// DELETE /packages/templates/:id   (safe: patient packages keep their own copy of the items)
const deletePackageTemplate = async (req, res) => {
  try {
    const { orgDb } = req;
    const id = asObjectId(req.params.id);
    if (!id) return sendError(res, 400, "Invalid template id");

    const { deletedCount } = await orgDb
      .collection("package_templates")
      .deleteOne({ _id: id, ...tenantMatch(req) });
    if (!deletedCount) return sendError(res, 404, "Template not found");

    return res.json({ success: true });
  } catch (err) {
    console.error("deletePackageTemplate error:", err);
    return sendError(res, 500, "Internal server error");
  }
};

module.exports = {
  createPackage,
  listPackages,
  getPackage,
  updatePackage,
  cancelPackage,
  createPackageTemplate,
  listPackageTemplates,
  updatePackageTemplate,
  deletePackageTemplate,
};
