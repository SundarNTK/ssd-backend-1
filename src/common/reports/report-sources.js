const { HallBooking } = require("../../models/hall-bookings");
const { HallBookingPayment } = require("../../models/hall-booking-payments");
const { Customer } = require("../../models/customers");
const { Booking } = require("../../models/bookings");
// Transaction, PosBooking and PosTransaction are unioned by their raw
// collection name ("transactions", "pos_bookings", "pos_transactions") in
// the pipelines below, not through their Mongoose models — $unionWith/
// $lookup talk to MongoDB directly by collection name, so no import of
// those model files is needed here at all.

/**
 * The Report Builder's data catalog — one entry per selectable "report
 * type" (Salesforce calls this a report's Object; here it's `sourceKey`),
 * each declaring every field a user may pick and how to produce it.
 *
 * Why this shape, and why it's fast even at 10k+ documents:
 *
 * 1. Every source's "obvious" fields (booking number, customer name, hall
 *    name, payment mode name, amount, status, dates) are already
 *    DENORMALIZED onto the document at write time — every booking/
 *    transaction model in this system snapshots `customerInfo`,
 *    `hallName`, `paymentModeName`, etc. right when it's created (see each
 *    model's own comments), specifically so downstream reads never need a
 *    join for them. A report built from nothing but those fields is a
 *    plain `$match` + `$project` + `$sort` — genuinely millisecond-fast at
 *    10k+ rows with the indexes each model already carries.
 *
 * 2. The handful of fields that DO need a join (Item Sales' Category,
 *    Customer Report's rollup totals) declare their own `extraStages()` —
 *    a function returning the aggregation stages that compute them. The
 *    report runner (./report-runner.js) includes a field's stages ONLY
 *    when that field is actually selected, deduplicated by `stageKey` when
 *    two fields would need the same join. Deselect Category from an Item
 *    Sales report and its three extra $lookup stages never run at all —
 *    "select fewer fields" literally means "less work per row", not just
 *    a narrower response.
 *
 * 3. Every join that IS used is an indexed equality lookup — by `_id`
 *    (Category lookup) or by `customer` (Customer Report's rollup, using
 *    the exact `{ customer: 1, createdAt: -1 }` index each booking model
 *    already has) — never a full collection scan.
 *
 * Field descriptor shape:
 *   { key, label, type: "string"|"number"|"date"|"boolean",
 *     path,            // dot-path on the working aggregation document
 *     options?,         // fixed value list — marks this a dropdown/enum
 *                        // field for the filter builder's "equals/in" set
 *                        // instead of the free-text operator set
 *     extraStages?,     // () => stage[] — extra pipeline stages this field needs
 *     stageKey?,        // dedupe key when several fields share one join (defaults to `key`)
 *   }
 *
 * Source shape:
 *   { key, label, description, model, basePipeline, fields,
 *     defaultSort: { field, dir } }
 *
 * Filtering, sorting and grouping are all generic now (see
 * ./report-filters.js and ./report-runner.js) — every field is filterable
 * by the operators its own `type` (and `options`, if set) allow, every
 * field is a legal sort key, and any field can be a Group By key with
 * SUM/COUNT/AVG/MIN/MAX available on the numeric ones.
 */

