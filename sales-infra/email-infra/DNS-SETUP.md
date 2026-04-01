# Email DNS Setup — dlm-digital.ch

Configure these DNS records at your registrar (Infomaniak or Cloudflare) to authenticate
outbound mail from Resend and enable inbound at sales@dlm-digital.ch.

---

## 1. Resend DKIM (outbound authentication)

After adding dlm-digital.ch in the Resend dashboard, Resend generates DKIM keys.
Add the records they show — typically:

| Type  | Host                              | Value                          |
|-------|-----------------------------------|--------------------------------|
| TXT   | `resend._domainkey.dlm-digital.ch` | `v=DKIM1; k=rsa; p=<pub-key>` |
| CNAME | `em.dlm-digital.ch`               | `em.resend.com`                |

> Copy the exact values from **Resend Dashboard → Domains → dlm-digital.ch → DNS Records**.

---

## 2. SPF (authorise senders)

Add or update the SPF TXT record on the root domain:

| Type | Host           | Value                                                  |
|------|----------------|--------------------------------------------------------|
| TXT  | `dlm-digital.ch` | `v=spf1 include:amazonses.com include:_spf.resend.com ~all` |

If Infomaniak also sends mail for this domain, add their include:
`include:_spf.infomaniak.com`

---

## 3. DMARC

| Type | Host                   | Value                                                                    |
|------|------------------------|--------------------------------------------------------------------------|
| TXT  | `_dmarc.dlm-digital.ch` | `v=DMARC1; p=quarantine; rua=mailto:marc@dlm-digital.ch; pct=100; adkim=r; aspf=r` |

Start with `p=none` for monitoring, then move to `p=quarantine` after a week.

---

## 4. MX records (inbound to sales@)

If using Infomaniak mailboxes:

| Type | Host              | Priority | Value                          |
|------|-------------------|----------|--------------------------------|
| MX   | `dlm-digital.ch`  | 10       | `mta-in1.infomaniak.com`       |
| MX   | `dlm-digital.ch`  | 20       | `mta-in2.infomaniak.com`       |

> Verify current Infomaniak MX values in their admin panel.

---

## 5. Environment variables to set in Coolify

```env
# Resend
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx
FROM_EMAIL=Marc Schmid <marc@dlm-digital.ch>
REPLY_TO_EMAIL=sales@dlm-digital.ch

# Inbound IMAP (sales@dlm-digital.ch)
IMAP_HOST=mail.infomaniak.com
IMAP_PORT=993
IMAP_USER=sales@dlm-digital.ch
IMAP_PASS=<mailbox-password>

# Paperclip reply-task
PAPERCLIP_API_URL=http://host.docker.internal:3100
PAPERCLIP_API_KEY=<service-key>
PAPERCLIP_COMPANY_ID=55be78fd-6837-49b8-a967-a03a72c43587
PAPERCLIP_GOAL_ID=fbd9599d-fd4d-4106-92a8-b85076f4b1e0
CHIEF_OF_SALES_AGENT_ID=<chief-of-sales-agent-id>
```

---

## 6. Verification checklist

- [ ] `dig TXT resend._domainkey.dlm-digital.ch` returns DKIM record
- [ ] `dig TXT dlm-digital.ch` includes `include:_spf.resend.com`
- [ ] `dig TXT _dmarc.dlm-digital.ch` returns DMARC record
- [ ] Resend dashboard shows domain as **Verified**
- [ ] Send test email → check headers for `DKIM=pass`, `SPF=pass`
- [ ] `docker logs email-infra` shows `new reply from …` when test reply arrives
