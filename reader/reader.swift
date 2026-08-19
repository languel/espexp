// Force Trainer II acquisition layer.
//
// Does exactly one job: get raw bytes off the headset and out onto a local
// TCP socket. No parsing here - interpretation lives in JS so students can
// change it without touching Bluetooth code.
//
// Path established empirically:
//   inquiry scan (REQUIRED - without it openConnection times out)
//     -> baseband openConnection()
//     -> RFCOMM channel 6 ("SerialPort" per the device's SDP records)
//     -> raw ThinkGear bytes
//
// Must be built as a .app bundle with NSBluetoothAlwaysUsageDescription and
// launched via `open`. Run directly it is SIGABRT'd by TCC, because the
// responsible process would be the terminal's parent rather than this bundle.

import Foundation
import IOBluetooth

// Match the paired device by name so this works with any unit. Override with
// FORCE_TRAINER_ADDRESS=xx-xx-xx-xx-xx-xx if you have several paired, or if
// yours reports a different name.
let TARGET_NAME_FRAGMENT = "force trainer"
let TARGET_ADDRESS = ProcessInfo.processInfo.environment["FORCE_TRAINER_ADDRESS"]?.lowercased()
let RFCOMM_CHANNEL: BluetoothRFCOMMChannelID = 6
let TCP_PORT: UInt16 = 9000
let LOG_PATH = "/tmp/forcetrainer-reader.log"

// MARK: - logging

let logQueue = DispatchQueue(label: "log")
func log(_ s: String) {
    logQueue.sync {
        let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(s)\n"
        FileHandle.standardError.write(line.data(using: .utf8)!)
        if !FileManager.default.fileExists(atPath: LOG_PATH) {
            FileManager.default.createFile(atPath: LOG_PATH, contents: nil)
        }
        if let h = FileHandle(forWritingAtPath: LOG_PATH) {
            h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile()
        }
    }
}

// MARK: - TCP fan-out

/// Minimal TCP server. Clients (the Node bridge) connect and receive the raw
/// byte stream. Being the server rather than the client means the bridge can
/// restart freely without us needing to know about it.
final class ByteServer {
    private var listenFD: Int32 = -1
    private var clients: [Int32] = []
    private let lock = NSLock()

    func start(port: UInt16) {
        listenFD = socket(AF_INET, SOCK_STREAM, 0)
        guard listenFD >= 0 else { log("socket() failed"); return }
        var yes: Int32 = 1
        setsockopt(listenFD, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")   // localhost only
        let bindOK = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listenFD, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindOK == 0 else { log("bind(\(port)) failed - port in use?"); return }
        guard listen(listenFD, 4) == 0 else { log("listen() failed"); return }
        log("TCP server listening on 127.0.0.1:\(port)")

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while true {
                let fd = accept(self?.listenFD ?? -1, nil, nil)
                if fd < 0 { usleep(100_000); continue }
                var one: Int32 = 1
                setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))
                // Don't die with SIGPIPE when the bridge goes away.
                setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
                self?.lock.lock(); self?.clients.append(fd); self?.lock.unlock()
                log("bridge connected (fd \(fd))")
            }
        }
    }

    func broadcast(_ bytes: [UInt8]) {
        lock.lock(); let targets = clients; lock.unlock()
        guard !targets.isEmpty else { return }
        var dead: [Int32] = []
        for fd in targets {
            let n = bytes.withUnsafeBufferPointer { send(fd, $0.baseAddress, bytes.count, 0) }
            if n < 0 { dead.append(fd) }
        }
        if !dead.isEmpty {
            lock.lock()
            clients.removeAll { dead.contains($0) }
            lock.unlock()
            dead.forEach { close($0) }
            log("dropped \(dead.count) disconnected bridge(s)")
        }
    }
}

let server = ByteServer()

// MARK: - Bluetooth

/// True if this is the headset we want: an explicit address override if set,
/// otherwise any paired device whose name looks like a Force Trainer.
func isTarget(_ device: IOBluetoothDevice) -> Bool {
    let addr = (device.addressString ?? "").lowercased()
    if let wanted = TARGET_ADDRESS { return addr == wanted }
    return (device.name ?? "").lowercased().contains(TARGET_NAME_FRAGMENT)
}

final class InquiryWatcher: NSObject, IOBluetoothDeviceInquiryDelegate {
    var complete = false
    var found = false
    func deviceInquiryDeviceFound(_ sender: IOBluetoothDeviceInquiry!, device: IOBluetoothDevice!) {
        if isTarget(device) {
            found = true
            log("headset on air, rssi=\(device.rawRSSI())")
            sender.stop()
        }
    }
    func deviceInquiryComplete(_ sender: IOBluetoothDeviceInquiry!, error: IOReturn, aborted: Bool) {
        complete = true
    }
}

