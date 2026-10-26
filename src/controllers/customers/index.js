const express = require("express");
const mongoose = require("mongoose");
const ExcelJS = require("exceljs");
const multer = require("multer");
const env = require("../../config/env");
const authGuard = require("../../common/middleware/auth-guard");
const adminOnly = require("../../common/middleware/admin-only");
const requirePermission = require("../../common/middleware/require-permission");
const validateBody = require("../../common/middleware/validate");
const { responseHandler, exceptionHandler, queryHandler } = require("../../utilities/handlers");
const { Customer } = require("../../models/customers");
const { User } = require("../../models/users");
const Nakshathiram = require("../../models/nakshathirams");
const { USER_TYPES } = require("../../utilities/constants/user-types");
const { MAX_IMPORT_ROWS } = require("../../common/factories/import-export-controller");
const { isTransactionsUnsupported } = require("../../common/utils/atomic-create-many");
const findActiveEntityByCode = require("../../utilities/helpers/find-active-entity-by-code");
const findActiveRoleByName = require("../../utilities/helpers/find-active-role-by-name");
const createPendingUser = require("../../utilities/helpers/create-pending-user");
const createCustomerProfile = require("../../utilities/helpers/create-customer-profile");
const sendTemplatedEmail = require("../../utilities/helpers/send-templated-email");
const rollbackCreatedUser = require("../../utilities/helpers/rollback-created-user");
const { isPlaceholderEmail } = require("../../common/utils/customer-email");
const resendActivation = require("../../utilities/helpers/resend-activation");
const { adminUpdateSchema, adminCreateSchema } = require("./request-objects");

const FAMILY_MEMBER_POPULATE = { path: "familyMembers.natchathiram", select: "name tamilName" };

/**
 * Admin-side devotee master — staff looking at everyone's records, as
 * opposed to controllers/customer-profile where a person reads their own.
 */
