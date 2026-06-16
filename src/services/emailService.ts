const esc = (str: string | undefined | null): string =>
  String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

interface BrevoPayload {
  sender: { name: string; email: string };
  to: { email: string; name?: string }[];
  subject: string;
  htmlContent: string;
}

async function sendBrevoEmail(payload: BrevoPayload): Promise<boolean> {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn('[Email] BREVO_API_KEY not set — skipping email send.');
    return false;
  }

  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@morniy.com';
  const body = { ...payload, sender: { ...payload.sender, email: senderEmail } };

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[Email] Brevo error:', err);
      return false;
    }

    const result = await res.json() as { messageId?: string };
    console.log('[Email] Sent via Brevo — messageId:', result.messageId);
    return true;
  } catch (err: any) {
    console.error('[Email] Brevo request failed:', err?.message);
    return false;
  }
}

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

export const sendReminderEmail = async (data: {
  recipientEmail: string;
  clientName: string;
  businessName: string;
  invoiceNumber: string;
  total: number;
  currency: string;
  dueDate: string;
  publicLink: string;
  type: 'upcoming' | 'due_today' | 'overdue';
}): Promise<boolean> => {
  const formattedTotal = new Intl.NumberFormat('en-NG', {
    style: 'currency', currency: data.currency || 'NGN', minimumFractionDigits: 0,
  }).format(data.total);
  const formattedDue = new Date(data.dueDate).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });

  const subjects = {
    upcoming: `Reminder: Invoice ${data.invoiceNumber} due in 3 days`,
    due_today: `Payment due today: Invoice ${data.invoiceNumber} — ${formattedTotal}`,
    overdue: `Overdue: Invoice ${data.invoiceNumber} — ${formattedTotal} past due`,
  };
  const headings = {
    upcoming: `Your invoice is due soon`,
    due_today: `Payment is due today`,
    overdue: `Invoice overdue`,
  };
  const colors = { upcoming: '#f59e0b', due_today: '#6366f1', overdue: '#ef4444' };
  const color = colors[data.type];

  const sBusinessName = esc(data.businessName);
  const sClientName = esc(data.clientName);
  const sInvoiceNumber = esc(data.invoiceNumber);

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 16px;"><tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">
    <tr><td style="background:${color};padding:32px 40px;">
      <h1 style="margin:0;font-size:22px;font-weight:900;color:#fff;">${headings[data.type]}</h1>
      <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.8);">From ${sBusinessName}</p>
    </td></tr>
    <tr><td style="padding:32px 40px;">
      <p style="margin:0 0 8px;font-size:15px;color:#334155;">Hi <strong>${sClientName}</strong>,</p>
      <p style="margin:0 0 24px;font-size:14px;color:#64748b;line-height:1.6;">
        ${data.type === 'upcoming' ? `This is a reminder that invoice <strong>${sInvoiceNumber}</strong> for <strong>${formattedTotal}</strong> is due on <strong>${formattedDue}</strong>.`
          : data.type === 'due_today' ? `Invoice <strong>${sInvoiceNumber}</strong> for <strong>${formattedTotal}</strong> is due <strong>today</strong>.`
          : `Invoice <strong>${sInvoiceNumber}</strong> for <strong>${formattedTotal}</strong> was due on <strong>${formattedDue}</strong> and has not been paid yet.`}
      </p>
      <table width="100%" style="background:#f8fafc;border-radius:12px;padding:20px;margin-bottom:24px;"><tr>
        <td><p style="margin:0;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:2px;font-weight:800;">Amount Due</p>
          <p style="margin:4px 0 0;font-size:28px;font-weight:900;color:${color};">${formattedTotal}</p></td>
        <td align="right"><p style="margin:0;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:2px;font-weight:800;">Invoice</p>
          <p style="margin:4px 0 0;font-size:16px;font-weight:700;color:#334155;">${sInvoiceNumber}</p></td>
      </tr></table>
      <a href="${data.publicLink}" style="display:block;text-align:center;background:${color};color:#fff;text-decoration:none;font-size:14px;font-weight:800;padding:16px 40px;border-radius:12px;text-transform:uppercase;letter-spacing:1px;">
        View &amp; Pay Invoice
      </a>
    </td></tr>
    <tr><td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #f1f5f9;text-align:center;">
      <p style="margin:0;font-size:11px;color:#94a3b8;">Powered by <strong style="color:#4f46e5;">Morniy</strong></p>
    </td></tr>
  </table></td></tr></table>
  </body></html>`;

  return sendBrevoEmail({
    sender: { name: data.businessName, email: '' },
    to: [{ email: data.recipientEmail, name: data.clientName }],
    subject: subjects[data.type],
    htmlContent: html,
  });
};

export const sendReceiptEmail = async (data: {
  recipientEmail: string;
  clientName: string;
  businessName: string;
  invoiceNumber: string;
  total: number;
  currency: string;
  paidAt: string;
  publicLink: string;
}): Promise<boolean> => {
  const formattedTotal = new Intl.NumberFormat('en-NG', {
    style: 'currency', currency: data.currency || 'NGN', minimumFractionDigits: 0,
  }).format(data.total);
  const formattedDate = new Date(data.paidAt).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
  const sBusinessName = esc(data.businessName);
  const sClientName = esc(data.clientName);
  const sInvoiceNumber = esc(data.invoiceNumber);

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0fdf4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;padding:40px 16px;"><tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">
    <tr><td style="background:#10b981;padding:32px 40px;">
      <h1 style="margin:0;font-size:22px;font-weight:900;color:#fff;">Payment Received</h1>
      <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.8);">From ${sBusinessName}</p>
    </td></tr>
    <tr><td style="padding:32px 40px;">
      <p style="margin:0 0 8px;font-size:15px;color:#334155;">Hi <strong>${sClientName}</strong>,</p>
      <p style="margin:0 0 24px;font-size:14px;color:#64748b;line-height:1.6;">
        We&#x27;ve received your payment for invoice <strong>${sInvoiceNumber}</strong>. Thank you!
      </p>
      <table width="100%" style="background:#f0fdf4;border-radius:12px;padding:20px;margin-bottom:24px;"><tr>
        <td><p style="margin:0;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:2px;font-weight:800;">Amount Paid</p>
          <p style="margin:4px 0 0;font-size:28px;font-weight:900;color:#10b981;">${formattedTotal}</p></td>
        <td align="right"><p style="margin:0;font-size:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:2px;font-weight:800;">Paid On</p>
          <p style="margin:4px 0 0;font-size:14px;font-weight:700;color:#334155;">${formattedDate}</p></td>
      </tr></table>
      <a href="${data.publicLink}" style="display:block;text-align:center;background:#10b981;color:#fff;text-decoration:none;font-size:14px;font-weight:800;padding:16px 40px;border-radius:12px;text-transform:uppercase;letter-spacing:1px;">
        View Invoice &amp; Receipt
      </a>
    </td></tr>
    <tr><td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #f1f5f9;text-align:center;">
      <p style="margin:0;font-size:11px;color:#94a3b8;">Powered by <strong style="color:#4f46e5;">Morniy</strong></p>
    </td></tr>
  </table></td></tr></table>
  </body></html>`;

  return sendBrevoEmail({
    sender: { name: data.businessName, email: '' },
    to: [{ email: data.recipientEmail, name: data.clientName }],
    subject: `Payment confirmed — Invoice ${data.invoiceNumber} | ${data.businessName}`,
    htmlContent: html,
  });
};

