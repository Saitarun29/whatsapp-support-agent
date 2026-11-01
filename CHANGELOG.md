# Changelog

## 0.1.0 · 2026-11-01

Initial release.

- Playground with three business presets: Glow & Co. (D2C skincare), SmileCare Dental (clinic) and Apex Coaching Institute (JEE and NEET coaching).
- Agent pipeline: language detection (English, Hinglish, Devanagari), intent classification over six intents with confidence, entity extraction, KB-grounded FAQ answers, order and booking lookup, slot booking, refunds with an auto-approve limit, and handoff tickets.
- Guardrails: prompt-injection block, medical-advice refusal, confidence floor, KB grounding, identity check on phone numbers, refund limit, double-booking check.
- Optional live mode with Gemini 2.0 Flash for classification and FAQ wording, with a deterministic demo fallback.
- n8n workflow for the WhatsApp Cloud API: webhook verification, classification, routing, order lookup over HTTP, Slack handoff and Graph API replies.
- Tests with `node:test` and a GitHub Actions workflow.
