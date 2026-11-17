# Academic Presenting — colleague pilot

An Agent Skill for building scientifically rigorous, editable PowerPoint presentations from a presenter's own input and checked sources. This is a test version of the **PowerPoint** workflow.

See the [public pilot website](https://academicpresenting.dev/) for the workflow and a clearly labelled synthetic slide example.

**Start here:** [PILOT-START.md](PILOT-START.md) has one prompt to paste into Codex desktop, Claude Cowork or Claude Code. It begins with presenter onboarding, then asks for a talk outline and sources. The agent shows a storyboard and waits for explicit approval before rendering slides.

No GitHub account is needed to read or download this repository. The repository contains a synthetic example, not real talk data or institutional templates.

## For a manual installation check

```sh
git clone https://github.com/HdBraanker/academic-presenting.git academic-presenting
cd academic-presenting
npm ci
npm run demo
```

Node.js 20+ is required. LibreOffice, Poppler (`pdftoppm` and `pdftotext`) and Python 3 enable the render check and contact sheet; `python-pptx` is optional for filling an institutional template. The demo uses invented FICTA-1 data. It automatically approves only that synthetic storyboard. A real talk requires the presenter's approval.

The working skill instructions are in [SKILL.md](SKILL.md). The agent-assisted source-to-claim step needs a person's scientific review. Institutional template handling is experimental. Upgrading an existing deck is experimental: the agent diagnoses each slide and rebuilds through an approved storyboard, without editing your original file. HTML output and in-place editing are planned.

Keep real talks in `local/` and presenter profiles in `profiles/*.local.md`; Git ignores both. Do not upload patient data or confidential material. The skill itself does not upload files, while an agent's connected services have their own data settings.

MIT licensed. Copyright 2026 Hannah den Braanker.