async function list(req, res) {
  try {
    const { page, pageSize, skip, filter, sort } = queryHandler(req, {
      notDeletedFilter: Customer.notDeletedFilter,
      searchFields: ["customerCode", "name", "mobileNumber", "email", "uid"],
    });

    const [items, total] = await Promise.all([
      Customer.find(filter).populate(FAMILY_MEMBER_POPULATE).sort(sort).skip(skip).limit(pageSize),
      Customer.countDocuments(filter),
    ]);

    // "Has this devotee set their password yet?" lives on the User record,
    // not here — a walk-in profile has no login at all. Resolved in one
    // extra query for the whole page rather than per row.
    const linkedIds = items.map((c) => c.linkedUserId).filter(Boolean);
    const logins = linkedIds.length
      ? await User.find({ _id: { $in: linkedIds } }).select("passwordSetAt lastLoginAt uCode")
      : [];
    const loginById = new Map(logins.map((u) => [String(u._id), u]));

    const withLoginState = items.map((customer) => {
      const login = customer.linkedUserId ? loginById.get(String(customer.linkedUserId)) : null;
      return {
        ...customer.toObject(),
        uCode: login?.uCode ?? null,
        passwordSetAt: login?.passwordSetAt ?? null,
        hasSetPassword: Boolean(login?.passwordSetAt),
        hasLogin: Boolean(login),
      };
    });

    return responseHandler({ res, response: { items: withLoginState, total, page, pageSize } });
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

/**
 * Manually registers a devotee from the Customer Master — the walk-in-form
 * counterpart to public self-registration. Same account-creation shape as
 * `auth.register()` (name/email/mobile + optional family members); `status`
 * and `maxFamilyMembers` stay the update route's concern, not something this
 * form collects up front. Reuses the exact same helpers as both
 * `auth.register()` and `users.create()` so all three creation paths stay in
 * lockstep, and rolls back the created User the same way they do if
 * anything downstream fails.
 */
async function create(req, res) {
  let createdUser = null;
  try {
    const { name, email, mobileNumber, familyMembers } = req.body;

    const entity = await findActiveEntityByCode(env.DEFAULT_ENTITY_CODE);
    if (!entity) throw "Registration isn't available right now — no active entity is configured.";

    const customerRole = await findActiveRoleByName("Customer");

    const { user, rawToken } = await createPendingUser({
      name,
      email,
      mobileNumber,
      userType: USER_TYPES.CUSTOMER,
      entityId: entity._id,
      roleIds: customerRole ? [customerRole._id] : [],
      createdBy: req.auth?.userId,
    });
    createdUser = user;

    await createCustomerProfile({
      entityId: entity._id,
      linkedUserId: user._id,
      name,
      mobileNumber,
      email,
      familyMembers,
    });

    // Staff-created, so the devotee still goes through the customer portal to
    // activate — never /admin — exactly like public registration.
    const activationUrl = `${env.CUSTOMER_APP_URL}/customer/activate/${rawToken}`;
    await sendTemplatedEmail("ACCOUNT_ACTIVATION", entity._id, user.email, {
      name: user.name,
      activationUrl,
    });

    return responseHandler({
      res,
      successMessage: "Devotee created — an activation email has been sent.",
      statusCode: 201,
    });
  } catch (error) {
    if (createdUser) await rollbackCreatedUser(createdUser._id);
    return exceptionHandler({ res, error });
  }
}

async function update(req, res) {
  let createdUser = null;
  // What the profile looked like before this edit, to put it back if giving the devotee a login fails.
  let before = null;
  try {
    const customer = await Customer.findOne(Customer.notDeletedFilter({ _id: req.params.id }));
    if (!customer) return exceptionHandler({ res, error: "Devotee profile not found.", statusCode: 404 });
    before = { email: customer.email, isRegistered: customer.isRegistered, linkedUserId: customer.linkedUserId };

    const { name, mobileNumber, email, familyMembers, maxFamilyMembers, status } = req.body;

    if (mobileNumber !== undefined && mobileNumber !== customer.mobileNumber) {
      const normalized = mobileNumber || null;
      if (normalized) {
        const taken = await Customer.exists(
          Customer.notDeletedFilter({ mobileNumber: normalized, _id: { $ne: customer._id } })
        );
        if (taken) throw "Another devotee profile already uses this mobile number.";
      }
      customer.mobileNumber = normalized;
    }

    if (email && email.toLowerCase() !== customer.email) {
      const taken = await Customer.exists(
        Customer.notDeletedFilter({ email: email.toLowerCase(), _id: { $ne: customer._id } })
      );
      if (taken) throw "Another devotee profile already uses this email.";
      customer.email = email.toLowerCase();
    }

    if (name !== undefined) customer.name = name;
    if (familyMembers !== undefined) customer.familyMembers = familyMembers;
    if (maxFamilyMembers !== undefined) customer.maxFamilyMembers = maxFamilyMembers;
    if (status !== undefined) customer.status = status;

    customer.updatedBy = req.auth?.userId || null;

    // A counter (walk-in) profile has no login. Adding - or changing - a real email on it gives the devotee one: a
    // login is created, linked, and the activation email is sent so they can set their own password. The edit and
    // the login stand or fall together.
    const givingLogin = !customer.linkedUserId && !isPlaceholderEmail(customer.email) && customer.email !== before.email;
    if (givingLogin) {
      const entityId = customer.entity;
      const customerRole = await findActiveRoleByName("Customer");
      const { user, rawToken } = await createPendingUser({
        name: customer.name,
        email: customer.email,
        mobileNumber: customer.mobileNumber,
        userType: USER_TYPES.CUSTOMER,
        entityId,
        roleIds: customerRole ? [customerRole._id] : [],
        createdBy: req.auth?.userId,
      });
      createdUser = user;
      customer.linkedUserId = user._id;
      customer.isRegistered = true;
      await customer.save();
      // Staff-added, so the devotee still activates through the customer portal, never /admin.
      await sendTemplatedEmail("ACCOUNT_ACTIVATION", entityId, user.email, {
        name: user.name,
        activationUrl: `${env.CUSTOMER_APP_URL}/customer/activate/${rawToken}`,
      });
    } else {
      await customer.save();
    }
    await customer.populate(FAMILY_MEMBER_POPULATE);

    // The devotee's login follows the profile: Inactive here locks them out of the portal right
    // away (the API re-checks on every request), Active lets them back in. Only a devotee-type
    // login is switched - a staff member's own account is managed from Users, not from here.
    if (status !== undefined && customer.linkedUserId) {
      await User.updateOne(
        { _id: customer.linkedUserId, userType: USER_TYPES.CUSTOMER },
        { $set: { status, updatedBy: req.auth?.userId || null } }
      );
    }

    return responseHandler({
      res,
      response: customer,
      successMessage: createdUser
        ? `Devotee profile updated - an activation email has been sent to ${customer.email}.`
        : "Devotee profile updated successfully.",
    });
  } catch (error) {
    // Put the profile back FIRST: rolling the new login back deletes whichever profile is linked to it.
    if (createdUser && before) {
      await Customer.updateOne({ _id: req.params.id }, { $set: before }).catch(() => {});
    }
    if (createdUser) await rollbackCreatedUser(createdUser._id);
    if (error?.code === 11000) {
      return exceptionHandler({ res, error: "Those details are already used by another profile.", statusCode: 409 });
    }
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

/**
 * POST /customers/:id/resend-activation
 * For a devotee who never set a password: a fresh set-password link goes to their email, replacing the old one.
 * A counter customer with no login yet has nothing to resend - add an email on the Edit screen to create it.
 */
async function resendCustomerActivation(req, res) {
  try {
    const customer = await Customer.findOne(Customer.notDeletedFilter({ _id: req.params.id }));
    if (!customer) return exceptionHandler({ res, error: "Devotee profile not found.", statusCode: 404 });
    const user = customer.linkedUserId ? await User.findOne(User.notDeletedFilter({ _id: customer.linkedUserId })) : null;
    if (!user) throw "This devotee has no login yet. Add an email address on the Edit screen to create one and send the activation email.";

    const { email, dryRun } = await resendActivation(user);
    return responseHandler({
      res,
      response: { email, dryRun },
      successMessage: dryRun ? `Activation email prepared for ${email} (test mode - not actually sent).` : `Activation email sent to ${email}.`,
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 400 : undefined });
  }
}

// ---- Customer Import — a bespoke controller, not common/factories/import-export-controller.js ----
//
// That factory assumes one flat Model.create() per row. A customer row needs
// a linked User + Customer pair plus nested, repeated Family Member columns
// — neither fits the factory's declarative single-model field list, so this
// reimplements the same
// scan → review → commit contract (the {rows, summary} / {rowNumber, raw,
// resolved, errors, status} shapes) by hand, so the existing generic
// ImportReviewModal/ImportExportBar frontend components work unchanged.

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SHEET_NAME = "Customers";
const FAMILY_MEMBER_SLOTS = 5; // matches Customer.maxFamilyMembers' default cap

const BASE_COLUMNS = [
  { key: "name", header: "Full Name" },
  { key: "email", header: "Email" },
  { key: "mobileNumber", header: "Mobile Number" },
];

function familyMemberColumns(slot) {
  return [
    { key: `fm${slot}NameEnglish`, header: `Family Member ${slot} Name (English)` },
    { key: `fm${slot}NameTamil`, header: `Family Member ${slot} Name (Tamil)` },
    { key: `fm${slot}Natchathiram`, header: `Family Member ${slot} Natchathiram` },
  ];
}

const COLUMNS = [
  ...BASE_COLUMNS,
  ...Array.from({ length: FAMILY_MEMBER_SLOTS }, (_, i) => familyMemberColumns(i + 1)).flat(),
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const okExt = /\.xlsx$/i.test(file.originalname || "");
    if (!okExt || file.mimetype !== XLSX_MIME) {
      return cb(new Error("Please upload the .xlsx file produced by the sample template."));
    }
    return cb(null, true);
  },
});

async function buildNakshathiramLookup() {
  const docs = await Nakshathiram.find(Nakshathiram.notDeletedFilter({ status: 1 }))
    .select("name tamilName")
    .sort({ name: 1 });
  const map = new Map();
  docs.forEach((d) => map.set(String(d.name).trim().toLowerCase(), d));
  return map;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Resolves and validates one row's fields — mirrors the factory's resolveField, just hand-rolled for this shape. */
function resolveRow(raw, nakshathiramLookup) {
  const errors = [];

  const name = String(raw.name ?? "").trim();
  if (!name) errors.push("Full Name is required.");
  else if (name.length < 2 || name.length > 100) errors.push("Full Name must be 2-100 characters.");

  const email = String(raw.email ?? "").trim().toLowerCase();
  if (!email) errors.push("Email is required.");
  else if (!EMAIL_RE.test(email)) errors.push("Email is not a valid email address.");

  // Same rule as the Customer form: an 8-digit Singapore mobile starting with 8 or 9. Spaces, dashes
  // and a leading +65 / 65 country code are tolerated and stripped, so the stored number is always the 8 digits.
  let mobileNumber = String(raw.mobileNumber ?? "").trim();
  if (!mobileNumber) errors.push("Mobile Number is required.");
  else {
    mobileNumber = mobileNumber.replace(/[\s-]/g, "").replace(/^\+?65(?=\d{8}$)/, "");
    if (!/^[89]\d{7}$/.test(mobileNumber)) errors.push("Mobile Number must be a valid 8-digit Singapore mobile number starting with 8 or 9.");
  }

  const familyMembers = [];
  for (let slot = 1; slot <= FAMILY_MEMBER_SLOTS; slot++) {
    const nameEnglish = String(raw[`fm${slot}NameEnglish`] ?? "").trim();
    const nameTamil = String(raw[`fm${slot}NameTamil`] ?? "").trim();
    const natchathiramRaw = String(raw[`fm${slot}Natchathiram`] ?? "").trim();

    // An entirely blank group means "no Nth family member for this row" — not an error.
    if (!nameEnglish && !nameTamil && !natchathiramRaw) continue;

    let natchathiramId = null;
    if (!nameEnglish) {
      errors.push(`Family Member ${slot} Name (English) is required once any of that family member's columns are filled.`);
    } else if (nameEnglish.length < 2 || nameEnglish.length > 100) {
      errors.push(`Family Member ${slot} Name (English) must be 2-100 characters.`);
    }

    if (!natchathiramRaw) {
      errors.push(`Family Member ${slot} Natchathiram is required once any of that family member's columns are filled.`);
    } else {
      const match = nakshathiramLookup.get(natchathiramRaw.toLowerCase());
      if (!match) {
        errors.push(
          `Family Member ${slot} Natchathiram "${natchathiramRaw}" is not a valid, active option — pick one of the dropdown values from the template.`
        );
      } else {
        natchathiramId = match._id;
      }
    }

    familyMembers.push({ nameEnglish, nameTamil, natchathiram: natchathiramId });
  }

  return { resolved: { name, email, mobileNumber, familyMembers }, errors };
}

/**
 * The single source of truth for "is this row good to insert" — run once at
 * /import/validate time and again, unchanged, at /import/commit time against
 * whatever the admin actually kept, exactly like the generic factory's own
 * validateRows.
 */
async function validateRows(rawRows) {
  const nakshathiramLookup = await buildNakshathiramLookup();

  const rows = rawRows.map(({ rowNumber, raw }) => {
    const { resolved, errors } = resolveRow(raw, nakshathiramLookup);
    return { rowNumber, raw, resolved, errors };
  });

  function flagDuplicates(getValue, label) {
    const byValue = new Map();
    rows.forEach((r) => {
      const v = getValue(r);
      if (!v) return;
      if (!byValue.has(v)) byValue.set(v, []);
      byValue.get(v).push(r.rowNumber);
    });
    byValue.forEach((rowNumbers) => {
      if (rowNumbers.length <= 1) return;
      rows.forEach((r) => {
        if (!rowNumbers.includes(r.rowNumber)) return;
        const others = rowNumbers.filter((n) => n !== r.rowNumber);
        r.errors.push(`Duplicate ${label} — also used on row ${others.join(", ")} in this file.`);
      });
    });
    return [...byValue.keys()];
  }

  const emails = flagDuplicates((r) => r.resolved.email, "Email");
  const mobiles = flagDuplicates((r) => r.resolved.mobileNumber, "Mobile Number");

  if (emails.length) {
    const [existingUsers, existingCustomers] = await Promise.all([
      User.find(User.notDeletedFilter({ email: { $in: emails } })).select("email"),
      Customer.find(Customer.notDeletedFilter({ email: { $in: emails } })).select("email"),
    ]);
    const existingSet = new Set([...existingUsers, ...existingCustomers].map((d) => d.email));
    rows.forEach((r) => {
      if (r.resolved.email && existingSet.has(r.resolved.email)) {
        r.errors.push(`Email "${r.resolved.email}" already exists in the system.`);
      }
    });
  }

  if (mobiles.length) {
    const [existingUsers, existingCustomers] = await Promise.all([
      User.find(User.notDeletedFilter({ mobileNumber: { $in: mobiles } })).select("mobileNumber"),
      Customer.find(Customer.notDeletedFilter({ mobileNumber: { $in: mobiles } })).select("mobileNumber"),
    ]);
    const existingSet = new Set([...existingUsers, ...existingCustomers].map((d) => d.mobileNumber));
    rows.forEach((r) => {
      if (r.resolved.mobileNumber && existingSet.has(r.resolved.mobileNumber)) {
        r.errors.push(`Mobile Number "${r.resolved.mobileNumber}" already exists in the system.`);
      }
    });
  }

  rows.forEach((r) => {
    r.status = r.errors.length ? "error" : "valid";
  });
  return rows;
}

function summarize(rows) {
  return {
    total: rows.length,
    valid: rows.filter((r) => r.status === "valid").length,
    invalid: rows.filter((r) => r.status === "error").length,
    blockingIssues: [],
  };
}

const toClientRow = (r) => ({ rowNumber: r.rowNumber, raw: r.raw, resolved: r.resolved, errors: r.errors, status: r.status });

async function parseWorkbookRows(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets.find((ws) => ws.name === SHEET_NAME) || workbook.worksheets[0];
  if (!sheet) throw "The uploaded file has no worksheet to read.";

  const colIndexByKey = {};
  sheet.getRow(1).eachCell((cell, colNumber) => {
    const text = String(cell.value ?? "").trim().toLowerCase();
    const column = COLUMNS.find((c) => c.header.toLowerCase() === text);
    if (column) colIndexByKey[column.key] = colNumber;
  });

  const missingCols = COLUMNS.filter((c) => !(c.key in colIndexByKey));
  if (missingCols.length) {
    throw `This file is missing column(s): ${missingCols.map((c) => c.header).join(", ")}. Please re-download the sample template and re-fill it.`;
  }

  if (sheet.rowCount - 1 > MAX_IMPORT_ROWS) {
    throw `This file has more than ${MAX_IMPORT_ROWS} data rows. Please split it into smaller batches.`;
  }

  const rawRows = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const raw = {};
    let hasAnyValue = false;

    COLUMNS.forEach((c) => {
      const cell = row.getCell(colIndexByKey[c.key]);
      let value = cell.value;
      if (value && typeof value === "object" && !(value instanceof Date)) {
        if (Array.isArray(value.richText)) value = value.richText.map((t) => t.text).join("");
        else if ("result" in value) value = value.result;
        else if ("text" in value) value = value.text;
        else value = "";
      }
      if (value !== null && value !== undefined && String(value).trim() !== "") hasAnyValue = true;
      raw[c.key] = value === null || value === undefined ? "" : value;
    });

    if (hasAnyValue) rawRows.push({ rowNumber: r, raw });
  }

  if (rawRows.length === 0) throw "No data rows were found in the uploaded file.";
  return rawRows;
}

// ---- GET /customers/import/template ----
async function downloadTemplate(req, res) {
  try {
    const nakshathiramLookup = await buildNakshathiramLookup();
    const nakshathiramNames = [...nakshathiramLookup.values()].map((d) => d.name);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(SHEET_NAME);
    sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: Math.max(20, c.header.length + 4) }));
    sheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF7C1527" } };
    });

    sheet.addRow({
      name: "Kamala Devi",
      email: "kamala.devi@example.com",
      mobileNumber: "91234567",
      fm1NameEnglish: "Ravi Kumar",
      fm1NameTamil: "ரவி குமார்",
      fm1Natchathiram: nakshathiramNames[0] || "",
    });

    if (nakshathiramNames.length) {
      const lookupSheet = workbook.addWorksheet("Lookups");
      lookupSheet.state = "veryHidden";
      nakshathiramNames.forEach((n, i) => {
        lookupSheet.getCell(i + 1, 1).value = n;
      });

      for (let slot = 1; slot <= FAMILY_MEMBER_SLOTS; slot++) {
        const colIndex = COLUMNS.findIndex((c) => c.key === `fm${slot}Natchathiram`) + 1;
        const colLetter = sheet.getColumn(colIndex).letter;
        for (let r = 2; r <= MAX_IMPORT_ROWS + 1; r++) {
          sheet.getCell(`${colLetter}${r}`).dataValidation = {
            type: "list",
            allowBlank: true,
            formulae: [`Lookups!$A$1:$A$${nakshathiramNames.length}`],
            showErrorMessage: true,
            errorStyle: "stop",
            errorTitle: "Invalid selection",
            error: "Choose one of the active Natchathiram values from the dropdown.",
          };
        }
      }
    }

    const infoSheet = workbook.addWorksheet("Instructions");
    infoSheet.getColumn(1).width = 110;
    infoSheet.addRow(["Customer Import — Instructions"]).getCell(1).font = { bold: true, size: 14 };
    infoSheet.addRow([""]);
    infoSheet.addRow(["1. Fill one row per devotee on the first sheet, starting below the sample row."]);
    infoSheet.addRow(["2. Full Name, Email, and Mobile Number are required for every row. Mobile Number must be an 8-digit Singapore mobile starting with 8 or 9 (a +65 prefix is removed)."]);
    infoSheet.addRow([
      `3. Up to ${FAMILY_MEMBER_SLOTS} family members per devotee — fill a family member's three columns together (Name (English) and Natchathiram are both required once you start one), or leave all three blank to skip that slot.`,
    ]);
    infoSheet.addRow(["4. Natchathiram has a dropdown (list arrow when you click the cell) — only active, currently-listed values are accepted."]);
    infoSheet.addRow(["5. Email and Mobile Number must be unique — both within this file and against existing devotee records."]);
    infoSheet.addRow([
      "6. Upload the file from the Import screen on the Customer Master — it is scanned and shown to you for review before anything is saved. Imported devotees do NOT receive an activation email automatically (unlike Add Customer) — invite them to set a password separately when you're ready.",
    ]);

    res.setHeader("Content-Type", XLSX_MIME);
    res.setHeader("Content-Disposition", 'attachment; filename="customer-import-template.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    return exceptionHandler({ res, error });
  }
}

