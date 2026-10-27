/**
 * PAYNOW_MODE=manual: PayNow payments are confirmed by hand, so there is no QR to build and nothing to configure. The
 * pending payment is still created (its reference is what the manual confirmation is made against); the QR is empty.
 */
module.exports = {
  mode: "manual",
  assertReady() {},
  async generateQr() {
    return { qrImage: "", engine: "manual" };
  },
};
