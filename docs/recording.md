<p align="center"><img src="../brand/logo-mark.svg" width="72" alt=""></p>

# Recording

Recording is not macro capture. It samples **where your focus and clicks go**, then turns that into a readable, editable skill draft.

## Record

```bash
node apps/recorder/main.ts --seconds 15 --out .demo/recordings/rec.jsonl
```

Operate the computer normally while it runs. It captures three kinds of events:

- **focus** — every 300 ms, the focused UIA element (window, control type, name, AutomationId, current value);
- **click** — every left-button press, via a `WH_MOUSE_LL` hook, with `AutomationElement.FromPoint` resolving the element under the cursor;
- **window-open** — a new top-level window appeared (keyed by title + pid).

## Draft a skill

```bash
node scripts/draft-skill.ts --recording .demo/recordings/rec.jsonl --name my-skill --only "Notepad"
```

Rules:

- **click** → `ui.click`, selector from control type + name (AutomationId wins when present);
- **typing** → `ui.type`, plus an inferred `ui.value` assertion ("the field must now equal what I typed");
- **a window appears within 3 s** → the click gets a `window.exists` assertion;
- **focus moves within 2.5 s** → the click gets a `ui.exists` assertion (the only signal available for clicks that don't open a window);
- repeated prefix values collapse into one step.

Preview it:

```bash
node bin/deskshell.ts run my-skill --mode preview
```

## A draft is not a skill

Assertions cover typing automatically. **Click assertions are still empty** (`post: []`), because only a human knows what "it worked" means:

- after clicking Save, should a dialog appear, or should the file be written directly?
- after clicking a tab, should the address bar change?
- if it fails, how do we get back?

Fill those in and the draft becomes a skill.

## Known limits

- focus is polled at 300 ms; fast switching can be missed;
- only left clicks; no drag, right-click menus, or wheel;
- windows that never receive focus never appear in the focus stream;
- window titles that embed a filename change over time — the draft takes the substring after `" - "` as the stable match;
- use `--only <regex>` to drop unrelated windows captured while recording.

## Next

- replace polling with UIA FocusChanged / StructureChanged events;
- record structure changes (a new window is the strongest "the click worked" signal — we already use it);
- drag and context-menu support.