// ---- POST /customers/import/validate — scan the file, insert nothing ----
function validateImport(req, res) {
  upload.single("file")(req, res, async (err) => {
    if (err) return exceptionHandler({ res, error: err.message, statusCode: 422 });
    if (!req.file) return exceptionHandler({ res, error: "Please attach a .xlsx file.", statusCode: 422 });

    try {
      const rawRows = await parseWorkbookRows(req.file.buffer);
      const rows = await validateRows(rawRows);
      return responseHandler({ res, response: { rows: rows.map(toClientRow), summary: summarize(rows) } });
    } catch (error) {
      return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 422 : undefined });
    }
  });
}

/**
 * Creates every User+Customer pair for the batch inside one Mongo
 * transaction — all-or-nothing at the database level, same reasoning as
 * common/utils/atomic-create-many.js. Falls back to sequential creation with
 * manual rollback on a standalone MongoDB with no replica set, exactly like
 * that helper does. Activation emails are sent by the caller, only after
 * this resolves — a per-row side effect that isn't, and shouldn't try to be,
 * part of the database transaction.
 */
async function commitRowsInBatch(rows, { entity, customerRole, actorUserId }) {
  const buildRow = (row, session) =>
    createPendingUser({
      name: row.resolved.name,
      email: row.resolved.email,
      mobileNumber: row.resolved.mobileNumber,
      userType: USER_TYPES.CUSTOMER,
      entityId: entity._id,
      roleIds: customerRole ? [customerRole._id] : [],
      createdBy: actorUserId,
      session,
    }).then(async ({ user, rawToken }) => {
      const customer = await createCustomerProfile({
        entityId: entity._id,
        linkedUserId: user._id,
        name: row.resolved.name,
        mobileNumber: row.resolved.mobileNumber,
        email: row.resolved.email,
        familyMembers: row.resolved.familyMembers,
        session,
      });
      return { user, customer, rawToken };
    });

  const session = await mongoose.startSession();
  try {
    let created = [];
    await session.withTransaction(async () => {
      created = [];
      for (const row of rows) {
        created.push(await buildRow(row, session));
      }
    });
    return created;
  } catch (err) {
    if (err?.code === 11000 || err?.name === "ValidationError" || typeof err === "string") throw err;
    if (!isTransactionsUnsupported(err)) {
      console.warn(">>> customers import commit: transaction failed, retrying without one:", err?.message || err);
    }
  } finally {
    await session.endSession();
  }

  const created = [];
  try {
    for (const row of rows) {
      created.push(await buildRow(row, undefined));
    }
    return created;
  } catch (err) {
    for (const c of created) {
      await Customer.deleteOne({ _id: c.customer._id }).catch(() => {});
      await User.deleteOne({ _id: c.user._id }).catch(() => {});
    }
    throw err;
  }
}