/** Resolves BOTH Category and Sub Category off the item/service's first categoryDetails pairing in one pass — selecting either field triggers this same lookup group once (shared `stageKey: "categoryLookup"`). */
function categoryLookupStages() {
  return [
    {
      $lookup: {
        from: "items",
        let: { rid: "$_refId", rtype: "$_refType" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$_id", "$$rid"] }, { $eq: ["$$rtype", "Item"] }] } } },
          { $project: { categoryId: { $arrayElemAt: ["$categoryDetails.category", 0] }, subCategoryId: { $arrayElemAt: ["$categoryDetails.subCategory", 0] } } },
        ],
        as: "__itemCat",
      },
    },
    {
      $lookup: {
        from: "services",
        let: { rid: "$_refId", rtype: "$_refType" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$_id", "$$rid"] }, { $eq: ["$$rtype", "Service"] }] } } },
          { $project: { categoryId: { $arrayElemAt: ["$categoryDetails.category", 0] }, subCategoryId: { $arrayElemAt: ["$categoryDetails.subCategory", 0] } } },
        ],
        as: "__serviceCat",
      },
    },
    {
      // An Event carries one category/sub category of its own, not a categoryDetails list.
      $lookup: {
        from: "events",
        let: { rid: "$_refId", rtype: "$_refType" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$_id", "$$rid"] }, { $eq: ["$$rtype", "Event"] }] } } },
          { $project: { categoryId: "$category", subCategoryId: "$subCategory" } },
        ],
        as: "__eventCat",
      },
    },
    {
      $addFields: {
        __categoryId: {
          $ifNull: [
            { $arrayElemAt: ["$__itemCat.categoryId", 0] },
            { $ifNull: [{ $arrayElemAt: ["$__serviceCat.categoryId", 0] }, { $arrayElemAt: ["$__eventCat.categoryId", 0] }] },
          ],
        },
        __subCategoryId: {
          $ifNull: [
            { $arrayElemAt: ["$__itemCat.subCategoryId", 0] },
            { $ifNull: [{ $arrayElemAt: ["$__serviceCat.subCategoryId", 0] }, { $arrayElemAt: ["$__eventCat.subCategoryId", 0] }] },
          ],
        },
      },
    },
    { $lookup: { from: "categories", localField: "__categoryId", foreignField: "_id", as: "__categoryDoc" } },
    { $lookup: { from: "subcategories", localField: "__subCategoryId", foreignField: "_id", as: "__subCategoryDoc" } },
    {
      $addFields: {
        _categoryName: { $arrayElemAt: ["$__categoryDoc.name", 0] },
        _subCategoryName: { $arrayElemAt: ["$__subCategoryDoc.name", 0] },
      },
    },
    { $project: { __itemCat: 0, __serviceCat: 0, __eventCat: 0, __categoryId: 0, __subCategoryId: 0, __categoryDoc: 0, __subCategoryDoc: 0 } },
  ];
}

/** Resolves the line's mapped Deity name(s) — comma-joined when there's more than one — off `lines.deities`. */
function deityLookupStages() {
  return [
    { $lookup: { from: "deities", localField: "_deityIds", foreignField: "_id", as: "__deityDocs" } },
    {
      $addFields: {
        _deityNames: {
          $reduce: {
            input: "$__deityDocs.name",
            initialValue: "",
            in: { $concat: ["$$value", { $cond: [{ $eq: ["$$value", ""] }, "", ", "] }, "$$this"] },
          },
        },
      },
    },
    { $project: { __deityDocs: 0 } },
  ];
}

