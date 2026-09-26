# Handoff

State of the project for whoever (human or agent) picks it up next. Read
`README.md` for the full hardware findings; this file is the operational summary.

## Where things stand

Working end to end, verified against real hardware:

```
Force Trainer II ─BT Classic SPP, RFCOMM ch 6─▶ reader/ (Swift .app)
   ─TCP :9000 raw bytes─▶ server/ (Node: source switch, ThinkGear parser)
   ─WebSocket + HTTP :8080─▶ web/ (p5.js)
```

- Transport, parser (cross-checked against an independent Python decode),
  bridge, and live p5 dashboard: done.
- Control bar with three byte sources: **Live**, **Playback** (recorded raw
  bytes on original timing), **Simulate** (synthetic ThinkGear frames, no
  hardware needed).
- Jitter buffer in `web/sketch.js` so the waveform scrolls smoothly despite
  Bluetooth delivering ~83-sample bursts ~8x/sec.

## Run it

```bash
./reader/build.sh                      # once, and after editing reader.swift
open ./reader/ForceTrainerReader.app   # MUST be `open`, never run the binary
node server/index.js
# then http://localhost:8080
```

No headset: skip the reader, run the server, press **Simulate**.

## Traps (each cost real time; details in README)

1. `/dev/cu.ForceTrainerII` is dead. Use IOBluetooth RFCOMM. WebSerial cannot
   work with the intact toy.
2. IOBluetooth processes must be a `.app` with `NSBluetoothAlwaysUsageDescription`,
   launched with `open`, or TCC SIGABRTs them. Anything run from Claude Code's
   Bash tool is a child of Claude.app, so test Bluetooth via the `open`ed bundle.
3. Connect path depends on LED: solid = connected (won't answer inquiry);
   blinking = idle (needs an inquiry scan before `openConnection`). Stale link
   (`isConnected` true but RFCOMM `kIOReturnError`) needs `closeConnection()`.
4. Never let `IOBluetoothDeviceInquiry` or its delegate deallocate: segfault.
5. macOS Settings showing "Not Connected" is expected. Trust the LED.
6. Background browser tabs throttle to ~1 fps. Not an app bug.
7. `poorSignal` 200 = no skin contact, and attention/meditation read 0. At
   intermediate values (25/51/80) metrics may still be nonzero but unreliable.
   Contact was the recurring practical struggle; a fresh AAA is worth trying.

## Local-only state (not in git)

- `recordings/2026-08-19T22-17-58_sample-eyes-open-closed.jsonl` (416 KB, 60 s
  at good contact). Gitignored on purpose since it is personal EEG data.
  Ship it deliberately with `git add -f` if a sample is wanted.
- Memory notes under `~/.claude/projects/-Users-liubo-dev-espexp/memory/`.

## Next steps, in rough priority

1. **Split mappings out of `web/sketch.js`** into a small file students edit
   (theta → particles, alpha → blur, beta → sound, raw → line drawing,
   attention → something absurd). Keep acquisition/interpretation/visualization
   separate; the p5 sketch should only turn numbers into pixels.
2. **Own band powers via FFT** on the 512 Hz raw stream, shown next to the
   TGAM's 1 Hz `ASIC_EEG_POWER`: a "compute it yourself vs trust the black box"
   lesson. The parser is pure and I/O-free, so this can live in the browser.
3. **Commit a sample recording** so others can demo playback without hardware.
4. **Open the headset**: identify the TGAM board, find TX/RX/GND, optionally
   replace the Bluetooth electronics with an ESP32. That also makes WebSerial
   viable (USB serial straight to the browser, no Node).
5. OSC / MIDI output for TouchDesigner and Max/MSP.

## Conventions to keep

- Only expose fields the device actually sends (no `0x81 EEG_POWER` on this unit).
- Raw samples (~512 Hz) and aggregates (1 Hz) stay separate message types.
- Label attention/meditation as NeuroSky proprietary algorithms, never as
  measurements of mental states. Raw values are arbitrary ADC units, not volts.
- Synthetic data must be labelled as such wherever it surfaces.
- Working style requested: hypothesis, smallest diagnostic, inspect real
  output, then next experiment. Do not build on chains of assumptions.
