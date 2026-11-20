# Changelog

## 0.3.1

- Follow Homebridge bridge settings for HomeKit and Matter publication. Set any transport preferences previously managed by the Keurig checkboxes on the bridge itself.
- Remove advanced account overrides from the settings screen. Existing manual overrides remain supported.
- Update the README logo, credits, donation links, reset instructions, and K-Café naming guidance.

## 0.3.0

- Add browser sign-in and favorite discovery to Homebridge settings.
- Add individual checkboxes for supported brewer controls.
- Publish selected controls to Homebridge 2.5 Matter with shared brew guards.
- Read the K27 empty-holder identifier and offer supported hot-water sizes.
- Distinguish readiness checks from brew submission in logs and reuse preparation failures for 10 seconds.

## 0.2.4

- Acknowledge repeated writes shortly after acceptance without submitting a second brew.

## 0.2.3

- Add recipe format 2.0 for K27 and K28 and shot controls for K-Café SMART.