export const sendProposalEmail = async (data: {
  recipientEmail: string;
  clientName: string;
  businessName: string;
  proposalNumber: string;
  title: string;
  total: number;
  currency: string;
  validUntil: string;
  lineItems: Array<{ description: string; quantity: number; unitPrice: number; total: number }>;
  subtotal: number;
  tax: number;
  notes?: string;
  publicLink: string;
}): Promise<boolean> => {
  const formattedTotal = new Intl.NumberFormat('en-NG', {
    style: 'currency', currency: data.currency || 'NGN', minimumFractionDigits: 0,
  }).format(data.total);
  const formattedValid = new Date(data.validUntil).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
  const sBusinessName = esc(data.businessName);
  const sClientName = esc(data.clientName);
  const sProposalNumber = esc(data.proposalNumber);
  const sTitle = esc(data.title);
  const sNotes = esc(data.notes);

  const lineItemRows = data.lineItems.map(item => `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;">${esc(item.description)}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;text-align:center;">${item.quantity}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;text-align:right;">${item.unitPrice.toLocaleString('en-NG')}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#0f172a;text-align:right;">${item.total.toLocaleString('en-NG')}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 16px;"><tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">
    <tr><td style="background:linear-gradient(135deg,#0f172a,#1e293b);padding:40px 40px 32px;">
      <table width="100%"><tr>
        <td><p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.5);">Proposal from</p>
          <h1 style="margin:0;font-size:24px;font-weight:900;color:#ffffff;">${sBusinessName}</h1></td>
        <td align="right"><div style="background:rgba(255,255,255,0.1);border-radius:12px;padding:12px 20px;">
          <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.6);">Proposal</p>
          <p style="margin:4px 0 0;font-size:18px;font-weight:900;color:#ffffff;">${sProposalNumber}</p>
        </div></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:32px 40px 0;">
      <table width="100%"><tr>
        <td><p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;">Prepared for</p>
          <p style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">${sClientName}</p></td>
        <td align="right"><p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;">Valid until</p>
          <p style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">${formattedValid}</p></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:24px 40px 0;">
      <p style="margin:0 0 12px;font-size:13px;font-weight:700;color:#475569;">Scope of Work</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-radius:12px;overflow:hidden;border:1px solid #f1f5f9;">
        <thead><tr style="background:#f8fafc;">
          <th style="padding:12px 16px;font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;text-align:left;">Description</th>
          <th style="padding:12px 16px;font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;text-align:center;">Qty</th>
          <th style="padding:12px 16px;font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;text-align:right;">Unit Price</th>
          <th style="padding:12px 16px;font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;text-align:right;">Total</th>
        </tr></thead>
        <tbody>${lineItemRows}</tbody>
      </table>
    </td></tr>
    <tr><td style="padding:16px 40px 0;">
      <table width="100%"><tr><td></td><td width="240">
        <table width="100%">
          <tr><td style="padding:6px 0;font-size:13px;color:#64748b;">Subtotal</td>
            <td style="padding:6px 0;font-size:13px;color:#334155;text-align:right;">${data.subtotal.toLocaleString('en-NG')}</td></tr>
          ${data.tax > 0 ? `<tr><td style="padding:6px 0;font-size:13px;color:#64748b;">Tax (${data.tax}%)</td>
            <td style="padding:6px 0;font-size:13px;color:#334155;text-align:right;">${(data.subtotal * data.tax / 100).toLocaleString('en-NG')}</td></tr>` : ''}
          <tr><td style="padding:12px 0 4px;font-size:15px;font-weight:800;color:#0f172a;border-top:2px solid #f1f5f9;">Total</td>
            <td style="padding:12px 0 4px;font-size:18px;font-weight:900;color:#4f46e5;text-align:right;border-top:2px solid #f1f5f9;">${formattedTotal}</td></tr>
        </table>
      </td></tr></table>
    </td></tr>
    ${data.notes ? `<tr><td style="padding:16px 40px 0;"><div style="background:#f8fafc;border-radius:10px;padding:16px;"><p style="margin:0 0 4px;font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;">Notes</p><p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">${sNotes}</p></div></td></tr>` : ''}
    <tr><td style="padding:32px 40px 40px;" align="center">
      <a href="${data.publicLink}" style="display:inline-block;background:linear-gradient(135deg,#0f172a,#1e293b);color:#ffffff;text-decoration:none;font-size:14px;font-weight:800;letter-spacing:1px;padding:16px 48px;border-radius:12px;text-transform:uppercase;">
        Review &amp; Respond
      </a>
      <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">Or copy: <a href="${data.publicLink}" style="color:#4f46e5;word-break:break-all;">${data.publicLink}</a></p>
    </td></tr>
    <tr><td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #f1f5f9;text-align:center;">
      <p style="margin:0;font-size:11px;color:#94a3b8;">Powered by <strong style="color:#4f46e5;">Morniy</strong></p>
    </td></tr>
  </table></td></tr></table>
</body></html>`;

  return sendBrevoEmail({
    sender: { name: data.businessName, email: '' },
    to: [{ email: data.recipientEmail, name: data.clientName }],
    subject: `Proposal ${data.proposalNumber}: ${sTitle} — ${formattedTotal} | ${data.businessName}`,
    htmlContent: html,
  });
};

export const sendInvoiceEmail = async (data: InvoiceEmailData): Promise<boolean> => {
  const formattedTotal = new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: data.currency === 'NGN' ? 'NGN' : (data.currency || 'NGN'),
    minimumFractionDigits: 0,
  }).format(data.total);

  const formattedDue = new Date(data.dueDate).toLocaleDateString('en-GB', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const sBusinessName = esc(data.businessName);
  const sClientName = esc(data.clientName);
  const sInvoiceNumber = esc(data.invoiceNumber);
  const sNotes = esc(data.notes);

  const lineItemRows = data.lineItems.map(item => `
    <tr>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;">${esc(item.description)}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;text-align:center;">${item.quantity}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;text-align:right;">${item.unitPrice.toLocaleString('en-NG')}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700;color:#0f172a;text-align:right;">${item.total.toLocaleString('en-NG')}</td>
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
        <tr>
          <td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:40px 40px 32px;">
            <table width="100%">
              <tr>
                <td>
                  <p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.6);">Invoice from</p>
                  <h1 style="margin:0;font-size:24px;font-weight:900;color:#ffffff;">${sBusinessName}</h1>
                </td>
                <td align="right">
                  <div style="background:rgba(255,255,255,0.15);border-radius:12px;padding:12px 20px;display:inline-block;">
                    <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.7);">Invoice</p>
                    <p style="margin:4px 0 0;font-size:18px;font-weight:900;color:#ffffff;">${sInvoiceNumber}</p>
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px 0;">
            <table width="100%">
              <tr>
                <td>
                  <p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;">Billed to</p>
                  <p style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">${sClientName}</p>
                </td>
                <td align="right">
                  <p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;">Due date</p>
                  <p style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">${formattedDue}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
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
        <tr>
          <td style="padding:16px 40px 0;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td></td>
                <td width="240">
                  <table width="100%">
                    <tr>
                      <td style="padding:6px 0;font-size:13px;color:#64748b;">Subtotal</td>
                      <td style="padding:6px 0;font-size:13px;color:#334155;text-align:right;">${data.subtotal.toLocaleString('en-NG')}</td>
                    </tr>
                    ${data.tax > 0 ? `<tr>
                      <td style="padding:6px 0;font-size:13px;color:#64748b;">Tax (${data.tax}%)</td>
                      <td style="padding:6px 0;font-size:13px;color:#334155;text-align:right;">${(data.subtotal * data.tax / 100).toLocaleString('en-NG')}</td>
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
        ${data.notes ? `<tr><td style="padding:16px 40px 0;"><div style="background:#f8fafc;border-radius:10px;padding:16px;"><p style="margin:0 0 4px;font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;">Notes</p><p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">${sNotes}</p></div></td></tr>` : ''}
        <tr>
          <td style="padding:32px 40px 40px;" align="center">
            <a href="${data.publicLink}" style="display:inline-block;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#ffffff;text-decoration:none;font-size:14px;font-weight:800;letter-spacing:1px;padding:16px 48px;border-radius:12px;text-transform:uppercase;">
              View &amp; Pay Invoice
            </a>
            <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">Or copy this link: <a href="${data.publicLink}" style="color:#4f46e5;word-break:break-all;">${data.publicLink}</a></p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #f1f5f9;text-align:center;">
            <p style="margin:0;font-size:11px;color:#94a3b8;">Powered by <strong style="color:#4f46e5;">Morniy</strong></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return sendBrevoEmail({
    sender: { name: data.businessName, email: '' },
    to: [{ email: data.recipientEmail, name: data.clientName }],
    subject: `Invoice ${data.invoiceNumber} — ${formattedTotal} due ${formattedDue} | ${data.businessName}`,
    htmlContent: html,
  });
};

