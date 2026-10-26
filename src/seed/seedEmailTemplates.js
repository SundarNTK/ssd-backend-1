const EmailTemplate = require("../models/email-templates");
const EmailTemplateMapping = require("../models/email-template-mappings");
const bookingConfirmationTemplate = require("./templates/booking-confirmation");

const accountActivationTemplate = require("./templates/account-activation");
const passwordResetTemplate = require("./templates/password-reset");

/**
 * Inner message only. The logo and the card around it are added when the
 * mail is sent (see common/mailer/render-email.js), using the entity logo.
 * Each default carries a version marker, so a deploy can replace an older copy nobody has edited.
 */
const DEFAULT_TEMPLATES = [accountActivationTemplate, passwordResetTemplate, bookingConfirmationTemplate];

function wasNeverEdited(doc) {
  if (!doc.updatedAt || !doc.createdAt) return true;
  return Math.abs(new Date(doc.updatedAt).getTime() - new Date(doc.createdAt).getTime()) < 5000;
}

/**
 * Idempotent — safe to run on every seed. Creates the template and copies
 * its subject and inner content onto the entity's mapping. An existing
 * mapping that already has its own content is left alone: that content is
 * what gets sent, and it is not the template master.
 */
async function ensureDefaultEmailTemplates(entityId) {
  for (const def of DEFAULT_TEMPLATES) {
    let template = await EmailTemplate.findOne(EmailTemplate.notDeletedFilter({ name: def.name }));
    if (!template) {
      template = await EmailTemplate.create({
        name: def.name,
        subject: def.subject,
        htmlContent: def.htmlContent,
        description: `Seeded default for the ${def.event} event.`,
      });
      console.log(`>>> Seed: email template "${def.name}" created`);
    } else if (
      wasNeverEdited(template) &&
      String(template.htmlContent || "").includes("font-family:Georgia,serif;background:#fbf6ea")
    ) {
      template.subject = def.subject;
      template.htmlContent = def.htmlContent;
      template.description = `Seeded default for the ${def.event} event.`;
      await template.save();
      console.log(`>>> Seed: email template "${def.name}" stored as inner content (logo comes from the entity)`);
    }

    // A newer version of a default (it carries a version marker): replace an older copy that nobody has edited, in
    // the template and in this entity's mapping. An edited copy is never touched.
    if (def.marker && !String(template.htmlContent || "").includes(def.marker)) {
      const previousContent = template.htmlContent;
      if (wasNeverEdited(template)) {
        template.subject = def.subject;
        template.htmlContent = def.htmlContent;
        await template.save();
        console.log(`>>> Seed: email template "${def.name}" upgraded to the latest default`);
      }
      const outdated = await EmailTemplateMapping.findOne(EmailTemplateMapping.notDeletedFilter({ entity: entityId, event: def.event }));
      if (outdated && template.htmlContent === def.htmlContent && String(outdated.content || "").trim() === String(previousContent || "").trim()) {
        outdated.subject = template.subject;
        outdated.content = template.htmlContent;
        await outdated.save();
        console.log(`>>> Seed: "${def.event}" mapping upgraded to the latest default`);
      }
    }

    const existingMapping = await EmailTemplateMapping.findOne(
      EmailTemplateMapping.notDeletedFilter({ entity: entityId, event: def.event })
    );
    if (!existingMapping) {
      await EmailTemplateMapping.create({
        entity: entityId,
        event: def.event,
        template: template._id,
        subject: template.subject,
        content: template.htmlContent,
        fromOverride: null,
        cc: [],
        bcc: [],
      });
      console.log(`>>> Seed: mapped event "${def.event}" → "${def.name}" for entity ${entityId}`);
    } else if (!String(existingMapping.content || "").trim()) {
      existingMapping.subject = template.subject;
      existingMapping.content = template.htmlContent;
      await existingMapping.save();
      console.log(`>>> Seed: copied "${def.name}" into the "${def.event}" mapping`);
    }
  }
}

/**
 * Run on every server start (UAT and production deploys included): for each active entity, make sure every default
 * template and its event mapping exists. Anything already there is left exactly as it is - including a template an
 * admin has edited - so this only ever inserts what is missing. Never throws: a failure is logged and the server
 * still starts.
 */
async function ensureDefaultEmailTemplatesForAllEntities() {
  try {
    const Entity = require("../models/entities");
    const entities = await Entity.find(Entity.notDeletedFilter({ status: 1 })).select("_id");
    for (const entity of entities) await ensureDefaultEmailTemplates(entity._id);
    return { entities: entities.length };
  } catch (err) {
    console.error(">>> Seed: could not ensure the default email templates:", err.message);
    return { entities: 0, error: err.message };
  }
}

module.exports = { ensureDefaultEmailTemplates, ensureDefaultEmailTemplatesForAllEntities, DEFAULT_TEMPLATES };
