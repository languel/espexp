#!/bin/bash
# Builds the acquisition app.
#
# It MUST be a .app bundle carrying NSBluetoothAlwaysUsageDescription, and it
# MUST be launched with `open` so launchd is the TCC "responsible process".
# Executing the binary directly gets it killed by TCC with SIGABRT.
set -e
cd "$(dirname "$0")"

APP=ForceTrainerReader.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

swiftc -O -o "$APP/Contents/MacOS/ForceTrainerReader" reader.swift
cp Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"

echo "built $APP"
