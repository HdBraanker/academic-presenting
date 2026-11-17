# Storyboard view and approval gate

Status: **working** for a validated presentation spec → readable storyboard → explicit approval receipt → PowerPoint render. Scientific source extraction and automatic completion of a rough user outline are **planned**; prepare the spec with the user before running this module.

## User-facing create workflow

1. Establish whether the input is a user-supplied outline or source material. Preserve the order and substantive meaning of a supplied outline; fill missing details as proposals for review. From source material, propose a storyboard rather than treating the first draft as approved. Record the input type with `--origin outline` or `--origin source`.
2. Build and validate the shared presentation spec. Do not invent citations, findings, figures, or missing source details. Leave unresolved claims as `needs-expert-review`.
3. Run `node scripts/storyboard.mjs generate <spec.json> --origin source|outline --out out/storyboard.md`. Show the resulting Markdown to the user. It includes the audience, central question, objectives, slide jobs, title wording, claim-level evidence states and source locators, caveats, speaker notes, and planned versus available time.
4. Wait for **explicit user approval of this storyboard**. Silence, a successful validator run, or approval of another version does not count. Revise the spec and regenerate the Markdown after feedback.
5. Only after the user approves the displayed version, run `node scripts/storyboard.mjs approve <spec.json> <storyboard.md> --by <approver>`. This creates a local sidecar approval receipt tied to the exact spec and storyboard hashes. The CLI cannot independently verify that the user spoke; the agent must honor this conversational gate.
6. Run `node scripts/storyboard.mjs render <spec.json> <storyboard.md> --out out/deck.pptx`. The wrapper refuses missing or stale approval receipts. A direct call to `engines/powerpoint/build.mjs` is a developer tool and bypasses this user-facing gate.

Keep the storyboard, approval receipt, and generated deck local unless the user authorizes an external transfer. Outputs under `out/` are ignored by Git.

## Existing deck in

A presenter who brings a finished deck to improve follows `upgrade.md` first (diagnosis, scope, change plan; experimental, T26). The deck counts as a supplied outline. The change plan does not replace steps 3–6 above.

## Interpretation

- `--origin outline` means the storyboard completes the supplied outline; it does **not** mean the user approved it.
- `--origin source` means the storyboard is proposed from source material.
- Evidence labels come from the spec. The generator checks structure and links; it does not independently read or verify the cited sources.
- Timing totals count specified slide durations. Missing durations are listed and never assumed to be zero in the presentation plan.
- Approval is invalidated by a change to the spec or the storyboard text. Regenerate and ask again.

## Developer check

```sh
node scripts/storyboard.mjs generate examples/research-talk/spec.json --origin source --out out/ficta1.storyboard.md
node --test scripts/storyboard.test.mjs
```

The FICTA-1 example is synthetic. Do not approve its storyboard on behalf of a real user to make the demonstration appear complete.
