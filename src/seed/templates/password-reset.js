const { heading, button, note, plainLink, small } = require("./shared");

const MARKER = "ssd-template:password-reset:v2";

module.exports = {
  name: "Password Reset",
  event: "PASSWORD_RESET",
  subject: "Reset your password — Sri Siva Durga Temple",
  marker: MARKER,
  htmlContent: `<!-- ${MARKER} -->
${heading("Reset your password")}
<p style="margin:0 0 14px;">Dear <strong>{{name}}</strong>,</p>
<p style="margin:0;">We received a request to reset your password. Use the button below to choose a new one.</p>
${button("{{resetUrl}}", "Reset Password")}
${note(`This link expires in <strong>{{expiresInMinutes}} minutes</strong> and can be used once. If the button does not work, copy this address into your browser:<br />${plainLink("{{resetUrl}}")}`)}
${small("If you didn't request this, your password is still safe — just ignore this email.")}`,
};