/** One member of the Item Sales union — reshapes Booking/PosBooking's per-line data into one common shape, right after $unwind, so the rest of the pipeline never needs to know which collection a row came from. */
function itemSalesBranch({ sourceLabel, byPortal = false }) {
  return [
    { $match: { isDeleted: false, bookingStatus: "confirmed" } },
    { $unwind: "$lines" },
    {
      $addFields: {
        _refType: "$lines.refType",
        _refId: "$lines.refId",
        _name: "$lines.name",
        _code: "$lines.code",
        _quantity: "$lines.quantity",
        _unitPrice: "$lines.unitPrice",
        _lineTotal: "$lines.lineTotal",
        // Bookings written after the per-line GST/GL snapshot was added
        // (see models/bookings, models/pos-bookings) carry the real
        // lines.gstAmount straight through. Older rows never got that
        // field written, so they fall back to the previous proportional
        // estimate — this line's share of the booking-level gstAmount, by
        // its share of the booking's subtotal — rather than reporting a
        // blank GST for historical sales.
        _gstAmount: {
          $ifNull: [
            "$lines.gstAmount",
            {
              $cond: [
                { $gt: ["$subtotal", 0] },
                { $multiply: [{ $divide: ["$lines.lineTotal", "$subtotal"] }, "$gstAmount"] },
                0,
              ],
            },
          ],
        },
        _customerName: "$customerInfo.name",
        _customerMobile: "$customerInfo.mobileNumber",
        _bookingNumber: "$bookingNumber",
        _bookingTotal: "$grandTotal",
        _paymentModeName: "$paymentModeName",
        _paymentStatus: "$paymentStatus",
        _saleDate: "$bookedAt",
        _deityIds: "$lines.deities",
        _devoteeNames: {
          $reduce: {
            input: "$lines.devotees.name",
            initialValue: "",
            in: { $concat: ["$$value", { $cond: [{ $eq: ["$$value", ""] }, "", ", "] }, "$$this"] },
          },
        },
        // POS bookings made from the Admin Panel are Admin Bookings, whichever collection holds them.
        _source: byPortal ? { $cond: [{ $eq: ["$portal", "admin"] }, "Admin Booking", sourceLabel] } : sourceLabel,
      },
    },
    {
      // The real stored lines.glAmount when this row has it. Older rows
      // never got that field written — lineTotal there is already the
      // GST-exclusive net amount (GST is added on top of it, not extracted
      // out — see models/bookings), so it doubles as its own GL fallback.
      $addFields: {
        _glAmount: { $ifNull: ["$lines.glAmount", "$lines.lineTotal"] },
      },
    },
    {
      $project: {
        _refType: 1,
        _refId: 1,
        _name: 1,
        _code: 1,
        _quantity: 1,
        _unitPrice: 1,
        _lineTotal: 1,
        _gstAmount: 1,
        _glAmount: 1,
        _customerName: 1,
        _customerMobile: 1,
        _bookingNumber: 1,
        _bookingTotal: 1,
        _paymentModeName: 1,
        _paymentStatus: 1,
        _saleDate: 1,
        _deityIds: 1,
        _devoteeNames: 1,
        _source: 1,
      },
    },
  ];
}

/**
 * One member of the Payment Report union — HallBookingPayment, Transaction
 * and PosTransaction reshaped into one common shape. `bookingNumber` needs
 * a tiny by-_id lookup (only when selected) since none of the three
 * denormalizes it. Payment Type and Reference No only really exist on
 * HallBookingPayment — the other two collections fold to "" for them
 * rather than the row disappearing or the field simply not existing.
 */
