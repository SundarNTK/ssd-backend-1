const mongoose = require("mongoose");

/** A booking's record of the Booking Confirmation emails sent from the Transactions screen: when, to whom, by whom. */
const emailLogFields = {
  emailLog: {
    type: [
      new mongoose.Schema(
        {
          at: { type: Date, default: Date.now },
          to: { type: String, default: "" },
          by: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
          byName: { type: String, default: "" },
        },
        { _id: false }
      ),
    ],
    default: [],
  },
};

module.exports = { emailLogFields };
