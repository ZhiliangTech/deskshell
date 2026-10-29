#!/usr/bin/env bash
# 编译 macOS AX 桥（需要 Xcode Command Line Tools）
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p .build
swiftc -O axbridge.swift -o .build/axbridge -framework Cocoa -framework ApplicationServices
echo "built: $(pwd)/.build/axbridge"
