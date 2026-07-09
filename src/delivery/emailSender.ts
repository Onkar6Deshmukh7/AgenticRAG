/**
 * emailSender.ts — sends a generated report by email via Gmail SMTP.
 *
 * IMPORTANT BEHAVIORAL RULE: email is sent ONLY when the user clicks
 * "Send via Email" in the report viewer (POST /api/reports/:id/email).
 * Nothing in the pipeline emails automatically.
 *
 * Setup: a Gmail App Password (not the account password) in SMTP_PASS —
 * see README. If SMTP isn't configured, we return a clear error the UI
 * shows as a toast; the report itself is unaffected.
 */
import nodemailer from "nodemailer";
import { ENV } from "../config.js";
import type { ReportRecord } from "../types.js";

export function isEmailConfigured(): boolean {
  return Boolean(ENV.SMTP_USER && ENV.SMTP_PASS && ENV.REPORT_EMAIL_TO);
}

/**
 * Send the report. Returns the recipient on success; throws with a
 * human-readable message on failure (the route converts it to a toast).
 */
export async function sendReportEmail(report: ReportRecord): Promise<string> {
  if (!isEmailConfigured()) {
    throw new Error(
      "Email not configured — set SMTP_USER, SMTP_PASS and REPORT_EMAIL_TO in .env (see README)."
    );
  }

  const transporter = nodemailer.createTransport({
    host: ENV.SMTP_HOST,
    port: ENV.SMTP_PORT,
    secure: ENV.SMTP_PORT === 465, // 587 uses STARTTLS, 465 uses implicit TLS
    auth: { user: ENV.SMTP_USER, pass: ENV.SMTP_PASS },
  });

  const subject = `[RCA Report] ${report.metricDisplayName} breach — severity: ${report.severity}`;

  // Simple plaintext + markdown body. Email clients render it readably and
  // we avoid shipping an HTML templating step for v1.
  const text = [
    `An RCA report was generated for a guardrail breach.`,
    ``,
    `Metric:    ${report.metricDisplayName} (${report.metricKey})`,
    `Value:     ${report.breachValue} (guardrail: ${report.guardrailDirection} ${report.guardrailValue})`,
    `Framework: ${report.framework}`,
    `Severity:  ${report.severity}`,
    `Generated: ${report.generatedAt} by ${report.llmProvider}`,
    ``,
    `--- Full report (markdown) ---`,
    ``,
    report.reportMarkdown,
  ].join("\n");

  await transporter.sendMail({
    from: `"RCA Tool" <${ENV.SMTP_USER}>`,
    to: ENV.REPORT_EMAIL_TO,
    subject,
    text,
  });

  console.log(`[email] Report ${report.id} sent to ${ENV.REPORT_EMAIL_TO}`);
  return ENV.REPORT_EMAIL_TO;
}
