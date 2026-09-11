// bulksms.js — thin client for the BulkSMS JSON API (api.bulksms.com/v1/messages).
// Auth is HTTP Basic using a BulkSMS API token id (BULKSMS_USERNAME) and
// token secret (BULKSMS_TOKEN) — see https://www.bulksms.com/developer/
const fetch = require('node-fetch');

const BULKSMS_API_URL = 'https://api.bulksms.com/v1/messages';

// Converts our stored 10-digit SA local format (e.g. 0821234567) to the
// international MSISDN BulkSMS expects (e.g. +27821234567).
function toInternationalSA(localPhone) {
  return '+27' + localPhone.slice(1);
}

async function sendSms(toLocalPhone, body) {
  const username = process.env.BULKSMS_USERNAME;
  const token = process.env.BULKSMS_TOKEN;
  if (!username || !token) {
    throw new Error('BulkSMS credentials are not configured (BULKSMS_USERNAME / BULKSMS_TOKEN)');
  }

  const auth = Buffer.from(`${username}:${token}`).toString('base64');

  const resp = await fetch(BULKSMS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({ to: toInternationalSA(toLocalPhone), body }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`BulkSMS request failed (${resp.status}): ${text || resp.statusText}`);
  }

  return resp.json();
}

module.exports = { sendSms, toInternationalSA };