function paymentBranch({ bookingRefCollection, bookingRefField, sourceLabel, byPortal = false }) {
  return [
    { $match: { isDeleted: false, paymentStatus: { $in: ["paid"] } } },
    // A POS transaction does not carry its portal; its booking does (Admin Panel bookings live in the same collection).
    ...(byPortal
      ? [
          { $lookup: { from: "pos_bookings", localField: bookingRefField, foreignField: "_id", pipeline: [{ $project: { portal: 1 } }], as: "_portalBooking" } },
          { $addFields: { _portal: { $ifNull: [{ $arrayElemAt: ["$_portalBooking.portal", 0] }, "pos"] } } },
        ]
      : []),
    {
      $addFields: {
        _receiptNo: "$receiptNo",
        _bookingRef: `$${bookingRefField}`,
        _bookingRefCollection: bookingRefCollection,
        _customerName: "$customerInfo.name",
        _customerMobile: "$customerInfo.mobileNumber",
        _paymentDate: { $ifNull: ["$paymentDate", "$transactionDate"] },
        _paymentModeName: "$paymentModeName",
        _paymentType: { $ifNull: ["$paymentType", ""] },
        _referenceNo: { $ifNull: ["$referenceNo", { $ifNull: ["$gatewayReference", ""] }] },
        // The reference this payment attempt was sent to NETS / PayNow / the card terminal under (POS...).
        _paymentRequestRef: { $ifNull: ["$referenceId", ""] },
        _processedByName: { $ifNull: ["$collectedByInfo.name", "$processedByInfo.name"] },
        _amount: "$amount",
        _source: byPortal ? { $cond: [{ $eq: ["$_portal", "admin"] }, "Admin Booking", sourceLabel] } : sourceLabel,
        // POS Counter / Admin Booking payments confirmed by hand (the other collections never are): the flag and the
        // details the person entered.
        _isManuallyConfirmed: { $ifNull: ["$isManuallyConfirmed", false] },
        _manualRefNo: { $ifNull: ["$manualConfirmationDetails.transactionRefNo", ""] },
        _manualPaidAt: { $ifNull: ["$manualConfirmationDetails.paidAt", null] },
        _manualPayerName: { $ifNull: [{ $ifNull: ["$manualConfirmationDetails.payerName", "$manualConfirmationDetails.senderParty.name"] }, ""] },
        _manualPayerBank: { $ifNull: ["$manualConfirmationDetails.payerBank", ""] },
        _manualRemarks: { $ifNull: ["$manualConfirmationDetails.remarks", ""] },
        _manualConfirmedBy: { $ifNull: ["$manualConfirmationDetails.confirmedByName", ""] },
        _manualConfirmedAt: { $ifNull: ["$manualConfirmationDetails.confirmedAt", null] },
        _term_terminalId: { $ifNull: [{ $ifNull: ["$terminalConfirmationDetails.terminalId", "$manualConfirmationDetails.terminalDetails.terminalId"] }, ""] },
        _term_approvalCode: { $ifNull: [{ $ifNull: ["$terminalConfirmationDetails.approvalCode", "$manualConfirmationDetails.terminalDetails.approvalCode"] }, ""] },
        _term_cardType: { $ifNull: [{ $ifNull: ["$terminalConfirmationDetails.response.cardType", "$manualConfirmationDetails.terminalDetails.cardType"] }, ""] },
        _term_cardNumber: { $ifNull: [{ $ifNull: ["$terminalConfirmationDetails.response.cardNumber", "$manualConfirmationDetails.terminalDetails.cardNumber"] }, ""] },
        _term_batchNumber: { $ifNull: [{ $ifNull: ["$terminalConfirmationDetails.response.batchNumber", "$manualConfirmationDetails.terminalDetails.batchNumber"] }, ""] },
        _term_stan: { $ifNull: [{ $ifNull: ["$terminalConfirmationDetails.response.stan", "$manualConfirmationDetails.terminalDetails.stan"] }, ""] },
        _term_rrn: { $ifNull: [{ $ifNull: ["$terminalConfirmationDetails.response.retrievalReferenceNumber", "$manualConfirmationDetails.terminalDetails.retrievalReferenceNumber"] }, ""] },
      },
    },
    {
      $project: {
        _receiptNo: 1,
        _bookingRef: 1,
        _bookingRefCollection: 1,
        _customerName: 1,
        _customerMobile: 1,
        _paymentDate: 1,
        _paymentModeName: 1,
        _paymentType: 1,
        _referenceNo: 1,
        _paymentRequestRef: 1,
        _processedByName: 1,
        _amount: 1,
        _source: 1,
        _isManuallyConfirmed: 1,
        _manualRefNo: 1,
        _manualPaidAt: 1,
        _manualPayerName: 1,
        _manualPayerBank: 1,
        _manualRemarks: 1,
        _manualConfirmedBy: 1,
        _manualConfirmedAt: 1,
        _term_terminalId: 1,
        _term_approvalCode: 1,
        _term_cardType: 1,
        _term_cardNumber: 1,
        _term_batchNumber: 1,
        _term_stan: 1,
        _term_rrn: 1,
      },
    },
  ];
}

/** Booking-number lookup for the Payment Report — `_bookingRefCollection` tags which of the three booking collections `_bookingRef` points into, since the union mixes rows from all three. */
function bookingNumberLookupStages() {
  return [
    { $lookup: { from: "hallbookings", localField: "_bookingRef", foreignField: "_id", as: "__hb" } },
    { $lookup: { from: "bookings", localField: "_bookingRef", foreignField: "_id", as: "__b" } },
    { $lookup: { from: "pos_bookings", localField: "_bookingRef", foreignField: "_id", as: "__pb" } },
    {
      $addFields: {
        _bookingNumber: {
          $switch: {
            branches: [
              { case: { $eq: ["$_bookingRefCollection", "hallbookings"] }, then: { $arrayElemAt: ["$__hb.bookingNumber", 0] } },
              { case: { $eq: ["$_bookingRefCollection", "bookings"] }, then: { $arrayElemAt: ["$__b.bookingNumber", 0] } },
              { case: { $eq: ["$_bookingRefCollection", "pos_bookings"] }, then: { $arrayElemAt: ["$__pb.bookingNumber", 0] } },
            ],
            default: null,
          },
        },
      },
    },
    { $project: { __hb: 0, __b: 0, __pb: 0 } },
  ];
}

