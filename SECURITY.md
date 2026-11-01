# Security

## Reporting

Please report vulnerabilities privately through a GitHub security advisory on this repository, not in a public issue. You will get a reply within 5 working days.

## How the demo handles data

- All businesses, customers, orders and bookings are fictional. Nothing is stored server-side.
- `GEMINI_API_KEY` stays on the server. The browser only learns whether live mode is on.
- `/api/chat` accepts POST only, caps the body at 16 KB and messages at 600 characters, rate limits per IP (in memory, per instance), and times out model calls.
- Customer text is passed to the model as quoted data. Instruction-override attempts are blocked before any model call, and every model answer is checked against the knowledge base before it is sent.
- Records linked to another phone number are never shown, and refunds above the business limit always go to a person.
- The n8n workflow reads every secret from `$env` and ships with no credentials.
