# AI Tone for UltraRig

This fork adds an **AI TONE** button to the UltraRig control page. Describe a sound
("warm 70s blues lead, light spring reverb"); AI builds a full UltraRig chain from the
effects, NAM captures and cab IRs that are **on your pedal**, and it starts playing
straight away.

The button sits next to TUNER, FOOTSWITCHES and STAGE (on a phone, next to TAP).

## How it works

```
UltraRig page (web/tankg.html + aitone.js)            tankgtone (your PC)
  reads the pedal: effect types and ranges (FXT),  ->  POST /api/ultrarig/tone
  captures (CLIST), IRs (ILIST), the chain              Claude builds the chain from
                                                        that exact catalogue
  loads the answer with UltraRig's own preset      <-  an "ultrarig-preset" v1 document
  importer (the same one as Import preset)
```

- The AI can only choose effects, parameters, captures and IRs your pedal reported.
  Every value is clamped twice: in tankgtone, then again by UltraRig's importer.
- Blocks enter switched off and only switch on if the pedal's CPU allows it, exactly
  like importing a preset file. Nothing is written to a preset slot: the sound is
  **unsaved** until you save it to a slot with the usual Save button.
- **From a recording**: paste a YouTube link (or an audio file path). tankgtone
  downloads it, separates the guitar from the mix, measures the tone (gain,
  EQ balance, delay time, reverb tail, modulation) and the AI matches those
  measurements. A description is optional then. Use **Start / End** to analyse just
  the solo: a whole song averages clean and driven parts, and takes much longer.
- **Find a capture on TONE3000**: when none of your captures fits, the AI says what
  to look for (e.g. "Marshall JCM800, crunch channel, medium gain"). The button opens
  TONE3000's own picker, signed in with your TONE3000 account, filtered to the A2
  NAM captures UltraRig can run. You pick one; only that capture is downloaded and
  loaded into a free capture slot through UltraRig's capture library. The creator and
  licence are shown when it loads. This follows TONE3000's free API tier: you choose,
  nothing searches or downloads on its own. Setup: generate a publishable key at
  tone3000.com/settings and `setx TONE3000_CLIENT_ID <key>`, then restart tankgtone.
  If you registered redirect URIs there, add
  `http://127.0.0.1:8765/api/tone3000/callback`.
- **Adjust what's playing** sends the current chain, so "less gain, more delay" edits
  it instead of starting over.
- **Download preset file** saves the result as a normal `.ultrarig.json` you can
  import later or share.
- The API key stays in tankgtone; the page never sees it.

## Run it

1. Install tankgtone with the AI and UI extras, and give it one AI key:

   ```bash
   pip install -e ".[ui,ai]"            # in the tankgtone folder
   setx OPENROUTER_API_KEY sk-or-...    # free: openrouter.ai, its ":free" models
   setx ANTHROPIC_API_KEY sk-ant-...    # or paid: Claude (used first when both are set)
   ```

   OpenRouter's free models cost nothing but are rate limited (a daily cap) and are
   not Claude: expect somewhat less careful tone choices. Pick other free models with
   `TANKGTONE_OPENROUTER_MODEL` (comma-separated ids, first one tried first).

2. Clone this fork next to tankgtone (`C:\Projects\ultrarig` beside
   `C:\Projects\tankgtone`), or point tankgtone at it with `--ultrarig-web`.

3. Start it and open the page in Chrome or Edge:

   ```bash
   python -m tankgtone ui
   # -> http://127.0.0.1:8765/ultrarig/
   ```

   Click **Connect** for the pedal (Web Serial works on localhost), or add `#demo` to
   the address to try it without a pedal.

### In the UltraRig Editor desktop app

The editor (the Windows / macOS app from UltraRig's `editor-*` releases) keeps the
same control page inside `resources/app.asar`. `desktop/patch_editor.py` adds AI Tone
to it:

```bash
python desktop/patch_editor.py "C:/Users/<you>/Music"            # the folder with "UltraRig Editor.exe"
python desktop/patch_editor.py "C:/Users/<you>/Music" --restore  # back to the original
```

Close the editor first. The script keeps the untouched archive as
`resources/app.asar.original` (once), always rebuilds from it, and stops without
writing anything if a newer editor's page doesn't match the edits. In the editor,
the TONE3000 sign-in opens in your web browser (the app sends new windows there);
the panel waits for your pick. tankgtone accepts the editor's `ultrarig://app` origin.

You can also open `web/tankg.html` straight from disk: the panel then calls tankgtone
at `http://127.0.0.1:8765` (change it under **AI server** in the panel).

## What changed in the page

- `web/aitone.js` and `web/aitone.css`: the button, the panel and the call.
- `web/tankg.html`: three small edits: load those two files, and an `auto` option
  on `pioImport` so an AI preset loads without the "Import?" question (it still asks
  when you have unsaved changes).

The page is otherwise UltraRig alpha 11 as released. To move to a newer UltraRig,
copy its `web/` over this one and re-apply those three edits.

## Limits

- Needs tankgtone running on the same computer, and the internet for the AI call. The
  Android app has no tankgtone next to it, so the panel tells you it can't reach it.
- Parallel branches and scenes are not generated: the AI builds one serial chain.
- Capture choice is only as good as the capture names on your pedal.
- The firmware itself is unchanged: UltraRig's firmware source is not published, so
  this is a control-page feature. Install the firmware with the official UltraRig
  installer from the upstream releases.

UltraRig is © Manuel Aguirre under the PolyForm Noncommercial License 1.0.0 (see
`LICENSE.md`): this fork is for personal, non-commercial use.