// ---- POST /customers/import/commit — re-validate exactly what was kept, then an all-or-nothing insert ----
async function commitImport(req, res) {
  try {
    const submitted = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (submitted.length === 0) throw "No rows were submitted to import.";
    if (submitted.length > MAX_IMPORT_ROWS) throw `Cannot import more than ${MAX_IMPORT_ROWS} rows at once.`;

    const rawRows = submitted.map((r, i) => ({
      rowNumber: Number(r.rowNumber) || i + 2,
      raw: r.raw && typeof r.raw === "object" ? r.raw : {},
    }));

    const rows = await validateRows(rawRows);
    const invalid = rows.filter((r) => r.status === "error");

    if (invalid.length > 0) {
      return res.status(422).json({
        success: false,
        message: `${invalid.length} of ${rows.length} row(s) failed re-validation — nothing was imported. Review the highlighted rows below and try again.`,
        data: { rows: rows.map(toClientRow), summary: summarize(rows) },
      });
    }

    const entity = await findActiveEntityByCode(env.DEFAULT_ENTITY_CODE);
    if (!entity) throw "Import isn't available right now — no active entity is configured.";
    const customerRole = await findActiveRoleByName("Customer");

    // Deliberately no activation email here, unlike create() — an import
    // batch can be hundreds of rows, and firing that many emails as a side
    // effect of one upload isn't something staff can undo. Each imported
    // devotee still gets an activation token on their User record (set by
    // createPendingUser above), so inviting them is only ever a "resend"
    // away; it's just never sent automatically by the import itself.
    const created = await commitRowsInBatch(rows, { entity, customerRole, actorUserId: req.auth?.userId });

    return responseHandler({
      res,
      response: { insertedCount: created.length },
      successMessage: `${created.length} devotee${created.length === 1 ? "" : "s"} imported successfully.`,
      statusCode: 201,
    });
  } catch (error) {
    return exceptionHandler({ res, error, statusCode: typeof error === "string" ? 422 : undefined });
  }
}

/**
 * Kept in a separate router from controllers/customer-profile on purpose.
 * That one is the devotee's own `/me` surface with no module permission at
 * all; this one is staff reading other people's records and is gated like
 * every other master. Same model, two genuinely different authorization
 * stories, so two routers rather than one file with branching inside it.
 */
const router = express.Router();
router.use(authGuard, adminOnly);

router.get("/", requirePermission("customers", "view"), list);
router.post("/", requirePermission("customers", "fullAccess"), validateBody(adminCreateSchema), create);
router.put("/:id", requirePermission("customers", "edit"), validateBody(adminUpdateSchema), update);
router.post("/:id/resend-activation", requirePermission("customers", "edit"), resendCustomerActivation);

router.get("/import/template", requirePermission("customers", "fullAccess"), downloadTemplate);
router.post("/import/validate", requirePermission("customers", "fullAccess"), validateImport);
router.post("/import/commit", requirePermission("customers", "fullAccess"), commitImport);

module.exports = router;
module.exports.update = update;

module.exports.resendCustomerActivation = resendCustomerActivation;