export const sendIssuedReceiptEmail = async (data: {
  recipientEmail: string;
  payerName: string;
  businessName: string;
  receiptNumber: string;
  amount: number;
  currency: string;
  description: string;
  date: string;
  publicLink: string;
}): Promise<boolean> => {
  const formattedAmount = new Intl.NumberFormat('en-NG', {
    style: 'currency', currency: data.currency || 'NGN', minimumFractionDigits: 0,
  }).format(data.amount);
  const formattedDate = new Date(data.date).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
  const sBusinessName = esc(data.businessName);
  const sPayerName = esc(data.payerName);
  const sDescription = esc(data.description);
  const sReceiptNumber = esc(data.receiptNumber);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0fdf4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;padding:40px 16px;"><tr><td align="center">
  <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);">
    <tr><td style="background:linear-gradient(135deg,#059669,#10b981);padding:40px 40px 32px;">
      <table width="100%"><tr>
        <td><p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.6);">Receipt from</p>
          <h1 style="margin:0;font-size:24px;font-weight:900;color:#ffffff;">${sBusinessName}</h1></td>
        <td align="right"><div style="background:rgba(255,255,255,0.2);border-radius:12px;padding:12px 20px;display:inline-block;">
          <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.7);">Receipt No.</p>
          <p style="margin:4px 0 0;font-size:18px;font-weight:900;color:#ffffff;">${sReceiptNumber}</p>
        </div></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:32px 40px 0;">
      <table width="100%"><tr>
        <td><p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;">Received from</p>
          <p style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">${sPayerName}</p></td>
        <td align="right"><p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;">Date</p>
          <p style="margin:0;font-size:16px;font-weight:700;color:#0f172a;">${formattedDate}</p></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:24px 40px 0;">
      <div style="background:#f0fdf4;border-radius:12px;padding:24px;">
        <p style="margin:0 0 8px;font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#64748b;">Payment For</p>
        <p style="margin:0;font-size:15px;color:#0f172a;line-height:1.5;">${sDescription}</p>
      </div>
    </td></tr>
    <tr><td style="padding:24px 40px 0;">
      <div style="background:linear-gradient(135deg,#059669,#10b981);border-radius:12px;padding:24px;text-align:center;">
        <p style="margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.7);">Amount Received</p>
        <p style="margin:0;font-size:36px;font-weight:900;color:#ffffff;">${formattedAmount}</p>
      </div>
    </td></tr>
    <tr><td style="padding:32px 40px 40px;" align="center">
      <a href="${data.publicLink}" style="display:inline-block;background:linear-gradient(135deg,#059669,#10b981);color:#ffffff;text-decoration:none;font-size:14px;font-weight:800;letter-spacing:1px;padding:16px 48px;border-radius:12px;text-transform:uppercase;">
        View Receipt
      </a>
      <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">Or copy: <a href="${data.publicLink}" style="color:#059669;word-break:break-all;">${data.publicLink}</a></p>
    </td></tr>
    <tr><td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #f1f5f9;text-align:center;">
      <p style="margin:0;font-size:11px;color:#94a3b8;">Powered by <strong style="color:#059669;">Morniy</strong></p>
    </td></tr>
  </table></td></tr></table>
</body></html>`;

  return sendBrevoEmail({
    sender: { name: data.businessName, email: '' },
    to: [{ email: data.recipientEmail, name: data.payerName }],
    subject: `Payment Receipt ${data.receiptNumber} — ${formattedAmount} | ${data.businessName}`,
    htmlContent: html,
  });
};
