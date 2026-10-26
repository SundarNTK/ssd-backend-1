const { heading, button, note, plainLink, blessing, small } = require("./shared");

const MARKER = "ssd-template:account-activation:v2";

module.exports = {
  name: "Account Activation",
  event: "ACCOUNT_ACTIVATION",
  subject: "Set your password — Sri Siva Durga Temple",
  marker: MARKER,
  htmlContent: `<!-- ${MARKER} -->
${heading("Welcome to the temple family")}
<p style="margin:0 0 14px;">Dear <strong>{{name}}</strong>,</p>
<p style="margin:0 0 14px;">We are pleased to welcome you to the Sri Siva Durga Temple community. Your account has been created successfully.</p>
<p style="margin:0;">Please set your password to get started and access your temple account.</p>
${button("{{activationUrl}}", "Set Your Password")}
${note(`This link can be used once and does not expire. If the button does not work, copy this address into your browser:<br />${plainLink("{{activationUrl}}")}`)}
${blessing}
${small("If you did not request this account, you may safely ignore this email.")}`,
};