/** No join at all — just the size of the customer's own embedded array. Still a proper extraStages (not a plain path) because $project only supports a bare "$field" reference, not an expression like $size. */
function familyMemberCountStages() {
  return [{ $addFields: { _familyMemberCount: { $size: { $ifNull: ["$familyMembers", []] } } } }];
}

/**
 * Customer Report's rollup — total bookings / total amount / total GST /
 * total GL amount / last booking date, summed across all three sale
 * collections via one indexed $lookup each (see the module comment above).
 *
 * GL Amount is derived (amount − gst) rather than read off a stored
 * `glAmount` field, since Hall Bookings never got that field added — every
 * booking collection already carries `gstAmount` alongside its total, and
 * "net of the GST portion" is the same arithmetic regardless of whether
 * that GST was extracted from an inclusive price or added on top of an
 * exclusive one (see models/pos-bookings, models/bookings for the POS/Admin
 * item-catalog flow's own per-line gstAmount/glAmount snapshot).
 */
function customerRollupStages() {
  const branch = (from, statusMatch, amountField, gstField, dateField) => ({
    $lookup: {
      from,
      let: { cid: "$_id" },
      pipeline: [
        { $match: { $expr: { $eq: ["$customer", "$$cid"] }, isDeleted: false, ...statusMatch } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            total: { $sum: `$${amountField}` },
            gst: { $sum: `$${gstField}` },
            last: { $max: `$${dateField}` },
          },
        },
      ],
      as: "__agg",
    },
  });

  return [
    branch("hallbookings", { bookingStatus: { $ne: "cancelled" } }, "finalAmount", "gstAmount", "eventDate"),
    { $addFields: { __hallAgg: { $arrayElemAt: ["$__agg", 0] } } },
    { $project: { __agg: 0 } },
    branch("bookings", { bookingStatus: "confirmed" }, "grandTotal", "gstAmount", "bookedAt"),
    { $addFields: { __bookingAgg: { $arrayElemAt: ["$__agg", 0] } } },
    { $project: { __agg: 0 } },
    branch("pos_bookings", { bookingStatus: "confirmed" }, "grandTotal", "gstAmount", "bookedAt"),
    { $addFields: { __posAgg: { $arrayElemAt: ["$__agg", 0] } } },
    { $project: { __agg: 0 } },
    {
      $addFields: {
        _totalBookings: {
          $add: [
            { $ifNull: ["$__hallAgg.count", 0] },
            { $ifNull: ["$__bookingAgg.count", 0] },
            { $ifNull: ["$__posAgg.count", 0] },
          ],
        },
        _totalAmount: {
          $add: [
            { $ifNull: ["$__hallAgg.total", 0] },
            { $ifNull: ["$__bookingAgg.total", 0] },
            { $ifNull: ["$__posAgg.total", 0] },
          ],
        },
        _totalGstAmount: {
          $add: [
            { $ifNull: ["$__hallAgg.gst", 0] },
            { $ifNull: ["$__bookingAgg.gst", 0] },
            { $ifNull: ["$__posAgg.gst", 0] },
          ],
        },
        _lastBookingDate: {
          $max: ["$__hallAgg.last", "$__bookingAgg.last", "$__posAgg.last"],
        },
      },
    },
    { $addFields: { _totalGlAmount: { $subtract: ["$_totalAmount", "$_totalGstAmount"] } } },
    { $project: { __hallAgg: 0, __bookingAgg: 0, __posAgg: 0 } },
  ];
}