final class ChannelReader: NSObject, IOBluetoothRFCOMMChannelDelegate {
    var bytesSeen = 0
    var isOpen = false

    func rfcommChannelData(_ ch: IOBluetoothRFCOMMChannel!,
                           data ptr: UnsafeMutableRawPointer!, length len: Int) {
        guard len > 0 else { return }
        let bytes = [UInt8](UnsafeRawBufferPointer(start: ptr, count: len))
        bytesSeen += len
        server.broadcast(bytes)
    }
    func rfcommChannelOpenComplete(_ ch: IOBluetoothRFCOMMChannel!, status error: IOReturn) {
        isOpen = (error == kIOReturnSuccess)
        log("RFCOMM open complete status=\(error)")
    }
    func rfcommChannelClosed(_ ch: IOBluetoothRFCOMMChannel!) {
        isOpen = false
        log("RFCOMM channel closed")
    }
}

func spin(_ seconds: Double) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
}

// IOBluetoothDeviceInquiry keeps an UNRETAINED delegate reference and touches
// it from -dealloc. Letting either object go out of scope segfaults, so both
// live for the lifetime of the process and get reused across sessions.
let inquiryWatcher = InquiryWatcher()
let sharedInquiry: IOBluetoothDeviceInquiry? = IOBluetoothDeviceInquiry(delegate: inquiryWatcher)

/// Run an inquiry scan. Needed to wake a sleeping/idle headset: without it
/// openConnection() returns kIOReturnTimeout. But note an ALREADY-connected
/// device stops answering inquiries, so this is a fallback, not a first step.
func scanForHeadset() -> Bool {
    guard let inquiry = sharedInquiry else { log("could not create inquiry"); return false }
    let watcher = inquiryWatcher
    watcher.found = false
    watcher.complete = false
    inquiry.inquiryLength = 10
    inquiry.updateNewDeviceNames = false
    log("scanning for headset...")
    inquiry.start()
    let deadline = Date().addingTimeInterval(14)
    while !watcher.found && !watcher.complete && Date() < deadline {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
    }
    inquiry.stop()
    return watcher.found
}

/// One full acquisition attempt. Returns when the link drops.
func runSession() {
    guard let devices = IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice],
          let dev = devices.first(where: isTarget)
    else {
        log("no paired device matching \(TARGET_ADDRESS ?? "name '\(TARGET_NAME_FRAGMENT)'") "
            + "- pair the headset in System Settings first")
        return
    }

    // Order matters. Try the cheap paths before the 14s scan:
    //  1. already connected (LED solid) - just reuse the link
    //  2. direct connect - works when the device is awake and listening
    //  3. inquiry scan, then connect - wakes an idle/sleeping headset
    var connected = dev.isConnected()
    if connected {
        log("headset already connected; skipping scan")
    } else {
        let direct = dev.openConnection()
        log("direct openConnection -> \(direct)")
        connected = (direct == kIOReturnSuccess)
    }

    if !connected {
        if scanForHeadset() {
            for attempt in 1...3 {
                let r = dev.openConnection()
                log("openConnection after scan, attempt \(attempt) -> \(r)")
                if r == kIOReturnSuccess { connected = true; break }
                spin(1.5)
            }
        } else {
            log("headset not found - powered on? (LED blinking = idle, solid = connected)")
        }
    }
    guard connected else { log("baseband connect failed"); return }

    let reader = ChannelReader()
    var channel: IOBluetoothRFCOMMChannel?
    let rc = dev.openRFCOMMChannelSync(&channel, withChannelID: RFCOMM_CHANNEL, delegate: reader)
    guard rc == kIOReturnSuccess, let chan = channel else {
        log("RFCOMM channel \(RFCOMM_CHANNEL) failed -> \(rc)")
        // A stale baseband link (e.g. left behind by a crashed session) reports
        // isConnected() == true but refuses new RFCOMM channels. Tear it down
        // so the next attempt starts from a clean, fully disconnected state.
        log("closing stale baseband link so the next attempt can reconnect cleanly")
        dev.closeConnection()
        spin(2.0)
        return
    }
    log("streaming (headset LED should now be solid)")

    // Stay in the run loop until the link drops or the headset goes quiet.
    var lastCount = 0
    var idleTicks = 0
    while true {
        spin(2.0)
        if reader.bytesSeen == lastCount {
            idleTicks += 1
            if idleTicks >= 5 { log("no data for 10s - assuming link dropped"); break }
        } else {
            idleTicks = 0
            lastCount = reader.bytesSeen
        }
        if !dev.isConnected() { log("device disconnected"); break }
    }
    chan.close()
    dev.closeConnection()
}

// MARK: - main

log("=== Force Trainer II reader starting ===")
server.start(port: TCP_PORT)

while true {
    runSession()
    log("retrying in 3s...")
    spin(3.0)
}
