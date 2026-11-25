# Principles

What Tend holds itself to. Each has a check, and a change that breaks one fails. The [plan](../PLAN.md) (section 4) has the reasons.

| | Principle | In short | Checked by |
|---|---|---|---|
| P1 | One process, one folder | The data folder is the whole site. Copy it, and you've moved it. | `portable.test.ts` |
| P2 | Nothing to set up | No settings and no config files are needed to start. | `smoke-dist.mjs` |
| P3 | Five new words | Nobody needs more than Page, Post, Draft or Published, Site menu and Design before they've published. | The [words we use](glossary.md), read at each release |
| P4 | Five minutes | From the command to a published page, on your own computer. | `journeys.spec.ts`, J1 |
| P5 | Never lose work | Whatever crashes, everything up to 2 seconds before is there again. | `editor.spec.ts` |
| P6 | Fast by default | A visitor's page runs no JavaScript. | `budgets.spec.ts` |
| P7 | Works without email, and offline | Everything email would do, a link or a code does. Nothing is asked of another server. | `journeys.spec.ts` |
| P8 | Plain words | No slug, no metadata, no deploy. | `messages.test.ts` |
| P9 | Undo over confirm | What can be taken back is done at once. At most five things ask first. | `dialogs.test.ts` |
| P10 | Three clicks to live | Publish, then Publish post now, and that's all. | `journeys.spec.ts`, J2 |
| P11 | A complexity budget | 14 tables, 3 packages to install, 32 settings. | `complexity.test.ts` |
| P12 | Accessible by default | WCAG 2.2 AA, 320 px, 44 px, and a keyboard is enough. | `accessibility.spec.ts`, `journeys.spec.ts` |
| P13 | Errors explain and fix | Every error says what happened and what to do, and has [a page](errors/README.md). | `error-docs.test.ts` |
| P15 | Status never misleads | "Live" is only said when anyone can see it. | `messages.test.ts`, `overview.spec.ts` |

P14, about exports, starts with the version that has them.

## How something gets in

It's needed for one of the plan's journeys, or three people who don't know each other have asked for it. And it fits P11: if it doesn't, something else goes.
