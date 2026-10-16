/** PAYNOW_MODE unset on a production-built server: PayNow is off. */
const refuse = () => {
  throw "PayNow is not enabled on this server (PAYNOW_MODE is not set).";
};

module.exports = {
  mode: "disabled",
  assertReady: refuse,
  async generateQr() {
    refuse();
  },
};
