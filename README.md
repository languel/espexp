# espexp — Force Trainer II → p5.js

Upcycling an Uncle Milton Force Trainer II (NeuroSky TGAM inside) into a live
EEG input for classroom physical-computing demos, without the obsolete vendor
app and without ThinkGear Connector.

Everything below was established empirically on Apple Silicon macOS (Darwin
25.x) by probing the actual hardware — not assumed from older tutorials, most
of which no longer work unchanged. If you are trying to talk to a NeuroSky
device on a modern Mac, the [macOS gotchas](#three-macos-gotchas-that-cost-the-most-time)
section is probably why you are here.

```
headset ──Bluetooth Classic SPP──▶ reader (Swift .app) ──TCP :9000──▶
    bridge (Node, ThinkGear parser) ──WebSocket :8080──▶ browser (p5.js)
```

## Run it

Pair the headset in System Settings first (it will show as `Force Trainer II`
and will say **Not Connected** afterwards — that is expected, see below).

```bash
./reader/build.sh                      # once, and after editing reader.swift
open ./reader/ForceTrainerReader.app   # acquisition (must be launched this way)
node server/index.js                   # bridge + web server
```

Then open <http://localhost:8080>.

No dependencies: no npm install, no CocoaPods, no ThinkGear Connector. p5 is
vendored in `web/` so it works offline in a classroom.

**No headset? Run only the server and press Simulate.** The reader and the
Bluetooth pairing are not needed for that.

If you have several paired devices, or yours advertises a different name:

```bash
FORCE_TRAINER_ADDRESS=xx-xx-xx-xx-xx-xx open ./reader/ForceTrainerReader.app
```

## What the hardware actually does (established empirically)

| Question | Answer |
|---|---|
| Transport | Bluetooth Classic, **not** BLE |
| Profile | SPP / RFCOMM |
| RFCOMM channel | **6** (SDP name `SerialPort`); channel 1 is `Wireless iAP` |
| Device matching | by name (`Force Trainer`); override with `FORCE_TRAINER_ADDRESS` |
| Class of device | `0x240404` — declares itself an *audio headset* |
| Protocol | NeuroSky ThinkGear |
| Raw EEG rate | ~512 Hz |
| Aggregate rate | ~1 Hz |

Data codes this unit actually emits — and **only** these:

| Code | Meaning | Rate |
|---|---|---|
| `0x80` | RAW_VALUE, signed 16-bit big-endian | ~512 Hz |
| `0x02` | POOR_SIGNAL, 0–200 | 1 Hz |
| `0x83` | ASIC_EEG_POWER, 8 bands × 3-byte big-endian | 1 Hz |
| `0x04` | ATTENTION (eSense) | 1 Hz |
| `0x05` | MEDITATION (eSense) | 1 Hz |

It does **not** send `0x81` (EEG_POWER). The parser reports only what arrives
rather than inventing absent fields.

Measured integrity over ~52k packets: 1 bad checksum, 3 resync bytes.

## Three macOS gotchas that cost the most time

**1. `/dev/cu.ForceTrainerII` is a dead end.**
macOS creates the node from the pairing record, but opening and writing to it
produces no data and no Bluetooth activity whatsoever. Ignore it. Use IOBluetooth
RFCOMM directly. (This also means **WebSerial cannot work** with the intact
toy — there is no functioning serial device for the browser to open.)

**2. TCC kills bare command-line binaries.**
Any process touching IOBluetooth must be a `.app` bundle with
`NSBluetoothAlwaysUsageDescription` **and be launched via `open`**. Run the
binary directly and it dies instantly with `SIGABRT`, because TCC attributes the
request to the *responsible process* (the terminal's parent app), not the binary.
Crash reports say so explicitly under `termination.namespace = "TCC"`.

**3. Connection ordering matters, and depends on the LED.**
- LED **solid** → already connected; an inquiry scan will *not* find it, because
  connected devices stop answering inquiries. Reuse the link.
- LED **blinking** → idle. A direct `openConnection()` usually times out
  (`kIOReturnTimeout`); an inquiry scan first is what makes it succeed.
- `isConnected() == true` but RFCOMM fails with `kIOReturnError` → stale link
  from a crashed session. Call `closeConnection()` and start over.

`reader.swift` tries these in cost order: reuse → direct → scan-then-connect.

Also: macOS System Settings shows the device as "Not Connected" and its Connect
button spins forever. That is expected and is **not** a pairing failure — the
toy advertises an audio device class it does not implement. "Connected" only
appears once software opens the RFCOMM channel, and the label lags reality.
Trust the LED.

**Do not** let `IOBluetoothDeviceInquiry` or its delegate go out of scope: the
delegate is unretained and touched from `-dealloc`, which segfaults. Both are
held for the process lifetime.

## How this was worked out

Roughly in order, in case you need to repeat it for a different device:

1. `system_profiler SPBluetoothDataType` — found the pairing record and, from
   `ls /dev/cu.*`, a `/dev/cu.ForceTrainerII` node. Its existence is what first
   suggested Bluetooth Classic SPP rather than BLE.
2. Opened that node with plain POSIX `open`/`termios`, at both 9600 and 57600.
   **Zero bytes, and `log stream` showed no Bluetooth activity at all** — which
   is what proved the node is vestigial rather than merely misconfigured.
3. Wrote a small Swift IOBluetooth probe. It died instantly with `SIGABRT`; the
   crash report's `termination.namespace = "TCC"` named the missing
   `NSBluetoothAlwaysUsageDescription` outright. Embedding an `Info.plist`
   section in the binary was *not* enough — it needed a real `.app` bundle,
   and it only worked when launched via `open` rather than executed directly.
4. With that working, `performSDPQuery` returned the real service records:
   `SerialPort` on RFCOMM channel 6, plus `Wireless iAP` on channel 1.
5. `openConnection()` still returned `kIOReturnTimeout` — until an inquiry scan
   was run first, after which it connected immediately. That one ordering
   detail was the last blocker.
6. Opened RFCOMM channel 6 and dumped hex. ThinkGear `AA AA` frames appeared
   immediately.
7. Verified the capture offline in Python (framing, checksums, code census),
   then wrote the JS parser and cross-checked it against the same capture with
   randomized chunk boundaries — identical packet counts either way.

## Three sources: live, recorded, simulated

The control bar switches the byte source at runtime. All three feed the *same*
parser, so nothing downstream can tell them apart.

| Source | What it is | Needs hardware |
|---|---|---|
| **Live** | the headset via the Swift reader | yes |
| **Playback** | a recorded byte stream, replayed on its original timing | no |
| **Simulate** | synthesised ThinkGear frames | no |

**Recording** captures the raw bytes, not parsed values, so a recording is a
faithful stand-in for the hardware — same packets, same bursty Bluetooth
timing. Files land in `recordings/` as `.jsonl`, deliberately inspectable:

```
{"format":"espexp-raw-v1","createdAt":"...","sampleRate":512}
{"t":67,"d":"8002010478aaaa04800200d9a4..."}
```

`recordings/` is gitignored, since it is your own EEG data. Commit one
deliberately if you want to ship a sample.

**Simulate** generates real ThinkGear frames — correct sync bytes, lengths and
checksums — rather than injecting pre-parsed numbers, and mimics the ~8
bursts/sec delivery pattern. It alternates every 10 s between "eyes open"
(more beta) and "eyes closed" (strong ~10 Hz alpha), which is the classic EEG
demonstration and makes the display do something worth looking at.

It is a plausible *synthesis*, not brain activity, and is labelled
`SIMULATED — SYNTHETIC SIGNAL, NOT EEG` on screen wherever it appears. Verified
to parse with 0 bad checksums and 0 resyncs at ~509 Hz.

Use it to develop visualizations without wearing the headset, and to keep a
class running if a battery dies mid-demo.

## Reading the display

- **Signal quality** is deliberately the loudest element. `poorSignal` 200 means
  the electrodes are not touching skin; the firmware forces attention and
  meditation to 0 in that state, and the band powers are noise. If the metrics
  sit at exactly 0, fix the fit before believing anything else on screen.
- **Raw EEG** is in arbitrary ADC units, *not* volts — no calibration is known.
  Auto-scaled with a decaying peak. Large rail-to-rail excursions (±2048) are
  movement/electrode artifacts, not brain signal — a useful thing to point at
  in class.
- **Band powers** are logarithmic; these ASIC units span orders of magnitude.
- **Attention / Meditation** are labelled as NeuroSky proprietary algorithms,
  not measurements of mental states. That distinction is the pedagogical point.

## Structure

```
reader/reader.swift          Bluetooth → raw bytes on TCP :9000. No parsing.
server/thinkgear-parser.js   Pure ThinkGear decoder. No I/O, no Bluetooth.
server/recording.js          Record / replay the raw byte stream.
server/simulator.js          Synthetic ThinkGear frames, for no-hardware use.
server/index.js              source switch → parse → WebSocket + static files.
web/controls.js              Control bar: live / simulate / record / play.
web/sketch.js                p5 visualization. Pixels only.
```

Acquisition, interpretation, and visualization are separate on purpose: students
can rewrite `web/sketch.js` — mapping theta to particles, alpha to blur, raw to
line drawings — without touching Bluetooth code.

Raw samples and 1 Hz aggregates are sent as **separate** WebSocket message types
(`raw` and `update`) rather than merged, so nothing pretends the slow derived
values arrived at the same instant as the waveform.

## Why the waveform needs a jitter buffer

Bluetooth delivers samples in bursts — roughly 8 chunks/sec of ~83 samples,
with gaps up to ~172 ms — even though the true rate is a steady ~514 Hz. Drawing
each burst on arrival advances the trace in visible 4%-of-width jumps, which
looks like a ~1 fps animation no matter how fast the renderer runs.

So `sketch.js` queues arrivals and drains them at a rate tied to wall-clock
time, nudged to keep ~200 ms of backlog (comfortably above the worst gap). Every
sample drawn is a real sample; only the *release timing* is evened out.

Measured effect: frames that advance the trace went from ~13% to 100%, and
per-frame movement from "0 or 83" to a steady 6–13 samples, with the effective
rate still tracking 514 Hz. The footer shows live fps and buffer depth.

## Status and next steps

Working: transport, parser, bridge, and a live p5 dashboard.

Also working: recording, playback, and a hardware-free simulator.

Not done yet:

- **Splitting the mappings** out of `sketch.js` into a file students edit.
- **Our own band powers** via FFT over the 512 Hz raw stream, to compare
  against the TGAM's 1 Hz `ASIC_EEG_POWER` — a direct "compute it yourself vs.
  trust the black box" lesson.
- **Opening the headset**: identify the TGAM board, tap TX/RX/GND, and
  optionally replace the original Bluetooth electronics with an ESP32. That
  path also makes **WebSerial** viable (USB serial straight to the browser,
  no Node), which is *not* possible with the intact toy — see gotcha 1.
- OSC / MIDI output for TouchDesigner and Max/MSP.

## Credit and prior work

NeuroSky's ThinkGear serial protocol is the basis for the parser. Earlier
Force Trainer / NeuroSky reverse-engineering projects (e.g.
`hollanderski/EEG-StarWars`) established that this toy family carries TGAM
hardware; the macOS-specific findings here were worked out from scratch
because that path has changed substantially on recent macOS.

