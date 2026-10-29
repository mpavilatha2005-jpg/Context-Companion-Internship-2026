---
name: Gemini model access and capacity
description: Project-specific Gemini generation eligibility and transient model capacity behavior.
---

Gemini generation access can differ from whether a model appears in the model catalog. When generation returns 404 for a model, check current project eligibility in Google's official documentation rather than assuming the API key is invalid. Treat `UNAVAILABLE` 503 and `DEADLINE_EXCEEDED` 504 responses as transient capacity signals; retain a tested fallback and log only redacted provider details.

**Why:** In October 2026, this app's Gemini 2.5 Flash generation returned 404 for the newly configured project, and Gemini 3.8 Flash intermittently returned 503/504. Gemini 3.5 Flash-Lite generated successful responses.

**How to apply:** When changing this app's Gemini model, verify the current official model documentation and perform a real generation test. Preserve the fallback path unless another model is verified.
