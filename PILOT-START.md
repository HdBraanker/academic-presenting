# Start Academic Presenting with an agent

This public pilot repository is for **Codex desktop, Claude Cowork or Claude Code** with access to local files and a terminal. You do not need a GitHub account. A regular web chat without those capabilities can discuss an outline, but cannot install the skill or generate the editable PowerPoint locally.

This repository contains the working PowerPoint workflow and a synthetic example. It has no development history, internal session logs, institutional templates or real presentation files. Keep your own material local; do not upload patient information, confidential work or unpublished figures to a feedback form.

## Paste this into your agent

The repository URL is public and can be opened without signing in.

> I want to try Academic Presenting. Use the public repository at https://github.com/HdBraanker/academic-presenting and clone or download it into a local folder named `academic-presenting`. Read `PILOT-START.md`, `SKILL.md` and `modules/onboarding/README.md`. Check that you can use local files and run commands. Install the Node dependencies with `npm ci`; tell me clearly if a required tool is missing. Begin with the short presenter-profile onboarding interview, asking at most two questions at a time. Save the confirmed profile locally under `profiles/*.local.md`. Then ask for my talk topic, audience, duration, my own outline or notes, and the scientific sources I can share. Follow the intake and evidence-integrity steps in `SKILL.md`. Show me the storyboard, source gaps and claims needing expert review, and wait for my explicit approval before rendering any slide. After approval, make an editable PowerPoint, a contact sheet and a quality report, and tell me what still needs my scientific review. Keep my talk in `local/`. Do not upload any of my files or content to an external service without asking me first.

If you want to check the installation first, ask the agent to run `npm run demo`. The demo uses invented FICTA-1 data and approves only its own synthetic storyboard. For a real talk, the approval gate always applies.

## What to send Hannah after the trial

Tell Hannah your operating system and agent, whether installation worked, whether the storyboard approval felt clear, whether the PowerPoint was editable and readable, and the one change you most want. Describe errors or slide problems without sending confidential content. Synthetic-demo screenshots are safe to share.

This is a PowerPoint pilot. Source-to-claim work is agent-assisted and needs your review. Institutional template handling is experimental; HTML output and redesign of an existing deck are planned.