const REPORT_SOURCES = [
  {
    key: "hallBookings",
    label: "Hall Booking Report",
    description: "One row per Hall Booking — every field here is denormalized on the booking itself, so this report never needs a join.",
    model: HallBooking,
    basePipeline: [{ $match: { isDeleted: false } }],
    defaultSort: { field: "eventDate", dir: "desc" },
    fields: [
      { key: "bookingNumber", label: "Booking No", type: "string", path: "bookingNumber" },
      { key: "customerName", label: "Customer", type: "string", path: "customerInfo.name" },
      { key: "customerMobile", label: "Customer Mobile", type: "string", path: "customerInfo.mobileNumber" },
      { key: "customerEmail", label: "Customer Email", type: "string", path: "customerInfo.email" },
      { key: "hallName", label: "Hall", type: "string", path: "hallName" },
      { key: "hallPurposeName", label: "Hall Purpose", type: "string", path: "hallPurposeName" },
      { key: "hallPackageName", label: "Hall Package", type: "string", path: "hallPackageName" },
      { key: "bookingType", label: "Booking Type", type: "string", path: "bookingType", options: ["individual", "package"] },
      { key: "eventDate", label: "Event Date", type: "date", path: "eventDate" },
      { key: "startTime", label: "Start Time", type: "string", path: "startTime" },
      { key: "endTime", label: "End Time", type: "string", path: "endTime" },
      { key: "foodRequired", label: "Food Required", type: "boolean", path: "foodRequired" },
      { key: "foodPackageName", label: "Food Package", type: "string", path: "foodPackageName" },
      { key: "paxCount", label: "Pax Count", type: "number", path: "paxCount" },
      { key: "amount", label: "Amount", type: "number", path: "finalAmount" },
      { key: "subtotalAmount", label: "Subtotal", type: "number", path: "subtotalAmount" },
      { key: "hallAmount", label: "Hall Amount", type: "number", path: "hallAmount" },
      { key: "foodAmount", label: "Food Amount", type: "number", path: "foodAmount" },
      { key: "additionalHourAmount", label: "Additional Hour Amount", type: "number", path: "additionalHourAmount" },
      { key: "gstAmount", label: "GST Amount", type: "number", path: "gstAmount" },
      { key: "discountAmount", label: "Discount Amount", type: "number", path: "discountAmount" },
      { key: "advanceAmount", label: "Advance Amount", type: "number", path: "advanceAmount" },
      { key: "depositAmount", label: "Deposit Amount", type: "number", path: "depositAmount" },
      { key: "paymentStatus", label: "Payment Status", type: "string", path: "paymentStatus", options: ["unpaid", "partial", "paid"] },
      { key: "bookingStatus", label: "Booking Status", type: "string", path: "bookingStatus", options: ["confirmed", "completed", "cancelled"] },
      { key: "membershipNumber", label: "Membership Number", type: "string", path: "membershipNumber" },
      { key: "memberName", label: "Member Name", type: "string", path: "memberName" },
      { key: "remarks", label: "Remarks", type: "string", path: "remarks" },
      { key: "bookedByName", label: "Booked By", type: "string", path: "bookedByInfo.name" },
      { key: "bookedAt", label: "Booked At", type: "date", path: "bookedAt" },
    ],
  },

  {
    key: "customers",
    label: "Customer Report",
    description: "One row per Customer. Total Bookings/Amount/GST Amount/GL Amount/Last Booking Date are rolled up live across Hall Bookings, Admin Bookings and POS Bookings — only computed when one of those fields is actually selected.",
    model: Customer,
    basePipeline: [{ $match: { isDeleted: false } }],
    defaultSort: { field: "name", dir: "asc" },
    fields: [
      { key: "customerCode", label: "Customer Code", type: "string", path: "customerCode" },
      { key: "name", label: "Customer Name", type: "string", path: "name" },
      { key: "mobileNumber", label: "Contact No", type: "string", path: "mobileNumber" },
      { key: "email", label: "Email", type: "string", path: "email" },
      { key: "isRegistered", label: "Registered", type: "boolean", path: "isRegistered" },
      {
        key: "familyMemberCount",
        label: "Family Member Count",
        type: "number",
        path: "_familyMemberCount",
        stageKey: "familyMemberCount",
        extraStages: familyMemberCountStages,
      },
      { key: "registeredAt", label: "Registered On", type: "date", path: "createdAt" },
      {
        key: "totalBookings",
        label: "Total Bookings",
        type: "number",
        path: "_totalBookings",
        stageKey: "customerRollup",
        extraStages: customerRollupStages,
      },
      {
        key: "totalAmount",
        label: "Total Amount",
        type: "number",
        path: "_totalAmount",
        stageKey: "customerRollup",
        extraStages: customerRollupStages,
      },
      {
        key: "totalGstAmount",
        label: "Total GST Amount",
        type: "number",
        path: "_totalGstAmount",
        stageKey: "customerRollup",
        extraStages: customerRollupStages,
      },
      {
        key: "totalGlAmount",
        label: "Total GL Amount",
        type: "number",
        path: "_totalGlAmount",
        stageKey: "customerRollup",
        extraStages: customerRollupStages,
      },
      {
        key: "lastBookingDate",
        label: "Last Booking Date",
        type: "date",
        path: "_lastBookingDate",
        stageKey: "customerRollup",
        extraStages: customerRollupStages,
      },
    ],
  },

  {
    key: "itemSales",
    label: "Item/Service/Event Sales Report",
    description: "One row per item, service or event line sold — Admin Bookings and POS Bookings combined. Category needs one small lookup, included only when selected.",
    model: Booking,
    basePipeline: [
      ...itemSalesBranch({ sourceLabel: "Admin Booking" }),
      { $unionWith: { coll: "pos_bookings", pipeline: itemSalesBranch({ sourceLabel: "POS Counter", byPortal: true }) } },
    ],
    defaultSort: { field: "saleDate", dir: "desc" },
    fields: [
      { key: "bookingNumber", label: "Booking No", type: "string", path: "_bookingNumber" },
      { key: "itemName", label: "Item/Service/Event Name", type: "string", path: "_name" },
      { key: "code", label: "Code", type: "string", path: "_code" },
      { key: "refType", label: "Type", type: "string", path: "_refType", options: ["Item", "Service", "Event"] },
      {
        key: "category",
        label: "Category",
        type: "string",
        path: "_categoryName",
        stageKey: "categoryLookup",
        extraStages: categoryLookupStages,
      },
      {
        key: "subCategory",
        label: "Sub Category",
        type: "string",
        path: "_subCategoryName",
        stageKey: "categoryLookup",
        extraStages: categoryLookupStages,
      },
      { key: "quantity", label: "Quantity", type: "number", path: "_quantity" },
      { key: "unitPrice", label: "Unit Price", type: "number", path: "_unitPrice" },
      { key: "saleAmount", label: "Sale Amount", type: "number", path: "_lineTotal" },
      { key: "gstAmount", label: "GST", type: "number", path: "_gstAmount" },
      { key: "glAmount", label: "GL Amount", type: "number", path: "_glAmount" },
      {
        key: "deityNames",
        label: "Deity Mapping",
        type: "string",
        path: "_deityNames",
        stageKey: "deityLookup",
        extraStages: deityLookupStages,
      },
      { key: "devoteeNames", label: "Devotee Name(s)", type: "string", path: "_devoteeNames" },
      { key: "customerName", label: "Customer", type: "string", path: "_customerName" },
      { key: "customerMobile", label: "Customer Mobile", type: "string", path: "_customerMobile" },
      { key: "paymentModeName", label: "Payment Mode", type: "string", path: "_paymentModeName" },
      { key: "paymentStatus", label: "Payment Status", type: "string", path: "_paymentStatus", options: ["paid", "partial", "pending"] },
      { key: "bookingTotal", label: "Booking Total", type: "number", path: "_bookingTotal" },
      { key: "source", label: "Source", type: "string", path: "_source", options: ["Admin Booking", "POS Counter"] },
      { key: "saleDate", label: "Sale Date", type: "date", path: "_saleDate" },
    ],
  },

  {
    key: "payments",
    label: "Payment Report",
    description: "One row per payment receipt — Hall Booking payments, Admin Booking transactions and POS Counter transactions combined. Booking No needs one small by-_id lookup, included only when selected.",
    model: HallBookingPayment,
    basePipeline: [
      ...paymentBranch({ bookingRefCollection: "hallbookings", bookingRefField: "booking", sourceLabel: "Hall Booking" }),
      {
        $unionWith: {
          coll: "transactions",
          pipeline: paymentBranch({ bookingRefCollection: "bookings", bookingRefField: "bookingId", sourceLabel: "Admin Booking" }),
        },
      },
      {
        $unionWith: {
          coll: "pos_transactions",
          pipeline: paymentBranch({ bookingRefCollection: "pos_bookings", bookingRefField: "bookingId", sourceLabel: "POS Counter", byPortal: true }),
        },
      },
    ],
    defaultSort: { field: "paymentDate", dir: "desc" },
    fields: [
      { key: "receiptNo", label: "Receipt No", type: "string", path: "_receiptNo" },
      {
        key: "bookingNumber",
        label: "Booking No",
        type: "string",
        path: "_bookingNumber",
        stageKey: "bookingNumberLookup",
        extraStages: bookingNumberLookupStages,
      },
      { key: "customerName", label: "Customer", type: "string", path: "_customerName" },
      { key: "customerMobile", label: "Customer Mobile", type: "string", path: "_customerMobile" },
      { key: "paymentDate", label: "Payment Date", type: "date", path: "_paymentDate" },
      { key: "paymentModeName", label: "Payment Mode", type: "string", path: "_paymentModeName" },
      { key: "paymentType", label: "Payment Type", type: "string", path: "_paymentType", options: ["deposit", "advance", "balance"] },
      { key: "referenceNo", label: "Reference No", type: "string", path: "_referenceNo" },
      { key: "paymentRequestRef", label: "Payment Request Ref", type: "string", path: "_paymentRequestRef" },
      { key: "processedByName", label: "Collected / Processed By", type: "string", path: "_processedByName" },
      { key: "amount", label: "Amount", type: "number", path: "_amount" },
      { key: "source", label: "Source", type: "string", path: "_source", options: ["Hall Booking", "Admin Booking", "POS Counter"] },
      // Payments confirmed by hand (PayNow / NETS / card entered by the cashier or an admin): filter on "Manually
      // Confirmed = Yes" for the list, and add the columns below for what was entered.
      { key: "isManuallyConfirmed", label: "Manually Confirmed", type: "boolean", path: "_isManuallyConfirmed" },
      { key: "manualRefNo", label: "Manual Confirmation Ref No", type: "string", path: "_manualRefNo" },
      { key: "manualPaidAt", label: "Manual - Payment Date", type: "date", path: "_manualPaidAt" },
      { key: "manualPayerName", label: "Manual - Payer Name", type: "string", path: "_manualPayerName" },
      { key: "manualPayerBank", label: "Manual - Payer Bank", type: "string", path: "_manualPayerBank" },
      { key: "manualRemarks", label: "Manual - Remarks", type: "string", path: "_manualRemarks" },
      { key: "manualConfirmedBy", label: "Manual - Confirmed By", type: "string", path: "_manualConfirmedBy" },
      { key: "manualConfirmedAt", label: "Manual - Confirmed At", type: "date", path: "_manualConfirmedAt" },
      // NETS / Credit Card terminal details: the terminal's own response, or what the cashier entered from its slip.
      { key: "term_terminalId", label: "Terminal - Terminal ID", type: "string", path: "_term_terminalId" },
      { key: "term_approvalCode", label: "Terminal - Approval Code", type: "string", path: "_term_approvalCode" },
      { key: "term_cardType", label: "Terminal - Card Type", type: "string", path: "_term_cardType" },
      { key: "term_cardNumber", label: "Terminal - Card Number (masked)", type: "string", path: "_term_cardNumber" },
      { key: "term_batchNumber", label: "Terminal - Batch No", type: "string", path: "_term_batchNumber" },
      { key: "term_stan", label: "Terminal - STAN", type: "string", path: "_term_stan" },
      { key: "term_rrn", label: "Terminal - Retrieval Ref No (RRN)", type: "string", path: "_term_rrn" },
    ],
  },
];

function getReportSource(sourceKey) {
  const source = REPORT_SOURCES.find((s) => s.key === sourceKey);
  if (!source) throw `Unknown report source "${sourceKey}".`;
  return source;
}

/** The catalog shape the frontend's report builder renders from — no Mongoose models leaked across the wire. */
function listReportSourcesForClient() {
  return REPORT_SOURCES.map((s) => ({
    key: s.key,
    label: s.label,
    description: s.description,
    defaultSort: s.defaultSort,
    fields: s.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options ?? null })),
  }));
}

module.exports = { REPORT_SOURCES, getReportSource, listReportSourcesForClient };
