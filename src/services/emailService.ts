import nodemailer from 'nodemailer';

const createTransporter = () => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

interface InvoiceEmailData {
  invoiceNumber: string;
  businessName: string;
  clientName: string;
  recipientEmail: string;
  total: number;
  currency: string;
  dueDate: string;
  lineItems: Array<{ description: string; quantity: number; unitPrice: number; total: number }>;
  subtotal: number;
  tax: number;
  notes?: string | undefined;
  publicLink: string;
}

export const sendInvoiceEmail = async (data: InvoiceEmailData): Promise<boolean> => {
  const transporter = createTransporter();
  if (!transporter) {
    console.warn('[Email] SMTP not configured — skipping email send.');
    return false;
  }

  const formattedTotal = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: data.currency || 'USD',
  }).format(data.total);

  const formattedDue = new Date(data.dueDate).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const lineItemRows = data.lineItems.map(item => `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;">${item.description}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;text-align:center;">${item.quantity}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;text-align:right;">${item.unitPrice.toLocaleString()}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#0f172a;text-align:right;">${item.total.toLocaleString()}</td>
    </tr>
  `).join('');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">

        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:40px 40px 32px;">
            <table width="100%">
              <tr>
                <td>
                  <p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.6);">Invoice from</p>
                  <h1 style="margin:0;font-size:24px;font-weight:900;color:#ffffff;">${data.businessName}</h1>
                </td>
                <td align="right">
                  <div style="background:rgba(255,255,255,0.15);border-radius:12px;padding:12px 20px;display:inline-block;">
                    <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.7);">Invoice</p>
                    <p style="margin:4px 0 0;font-size:18px;font-weight:900;color:#ffffff;">${data.invoiceNumber}</p>
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Billed To -->
        <tr>
          <td style="padding:32px 40px 0;">
            <table width="100%">
              <tr>
                <td>
                  <p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;">Billed to</p>
                  <p style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">${data.clientName}</p>
                </td>
                <td align="right">
                  <p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;">Due date</p>
                  <p style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">${formattedDue}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Line Items -->
        <tr>
          <td style="padding:24px 40px 0;">
            <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:12px;overflow:hidden;border:1px solid #f1f5f9;">
              <thead>
                <tr style="background:#f8fafc;">
                  <th style="padding:12px 16px;font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;text-align:left;">Description</th>
                  <th style="padding:12px 16px;font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;text-align:center;">Qty</th>
                  <th style="padding:12px 16px;font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;text-align:right;">Unit Price</th>
                  <th style="padding:12px 16px;font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;text-align:right;">Total</th>
                </tr>
              </thead>
              <tbody>${lineItemRows}</tbody>
            </table>
          </td>
        </tr>

        <!-- Totals -->
        <tr>
          <td style="padding:16px 40px 0;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td></td>
                <td width="240">
                  <table width="100%">
                    <tr>
                      <td style="padding:6px 0;font-size:13px;color:#64748b;">Subtotal</td>
                      <td style="padding:6px 0;font-size:13px;color:#334155;text-align:right;">${data.subtotal.toLocaleString()}</td>
                    </tr>
                    ${data.tax > 0 ? `<tr>
                      <td style="padding:6px 0;font-size:13px;color:#64748b;">Tax</td>
                      <td style="padding:6px 0;font-size:13px;color:#334155;text-align:right;">${data.tax.toLocaleString()}</td>
                    </tr>` : ''}
                    <tr>
                      <td style="padding:12px 0 4px;font-size:15px;font-weight:800;color:#0f172a;border-top:2px solid #f1f5f9;">Total Due</td>
                      <td style="padding:12px 0 4px;font-size:18px;font-weight:900;color:#4f46e5;text-align:right;border-top:2px solid #f1f5f9;">${formattedTotal}</td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        ${data.notes ? `<tr><td style="padding:16px 40px 0;"><div style="background:#f8fafc;border-radius:10px;padding:16px;"><p style="margin:0 0 4px;font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;">Notes</p><p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">${data.notes}</p></div></td></tr>` : ''}

        <!-- CTA -->
        <tr>
          <td style="padding:32px 40px 40px;" align="center">
            <a href="${data.publicLink}" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#ffffff;text-decoration:none;font-size:14px;font-weight:800;letter-spacing:1px;padding:16px 48px;border-radius:12px;text-transform:uppercase;">
              View &amp; Pay Invoice
            </a>
            <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">Or copy this link: <a href="${data.publicLink}" style="color:#4f46e5;word-break:break-all;">${data.publicLink}</a></p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #f1f5f9;text-align:center;">
            <p style="margin:0;font-size:11px;color:#94a3b8;">Powered by <strong style="color:#4f46e5;">OpsFlow</strong></p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from: `"${data.businessName}" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
      to: data.recipientEmail,
      subject: `Invoice ${data.invoiceNumber} from ${data.businessName} — ${formattedTotal} due ${formattedDue}`,
      html,
    });
    return true;
  } catch (err) {
    console.error('[Email] Failed to send invoice email:', err);
    return false;
  }
};
