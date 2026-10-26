const handlebars = require("handlebars");
const EmailTemplateMapping = require("../../../models/email-template-mappings");
const Entity = require("../../../models/entities");
const env = require("../../../config/env");
const { sendRawEmail } = require("../../../common/mailer/transport");
const { renderEmailHtml, htmlToText } = require("../../../common/mailer/render-email");

function publicLogo(url) {
  const value = String(url || "").trim();
  if (/^https:\/\//i.test(value) && !/localhost|127\.0\.0\.1/i.test(value)) return value;
  return "";
}

/**
 * Event → entity → mapping → render → send. The one function every other
 * module calls to email someone.
 *
 * The subject and the inner HTML come from the mapping (a copy of the
 * chosen Email Template, which the mapping screen may have edited). The
 * card, header, and logo are the shared shell — the logo is the entity's
 * uploaded image, with EMAIL_LOGO_URL only when that image is still empty.
 */
async function sendTemplatedEmail(event, entityId, to, data = {}, { attachments = [] } = {}) {
  const mapping = await EmailTemplateMapping.findOne(
    EmailTemplateMapping.notDeletedFilter({
      entity: entityId,
      event: String(event).toUpperCase(),
      status: 1,
    })
  ).populate("template");

  if (!mapping) {
    throw new Error(
      `No active email template mapped for event "${event}" on entity "${entityId}". Configure one in Email Template Mapping.`
    );
  }

  const subjectSource = mapping.subject || mapping.template?.subject;
  const bodySource = mapping.content || mapping.template?.htmlContent;
  if (!subjectSource || !bodySource) {
    throw new Error(
      `The mapping for event "${event}" has no subject or content. Open Email Template Mapping and save the message.`
    );
  }

  let subject;
  let inner;
  try {
    subject = handlebars.compile(subjectSource)(data);
    inner = handlebars.compile(bodySource)(data);
  } catch (err) {
    throw new Error(`The email for "${event}" could not be rendered: ${err.message}`);
  }

  const entity = entityId
    ? await Entity.findById(entityId).select("logoUrl templeName name address mobileNumber email")
    : null;
  const logo = publicLogo(entity?.logoUrl) || publicLogo(env.EMAIL_LOGO_URL);
  const templeName = entity?.templeName || entity?.name || "Sri Siva Durga Temple";
  // The footer: where the temple is and how to reach it, from the Entity master.
  const a = entity?.address || {};
  const footerAddress = [[a.block, a.street].filter(Boolean).join(" "), a.unit, [a.country, a.pincode].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const footerContact = [entity?.mobileNumber, entity?.email].filter(Boolean).join("  |  ");
  const html = renderEmailHtml({ body: inner, entityLogo: logo, templeName, footerAddress, footerContact });
  const from = mapping.fromOverride || undefined;
  const fromDomain = String(from || env.SENDER_EMAIL_ID || "").split("@")[1] || "";
  const fromName = /^(gmail|googlemail)\.com$/i.test(fromDomain) ? undefined : templeName;

  return sendRawEmail({
    to,
    subject,
    html,
    text: htmlToText(html),
    cc: mapping.cc,
    bcc: mapping.bcc,
    from,
    fromName,
    attachments,
  });
}

module.exports = sendTemplatedEmail;
